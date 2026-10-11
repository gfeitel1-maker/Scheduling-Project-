// @vitest-environment node
//
// Synthetic-corpus harness: 15 fictional camps (docs/work/specs/samples/synthetic) pushed through the
// REAL import pipeline, then through Generate and Manual-from-import, with a scorecard written as JSON.
//
//   parseTextGrid -> extractEntities -> inferFixedEvents -> commitIngest (dry run) ->
//   buildReconciliationReport -> foldTriageInputs -> commitIngest -> real SQLite ->
//   buildSchedule (Generate) + capturePlacements/materializeImportedVersion (Manual from import)
//
// This file asserts hard invariants (a crash, the fill-again invariants below, the T266 exclusivity invariant, a Keep
// re-import that writes, a Generate error finding) and RECORDS every quality metric without asserting it.
// A hard invariant that fails today is listed in KNOWN_FAILING and runs under it.fails, so CI stays green
// while the finding stays visible; the entry must be deleted the day the product is fixed (it.fails then
// turns red, which is the prompt to remove it).
//
// Glue (importUnanswered) mirrors electron/importDirectorPath.integration.test.js plus the division and
// co-schedule inference ImportScreen runs before commit. Nothing here reimplements product logic: scope
// resolution, overlap and span behaviour are read from the product modules.
//
// Scope limit: the glue is a hand-written copy of ImportScreen's plan assembly, so a green run says nothing
// about ImportScreen branches it does not copy: an accepted trip's rule recompute (partlyClaimed), the
// director's hand edits in the rule editor, and the trip review itself (a fresh camp has no week, so
// planTripEvents offers nothing; see WHOLE_DAY_FOR_SOME).
//
// SYNTHETIC_ONLY=s05 runs one camp (debugging aid; the scorecard then holds only that camp).
// Scorecard: written ONLY when asked. SHORESH_WRITE_SCORECARD=1 writes the tracked
// docs/work/evidence/2026-10-11-synthetic-15-scorecard.json; SYNTHETIC_SCORECARD_PATH=<file> writes there instead.
// A plain run writes nothing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { commitIngest } from './ops/ingest.js'
import { appendOp } from './ops/operations.js'
import { listOpenReconciliationDecisions } from './ops/openReconciliationDecisions.js'
import { materializeImportedVersion, nameMap } from './ops/materializeImportedVersion.js'
import { normalizeScheduleInputs, SCHEDULE_INPUT_ENTITIES } from './ops/scheduleInputNormalization.js'
import { normalizeName } from '../src/ingest/preview.js'
import { parseTextGrid, normalizeTimeLabel } from '../src/ingest/textGrid.js'
import { extractEntities } from '../src/ingest/extractEntities.js'
import { inferFixedEvents } from '../src/ingest/fixedEvents.js'
import { settleAmbiguousFromCamp } from '../src/ingest/settleAmbiguousFromCamp.js'
import { derivePinOnlyActivityNames } from '../src/ingest/pinOnlyActivityNames.js'
import { inferActivityRules } from '../src/ingest/activityRules.js'
import { capturePlacements } from '../src/ingest/capturePlacements.js'
import { inferTextSpans } from '../src/ingest/textSpans.js'
import { buildReconciliationReport } from '../src/ingest/reconciliationReport.js'
import { inferDivisionEntities } from '../src/ingest/inferDivisions.js'
import { buildBlastRadiusIndex } from '../src/ingest/blastRadius.js'
import { detectAllCampOverrides } from '../src/ingest/allCampOverrides.js'
import { inferCoScheduleRules } from '../src/ingest/coScheduleRules.js'
import { proposeSpecialDay } from '../src/ingest/specialDayFile.js'
import { buildSpecialDayPlan } from '../src/ingest/specialDayPlan.js'
import { foldTriageInputs, heldBackDecisions } from '../src/screens/reconciliationTriage.js'
import { resolvePriorityForGeneration } from '../src/ingest/resolvePriorityForGeneration.js'
import { resolveFixedEventGroupIds, resolveFixedEventDayIds } from '../src/engine/fixedEventScope.js'
import { computeOverlaps } from '../src/utils/computeOverlaps.js'
import buildSchedule from '../src/engine/buildSchedule.js'
import { isActivityEligibleForGroup } from '../src/engine/eligibility.js'

const DIR = path.join(process.cwd(), 'docs/work/specs/samples/synthetic')
const MANIFEST = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'))
const DEFAULT_SCORECARD_PATH = path.join(process.cwd(), 'docs/work/evidence/2026-10-11-synthetic-15-scorecard.json')
// The scorecard is tracked evidence: it is (re)written only on request, never by a plain test run.
function scorecardWriteTarget(env) {
  if (env.SYNTHETIC_SCORECARD_PATH) return env.SYNTHETIC_SCORECARD_PATH
  return env.SHORESH_WRITE_SCORECARD === '1' ? DEFAULT_SCORECARD_PATH : null
}
const SCORECARD_PATH = scorecardWriteTarget(process.env)
const deviceId = 'device-1'
const userId = 'u1'
const COUNTED_TABLES = ['groups', 'tiers', 'days_of_operation', 'time_blocks', 'activities', 'locations', 'fixed_events', 'elective_sets']

// `<slug>:<invariant>` entries that fail today and are tracked as findings in the scorecard; each runs under
// it.fails and must be removed the day its product bug is fixed.
const MEAL_ZERO = 'zero answers: every group gets its meal on every day and block the file prints it'
const MEAL_ALL = 'confirm all: every group gets its meal on every day and block the file prints it'
// Owner: "imagine that a camp imports a schedule - all things have been filled in. it would be
// reasonable to assume that when we generate it should be again."
const FAITHFUL_ZERO = 'zero answers: every inferred rule admits the file it was read from'
const FAITHFUL_ALL = 'confirm all: every inferred rule admits the file it was read from'
const FILLS_ZERO = 'zero answers: Generate fills the week again (nothing short, no empty cell)'
const FILLS_ALL = 'confirm all: Generate fills the week again (nothing short, no empty cell)'
// A whole-day item for SOME groups (a trip, a Games Day) is read as an event only when the camp has a
// schedule week to bind it to (src/ingest/tripEvents.js planTripEvents), and a camp's first import has
// none: the name becomes a day-long span activity that the inferred daily fixed events leave no room for.
const WHOLE_DAY_FOR_SOME = [`s04-by-day-6day-large:${FILLS_ZERO}`, `s04-by-day-6day-large:${FILLS_ALL}`]
const KNOWN_FAILING = new Set(WHOLE_DAY_FOR_SOME)

const results = {}
const startedAt = Date.now()

