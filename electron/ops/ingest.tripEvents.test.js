// @vitest-environment node
//
// F3/F4 slice 2 (docs/adr/2026-10-11-import-special-days-and-field-trips.md): detected trips and subset
// days become WEEK-BOUND recurring events. Real pipeline: parseTextGrid -> extractEntities -> detector ->
// planTripEvents / applyTripClaims (src/ingest/tripEvents.js, the same functions ImportScreen calls) ->
// inferFixedEvents / inferActivityRules -> commitIngest (dry run, report, confirm-all fold, commit) ->
// real SQLite -> buildSchedule (Generate). Assertions are per ROW, read back from fixed_events.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { commitIngest, ingestUndo } from './ingest.js'
import { matchImportAnswers, rememberImportAnswers } from './answerMemory.js'
import { normalizeScheduleInputs, SCHEDULE_INPUT_ENTITIES } from './scheduleInputNormalization.js'
import { normalizeName } from '../../src/ingest/preview.js'
import { parseTextGrid, normalizeTimeLabel } from '../../src/ingest/textGrid.js'
import { extractEntities } from '../../src/ingest/extractEntities.js'
import { inferFixedEvents } from '../../src/ingest/fixedEvents.js'
import { derivePinOnlyActivityNames } from '../../src/ingest/pinOnlyActivityNames.js'
import { inferActivityRules } from '../../src/ingest/activityRules.js'
import { inferTextSpans } from '../../src/ingest/textSpans.js'
import { detectTripsAndSpecialDays } from '../../src/ingest/tripDetection.js'
import { planTripEvents, applyTripClaims, dropMultiBlockForTrips, tripItemKey } from '../../src/ingest/tripEvents.js'
import { defaultWeekId, weeksForImport } from '../../src/ingest/defaultWeek.js'
import { materializeImportedVersion } from './materializeImportedVersion.js'
import { appendOp } from './operations.js'
import { buildReconciliationReport } from '../../src/ingest/reconciliationReport.js'
import { buildBlastRadiusIndex } from '../../src/ingest/blastRadius.js'
import { foldTriageInputs, heldBackDecisions } from '../../src/screens/reconciliationTriage.js'
import { resolvePriorityForGeneration } from '../../src/ingest/resolvePriorityForGeneration.js'
import { resolveFixedEventGroupIds } from '../../src/engine/fixedEventScope.js'
import buildSchedule from '../../src/engine/buildSchedule.js'

afterAll(() => cleanupTemplatedDbs())
const SYN = path.join(process.cwd(), 'docs/work/specs/samples/synthetic')
const MANIFEST = JSON.parse(fs.readFileSync(path.join(SYN, 'manifest.json'), 'utf8'))
const CAMPB = path.join(process.cwd(), 'docs/work/specs/samples/campB-by-day.txt')
const deviceId = 'device-1'
const userId = 'u1'

let d, file, campId, week1, week2
beforeEach(() => {
  const t = openTemplatedDb()
  d = t.db
  file = t.file
  campId = randomUUID()
  d.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'a'.repeat(64))
  d.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  d.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run(userId, campId)
  week1 = randomUUID()
  week2 = randomUUID()
  d.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order) VALUES (?, ?, ?, ?)').run(week1, campId, 'Week 1', 0)
  d.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order) VALUES (?, ?, ?, ?)').run(week2, campId, 'Week 2', 1)
})
afterEach(() => {
  d.close()
  if (fs.existsSync(file)) fs.unlinkSync(file)
})

const CONFIRM_ALL = (dec) => {
  if (dec.kind === 'confirm_value') return { action: 'looks_right' }
  if (dec.kind === 'elective_candidate') return { choice: 'confirm' }
  return null
}

