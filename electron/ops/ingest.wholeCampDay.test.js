// @vitest-environment node
//
// F3/F4 slice 3b (docs/adr/2026-10-11-import-special-days-and-field-trips.md): an accepted whole-camp day
// becomes a special day plus a placement on (week, day); unanswered it stays week-bound all-camp events. Real pipeline: parseTextGrid -> extractEntities -> detector ->
// planTripEvents / applyTripClaims (src/ingest/tripEvents.js, the same functions ImportScreen calls) ->
// inferFixedEvents / inferActivityRules -> commitIngest (dry run, report, confirm-all fold, commit) ->
// real SQLite -> buildSchedule (Generate). Assertions are per ROW, read back from fixed_events.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { commitIngest, ingestUndo } from './ingest.js'
import { deriveSpecialDayPlacementId } from './electiveDerivedIds.js'
import { parseTextGrid } from '../../src/ingest/textGrid.js'
import { extractEntities } from '../../src/ingest/extractEntities.js'
import { inferFixedEvents } from '../../src/ingest/fixedEvents.js'
import { derivePinOnlyActivityNames } from '../../src/ingest/pinOnlyActivityNames.js'
import { inferActivityRules } from '../../src/ingest/activityRules.js'
import { inferTextSpans } from '../../src/ingest/textSpans.js'
import { detectTripsAndSpecialDays } from '../../src/ingest/tripDetection.js'
import { planTripEvents, planWholeCampDays, applyTripClaims, tripItemKey } from '../../src/ingest/tripEvents.js'
import { buildReconciliationReport } from '../../src/ingest/reconciliationReport.js'
import { buildBlastRadiusIndex } from '../../src/ingest/blastRadius.js'
import { foldTriageInputs, heldBackDecisions } from '../../src/screens/reconciliationTriage.js'

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
function importText(text, { weekId = week1, hasWeeks = true, tripAnswers = {}, wholeAnswers = {}, mutate, captureInverse = false, mode = 'add' } = {}) {
  const parsed = parseTextGrid(text)
  mutate?.(parsed)
  const pages = { pages: parsed.pages }
  const proposal = extractEntities(parsed)
  const detections = detectTripsAndSpecialDays(pages, proposal)
  const trips = planTripEvents({ detections, answers: tripAnswers, weekId, hasWeeks, allGroupNames: proposal.entities.groups })
  const whole = planWholeCampDays({ detections, answers: wholeAnswers, weekId, hasWeeks, allGroupNames: proposal.entities.groups })
  const claims = new Map([...trips.claims, ...whole.claims])
  const { fixedEvents: inferred, dualUseNames = [] } = inferFixedEvents(pages, proposal, {})
  const claimed = applyTripClaims({ parsed: pages, proposal, claims, fixedEvents: inferred, textSpans: inferTextSpans(pages, proposal).spans })
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
    fixedEvents: [...claimed.fixedEvents, ...trips.fixedEvents, ...whole.fixedEvents],
    wholeCampDays: whole.wholeCampDays,
    activityRules,
    pinOnlyActivityNames: [...pinOnly],
    seenCounts: claimed.seenCounts ?? null,
  }
  const common = { camp_id: campId, cohort_id: null, author_user_id: userId, device_id: deviceId, mode }
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
  return { parsed, proposal, detections, trips, whole, claimed, committed }
}

const S05 = () => fs.readFileSync(path.join(SYN, MANIFEST.camps.find((c) => c.slug.startsWith('s05')).file), 'utf8')
const gamesDay = (text) => {
  const p = parseTextGrid(text)
  return detectTripsAndSpecialDays({ pages: p.pages }, extractEntities(p)).find((x) => x.kind === 'all-camp-day' && x.name === 'Games Day')
}
const wholeKey = (text) => tripItemKey(gamesDay(text))
const rows = (sql, ...a) => d.prepare(sql).all(...a)
const counts = () => Object.fromEntries(['special_days', 'special_day_time_blocks', 'special_day_slots', 'special_day_placements'].map((t) => [t, rows(`SELECT id FROM ${t}`).length]))
const gamesEvents = () => rows("SELECT fe.*, dy.label day FROM fixed_events fe JOIN days_of_operation dy ON dy.id = fe.day_id WHERE fe.camp_id = ? AND fe.name = 'Games Day'", campId)