// The engine seeds its PRNG from camp id + cohort id. Random ids made every scorecard a different
// draw (s02 stillNeeded ranged 0-3 and s07 38-47 across identical runs), so a delta against the
// baseline was partly noise. Ids derived from the camp slug and scenario make the run repeatable.
const stableId = (key) => {
  const h = createHash('sha256').update(key).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function seedCamp(key = randomUUID()) {
  const { db: d } = openTemplatedDb()
  const id = stableId(`camp:${key}`)
  d.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(id, 'Synthetic Camp', 'a'.repeat(64))
  d.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  d.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run(userId, id)
  d.prepare('INSERT INTO cohorts (id, camp_id, name, sort_order) VALUES (?, ?, ?, 0)').run(stableId(`cohort:${key}`), id, 'Main')
  return { d, id }
}

// The director's import path: dry run -> report -> answers -> fold -> real commit (openDecisions as the screen sends them).
function importFile(d, id, text, { answerFor = () => null, mode = 'add' } = {}) {
  const parsed = parseTextGrid(text)
  const proposal = extractEntities(parsed)
  // As ImportScreen does: the camp's own time-block names, so a re-import recognizes its named periods.
  const knownTimeBlockNames = d.prepare('SELECT name FROM time_blocks WHERE camp_id = ?').all(id).map((t) => t.name)
  const { fixedEvents: inferredEvents, dualUseNames = [], ambiguousEvents = [] } = inferFixedEvents({ pages: parsed.pages }, proposal, { knownTimeBlockNames })
  // As ImportScreen does: a dual-use name the camp already classified is read from its records, not
  // asked again (Replace deletes them first); the rest go to the review as one name_kind question.
  const settled = settleAmbiguousFromCamp(ambiguousEvents, mode === 'replace' ? {} : {
    activities: d.prepare('SELECT name, catalog_role FROM activities WHERE camp_id = ?').all(id),
    fixedEvents: d.prepare('SELECT name FROM fixed_events WHERE camp_id = ?').all(id),
  })
  const fixedEvents = [...inferredEvents, ...settled.settledFixed]
  const pinOnly = new Set([...derivePinOnlyActivityNames(inferredEvents, dualUseNames), ...settled.settledFixedNames.map(normalizeName)])
  const { placements } = capturePlacements({ pages: parsed.pages }, proposal)
  const fixedEventNames = fixedEvents.filter((e) => e.kind === 'fixed').map((e) => e.name)
  const statedUnits = proposal.groupUnits ?? {}
  const inferred = inferDivisionEntities(proposal.entities.groups ?? [], placements, fixedEventNames)
  const divisions = inferred
    .map((dv) => ({ ...dv, groupNames: dv.groupNames.filter((g) => !statedUnits[g]) }))
    .filter((dv) => dv.groupNames.length > 0)
  const groupUnits = {}
  for (const dv of divisions) for (const g of dv.groupNames) groupUnits[g] = dv.name
  Object.assign(groupUnits, statedUnits)
  const tierNames = [...(proposal.entities.tiers ?? [])]
  for (const dv of divisions) if (!tierNames.some((t) => normalizeName(t) === normalizeName(dv.name))) tierNames.push(dv.name)
  const coSchedule = inferCoScheduleRules(placements, groupUnits)
  const rules = inferActivityRules(
    proposal.entities.activities, proposal.activityPages, proposal.seenCounts,
    proposal.entities.days_of_operation.length, proposal.entities.groups, pinOnly,
    inferTextSpans({ pages: parsed.pages }, proposal).spans,
  )
  // inferActivityRules returns a Map; ImportScreen sends commitIngest a plain object keyed by activity name.
  const activityRules = {}
  for (const name of proposal.entities.activities) {
    const rule = rules.get(name)
    if (!rule) continue
    activityRules[name] = {
      eligible_group_names: rule.eligible_group_names ?? null,
      min_per_week: rule.min_per_week,
      max_per_week: rule.max_per_week,
      priority: rule.priority,
      ...(rule.span_blocks ? { span_blocks: rule.span_blocks } : {}),
      co_schedule: coSchedule.get(name),
      ...(rule.min_from_file ? { min_from_file: true } : {}),
    }
  }
  const baseInputs = {
    approved: {
      groups: proposal.entities.groups,
      days_of_operation: proposal.entities.days_of_operation,
      time_blocks: proposal.entities.time_blocks,
      activities: proposal.entities.activities,
      tiers: tierNames,
    },
    links: { groups: groupUnits },
    fixedEvents,
    activityRules,
    pinOnlyActivityNames: [...pinOnly],
    seenCounts: proposal.seenCounts ?? null,
    electiveHeaderFindings: proposal.electiveHeaderFindings ?? [],
    activityPeriods: proposal.activityPeriods ?? {},
  }
  const common = { camp_id: id, cohort_id: null, author_user_id: userId, device_id: deviceId, mode }
  const dry = commitIngest(d, { ...common, ...baseInputs, dryRun: true })
  // The same inputs ReconciliationScreen hands buildReconciliationReport (readiness and the census snapshot are
  // display-only and are not built here).
  const report = buildReconciliationReport({
    planItems: dry.planItems ?? [],
    fixedEventsReport: { ...dry.fixedEvents, created: dry.fixedEvents?.createdEntries ?? [], unchanged: dry.fixedEvents?.unchangedEntries ?? [] },
    legacyPriorityActivities: dry.legacyPriorityActivities,
    fieldProvenance: new Map(Object.entries(dry.fieldProvenance ?? {})),
    evidenceSupport: dry.evidenceSupport,
    blastRadiusIndex: buildBlastRadiusIndex(dry.planItems ?? []),
    unknownFieldEvidence: new Map(Object.entries(dry.unknownFieldEvidence ?? {})),
    electiveCandidates: dry.electiveCandidates,
    allCampOverrides: detectAllCampOverrides(placements, proposal.entities.groups ?? []),
    ambiguousEvents: settled.stillAmbiguous,
    placements,
    allGroupNames: proposal.entities.groups ?? [],
  })
  const answers = Object.fromEntries(report.decisions.map((dec) => [dec.id, answerFor(dec)]).filter(([, a]) => a))
  const folded = foldTriageInputs(baseInputs, report.decisions, answers)
  const committed = commitIngest(d, { ...common, ...baseInputs, ...folded, openDecisions: heldBackDecisions(report.decisions, answers) })
  return { parsed, proposal, placements, pinOnly, dualUseNames, dry, report, answers, committed }
}

const CONFIRM_ALL = (dec) => {
  if (dec.kind === 'confirm_value') return { action: 'looks_right' }
  if (dec.kind === 'elective_candidate') return { choice: 'confirm' }
  // F9: a name that is both a pinned event and a catalogue activity is ONE name_kind question
  // (ADR 2026-09-26 OQ3, unanswered = activity). "Confirm everything" answers it the way the file
  // reads it: a fixed time. Without this the confirm path never exercised the weekly event at all.
  if (dec.kind === 'name_kind') return { choice: 'fixed' }
  return null
}

function tableCounts(d) {
  return Object.fromEntries(COUNTED_TABLES.map((t) => [t, d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c]))
}

function scheduleInput(d, id) {
  const rowsByEntity = {}
  for (const entity of SCHEDULE_INPUT_ENTITIES) rowsByEntity[entity] = d.prepare(`SELECT * FROM ${entity}`).all()
  const { cohorts: _c, ...flat } = normalizeScheduleInputs(rowsByEntity, id)
  return { ...flat, activities: resolvePriorityForGeneration(flat.activities), campId: id, replacedDayIds: [] }
}

function safe(fn) {
  try { return { ok: true, value: fn() } } catch (err) { return { ok: false, error: String(err?.message ?? err).slice(0, 300) } }
}

// ── expected facts, read from the manifest ───────────────────────────────────
const groupsOf = (m, sel) => (sel === 'all' ? m.groups : sel)
const blockKey = (label) => normalizeName(normalizeTimeLabel(label))

// Event cells after displacement: a trip or all-day day replaces whatever else is printed in those cells.
function expectedEventCells(m) {
  const cells = new Map()
  const order = (kind) => (kind === 'trip' || kind === 'allday' ? 0 : 1)
  const events = [...m.events].sort((a, b) => order(a.kind) - order(b.kind))
  for (const e of events) {
    for (const g of groupsOf(m, e.groups)) for (const day of e.days) for (const block of e.blocks) {
      const k = `${g}|${day}|${blockKey(block)}`
      if (!cells.has(k)) cells.set(k, { kind: e.kind, name: e.name, group: g, day, block })
    }
  }
  return [...cells.values()]
}

function expectedElectiveCells(m) {
  const out = []
  for (const el of m.electives) for (const g of el.groups) for (const day of el.days) for (const block of el.rows) {
    out.push({ el, group: g, day, block })
  }
  return out
}

function tally(cells, isHit, describe) {
  const byKind = {}
  const byName = {}
  const firstMisses = []
  for (const c of cells) {
    const hit = isHit(c)
    for (const [bucket, key] of [[byKind, c.kind], [byName, c.name]]) {
      const slot = (bucket[key] ??= { ok: 0, total: 0 })
      slot.total++
      if (hit) slot.ok++
    }
    if (!hit && firstMisses.length < 12) firstMisses.push(describe(c))
  }
  return { byKind, byName, firstMisses }
}

const fraction = (ok, total) => ({ ok, total, ratio: total === 0 ? null : Number((ok / total).toFixed(3)) })

// ── reading the result back out of SQLite ────────────────────────────────────
function lookups(d, id) {
  return {
    group: nameMap(d, 'groups', id),
    day: nameMap(d, 'days_of_operation', id, 'label'),
    block: nameMap(d, 'time_blocks', id),
  }
}

function exclusivity(d, id, imp) {
  const pinOnly = imp.pinOnly
  const dual = new Set([...imp.dualUseNames].map((n) => normalizeName(String(n))))
  // A question about the EVENT itself (entity fixed_events: "is Lunch at 8:00 right?") is a legitimate card and is
  // recorded as eventQuestions; the invariant is about a claimed name leaking into the ACTIVITY pass.
  const claimed = imp.report.decisions.filter((x) => pinOnly.has(x.entityName)).map((x) => `${x.entity}:${x.entityName}`)
  const decisions = claimed.filter((x) => !x.startsWith('fixed_events:'))
  const claimedOpen = listOpenReconciliationDecisions(d, id).filter((r) => pinOnly.has(r.entity_name)).map((r) => `${r.entity_type}:${r.entity_name}`)
  const openItems = claimedOpen.filter((x) => !x.startsWith('fixed_events:'))
  const candidates = (imp.dry.planItems ?? [])
    .filter((i) => i.entity === 'activities' && pinOnly.has(i._name) && i.fields?.catalog_role?.to !== 'pinned_event')
    .map((i) => i._name)
  const eventNames = new Set(d.prepare('SELECT name FROM fixed_events WHERE camp_id = ?').all(id).map((r) => normalizeName(r.name ?? '')))
  const regular = new Set(d.prepare("SELECT name FROM activities WHERE camp_id = ? AND (catalog_role IS NULL OR catalog_role != 'pinned_event')").all(id).map((r) => normalizeName(r.name)))
  const inTwoBuckets = [...eventNames].filter((n) => regular.has(n) && !dual.has(n))
  // A pinned_event marker exists only to back an event: one with no fixed_events row linking to it is an orphan (F2).
  const orphanMarkers = d.prepare("SELECT a.name FROM activities a WHERE a.camp_id = ? AND a.catalog_role = 'pinned_event' AND NOT EXISTS (SELECT 1 FROM fixed_events f WHERE f.activity_id = a.id)").all(id).map((r) => r.name)
  const pinnedMarkers = d.prepare("SELECT COUNT(*) AS n FROM activities WHERE camp_id = ? AND catalog_role = 'pinned_event'").get(id).n
  return { decisions, openItems, candidates, inTwoBuckets, orphanMarkers, pinnedMarkers, eventQuestions: claimed.filter((x) => x.startsWith('fixed_events:')), eventOpenItems: claimedOpen.filter((x) => x.startsWith('fixed_events:')), ok: !decisions.length && !openItems.length && !candidates.length && !inTwoBuckets.length && !orphanMarkers.length }
}

// Event-cell coverage read from fixed_events through the product's own scope resolvers.
function fixedCoverage(input) {
  const blockIdx = new Map(input.timeBlocks.map((b, i) => [b.id, i]))
  const byIndex = input.timeBlocks.map((b) => b.id)
  const cover = new Map()
  for (const fe of input.fixedEvents) {
    const gids = resolveFixedEventGroupIds(fe, input.groups)
    const dids = resolveFixedEventDayIds(fe, input.days)
    const start = blockIdx.get(fe.time_block_id)
    const span = fe.span_blocks || 1
    const bids = start === undefined ? [fe.time_block_id] : byIndex.slice(start, start + span)
    for (const g of gids) for (const dd of dids) for (const b of bids) cover.set(`${g}|${dd}|${b}`, normalizeName(fe.name ?? ''))
  }
  return cover
}

function evaluateImport(m, d, id, imp) {
  const input = scheduleInput(d, id)
  const lk = lookups(d, id)
  const activities = d.prepare('SELECT * FROM activities WHERE camp_id = ?').all(id)
  const regular = activities.filter((a) => a.catalog_role !== 'pinned_event')
  const feRows = d.prepare('SELECT * FROM fixed_events WHERE camp_id = ?').all(id)
  const expectedActs = new Map(m.activities.map((n) => [normalizeName(n), n]))
  const regularNames = new Set(regular.map((a) => normalizeName(a.name)))
  const eventNames = new Set(m.events.filter((e) => !['trip', 'allday'].includes(e.kind)).map((e) => normalizeName(e.name)))
  const typoVariants = new Set(m.typos.map((t) => normalizeName(t.variant)))

  const cover = fixedCoverage(input)
  const cellIds = (c) => `${lk.group.get(normalizeName(c.group))}|${lk.day.get(normalizeName(c.day))}|${lk.block.get(blockKey(c.block))}`
  const eventCells = expectedEventCells(m)
  const evTally = tally(eventCells, (c) => cover.get(cellIds(c)) === normalizeName(c.name), (c) => `${c.name} | ${c.group} | ${c.day} | ${c.block}`)
  const lunchCells = eventCells.filter((c) => c.kind === 'lunch')
  const lunchOk = lunchCells.filter((c) => cover.get(cellIds(c)) === normalizeName(c.name)).length
  const lunchAnyBlock = lunchCells.filter((c) => {
    const [g, dd] = cellIds(c).split('|')
    return [...cover.entries()].some(([k, n]) => k.startsWith(`${g}|${dd}|`) && n === normalizeName(c.name))
  }).length
  const lunchExpectedGroups = new Set(m.lunchWaves.flatMap((w) => w.groups))

  const spanDb = m.spans.map((sp) => {
    const row = activities.find((a) => normalizeName(a.name) === normalizeName(sp.name))
    return {
      name: sp.name, expected: sp.blocks, form: sp.form, dbSpanBlocks: row?.span_blocks ?? null, activityRow: !!row,
      pinnedAsEvent: row?.catalog_role === 'pinned_event', minPerWeek: row?.min_per_week ?? null, maxPerWeek: row?.max_per_week ?? null,
      sessionsPerGroupWeekPrinted: sp.days.length,
    }
  })

  const elSets = d.prepare('SELECT * FROM elective_sets WHERE camp_id = ?').all(id)
  const expectedSetNames = [...new Set(m.electives.map((e) => normalizeName(e.name)))]
  const setsCreated = expectedSetNames.filter((n) => elSets.some((s) => normalizeName(s.name) === n))
  const eligibilityCaptured = elSets.filter((s) => s.day_id || s.time_block_id || s.is_all_groups || (s.group_ids && s.group_ids !== '[]')).length

  const spurious = regular.map((a) => a.name).filter((n) => !expectedActs.has(normalizeName(n)) && !eventNames.has(normalizeName(n)))
  const missingActs = [...expectedActs.entries()].filter(([k]) => !regularNames.has(k) && !typoVariants.has(k)).map(([, v]) => v)

  // What the importer actually wrote as events, scoped through the product's own resolvers (for repros).
  const dayLabel = new Map(input.days.map((x) => [x.id, x.label]))
  const blockName = new Map(input.timeBlocks.map((x) => [x.id, x.name]))
  const groupName = new Map(input.groups.map((x) => [x.id, x.name]))
  const eventRows = input.fixedEvents.map((fe) => {
    const gids = resolveFixedEventGroupIds(fe, input.groups)
    return {
      name: fe.name, kind: fe.kind, block: blockName.get(fe.time_block_id) ?? fe.time_block_id, span: fe.span_blocks ?? 1,
      days: fe.day_id ? [dayLabel.get(fe.day_id)] : 'every day',
      groups: gids.length === input.groups.length ? 'all' : gids.length > 6 ? `${gids.length} groups` : gids.map((g) => groupName.get(g)),
    }
  })
  const rolled = new Map()
  for (const r of eventRows) {
    const key = `${r.name}|${r.kind}|${r.block}|${r.span}|${JSON.stringify(r.groups)}`
    const prior = rolled.get(key)
    if (prior) prior.days = prior.days === 'every day' || r.days === 'every day' ? 'every day' : [...prior.days, ...r.days]
    else rolled.set(key, { ...r })
  }

  return {
    eventRows: [...rolled.values()].slice(0, 80),
    counts: {
      groups: d.prepare('SELECT COUNT(*) c FROM groups WHERE camp_id = ?').get(id).c,
      divisions: d.prepare('SELECT COUNT(*) c FROM tiers WHERE camp_id = ?').get(id).c,
      days: d.prepare('SELECT COUNT(*) c FROM days_of_operation WHERE camp_id = ?').get(id).c,
      timeBlocks: d.prepare('SELECT COUNT(*) c FROM time_blocks WHERE camp_id = ?').get(id).c,
      activities: regular.length,
      pinnedEventActivities: activities.length - regular.length,
      fixedEvents: feRows.filter((r) => r.kind === 'fixed').length,
      recurringEvents: feRows.filter((r) => r.kind === 'recurring').length,
      electiveSets: elSets.length,
      specialDays: d.prepare('SELECT COUNT(*) c FROM special_days WHERE camp_id = ?').get(id).c,
    },
    expected: { groups: m.groups.length, divisions: m.divisions.length, days: m.days.length, timeBlocks: m.blocks.length, activities: m.activities.length },
    questions: { total: imp.report.decisions.length, byKind: imp.report.decisions.reduce((acc, x) => { acc[x.kind] = (acc[x.kind] ?? 0) + 1; return acc }, {}) },
    exclusivity: exclusivity(d, id, imp),
    lunch: { expectedCells: lunchCells.length, strictOk: lunchOk, groupDayOk: lunchAnyBlock, expectedGroups: lunchExpectedGroups.size, missingGroups: [...new Set(lunchCells.filter((c) => cover.get(cellIds(c)) !== normalizeName(c.name)).map((c) => c.group))].slice(0, 12), ...fraction(lunchOk, lunchCells.length) },
    events: evTally,
    activitiesVsManifest: { spurious: spurious.slice(0, 15), spuriousCount: spurious.length, missing: missingActs.slice(0, 15), missingCount: missingActs.length },
    spansDb: spanDb,
    electiveSets: { expected: expectedSetNames.length, created: setsCreated.length, withEligibility: eligibilityCaptured },
    unresolvedTimeBlocks: m.blocks.filter((b) => !lk.block.has(blockKey(b.label))).map((b) => b.label),
  }
}

function slotContent(input, activitiesById, feById, setById, slot) {
  if (!slot) return { type: 'none', name: null }
  if (slot.type === 'fixed_event') return { type: 'fixed_event', name: normalizeName(feById.get(slot.fixedEventId)?.name ?? '') }
  if (slot.type === 'activity') return { type: 'activity', name: normalizeName(activitiesById.get(slot.activityId)?.name ?? '') }
  if (slot.type === 'elective') return { type: 'elective', name: normalizeName(setById.get(slot.electiveSetId)?.name ?? '') }
  return { type: slot.type, name: null }
}

// Owner: "imagine that a camp imports a schedule - all things have been filled in. it would be
// reasonable to assume that when we generate it should be again." Last year's file is a feasible
// schedule, so every rule inferred from it must admit it: per group per week, the file's session
// count (a printed span counts once per run) sits within [min_per_week, max_per_week], and a group
// the file shows doing the activity is eligible for it. Any violation is an inference bug.
function evaluateFaithful(m, d, id, imp) {
  const input = scheduleInput(d, id)
  const lk = lookups(d, id)
  const order = new Map(input.timeBlocks.map((b, i) => [b.id, i]))
  const kind = new Map()
  for (const e of m?.events ?? []) kind.set(normalizeName(e.name), e.kind)
  for (const e of m?.electives ?? []) kind.set(normalizeName(e.name), 'elective')
  const cells = new Map() // activity|group -> Map(day -> [block index])
  for (const p of imp.placements) {
    const k = `${normalizeName(p.activityName)}|${normalizeName(p.groupName)}`
    if (!cells.has(k)) cells.set(k, new Map())
    const byDay = cells.get(k)
    const day = normalizeName(p.dayName)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(order.get(lk.block.get(blockKey(p.blockLabel))) ?? -1)
  }
  const sessions = (k, span) => {
    let n = 0
    for (const idx of cells.get(k)?.values() ?? []) {
      if (span <= 1) { n += idx.length; continue }
      const sorted = [...idx].sort((a, b) => a - b)
      for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] !== sorted[i - 1] + 1) n++
    }
    return n
  }
  const violations = []
  let checked = 0
  let fileSessions = 0
  for (const act of input.activities) {
    // Every catalogue activity, a min-0 one included: eligibility and max still have to admit the file.
    if (act.catalog_role === 'pinned_event') continue
    for (const g of input.groups) {
      const n = sessions(`${normalizeName(act.name)}|${normalizeName(g.name)}`, act.span_blocks ?? 1)
      const eligible = isActivityEligibleForGroup(act, g)
      checked++
      fileSessions += n
      const why = n > 0 && !eligible ? 'ineligible' : eligible && n < (act.min_per_week ?? 0) ? 'belowMin' : act.max_per_week != null && n > act.max_per_week ? 'aboveMax' : null
      if (why) violations.push({ why, activity: act.name, group: g.name, file: n, min: act.min_per_week, max: act.max_per_week ?? null, eventKind: kind.get(normalizeName(act.name)) ?? null })
    }
  }
  // The week must also hold every minimum at once: per group, the cells the file gives activities
  // must cover the sum of the minimums (span blocks included).
  const actByName = new Map(input.activities.filter((a) => a.catalog_role !== 'pinned_event').map((a) => [normalizeName(a.name), a]))
  for (const g of input.groups) {
    const cellsUsed = new Set(imp.placements.filter((p) => normalizeName(p.groupName) === normalizeName(g.name) && actByName.has(normalizeName(p.activityName))).map((p) => `${normalizeName(p.dayName)}|${blockKey(p.blockLabel)}`))
    const need = input.activities.filter((a) => a.catalog_role !== 'pinned_event' && a.min_per_week && isActivityEligibleForGroup(a, g)).reduce((n, a) => n + a.min_per_week * (a.span_blocks ?? 1), 0)
    if (need > cellsUsed.size) violations.push({ why: 'overCapacity', group: g.name, file: cellsUsed.size, min: need })
  }
  const byWhy = {}
  for (const v of violations) byWhy[v.why] = (byWhy[v.why] ?? 0) + 1
  return { checked, fileSessions, count: violations.length, byWhy, first: violations.slice(0, 20) }
}