// The ImportScreen glue for one schedule file, trips included.
function importText(text, { weekId = week1, hasWeeks = true, tripAnswers = {}, mutate, captureInverse = false } = {}) {
  const parsed = parseTextGrid(text)
  mutate?.(parsed)
  const pages = { pages: parsed.pages }
  const proposal = extractEntities(parsed)
  const detections = detectTripsAndSpecialDays(pages, proposal)
  const trips = planTripEvents({ detections, answers: tripAnswers, weekId, hasWeeks, allGroupNames: proposal.entities.groups })
  const { fixedEvents: inferred, dualUseNames = [] } = inferFixedEvents(pages, proposal, {})
  const claimed = applyTripClaims({ parsed: pages, proposal, claims: trips.claims, fixedEvents: inferred, textSpans: inferTextSpans(pages, proposal).spans })
  const pinOnly = new Set([...derivePinOnlyActivityNames(claimed.fixedEvents, dualUseNames), ...claimed.fullyClaimedNames])
  const rules = inferActivityRules(
    proposal.entities.activities, claimed.activityPages, claimed.seenCounts,
    proposal.entities.days_of_operation.length, proposal.entities.groups, pinOnly, claimed.textSpans,
  )
  const activityRules = {}
  for (const name of proposal.entities.activities) {
    const r = rules.get(name)
    if (r) activityRules[name] = { eligible_group_names: r.eligible_group_names ?? null, min_per_week: r.min_per_week, max_per_week: r.max_per_week, priority: r.priority, ...(r.span_blocks ? { span_blocks: r.span_blocks } : {}) }
  }
  const base = {
    approved: {
      groups: proposal.entities.groups, days_of_operation: proposal.entities.days_of_operation,
      time_blocks: proposal.entities.time_blocks, activities: proposal.entities.activities,
    },
    links: {},
    fixedEvents: [...claimed.fixedEvents, ...trips.fixedEvents],
    activityRules,
    pinOnlyActivityNames: [...pinOnly],
    seenCounts: claimed.seenCounts ?? null,
  }
  const common = { camp_id: campId, cohort_id: null, author_user_id: userId, device_id: deviceId, mode: 'add' }
  const dry = commitIngest(d, { ...common, ...base, dryRun: true })
  const report = buildReconciliationReport({
    planItems: dry.planItems ?? [],
    fixedEventsReport: { ...dry.fixedEvents, created: dry.fixedEvents?.createdEntries ?? [], unchanged: dry.fixedEvents?.unchangedEntries ?? [] },
    legacyPriorityActivities: dry.legacyPriorityActivities,
    fieldProvenance: new Map(Object.entries(dry.fieldProvenance ?? {})),
    evidenceSupport: dry.evidenceSupport,
    blastRadiusIndex: buildBlastRadiusIndex(dry.planItems ?? []),
    unknownFieldEvidence: new Map(Object.entries(dry.unknownFieldEvidence ?? {})),
    electiveCandidates: dry.electiveCandidates,
    allCampOverrides: [],
    placements: [],
    allGroupNames: proposal.entities.groups ?? [],
  })
  const answers = Object.fromEntries(report.decisions.map((dec) => [dec.id, CONFIRM_ALL(dec)]).filter(([, a]) => a))
  const folded = foldTriageInputs(base, report.decisions, answers)
  const committed = commitIngest(d, { ...common, ...base, ...folded, openDecisions: heldBackDecisions(report.decisions, answers), captureInverse })
  return { parsed, proposal, detections, trips, claimed, committed }
}

const groupName = () => new Map(d.prepare('SELECT id, name FROM groups WHERE camp_id = ?').all(campId).map((g) => [g.id, g.name]))
const weekRows = () => d.prepare(`
  SELECT fe.*, dy.label AS day, tb.name AS block FROM fixed_events fe
  JOIN days_of_operation dy ON dy.id = fe.day_id JOIN time_blocks tb ON tb.id = fe.time_block_id
  WHERE fe.camp_id = ? AND fe.schedule_week_id IS NOT NULL ORDER BY dy.label, fe.name`).all(campId)