describe('slice 3b: whole-camp day, director accepts', () => {
  it('writes 1 special day + 1 placement on the right (week, day) and no leftover events', () => {
    const det = gamesDay(S05())
    expect(det.kind).toBe('all-camp-day')
    const imp = importText(S05(), { wholeAnswers: { [wholeKey(S05())]: 'special_day' } })
    expect(imp.whole.items[0]).toMatchObject({ accepted: true, pending: false, weekId: week1 })
    const sds = rows('SELECT * FROM special_days')
    expect(sds.map((s) => s.name)).toEqual(['Games Day'])
    const dayId = rows("SELECT id FROM days_of_operation WHERE camp_id = ? AND label = ?", campId, det.day)[0].id
    expect(rows('SELECT week_id, day_id, special_day_id FROM special_day_placements')).toEqual([{ week_id: week1, day_id: dayId, special_day_id: sds[0].id }])
    expect(counts().special_day_time_blocks).toBe(det.blocks.length)
    expect(counts().special_day_slots).toBe(det.blocks.length * det.groupIds.length)
    expect(gamesEvents()).toEqual([])
  })

  it('re-importing the same file leaves identical rows and ids', () => {
    const answers = { wholeAnswers: { [wholeKey(S05())]: 'special_day' } }
    importText(S05(), answers)
    const snap = () => ({ c: counts(), ids: rows('SELECT id FROM special_days UNION ALL SELECT id FROM special_day_placements UNION ALL SELECT id FROM special_day_slots ORDER BY 1') })
    const first = snap()
    importText(S05(), answers)
    expect(snap()).toEqual(first)
  })

  it('keep-existing binding: an occupied (week, day) gets no new special day and no new placement', () => {
    importText(S05())
    const friday = rows("SELECT id FROM days_of_operation WHERE camp_id = ? AND label = 'Friday'", campId)[0].id
    const other = randomUUID()
    d.prepare('INSERT INTO special_days (id, camp_id, name) VALUES (?, ?, ?)').run(other, campId, 'Other Day')
    d.prepare('INSERT INTO special_day_placements (id, week_id, day_id, special_day_id) VALUES (?, ?, ?, ?)').run(deriveSpecialDayPlacementId(week1, friday), week1, friday, other)
    const before = counts()
    const imp = importText(S05(), { wholeAnswers: { [wholeKey(S05())]: 'special_day' } })
    expect(counts()).toEqual(before)
    expect(rows('SELECT name FROM special_days').map((s) => s.name)).toEqual(['Other Day'])
    expect(rows('SELECT special_day_id FROM special_day_placements')).toEqual([{ special_day_id: other }])
    expect(imp.committed.wholeCampDays).toEqual([expect.objectContaining({ name: 'Games Day', created: false, placed: false, keptExisting: true })])
  })

  it('Undo import removes the special day, its children and the placement', () => {
    const { committed } = importText(S05(), { wholeAnswers: { [wholeKey(S05())]: 'special_day' }, captureInverse: true })
    expect(counts().special_day_placements).toBe(1)
    const r = ingestUndo(d, { invertibleOps: committed.invertibleOps ?? [], createdEntityIds: committed.createdEntityIds ?? [], importRunId: committed.importRunId, author_user_id: userId, device_id: deviceId, client_write_id: randomUUID() })
    expect(r.ok).toBe(true)
    expect(counts()).toEqual({ special_days: 0, special_day_time_blocks: 0, special_day_slots: 0, special_day_placements: 0 })
  })
})