function evaluateGenerate(m, d, id, imp = null) {
  const input = scheduleInput(d, id)
  const lk = lookups(d, id)
  const t0 = process.cpuUsage()
  const gen = safe(() => buildSchedule(input))
  const cpu = process.cpuUsage(t0)
  if (!gen.ok) return { error: gen.error }
  const { slots, findings } = gen.value
  const activitiesById = new Map(input.activities.map((a) => [a.id, a]))
  const feById = new Map(input.fixedEvents.map((f) => [f.id, f]))
  const setById = new Map((input.electiveSets ?? []).map((s) => [s.id, s]))
  const at = new Map(slots.map((s) => [`${s.groupId}|${s.dayId}|${s.blockId}`, s]))
  const idsOf = (c, block) => `${lk.group.get(normalizeName(c.group))}|${lk.day.get(normalizeName(c.day))}|${lk.block.get(blockKey(block))}`

  const eventCells = expectedEventCells(m)
  const evTally = tally(eventCells, (c) => {
    const got = slotContent(input, activitiesById, feById, setById, at.get(idsOf(c, c.block)))
    return got.type === 'fixed_event' && got.name === normalizeName(c.name)
  }, (c) => {
    const got = slotContent(input, activitiesById, feById, setById, at.get(idsOf(c, c.block)))
    return `${c.name} | ${c.group} | ${c.day} | ${c.block} -> ${got.type}:${got.name ?? ''}`
  })

  const order = new Map(input.timeBlocks.map((b, i) => [b.id, i]))
  const spanRuns = m.spans.map((sp) => {
    const act = input.activities.find((a) => normalizeName(a.name) === normalizeName(sp.name))
    if (!act) return { name: sp.name, expected: sp.blocks, placedBy: 0, runs: {} }
    const by = new Map()
    for (const s of slots) {
      if (s.type !== 'activity' || s.activityId !== act.id) continue
      const k = `${s.groupId}|${s.dayId}`
      if (!by.has(k)) by.set(k, [])
      by.get(k).push(order.get(s.blockId))
    }
    const runs = {}
    for (const arr of by.values()) {
      arr.sort((a, b) => a - b)
      let len = 1
      for (let i = 1; i <= arr.length; i++) {
        if (i < arr.length && arr[i] === arr[i - 1] + 1) len++
        else { runs[len] = (runs[len] ?? 0) + 1; len = 1 }
      }
    }
    return { name: sp.name, expected: sp.blocks, activitySpanBlocks: act.span_blocks ?? null, placedGroupDays: by.size, runs }
  })

  // A trip or all-day name the importer made a catalog ACTIVITY (not an event): where did Generate put it?
  const displacedNames = [...new Set(eventCells.filter((c) => c.kind === 'trip' || c.kind === 'allday').map((c) => c.name))]
  const displacedAsActivity = displacedNames.flatMap((name) => {
    const act = input.activities.find((a) => normalizeName(a.name) === normalizeName(name) && a.catalog_role !== 'pinned_event')
    if (!act) return []
    const expectedKeys = new Set(eventCells.filter((c) => c.name === name).map((c) => idsOf(c, c.block)))
    const placed = slots.filter((x) => x.type === 'activity' && x.activityId === act.id)
    return [{ name, expectedCells: expectedKeys.size, placedTotal: placed.length, placedAtExpectedCells: placed.filter((x) => expectedKeys.has(`${x.groupId}|${x.dayId}|${x.blockId}`)).length }]
  })

  const elCells = expectedElectiveCells(m)
  const elGot = {}
  for (const c of elCells) {
    const got = slotContent(input, activitiesById, feById, setById, at.get(idsOf(c, c.block)))
    elGot[got.type] = (elGot[got.type] ?? 0) + 1
  }

  const activitySlots = slots.filter((s) => s.type === 'activity')
  const overlap = safe(() => computeOverlaps({
    slots: slots.map((s) => ({ group_id: s.groupId, day_id: s.dayId, time_block_id: s.blockId, activity_id: s.activityId, fixed_event_id: s.fixedEventId ?? null, is_fixed_event: s.type === 'fixed_event', flags: s.flags ?? {} })),
    activities: input.activities, locations: input.locations, electiveSetActivities: input.electiveSetActivities, timeBlocks: input.timeBlocks,
  }))
  const underserved = findings.filter((f) => f.kind === 'UNDERSERVED')
  // Why each shortfall exists (owner: "why aren't we generating more activities to fill slots?").
  // fileWeekly: the distinct days the FILE shows this activity for this group (a printed span counts
  // once). eventKind: what the manifest says the name really is (trip / allday / elective), if any.
  const groupNameById = new Map(input.groups.map((g) => [g.id, g.name]))
  const fileDays = new Map()
  for (const p of imp?.placements ?? []) {
    const k = `${normalizeName(p.activityName)}|${normalizeName(p.groupName)}`
    if (!fileDays.has(k)) fileDays.set(k, new Set())
    fileDays.get(k).add(normalizeName(p.dayName))
  }
  const manifestKind = new Map()
  for (const e of m.events ?? []) manifestKind.set(normalizeName(e.name), e.kind)
  for (const e of m.electives ?? []) manifestKind.set(normalizeName(e.name), 'elective')
  const activityCellsPerGroup = (() => {
    const free = new Map()
    for (const sl of slots) if (sl.type === 'activity') free.set(sl.groupId, (free.get(sl.groupId) ?? 0) + 1)
    return free
  })()
  const sumMinsPerGroup = new Map()
  for (const a of input.activities) {
    if (!a.min_per_week || a.catalog_role === 'pinned_event') continue
    for (const g of input.groups) sumMinsPerGroup.set(g.id, (sumMinsPerGroup.get(g.id) ?? 0) + a.min_per_week * (a.span_blocks ?? 1))
  }
  const underservedDetail = underserved.map((f) => {
    const act = activitiesById.get(f.activityId)
    const name = act?.name ?? f.activityId
    const group = groupNameById.get(f.groupId) ?? f.groupId
    return {
      activity: name, group, needed: f.needed, got: f.got,
      min_per_week: act?.min_per_week ?? null, span_blocks: act?.span_blocks ?? null,
      fileWeekly: fileDays.get(`${normalizeName(name)}|${normalizeName(group)}`)?.size ?? 0,
      eventKind: manifestKind.get(normalizeName(name)) ?? null,
      groupActivityCells: activityCellsPerGroup.get(f.groupId) ?? 0,
      groupSumOfMins: sumMinsPerGroup.get(f.groupId) ?? 0,
    }
  })
  return {
    underservedDetail,
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    slots: slots.length,
    placed: activitySlots.filter((s) => s.activityId).length,
    unfillable: activitySlots.filter((s) => s.flags?.UNFILLABLE).length,
    unfillableCells: activitySlots.filter((s) => s.flags?.UNFILLABLE).slice(0, 12).map((s) => `${groupNameById.get(s.groupId)} | ${input.days.find((x) => x.id === s.dayId)?.label} | ${input.timeBlocks.find((x) => x.id === s.blockId)?.name}: ${s.flags?.UNFILLABLE_reason ?? ''}`),
    stillNeeded: underserved.reduce((sum, f) => sum + Math.max(0, (f.needed ?? 0) - (f.got ?? 0)), 0),
    underservedPairs: underserved.length,
    overlap: overlap.ok ? overlap.value.size : `error: ${overlap.error}`,
    errorFindings: findings.filter((f) => f.severity === 'error').map((f) => `${f.kind}: ${f.reason}`.slice(0, 160)).slice(0, 8),
    errorFindingCount: findings.filter((f) => f.severity === 'error').length,
    eventCells: evTally,
    spanRuns,
    displacedAsActivity,
    electiveCells: { expected: elCells.length, got: elGot },
  }
}