const rowShape = (r) => ({
  name: r.name, kind: r.kind, is_all_groups: r.is_all_groups,
  groups: r.is_all_groups ? 'all' : JSON.parse(r.group_ids).map((id) => groupName().get(id)).sort(),
  day: r.day, block: normalizeName(r.block), span_blocks: r.span_blocks ?? 1, week: r.schedule_week_id,
})
const expectedShape = (det, allGroups, weekId) => {
  const every = det.groupIds.length === allGroups.length
  return {
    name: det.name, kind: every ? 'fixed' : 'recurring', is_all_groups: every ? 1 : 0,
    groups: every ? 'all' : [...det.groupIds].sort(), day: det.day, block: normalizeName(det.blocks[0]),
    span_blocks: det.blocks.length, week: weekId,
  }
}

function scheduleInput(weekId) {
  const rowsByEntity = {}
  for (const entity of SCHEDULE_INPUT_ENTITIES) rowsByEntity[entity] = d.prepare(`SELECT * FROM ${entity}`).all()
  const { cohorts: _c, ...flat } = normalizeScheduleInputs(rowsByEntity, campId)
  return { ...flat, activities: resolvePriorityForGeneration(flat.activities), campId, replacedDayIds: [], weekId }
}

// Every (group, day, block) a week-bound event covers, through the product's own scope resolver.
function weekBoundCoverage(input) {
  const order = input.timeBlocks.map((b) => b.id)
  const idx = new Map(order.map((id, i) => [id, i]))
  const cover = new Map()
  for (const fe of input.fixedEvents.filter((x) => x.schedule_week_id)) {
    const start = idx.get(fe.time_block_id)
    for (const g of resolveFixedEventGroupIds(fe, input.groups)) {
      for (const b of order.slice(start, start + (fe.span_blocks || 1))) {
        const k = `${g}|${fe.day_id}|${b}`
        cover.set(k, [...(cover.get(k) ?? []), normalizeName(fe.name)])
      }
    }
  }
  return cover
}

const SLICE2_CAMPS = ['s04', 's05', 's09', 's12', 's13']

describe('slice 2: detected trips become week-bound recurring events (synthetic corpus, per row)', () => {
  for (const prefix of SLICE2_CAMPS) {
    const camp = MANIFEST.camps.find((c) => c.slug.startsWith(prefix))
    it(`${camp.slug}: one row per accepted trip with kind, scope, day, span and the open week`, () => {
      const imp = importText(fs.readFileSync(path.join(SYN, camp.file), 'utf8'))
      const accepted = imp.trips.items.filter((i) => i.accepted).map((i) => i.detection)
      expect(accepted.length).toBeGreaterThan(0)
      const all = imp.proposal.entities.groups
      const got = weekRows().map(rowShape)
      expect(got).toEqual(accepted.map((det) => expectedShape(det, all, week1))
        .sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name)))
      for (const r of weekRows()) expect(r.schedule_week_id).not.toBeNull()
    })

    it(`${camp.slug}: >= 95% of the manifest's trip cells covered, none by two week-bound events, no trip name on an all-weeks event`, () => {
      const imp = importText(fs.readFileSync(path.join(SYN, camp.file), 'utf8'))
      const input = scheduleInput(week1)
      const cover = weekBoundCoverage(input)
      const gid = new Map(input.groups.map((g) => [normalizeName(g.name), g.id]))
      const did = new Map(input.days.map((x) => [normalizeName(x.label), x.id]))
      const bid = new Map(input.timeBlocks.map((b) => [normalizeName(normalizeTimeLabel(b.name)), b.id]))
      // Whole-camp days are slice 3b; every other trip / all-day entry is this slice's.
      const expected = camp.events.filter((e) => (e.kind === 'trip' || e.kind === 'allday') && !(e.groups === 'all' || e.groups.length === camp.groups.length))
      const cells = expected.flatMap((e) => e.groups.flatMap((g) => e.days.flatMap((day) => e.blocks.map((b) => ({ name: e.name, k: `${gid.get(normalizeName(g))}|${did.get(normalizeName(day))}|${bid.get(normalizeName(normalizeTimeLabel(b)))}` })))))
      const hit = cells.filter((c) => (cover.get(c.k) ?? []).includes(normalizeName(c.name))).length
      expect(cells.length).toBeGreaterThan(0)
      expect(hit / cells.length).toBeGreaterThanOrEqual(0.95)
      expect([...cover.values()].filter((names) => names.length > 1)).toEqual([])
      const tripNames = new Set(imp.trips.fixedEvents.map((fe) => normalizeName(fe.name)))
      const allWeeksTrip = d.prepare('SELECT name FROM fixed_events WHERE camp_id = ? AND schedule_week_id IS NULL').all(campId)
        .filter((r) => tripNames.has(normalizeName(r.name)))
      expect(allWeeksTrip).toEqual([])
    })

    it(`${camp.slug}: Generate places no accepted trip name anywhere as an activity (min_per_week not inflated)`, () => {
      const imp = importText(fs.readFileSync(path.join(SYN, camp.file), 'utf8'))
      const input = scheduleInput(week1)
      const tripNames = new Set(imp.trips.fixedEvents.map((fe) => normalizeName(fe.name)))
      const regular = input.activities.filter((a) => tripNames.has(normalizeName(a.name)) && a.catalog_role !== 'pinned_event')
      expect(regular.map((a) => [a.name, a.min_per_week])).toEqual([])
      const { slots } = buildSchedule(input)
      const byId = new Map(input.activities.map((a) => [a.id, a]))
      const placedAsActivity = slots.filter((s) => s.type === 'activity' && tripNames.has(normalizeName(byId.get(s.activityId)?.name ?? '')))
      expect(placedAsActivity).toEqual([])
      // ...and in the open week Generate does put the trip on its own cells.
      const cover = weekBoundCoverage(input)
      const feSlots = new Set(slots.filter((s) => s.type === 'fixed_event').map((s) => `${s.groupId}|${s.dayId}|${s.blockId}`))
      const missing = [...cover.keys()].filter((k) => !feSlots.has(k))
      expect(missing).toEqual([])
    })
  }
})

