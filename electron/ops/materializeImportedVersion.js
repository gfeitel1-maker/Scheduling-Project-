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

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{write: Function}} syncClient
 * @param {{campId: string, authorUserId: string, placements: Array}} args
 * @returns {Promise<{created: boolean, snapshotId: string|null, allWeeksArchived?: boolean, unresolvedCount: number, unresolvedNames: string[]}>}
 */
export async function materializeImportedVersion(db, syncClient, { campId, authorUserId, placements, sourceFileName = null }) {
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
    weekId = `schedule-week:${campId}:1`
    await writeFields(syncClient, 'schedule_weeks', weekId, { camp_id: campId, name: 'Week 1', sort_order: '0', is_archived: '0' }, authorUserId)
  }

  const maps = {
    activityIdByName: nameMap(db, 'activities', campId),
    fixedEventIdByName: nameMap(db, 'fixed_events', campId),
    groupIdByName: nameMap(db, 'groups', campId),
    dayIdByName: nameMap(db, 'days_of_operation', campId, 'label'),
    blockIdByName: nameMap(db, 'time_blocks', campId),
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
  let snapshotId = null
  for (const kind of ['manual', 'generated']) {
    const existing = db.prepare('SELECT id FROM schedule_templates WHERE week_id = ? AND kind = ?').get(weekId, kind)
    let templateId = existing?.id
    if (!templateId) {
      templateId = deriveScheduleTemplateId(weekId, kind)
      await writeFields(syncClient, 'schedule_templates', templateId, { kind, camp_id: campId, week_id: weekId, name: '' }, authorUserId)
    }
    const id = randomUUID()
    await writeFields(syncClient, 'schedule_snapshots', id, {
      template_id: templateId,
      name,
      is_auto: false,
      created_at: new Date().toISOString(),
      slots: JSON.stringify(slots),
    }, authorUserId)
    snapshotId ??= id
  }

  return { created: true, snapshotId, unresolvedCount: unresolved.length, unresolvedNames: unresolved.map((u) => u.activityName), unresolvedItems }
}