async function evaluateManual(m, d, id, imp) {
  const writeClient = {
    async write({ entity, entity_id, field, value, author_user_id }) {
      return { status: 'applied', op: appendOp(d, { entity, entity_id, field, value, author_user_id, device_id: deviceId }) }
    },
  }
  const out = await materializeImportedVersion(d, writeClient, { campId: id, authorUserId: userId, placements: imp.placements, sourceFileName: m.file })
  const snap = d.prepare("SELECT s.slots FROM schedule_snapshots s JOIN schedule_templates t ON t.id = s.template_id WHERE t.kind = 'manual' AND t.camp_id = ? ORDER BY s.created_at DESC LIMIT 1").get(id)
  const slots = snap ? JSON.parse(snap.slots) : []
  const input = scheduleInput(d, id)
  const lk = lookups(d, id)
  const activitiesById = new Map(input.activities.map((a) => [a.id, a]))
  const feById = new Map(input.fixedEvents.map((f) => [f.id, f]))
  const at = new Map(slots.map((s) => [`${s.group_id}|${s.day_id}|${s.time_block_id}`, s]))
  const content = (c, block) => {
    const s = at.get(`${lk.group.get(normalizeName(c.group))}|${lk.day.get(normalizeName(c.day))}|${lk.block.get(blockKey(block))}`)
    if (!s) return { type: 'none', name: null }
    if (s.is_fixed_event) return { type: 'fixed_event', name: normalizeName(feById.get(s.fixed_event_id)?.name ?? '') }
    return { type: 'activity', name: normalizeName(activitiesById.get(s.activity_id)?.name ?? '') }
  }
  const evTally = tally(expectedEventCells(m), (c) => {
    const got = content(c, c.block)
    return got.type === 'fixed_event' && got.name === normalizeName(c.name)
  }, (c) => {
    const got = content(c, c.block)
    return `${c.name} | ${c.group} | ${c.day} | ${c.block} -> ${got.type}:${got.name ?? ''}`
  })
  const spans = m.spans.map((sp) => {
    let okCells = 0
    let total = 0
    for (const g of sp.groups) for (const day of sp.days) for (const block of sp.rows) {
      total++
      if (content({ group: g, day }, block).name === normalizeName(sp.name)) okCells++
    }
    return { name: sp.name, form: sp.form, blocks: sp.blocks, ...fraction(okCells, total) }
  })
  const elGot = {}
  for (const c of expectedElectiveCells(m)) {
    const got = content(c, c.block)
    const label = got.type === 'none' ? 'none' : `${got.type}:${got.name}`
    elGot[label] = (elGot[label] ?? 0) + 1
  }
  return {
    created: out.created, unresolvedCount: out.unresolvedCount, unresolvedNames: [...new Set(out.unresolvedNames)].slice(0, 12),
    placements: imp.placements.length, snapshotSlots: slots.length,
    eventCells: evTally, spans, electiveCells: elGot,
  }
}