describe('slice 2: mutated campB plant', () => {
  const plant = (parsed) => {
    const thu = parsed.pages.find((p) => p.title.startsWith('Thursday'))
    const cols = ['Badger 1', 'Badger 2', 'Badger 3'].map((g) => thu.columns.indexOf(g))
    const r1 = thu.rows.findIndex((r) => r.label.startsWith('12:55'))
    for (const c of cols) { thu.rows[r1].cells[c] = 'Zoo Trip'; thu.rows[r1 + 1].cells[c] = 'Zoo Trip' }
    thu.rows[r1 + 1].cells[cols[2]] = 'Music'
  }
  const snapshot = () => ({
    weekBound: weekRows().map(rowShape),
    allWeeks: d.prepare('SELECT fe.name, dy.label day, tb.name block, fe.kind, fe.is_all_groups, fe.group_ids, fe.span_blocks FROM fixed_events fe JOIN days_of_operation dy ON dy.id = fe.day_id JOIN time_blocks tb ON tb.id = fe.time_block_id WHERE fe.camp_id = ? AND fe.schedule_week_id IS NULL').all(campId)
      .map((r) => ({ ...r, group_ids: JSON.parse(r.group_ids ?? '[]').map((id) => groupName().get(id)).sort() }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  })

  it('adds exactly one week-bound trip event; every other fixed_events row is unchanged', () => {
    const text = fs.readFileSync(CAMPB, 'utf8')
    importText(text)
    const base = snapshot()
    d.close()
    const t = openTemplatedDb()
    d = t.db
    file = t.file
    d.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'a'.repeat(64))
    d.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
    d.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run(userId, campId)
    d.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order) VALUES (?, ?, ?, ?)').run(week1, campId, 'Week 1', 0)
    importText(text, { mutate: plant })
    const after = snapshot()
    const zoo = after.weekBound.filter((r) => r.name === 'Zoo Trip')
    expect(zoo).toEqual([{ name: 'Zoo Trip', kind: 'recurring', is_all_groups: 0, groups: ['Badger 1', 'Badger 2'], day: 'Thursday', block: zoo[0]?.block, span_blocks: 2, week: week1 }])
    expect(zoo[0].block.startsWith('12:55')).toBe(true)
    expect(after.weekBound.filter((r) => r.name !== 'Zoo Trip')).toEqual(base.weekBound)
    expect(after.allWeeks).toEqual(base.allWeeks)
  })
})

