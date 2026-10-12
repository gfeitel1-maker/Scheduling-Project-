// T117 slice 2 — the Host-side orchestrator that turns a raw schedule
// import's captured placements into a saved version (a schedule_snapshots
// row on the camp's manual schedule_templates), per
// docs/adr/2026-09-02-imported-schedule-materializes-as-a-version.md.
//
// Writes go through the injected write client's write() (not a bare db.prepare)
// so they get the op-log entry and the mirror into the Automerge document for
// free — see the ADR and CLAUDE.md's op-log rule. _Prior: this said "op-log +
// Host broadcast". There is no Host broadcasting writes: replication is the
// document merging peer-to-peer over libp2p, and the op-log entry these writes
// get is device-local history (Trash/Restore/entity history), not the way the
// write reaches another device._
// This mirrors createUser's write-per-field loop (electron/auth/localAuth.js).

import { randomUUID } from 'node:crypto'
import { normalizeName } from '../../src/ingest/preview.js'
import { resolveImportedPlacements, describeUnresolved } from './resolveImportedPlacements.js'
import { deriveScheduleTemplateId } from './scheduleTemplateId.js'
import { defaultWeekId, defaultWeekFields } from '../../src/ingest/defaultWeek.js'
import { blocksThatContinue } from '../../src/engine/blockOverlap.js'
import { isHumanDeleted } from './fieldProvenance.js'
import { DELETE_FIELD } from './operations.js'
import { deriveSpecialDayActivityId } from './electiveDerivedIds.js'

// The renderer supplies the file name; it becomes a stored version name, so it
// is coerced to a bare, bounded string at the boundary.
export function cleanSourceFileName(value) {
  if (typeof value !== 'string') return null
  const base = value.split(/[\\/]/).pop().trim()
  if (!base) return null
  return base.length > 120 ? `${base.slice(0, 119)}…` : base
}

async function writeFields(syncClient, entity, entityId, fields, authorUserId) {
  for (const [field, value] of Object.entries(fields)) {
    const result = await syncClient.write({ entity, entity_id: entityId, field, value, author_user_id: authorUserId })
    if (!(result && result.status === 'applied')) {
      throw new Error(`materializeImportedVersion: write failed for ${entity}.${field} (status: ${result?.status})`)
    }
  }
}

// T252: sort by id ASC and use first-write-wins, so a duplicated name (now
// possible post-merge, schema v73) always resolves to the lowest id
// regardless of the unordered SELECT's physical row order.
export function nameMap(db, table, campId, nameColumn = 'name') {
  const rows = db.prepare(`SELECT id, ${nameColumn} AS name FROM ${table} WHERE camp_id = ? ORDER BY id ASC`).all(campId)
  const map = new Map()
  for (const row of rows) {
    const key = normalizeName(row.name)
    if (!map.has(key)) map.set(key, row.id)
  }
  return map
}

// T219: one bundle per (set, choice, day, span blocks). Content-keyed, so a
// re-import, or a second group with the same span, converges on one row.
export function deriveImportedBundleId(electiveSetId, activityId, dayId, blockIds) {
  return `elective-bundle-import:${electiveSetId}:${activityId}:${dayId}:${blockIds.join(',')}`
}