async function evaluateSpecialDayFiles(m, d, id) {
  const out = []
  for (const f of MANIFEST.specialDayFiles.filter((x) => x.slug === m.slug)) {
    const parsed = parseTextGrid(fs.readFileSync(path.join(DIR, f.file), 'utf8'))
    const proposal = proposeSpecialDay(parsed.pages)
    const rec = { file: f.file, name: f.name, pages: parsed.pages.length, recognised: !!proposal }
    if (proposal) {
      const live = {
        groups: d.prepare('SELECT * FROM groups WHERE camp_id = ?').all(id),
        activities: d.prepare('SELECT * FROM activities WHERE camp_id = ?').all(id),
        specialDays: d.prepare('SELECT * FROM special_days WHERE camp_id = ?').all(id),
      }
      const plan = buildSpecialDayPlan(proposal, live)
      rec.ready = !!plan?.ready
      rec.blockedBy = plan?.blockedBy ?? []
      rec.periods = plan?.periods?.length ?? null
      if (plan?.ready) {
        const res = await safe2(async () => commitIngest(d, { camp_id: id, approved: {}, links: {}, specialDay: plan, author_user_id: userId, device_id: deviceId, mode: 'add' }).specialDay)
        rec.commit = res
      }
    }
    rec.specialDaysAfter = d.prepare('SELECT COUNT(*) c FROM special_days WHERE camp_id = ?').get(id).c
    rec.placementsAfter = d.prepare('SELECT COUNT(*) c FROM special_day_placements').get().c
    out.push(rec)
  }
  return out
}