describe('slice 2: week rules', () => {
  const s13 = () => fs.readFileSync(path.join(SYN, MANIFEST.camps.find((c) => c.slug.startsWith('s13')).file), 'utf8')

  it('no week known: every item is pending and nothing is written week-bound or as a trip event', () => {
    const imp = importText(s13(), { weekId: null })
    expect(imp.trips.items.length).toBeGreaterThan(0)
    expect(imp.trips.items.every((i) => i.pending && !i.accepted)).toBe(true)
    expect(weekRows()).toEqual([])
  })

  it('a camp with no weeks is not offered trips', () => {
    const imp = importText(s13(), { weekId: null, hasWeeks: false })
    expect(imp.trips.items).toEqual([])
    expect(weekRows()).toEqual([])
  })

  it('a week id that is not this camp\'s is skipped, never written as NULL', () => {
    const imp = importText(s13(), { weekId: 'not-a-week' })
    expect(imp.committed.fixedEvents.skipped.filter((s) => s.reason === 'week not found').length).toBe(imp.trips.fixedEvents.length)
    const tripNames = new Set(imp.trips.fixedEvents.map((fe) => normalizeName(fe.name)))
    expect(d.prepare('SELECT name FROM fixed_events WHERE camp_id = ?').all(campId).filter((r) => tripNames.has(normalizeName(r.name)))).toEqual([])
  })

  it('a re-import into the same week writes nothing new; into another week writes that week\'s rows', () => {
    importText(s13())
    const first = weekRows().length
    const again = importText(s13())
    expect(weekRows().length).toBe(first)
    expect(again.committed.fixedEvents.created).toBe(0)
    importText(s13(), { weekId: week2 })
    expect(weekRows().filter((r) => r.schedule_week_id === week2).length).toBe(first)
  })
})

describe('slice 2: Undo import removes the week-bound trip events', () => {
  const s13 = () => fs.readFileSync(path.join(SYN, MANIFEST.camps.find((c) => c.slug.startsWith('s13')).file), 'utf8')

  it('undoing the import leaves no week-bound row behind', () => {
    const { committed } = importText(s13(), { captureInverse: true })
    expect(weekRows().length).toBeGreaterThan(0) // non-vacuity: the import did write week-bound trips
    const r = ingestUndo(d, {
      invertibleOps: committed.invertibleOps ?? [],
      createdEntityIds: committed.createdEntityIds ?? [],
      importRunId: committed.importRunId ?? committed.import_run_id ?? null,
      author_user_id: userId, device_id: deviceId, client_write_id: randomUUID(),
    })
    expect(r.ok).toBe(true)
    expect(weekRows()).toEqual([])
  })
})

describe('slice 2: decline is an ordinary activity and is remembered', () => {
  const s13 = () => fs.readFileSync(path.join(SYN, MANIFEST.camps.find((c) => c.slug.startsWith('s13')).file), 'utf8')

  it('declined trip -> no event, a regular activity; the answer is recalled on re-import', () => {
    const probe = detectTripsAndSpecialDays({ pages: parseTextGrid(s13()).pages }, extractEntities(parseTextGrid(s13())))
    const trip = probe.find((x) => x.name === 'Aquarium Trip')
    const key = tripItemKey(trip)
    importText(s13(), { tripAnswers: { [key]: 'activity' } })
    expect(weekRows().filter((r) => r.name === 'Aquarium Trip')).toEqual([])
    const act = d.prepare("SELECT * FROM activities WHERE camp_id = ? AND name = 'Aquarium Trip'").get(campId)
    expect(act.catalog_role ?? null).not.toBe('pinned_event')

    const other = { id: key, qkind: 'trip', name: trip.name, day: trip.day }
    const res = rememberImportAnswers(d, { campId, authorUserId: userId, deviceId, entries: [{ other, answer: { verdict: 'activity' } }] })
    expect(res.written.length).toBe(1)
    const recalled = matchImportAnswers(d, { campId, others: [other] })
    expect(recalled[key]?.answer).toEqual({ verdict: 'activity' })
    expect(recalled[key]?.autoApply).toBe(false)
  })
})