// T219: an imported elective span (head + tails from markElectiveSpans) links
// each of the set's choices across the span's periods, so the solver gives a
// camper the same choice for the whole double period
// (docs/adr/2026-09-29-linked-elective-bundles.md). Only choices the set holds
// now are linked; a choice the director adds later is linked by hand.
async function writeSpanBundles(db, syncClient, slots, blockOrder, blockContinues, authorUserId, onRowCreated, fileLabels) {
  const blockAt = new Map([...blockOrder].map(([id, i]) => [i, id]))
  // Each group's runs of consecutive blocks holding a set on a day, marked or not.
  const runsBySetDay = new Map() // `${set}|${day}` -> [[blockId, ...], ...]
  const cellsByGroupSetDay = new Map()
  for (const s of slots) {
    if (!s.elective_set_id || !blockOrder.has(s.time_block_id)) continue
    const k = `${s.elective_set_id}|${s.day_id}|${s.group_id}`
    if (!cellsByGroupSetDay.has(k)) cellsByGroupSetDay.set(k, new Set())
    cellsByGroupSetDay.get(k).add(blockOrder.get(s.time_block_id))
  }
  for (const [k, positions] of cellsByGroupSetDay) {
    const setDay = k.slice(0, k.lastIndexOf('|'))
    const sorted = [...positions].sort((x, y) => x - y)
    const runs = runsBySetDay.get(setDay) ?? []
    let run = [sorted[0]]
    for (let i = 1; i <= sorted.length; i++) {
      if (i < sorted.length && sorted[i] === run[run.length - 1] + 1 && blockContinues.has(blockAt.get(sorted[i]))) { run.push(sorted[i]); continue }
      runs.push(run.map((p) => blockAt.get(p)))
      if (i < sorted.length) run = [sorted[i]]
    }
    runsBySetDay.set(setDay, runs)
  }
  // A span is linked only when every group's run touching it IS it: bundles of one choice that
  // share a period are refused by the solver (bundleOverlap.js), and a bundle's periods name no group.
  const spans = []
  const unlinked = []
  for (const [setDay, runs] of runsBySetDay) {
    const multi = [...new Map(runs.filter((r) => r.length > 1).map((r) => [r.join(','), r])).values()]
    if (multi.length === 0) continue
    const consistent = multi.every((span) => runs.every((r) => !r.some((b) => span.includes(b)) || r.join(',') === span.join(',')))
    const [setId, dayId] = setDay.split('|')
    if (consistent) for (const blockIds of multi) spans.push({ setId, dayId, blockIds })
    else unlinked.push({ setId, dayId })
  }
  const setName = db.prepare('SELECT name FROM elective_sets WHERE id = ?')
  const dayLabel = db.prepare('SELECT label FROM days_of_operation WHERE id = ?')
  const unlinkedSpans = unlinked.map(({ setId, dayId }) => ({ electiveSetName: setName.get(setId)?.name ?? null, dayName: dayLabel.get(dayId)?.label ?? null }))
  if (spans.length === 0) return { unlinkedSpans }
  const choices = db.prepare(`SELECT esa.activity_id AS id, a.name AS name FROM elective_set_activities esa
    LEFT JOIN activities a ON a.id = esa.activity_id WHERE esa.elective_set_id = ? ORDER BY esa.activity_id`)
  const exists = (table, id) => Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id))
  // A bundle or period the director deleted keeps its delete in the op log under the same derived
  // id: that is the tombstone, so a re-import of the same file never brings it back. Undo's own
  // deletes are not tombstones (isHumanDeleted, the rule fixed events use too).
  //
  // A rejection ends when an import recreates what it rejected (keeper ruling, final audit): a
  // director who deleted the whole elective set cascaded its bundles with it, and an import that
  // has since made the set again links its double period again. So the tombstone counts only if
  // the delete is newer than the set's latest (re)creation.
  const createdSeq = (setId) => db.prepare("SELECT MAX(seq) AS s FROM operations WHERE entity = 'elective_sets' AND entity_id = ? AND field = 'name'").get(setId)?.s ?? 0
  const deleteSeq = (table, id) => db.prepare('SELECT MAX(seq) AS s FROM operations WHERE entity = ? AND entity_id = ? AND field = ?').get(table, id, DELETE_FIELD)?.s ?? 0
  const deleted = (table, id, setId) => !exists(table, id) && isHumanDeleted(db, table, id) && deleteSeq(table, id) > createdSeq(setId)
  try {
    for (const { setId, dayId, blockIds } of spans) {
      const day = fileLabels.dayName(dayId) ?? dayLabel.get(dayId)?.label ?? ''
      for (const choice of choices.all(setId)) {
        const bundleId = deriveImportedBundleId(setId, choice.id, dayId, blockIds)
        if (deleted('elective_bundles', bundleId, setId)) continue
        if (!exists('elective_bundles', bundleId)) {
          await writeFields(syncClient, 'elective_bundles', bundleId, {
            elective_set_id: setId, activity_id: choice.id, name: [fileLabels.choiceName(setId, choice.id) ?? choice.name ?? 'Choice', day].filter(Boolean).join(' — '), scope_mode: 'all',
          }, authorUserId)
          onRowCreated?.('elective_bundles', bundleId)
        }
        for (const blockId of blockIds) {
          const periodId = `${bundleId}:${blockId}`
          if (exists('elective_bundle_periods', periodId) || deleted('elective_bundle_periods', periodId, setId)) continue
          await writeFields(syncClient, 'elective_bundle_periods', periodId, { bundle_id: bundleId, day_id: dayId, time_block_id: blockId }, authorUserId)
          onRowCreated?.('elective_bundle_periods', periodId)
        }
      }
    }
  } catch (err) {
    // The version is already saved; the link is what failed, and the director is told.
    return { unlinkedSpans, linkFailed: String(err?.message ?? err) }
  }
  return { unlinkedSpans }
}