async function safe2(fn) {
  try { return { ok: true, ...(await fn()) } } catch (err) { return { ok: false, error: String(err?.message ?? err).slice(0, 300) } }
}

async function runCamp(m) {
  const rec = { slug: m.slug, layout: m.layout, traits: m.traits, stages: {} }
  const text = fs.readFileSync(path.join(DIR, m.file), 'utf8')

  const zero = seedCamp(`${m.slug}:zero`)
  const t0 = process.cpuUsage()
  const z = safe(() => importFile(zero.d, zero.id, text))
  rec.stages.zeroAnswers = z.ok ? { ok: true, cpuMs: Math.round((process.cpuUsage(t0).user + process.cpuUsage(t0).system) / 1000), held: z.value.committed.held } : { ok: false, error: z.error }
  if (z.ok) {
    rec.zeroAnswers = evaluateImport(m, zero.d, zero.id, z.value)
    rec.faithful = evaluateFaithful(m, zero.d, zero.id, z.value)
    rec.generate = evaluateGenerate(m, zero.d, zero.id, z.value)
    rec.manual = await evaluateManual(m, zero.d, zero.id, z.value).catch((e) => ({ error: String(e?.message ?? e).slice(0, 300) }))
    rec.specialDayFiles = await evaluateSpecialDayFiles(m, zero.d, zero.id).catch((e) => [{ error: String(e?.message ?? e).slice(0, 300) }])

    const before = tableCounts(zero.d)
    const keep = safe(() => importFile(zero.d, zero.id, text, { mode: 'add' }))
    const after = tableCounts(zero.d)
    rec.reimportKeep = keep.ok
      ? { ok: true, newRecords: Object.fromEntries(Object.keys(before).map((k) => [k, after[k] - before[k]]).filter(([, n]) => n !== 0)) }
      : { ok: false, error: keep.error }
    const c0 = process.cpuUsage()
    const repl = safe(() => importFile(zero.d, zero.id, text, { mode: 'replace' }))
    const cpu = process.cpuUsage(c0)
    rec.reimportReplace = { ok: repl.ok, cpuMs: Math.round((cpu.user + cpu.system) / 1000), ...(repl.ok ? { held: repl.value.committed.held, counts: tableCounts(zero.d) } : { error: repl.error }) }
  }
  zero.d.close()

  const all = seedCamp(`${m.slug}:all`)
  const a = safe(() => importFile(all.d, all.id, text, { answerFor: CONFIRM_ALL }))
  rec.stages.confirmAll = a.ok ? { ok: true, held: a.value.committed.held } : { ok: false, error: a.error }
  if (a.ok) {
    rec.confirmAll = evaluateImport(m, all.d, all.id, a.value)
    rec.confirmAllFaithful = evaluateFaithful(m, all.d, all.id, a.value)
    rec.confirmAllGenerate = evaluateGenerate(m, all.d, all.id, a.value)
    rec.confirmAllManual = await evaluateManual(m, all.d, all.id, a.value).catch((e) => ({ error: String(e?.message ?? e).slice(0, 300) }))
  }
  all.d.close()
  return rec
}