describe('slice 2: same-slot same-name trips for disjoint groups', () => {
  it('commit one row with the union of the groups', () => {
    const fe = (groups) => ({ name: 'Zoo Trip', time_block: '10:00-10:45', days: ['Monday'], kind: 'recurring', scope: { is_all_groups: false, groups }, confidence: 'high', span_blocks: 2, weekId: week1 })
    commitIngest(d, {
      camp_id: campId, cohort_id: null, author_user_id: userId, device_id: deviceId, mode: 'add',
      approved: { groups: ['Group 1', 'Group 2', 'Group 3', 'Group 4'], days_of_operation: ['Monday'], time_blocks: ['10:00-10:45', '11:00-11:45'], activities: [] },
      fixedEvents: [fe(['Group 1', 'Group 2']), fe(['Group 3'])],
    })
    expect(weekRows().map(rowShape)).toEqual([{ name: 'Zoo Trip', kind: 'recurring', is_all_groups: 0, groups: ['Group 1', 'Group 2', 'Group 3'], day: 'Monday', block: '10:00-10:45', span_blocks: 2, week: week1 }])
  })

  it('a week-bound trip is not swallowed by a same-slot all-weeks event of the same name', () => {
    const base = {
      camp_id: campId, cohort_id: null, author_user_id: userId, device_id: deviceId, mode: 'add',
      approved: { groups: ['Group 1', 'Group 2'], days_of_operation: ['Monday'], time_blocks: ['10:00-10:45'], activities: [] },
    }
    commitIngest(d, { ...base, fixedEvents: [{ name: 'Zoo Trip', time_block: '10:00-10:45', days: ['Monday'], scope: { is_all_groups: true, groups: null }, confidence: 'high' }] })
    commitIngest(d, { ...base, fixedEvents: [{ name: 'Zoo Trip', time_block: '10:00-10:45', days: ['Monday'], scope: { is_all_groups: false, groups: ['Group 1'] }, confidence: 'high', weekId: week1 }] })
    expect(weekRows().map(rowShape)).toEqual([{ name: 'Zoo Trip', kind: 'recurring', is_all_groups: 0, groups: ['Group 1'], day: 'Monday', block: '10:00-10:45', span_blocks: 1, week: week1 }])
  })
})

describe('slice 2: precedence over the multi-block "Just this once" question', () => {
  it('an accepted trip removes its day from a same-name, same-start multi-block candidate', () => {
    const trip = [{ name: 'Zoo Trip', time_block: '10:00', days: ['Monday'] }]
    expect(dropMultiBlockForTrips([
      { name: 'Zoo Trip', start_block: '10:00', span_blocks: 2, days: ['Monday'] },
      { name: 'Zoo Trip', start_block: '10:00', span_blocks: 2, days: ['Monday', 'Friday'] },
      { name: 'Pottery', start_block: '10:00', span_blocks: 2, days: ['Monday'] },
    ], trip)).toEqual([
      { name: 'Zoo Trip', start_block: '10:00', span_blocks: 2, days: ['Friday'] },
      { name: 'Pottery', start_block: '10:00', span_blocks: 2, days: ['Monday'] },
    ])
  })
})