describe('slice 3b: whole-camp day, unanswered or declined', () => {
  it('unanswered: pending item, no special day, week-bound all-camp fixed events instead', () => {
    const imp = importText(S05())
    expect(imp.whole.items[0]).toMatchObject({ answer: null, pending: true, accepted: false })
    expect(imp.whole.wholeCampDays).toEqual([])
    expect(counts()).toEqual({ special_days: 0, special_day_time_blocks: 0, special_day_slots: 0, special_day_placements: 0 })
    const ev = gamesEvents()
    expect(ev.length).toBeGreaterThan(0)
    for (const e of ev) expect(e).toMatchObject({ kind: 'fixed', is_all_groups: 1, schedule_week_id: week1 })
  })

  it('no week known: the item stays pending and nothing is written for it', () => {
    const imp = importText(S05(), { weekId: null, wholeAnswers: { [wholeKey(S05())]: 'special_day' } })
    expect(imp.whole.items[0]).toMatchObject({ pending: true, accepted: false })
    expect(counts().special_days).toBe(0)
  })

  it('the item is never pre-selected: the detector gives no default, and an unrelated answer map leaves it pending', () => {
    expect(gamesDay(S05()).defaultAnswer).toBeNull()
    const trips = planWholeCampDays({ detections: [gamesDay(S05())], answers: { somethingElse: 'special_day' }, weekId: week1, hasWeeks: true, allGroupNames: [] })
    expect(trips.items[0].pending).toBe(true)
  })

  it('answering events commits week-bound fixed events and no special day', () => {
    importText(S05(), { wholeAnswers: { [wholeKey(S05())]: 'events' } })
    expect(counts().special_days).toBe(0)
    expect(gamesEvents().length).toBeGreaterThan(0)
  })
})

describe('slice 3b: mutated campB plant', () => {
  const plant = (parsed) => {
    const thu = parsed.pages.find((p) => p.title.startsWith('Thursday'))
    for (const r of thu.rows) r.cells = r.cells.map(() => 'Spirit Day')
  }
  const text = () => fs.readFileSync(CAMPB, 'utf8')
  const spiritKey = () => {
    const p = parseTextGrid(text()); plant(p)
    return tripItemKey(detectTripsAndSpecialDays({ pages: p.pages }, extractEntities(p)).find((x) => x.name === 'Spirit Day'))
  }

  it('the unmutated camp offers no Spirit Day and writes no special day', () => {
    importText(text(), { wholeAnswers: { x: 'special_day' } })
    expect(counts().special_days).toBe(0)
  })

  it('the planted whole-camp day yields exactly one special day with one placement on Thursday', () => {
    const imp = importText(text(), { mutate: plant, wholeAnswers: { [spiritKey()]: 'special_day' } })
    const spirit = imp.whole.items.find((i) => i.detection.name === 'Spirit Day')
    expect(spirit).toMatchObject({ accepted: true })
    expect(rows('SELECT name FROM special_days').map((s) => s.name)).toEqual(['Spirit Day'])
    const pl = rows("SELECT dy.label day, p.week_id FROM special_day_placements p JOIN days_of_operation dy ON dy.id = p.day_id")
    expect(pl).toEqual([{ day: 'Thursday', week_id: week1 }])
    expect(counts().special_day_slots).toBe(spirit.detection.blocks.length * spirit.detection.groupIds.length)
    expect(rows("SELECT id FROM fixed_events WHERE name = 'Spirit Day'")).toEqual([])
  })
})

describe('slice 3b: Replace import leaves no dangling placement', () => {
  const approved = (days) => ({ groups: ['Red'], days_of_operation: days, time_blocks: ['9:00-9:45'], activities: [] })
  const base = () => ({ camp_id: campId, cohort_id: null, author_user_id: userId, device_id: deviceId })

  it('a placement whose day survives the Replace stays valid; one whose day is gone is dropped and reported', () => {
    commitIngest(d, { ...base(), mode: 'add', approved: approved(['Monday', 'Friday']) })
    const mon = rows("SELECT id FROM days_of_operation WHERE label = 'Monday'")[0].id
    const fri = rows("SELECT id FROM days_of_operation WHERE label = 'Friday'")[0].id
    const sd = randomUUID()
    d.prepare('INSERT INTO special_days (id, camp_id, name) VALUES (?, ?, ?)').run(sd, campId, 'Games Day')
    for (const day of [mon, fri]) d.prepare('INSERT INTO special_day_placements (id, week_id, day_id, special_day_id) VALUES (?, ?, ?, ?)').run(randomUUID(), week1, day, sd)
    const out = commitIngest(d, { ...base(), mode: 'replace', approved: approved(['Monday']) })
    const live = new Set(rows('SELECT id FROM days_of_operation').map((r) => r.id))
    const placements = rows('SELECT day_id FROM special_day_placements')
    expect(placements.length).toBeGreaterThan(0)
    for (const p of placements) expect(live.has(p.day_id)).toBe(true)
    expect(placements.map((p) => p.day_id)).toEqual([mon])
    expect(out.placementsDropped).toEqual([expect.objectContaining({ dayLabel: 'Friday', specialDayId: sd })])
  })
})