// SYNTHETIC_REPRO=<path to a grid .txt> prints what the importer wrote for any single file (used by the scorecard repros):
//   SYNTHETIC_REPRO=docs/work/specs/samples/synthetic/repro/r1.txt npx vitest run electron/syntheticCamps.harness.integration.test.js
describe.skipIf(!process.env.SYNTHETIC_REPRO)('repro', () => {
  it('prints the import result for one file', () => {
    const { d, id } = seedCamp()
    const imp = importFile(d, id, fs.readFileSync(path.resolve(process.env.SYNTHETIC_REPRO), 'utf8'))
    const input = scheduleInput(d, id)
    const dayLabel = new Map(input.days.map((x) => [x.id, x.label]))
    const blockName = new Map(input.timeBlocks.map((x) => [x.id, x.name]))
    const groupName = new Map(input.groups.map((x) => [x.id, x.name]))
    const events = input.fixedEvents.map((fe) => `${fe.name} | ${blockName.get(fe.time_block_id)} | ${dayLabel.get(fe.day_id)} | ${resolveFixedEventGroupIds(fe, input.groups).map((g) => groupName.get(g)).join(',')}`)
    const acts = d.prepare('SELECT name, catalog_role, span_blocks, min_per_week FROM activities WHERE camp_id = ?').all(id)
    // Generate summary (F5 evidence): placed/unfillable cells, and each span activity's run lengths.
    const { slots } = buildSchedule(input)
    const act = slots.filter((s) => s.type === 'activity')
    const order = new Map(input.timeBlocks.map((b, i) => [b.id, i]))
    const spanRuns = input.activities.filter((a) => (a.span_blocks ?? 1) > 1).map((a) => {
      const by = new Map()
      for (const s of act) if (s.activityId === a.id) by.set(`${s.groupId}|${s.dayId}`, [...(by.get(`${s.groupId}|${s.dayId}`) ?? []), order.get(s.blockId)])
      const runs = {}
      for (const arr of by.values()) {
        arr.sort((x, y) => x - y)
        let len = 1
        for (let i = 1; i <= arr.length; i++) {
          if (i < arr.length && arr[i] === arr[i - 1] + 1) len++
          else { runs[len] = (runs[len] ?? 0) + 1; len = 1 }
        }
      }
      return { name: a.name, span_blocks: a.span_blocks, min_per_week: a.min_per_week, runs }
    })
    const generate = { placed: act.filter((s) => s.activityId).length, unfillable: act.filter((s) => s.flags?.UNFILLABLE).length, spanRuns }
    console.log('REPRO ' + JSON.stringify({ blocks: [...blockName.values()], events, activities: acts, questions: imp.report.decisions.map((x) => `${x.kind}:${x.entity}:${x.entityName}`), generate }, null, 1))
    d.close()
  })
})

// A normal test run (CI, the gate, a developer's vitest) must not rewrite tracked evidence.
const fillsAgain = (g) => ({ stillNeeded: g?.stillNeeded ?? null, unfillable: g?.unfillable ?? null, ...(g?.error ? { error: g.error } : {}) })

// The owner's real camp file and the variants built from it (docs/work/specs/samples/synthetic/campb-variants.mjs):
// filled weeks, so the fill-again invariants apply to them exactly as to the synthetic corpus.
const VARIANT_DIR = path.join(DIR, 'campb-variants')
const REAL_SAMPLES = [
  { slug: 'campB', file: path.join(process.cwd(), 'docs/work/specs/samples/campB-by-day.txt') },
  ...fs.readdirSync(VARIANT_DIR).filter((f) => f.endsWith('.txt')).sort().map((f) => ({ slug: f.replace(/\.txt$/, ''), file: path.join(VARIANT_DIR, f) })),
]
const realResults = {}

describe('the owner\'s camp and its variants fill again', () => {
  it('has campB and seven variants', () => { expect(REAL_SAMPLES).toHaveLength(8) })

  describe.each(REAL_SAMPLES.filter((c) => !process.env.SYNTHETIC_ONLY || c.slug.startsWith(process.env.SYNTHETIC_ONLY)))('$slug', ({ slug, file }) => {
    const rec = {}
    const m = { slug, events: [], electives: [], spans: [] }
    beforeAll(() => {
      const text = fs.readFileSync(file, 'utf8')
      for (const [key, answerFor] of [['zero', undefined], ['all', CONFIRM_ALL]]) {
        const { d, id } = seedCamp(`${slug}:${key}`)
        const imp = importFile(d, id, text, answerFor ? { answerFor } : {})
        rec[key] = { faithful: evaluateFaithful(m, d, id, imp), generate: evaluateGenerate(m, d, id, imp) }
        d.close()
      }
      realResults[slug] = rec
    }, 900_000)
    const hard = (name, check) => (KNOWN_FAILING.has(`${slug}:${name}`) ? it.fails : it)(name, () => check(rec))
    hard(FAITHFUL_ZERO, (r) => { expect(r.zero.faithful.first).toEqual([]) })
    hard(FAITHFUL_ALL, (r) => { expect(r.all.faithful.first).toEqual([]) })
    hard(FILLS_ZERO, (r) => { expect(fillsAgain(r.zero.generate)).toEqual({ stillNeeded: 0, unfillable: 0 }) })
    hard(FILLS_ALL, (r) => { expect(fillsAgain(r.all.generate)).toEqual({ stillNeeded: 0, unfillable: 0 }) })
  })

  // Non-vacuity: the faithfulness check must see a rule the file breaks. Raise one activity's minimum
  // above what any group got and it reports belowMin; leave it and it reports nothing.
  it('the faithfulness check reports a rule the file breaks', () => {
    const { d, id } = seedCamp('campB:plant')
    const imp = importFile(d, id, fs.readFileSync(REAL_SAMPLES[0].file, 'utf8'))
    const m = { events: [], electives: [], spans: [] }
    expect(evaluateFaithful(m, d, id, imp).first).toEqual([])
    d.prepare("UPDATE activities SET min_per_week = 9, max_per_week = 9 WHERE camp_id = ? AND name = 'Music'").run(id)
    expect(evaluateFaithful(m, d, id, imp).byWhy.belowMin).toBeGreaterThan(0)
    // A max below what a group got, and an eligibility that leaves out a group the file shows.
    d.prepare("UPDATE activities SET min_per_week = 1, max_per_week = 1 WHERE camp_id = ? AND name = 'Music'").run(id)
    expect(evaluateFaithful(m, d, id, imp).byWhy.aboveMax).toBeGreaterThan(0)
    const oneGroup = d.prepare('SELECT id FROM groups WHERE camp_id = ? LIMIT 1').get(id).id
    d.prepare("UPDATE activities SET max_per_week = 9, eligible_group_ids = ? WHERE camp_id = ? AND name = 'Music'").run(JSON.stringify([oneGroup]), id)
    expect(evaluateFaithful(m, d, id, imp).byWhy.ineligible).toBeGreaterThan(0)
    d.close()
  })
})