describe('first import on a fresh camp: Week 1 is created, trips bind to it', () => {
  const synText = (prefix) => fs.readFileSync(path.join(SYN, MANIFEST.camps.find((c) => c.slug.startsWith(prefix)).file), 'utf8')
  const freshCamp = () => d.prepare('DELETE FROM schedule_weeks WHERE camp_id = ?').run(campId)
  const firstImport = (text, opts = {}) => {
    freshCamp()
    const weeks = weeksForImport([], campId)
    return importText(text, { weekId: weeks[0].id, hasWeeks: true, ...opts })
  }
  const weeksOfCamp = () => d.prepare('SELECT id, name, sort_order, is_archived FROM schedule_weeks WHERE camp_id = ?').all(campId)

  it('the renderer plan side offers a virtual Week 1 with the deterministic id when the camp has no weeks', () => {
    expect(weeksForImport([], campId)).toEqual([{ id: `schedule-week:${campId}:1`, name: 'Week 1', willCreate: true }])
    expect(defaultWeekId(campId)).toBe(`schedule-week:${campId}:1`)
    const real = [{ id: 'w', name: 'Week A' }]
    expect(weeksForImport(real, campId)).toBe(real)
  })

  for (const prefix of ['s04', 's13']) {
    it(`${prefix}: first import writes trips week-bound on schedule-week:<camp>:1, not as activities`, () => {
      const text = synText(prefix)
      const imp = firstImport(text)
      const accepted = imp.trips.items.filter((i) => i.accepted)
      expect(accepted.length).toBeGreaterThan(0)
      expect(weeksOfCamp()).toEqual([{ id: defaultWeekId(campId), name: 'Week 1', sort_order: 0, is_archived: 0 }])
      const rows = weekRows()
      expect(rows.length).toBe(accepted.length)
      for (const r of rows) expect(r.schedule_week_id).toBe(defaultWeekId(campId))
      const tripNames = new Set(accepted.map((i) => normalizeName(i.detection.name)))
      const asActivity = d.prepare('SELECT name, catalog_role FROM activities WHERE camp_id = ?').all(campId)
        .filter((a) => tripNames.has(normalizeName(a.name)) && a.catalog_role !== 'pinned_event')
      expect(asActivity).toEqual([])
    })
  }

  it('materializeImportedVersion afterwards finds the existing Week 1 instead of duplicating it', async () => {
    firstImport(synText('s13'))
    const client = { async write({ entity, entity_id, field, value, author_user_id }) { return { status: 'applied', op: appendOp(d, { entity, entity_id, field, value, author_user_id, device_id: deviceId }) } } }
    const placements = [{ activityName: 'Swim', groupName: 'Group 1', dayLabel: 'Monday', blockName: '10:00-10:45' }]
    await materializeImportedVersion(d, client, { campId, authorUserId: userId, placements })
    expect(weeksOfCamp().map((w) => w.id)).toEqual([defaultWeekId(campId)])
  })

  it('Undo removes the Week 1 the import created when nothing else references it', () => {
    const { committed } = firstImport(synText('s13'), { captureInverse: true })
    expect(weeksOfCamp().length).toBe(1)
    const r = ingestUndo(d, {
      invertibleOps: committed.invertibleOps ?? [], createdEntityIds: committed.createdEntityIds ?? [],
      importRunId: committed.importRunId ?? committed.import_run_id ?? null,
      author_user_id: userId, device_id: deviceId, client_write_id: randomUUID(),
    })
    expect(r.ok).toBe(true)
    expect(weekRows()).toEqual([])
    expect(weeksOfCamp()).toEqual([])
  })

  it('Undo keeps Week 1 when something else (a director-made template) references it', () => {
    const { committed } = firstImport(synText('s13'), { captureInverse: true })
    d.prepare("INSERT INTO schedule_templates (id, camp_id, week_id, kind, name) VALUES (?, ?, ?, 'manual', '')").run(randomUUID(), campId, defaultWeekId(campId))
    const r = ingestUndo(d, {
      invertibleOps: committed.invertibleOps ?? [], createdEntityIds: committed.createdEntityIds ?? [],
      importRunId: committed.importRunId ?? committed.import_run_id ?? null,
      author_user_id: userId, device_id: deviceId, client_write_id: randomUUID(),
    })
    expect(r.kept.filter((k) => k.entity === 'schedule_weeks').map((k) => k.reason)).toEqual(['still_referenced'])
    expect(weeksOfCamp().length).toBe(1)
  })

  it('a camp that already has a different week never gets schedule-week:<camp>:1 created', () => {
    const imp = importText(synText('s13'), { weekId: week1 })
    expect(imp.trips.items.some((i) => i.accepted)).toBe(true)
    expect(weeksOfCamp().map((w) => w.id).sort()).toEqual([week1, week2].sort())
  })
})