// T375: a bundle's name is read from the FILE (the choice and day as printed), so every device
// importing the same file writes the same bytes. A device holding an unsynced rename of a choice
// would otherwise write a different name and raise a conflict on the other. The import's choice
// activities carry an id derived from the printed text (deriveSpecialDayActivityId, as
// writeElectiveChoices mints them), which is what ties a printed label to an activity here; one
// matched by spelling instead falls back to that spelling. Local names are the last resort.
function fileLabelsFor(db, campId, placements, electiveChoiceLabels, maps) {
  const choicesBySetId = new Map()
  const addChoices = (setName, choices) => {
    const setId = maps.electiveSetIdByName.get(normalizeName(setName ?? ''))
    if (!setId || !Array.isArray(choices)) return
    if (!choicesBySetId.has(setId)) choicesBySetId.set(setId, new Map())
    const byId = choicesBySetId.get(setId)
    for (const raw of choices) {
      const text = String(raw ?? '').trim()
      if (!text) continue
      const derived = deriveSpecialDayActivityId(campId, text)
      if (!byId.has(derived)) byId.set(derived, text)
      const spelled = maps.activityIdByName.get(normalizeName(text))
      if (spelled && !byId.has(spelled)) byId.set(spelled, text)
    }
  }
  for (const s of electiveChoiceLabels ?? []) addChoices(s?.name, s?.choices)
  for (const p of placements ?? []) if (p?.electiveSetName) addChoices(p.electiveSetName, p.choices)
  const dayNameById = new Map()
  for (const p of placements ?? []) {
    const dayId = maps.dayIdByName.get(normalizeName(p?.dayName ?? ''))
    if (dayId && !dayNameById.has(dayId)) dayNameById.set(dayId, String(p.dayName).trim())
  }
  return {
    choiceName: (setId, activityId) => choicesBySetId.get(setId)?.get(activityId) ?? null,
    dayName: (dayId) => dayNameById.get(dayId) ?? null,
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{write: Function}} syncClient
 * @param {{campId: string, authorUserId: string, placements: Array}} args
 * @returns {Promise<{created: boolean, snapshotId: string|null, allWeeksArchived?: boolean, unresolvedCount: number, unresolvedNames: string[]}>}
 */
export async function materializeImportedVersion(db, syncClient, { campId, authorUserId, placements, sourceFileName = null, onSnapshotCreated = null, onRowCreated = null, electiveChoiceLabels = [] }) {
  if (!placements || placements.length === 0) {
    return { created: false, snapshotId: null, unresolvedCount: 0, unresolvedNames: [] }
  }

  const week = db
    .prepare('SELECT id FROM schedule_weeks WHERE camp_id = ? AND is_archived = 0 ORDER BY sort_order ASC LIMIT 1')
    .get(campId)
  // Packaged audit #12: a fresh camp has no week until the Schedule screen first
  // opens. Create it here under the screen's own lazy-creation guard
  // (useScheduleData.js fires only when the camp has NO week rows, archived
  // included) and with the same id, so the two paths converge on one "Week 1".
  // A camp whose weeks are all archived gets nothing created: writing
  // schedule-week:<camp>:1 would un-archive it, or duplicate "Week 1" beside
  // a differently-id'd archived one.
  let weekId = week?.id
  if (!weekId) {
    const anyWeek = db.prepare('SELECT 1 FROM schedule_weeks WHERE camp_id = ? LIMIT 1').get(campId)
    if (anyWeek) {
      return { created: false, snapshotId: null, allWeeksArchived: true, unresolvedCount: 0, unresolvedNames: [] }
    }
    weekId = defaultWeekId(campId)
    await writeFields(syncClient, 'schedule_weeks', weekId, defaultWeekFields(campId), authorUserId)
  }

  const orderedBlocks = db.prepare('SELECT id, start_time, end_time FROM time_blocks WHERE camp_id = ? ORDER BY sort_order IS NULL, sort_order, start_time, id').all(campId)
  const maps = {
    activityIdByName: nameMap(db, 'activities', campId),
    fixedEventIdByName: nameMap(db, 'fixed_events', campId),
    // Built after commitIngest has run (main.js ingestCommit), so a set the
    // import just created is already here.
    electiveSetIdByName: nameMap(db, 'elective_sets', campId),
    groupIdByName: nameMap(db, 'groups', campId),
    dayIdByName: nameMap(db, 'days_of_operation', campId, 'label'),
    blockIdByName: nameMap(db, 'time_blocks', campId),
    // T219: the day's block order, and which blocks begin exactly when the one before ends,
    // so an elective held in back-to-back blocks resolves as one span and two chugim around a
    // break stay two. sort_order is the order the engine and the grid sort by; start_time then
    // id only break ties they leave undefined.
    blockOrder: new Map(orderedBlocks.map((b, i) => [b.id, i])),
    blockContinues: blocksThatContinue(orderedBlocks),
    activitySpanBlocks: new Map(db.prepare('SELECT id, span_blocks FROM activities WHERE camp_id = ? AND span_blocks > 1').all(campId).map((a) => [a.id, a.span_blocks])),
  }

  const { slots, unresolved } = resolveImportedPlacements(placements, maps)
  const unresolvedItems = describeUnresolved(
    unresolved,
    db.prepare('SELECT name, start_time, end_time FROM time_blocks WHERE camp_id = ?').all(campId),
  )

  if (slots.length === 0) {
    return { created: false, snapshotId: null, unresolvedCount: unresolved.length, unresolvedNames: unresolved.map((u) => u.activityName), unresolvedItems }
  }

  // The director lands on Generated, so the imported week must be findable
  // there as well as on Manual: one identical version per candidate route.
  const name = sourceFileName ? `Imported from ${sourceFileName}` : 'Imported schedule'
  const slotsJson = JSON.stringify(slots)
  let snapshotId = null
  for (const kind of ['manual', 'generated']) {
    const existing = db.prepare('SELECT id FROM schedule_templates WHERE week_id = ? AND kind = ?').get(weekId, kind)
    let templateId = existing?.id
    if (!templateId) {
      templateId = deriveScheduleTemplateId(weekId, kind)
      await writeFields(syncClient, 'schedule_templates', templateId, { kind, camp_id: campId, week_id: weekId, name: '' }, authorUserId)
    }
    // Re-importing the same file (Keep mode, nothing new placed) must not stack
    // another identical version: skip when the newest same-named version on this
    // route already holds exactly these slots. A changed file or changed slots
    // still saves.
    const latest = db
      .prepare('SELECT slots FROM schedule_snapshots WHERE template_id = ? AND name = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(templateId, name)
    if (latest?.slots === slotsJson) continue
    const id = randomUUID()
    await writeFields(syncClient, 'schedule_snapshots', id, {
      template_id: templateId,
      name,
      is_auto: false,
      created_at: new Date().toISOString(),
      slots: slotsJson,
    }, authorUserId)
    snapshotId ??= id
    // Reported as each is saved, so a later failure cannot leave one the import does not own.
    onSnapshotCreated?.(id, name)
  }

  // After the versions, so a failed link cannot cost the version. Each row is reported as it is
  // written, like the versions, so undo owns it (T219).
  const links = await writeSpanBundles(db, syncClient, slots, maps.blockOrder, maps.blockContinues, authorUserId, onRowCreated, fileLabelsFor(db, campId, placements, electiveChoiceLabels, maps))
  const linkReport = { ...(links.unlinkedSpans.length ? { unlinkedSpans: links.unlinkedSpans } : {}), ...(links.linkFailed ? { linkFailed: links.linkFailed } : {}) }

  if (!snapshotId) return { created: false, snapshotId: null, unchanged: true, ...linkReport, unresolvedCount: unresolved.length, unresolvedNames: unresolved.map((u) => u.activityName), unresolvedItems }
  return { created: true, snapshotId, versionName: name, ...linkReport, electiveCellCount: slots.filter((slot) => slot.elective_set_id).length, unresolvedCount: unresolved.length, unresolvedNames: unresolved.map((u) => u.activityName), unresolvedItems }
}