describe('scorecard write gate', () => {
  // Standing guard for the deterministic seeds: the same camp run twice gives the same metrics
  // (timings excluded). Random camp or cohort ids made identical runs differ before.
  it('one camp run twice gives identical metrics', async () => {
    const m = MANIFEST.camps.find((c) => c.slug.startsWith('s05'))
    const strip = (r) => JSON.parse(JSON.stringify(r, (k, v) => (/cpuMs|runtimeMs/.test(k) ? undefined : v)))
    const first = strip(await runCamp(m))
    const second = strip(await runCamp(m))
    expect(second).toEqual(first)
  }, 120000)

  it('writes nowhere unless asked: SHORESH_WRITE_SCORECARD=1 or an explicit SYNTHETIC_SCORECARD_PATH', () => {
    expect(scorecardWriteTarget({})).toBeNull()
    expect(scorecardWriteTarget({ SHORESH_WRITE_SCORECARD: '0' })).toBeNull()
    expect(scorecardWriteTarget({ SHORESH_WRITE_SCORECARD: '1' })).toBe(DEFAULT_SCORECARD_PATH)
    expect(scorecardWriteTarget({ SYNTHETIC_SCORECARD_PATH: '/tmp/x.json' })).toBe('/tmp/x.json')
  })
})

describe('synthetic corpus: 15 fictional camps through the real pipeline', () => {
  it('has 15 camps', () => {
    expect(MANIFEST.camps).toHaveLength(15)
  })

  afterAll(() => {
    cleanupTemplatedDbs()
    if (!SCORECARD_PATH) return
    const real = Object.fromEntries(Object.entries(realResults).map(([slug, r]) => [slug, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, {
      faithful: { checked: v.faithful.checked, violations: v.faithful.byWhy, first: v.faithful.first.slice(0, 8) },
      generate: { stillNeeded: v.generate.stillNeeded, unfillable: v.generate.unfillable, short: v.generate.underservedDetail?.map((u) => `${u.activity} / ${u.group}`) ?? [] },
    }]))]))
    const scorecard = { generatedAt: new Date().toISOString(), runtimeMs: Date.now() - startedAt, node: process.version, camps: results, ownerCampAndVariants: real }
    fs.mkdirSync(path.dirname(SCORECARD_PATH), { recursive: true })
    fs.writeFileSync(SCORECARD_PATH, JSON.stringify(scorecard, null, 2) + '\n')
  })

  describe.each(MANIFEST.camps.filter((c) => !process.env.SYNTHETIC_ONLY || c.slug.startsWith(process.env.SYNTHETIC_ONLY)))('$slug ($layout)', (m) => {
    let rec
    beforeAll(async () => {
      const t = Date.now()
      rec = await runCamp(m)
      rec.runtimeMs = Date.now() - t
      results[m.slug] = rec
    }, 900_000)

    // Each hard invariant runs under it.fails when KNOWN_FAILING lists it, so a fixed bug turns the entry red.
    const hard = (name, check) => {
      const t = KNOWN_FAILING.has(`${m.slug}:${name}`) ? it.fails : it
      t(name, () => check(rec))
    }

    hard('import with zero answers completes', (r) => { expect(r.stages.zeroAnswers).toMatchObject({ ok: true }) })
    hard('import confirming every card completes', (r) => { expect(r.stages.confirmAll).toMatchObject({ ok: true }) })
    hard('zero answers: claimed event names raise no decision, no open item, no activity, sit in one bucket, and leave no orphan pinned_event marker', (r) => {
      expect(r.zeroAnswers?.exclusivity ?? {}).toMatchObject({ decisions: [], openItems: [], candidates: [], inTwoBuckets: [], orphanMarkers: [] })
    })
    hard('confirm all: claimed event names raise no decision, no open item, no activity, sit in one bucket, and leave no orphan pinned_event marker', (r) => {
      expect(r.confirmAll?.exclusivity ?? {}).toMatchObject({ decisions: [], openItems: [], candidates: [], inTwoBuckets: [], orphanMarkers: [] })
    })
    hard(MEAL_ZERO, (r) => {
      expect(r.zeroAnswers?.lunch).toMatchObject({ strictOk: r.zeroAnswers?.lunch?.expectedCells })
    })
    hard(MEAL_ALL, (r) => {
      expect(r.confirmAll?.lunch).toMatchObject({ strictOk: r.confirmAll?.lunch?.expectedCells })
    })
    hard('Generate completes with no error findings (zero answers)', (r) => {
      expect(r.generate).toBeDefined()
      expect(r.generate.error).toBeUndefined()
      expect(r.generate.errorFindings).toEqual([])
    })
    hard('Generate completes with no error findings (confirm all)', (r) => {
      expect(r.confirmAllGenerate).toBeDefined()
      expect(r.confirmAllGenerate.error).toBeUndefined()
      expect(r.confirmAllGenerate.errorFindings).toEqual([])
    })
    hard(FAITHFUL_ZERO, (r) => { expect(r.faithful?.first).toEqual([]) })
    hard(FAITHFUL_ALL, (r) => { expect(r.confirmAllFaithful?.first).toEqual([]) })
    hard(FILLS_ZERO, (r) => { expect(fillsAgain(r.generate)).toEqual({ stillNeeded: 0, unfillable: 0 }) })
    hard(FILLS_ALL, (r) => { expect(fillsAgain(r.confirmAllGenerate)).toEqual({ stillNeeded: 0, unfillable: 0 }) })
    hard('re-import with Keep writes zero new records', (r) => {
      expect(r.reimportKeep).toEqual({ ok: true, newRecords: {} })
    })
    hard('re-import with Replace completes', (r) => {
      expect(r.reimportReplace?.ok).toBe(true)
    })
  })

  // The orphanMarkers invariant is only meaningful if markers exist to be checked.
  it('the corpus produces pinned_event markers, so the orphan check is not vacuous', () => {
    const total = Object.values(results).reduce((n, r) => n + (r.zeroAnswers?.exclusivity?.pinnedMarkers ?? 0), 0)
    expect(total).toBeGreaterThan(0)
  })
})
