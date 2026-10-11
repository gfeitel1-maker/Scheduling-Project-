// @vitest-environment node
//
// Packaged-audit ship-blockers #12/#14/#16 — the director's import path end to
// end, with every reconciliation card left UNANSWERED (the common case: a
// director who clicks Import without working the queue).
//
// real sample -> parseTextGrid -> extractEntities -> inferFixedEvents ->
// commitIngest dry run -> buildReconciliationReport -> foldTriageInputs (no
// answers) -> commitIngest -> real SQLite -> buildSchedule (Generate and
// Manual's fixedEventsOnly) + materializeImportedVersion.
//
// Before this fix: a claimed event name's low-confidence activity card went
// unanswered, the activity was held back while the event still committed, the
// fixed_events row landed with a NULL activity_id, and both Generate and
// Manual "Start a blank week" refused on FIXED_EVENT_IDENTITY_GAP.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { commitIngest } from './ops/ingest.js'
import { appendOp } from './ops/operations.js'
import { materializeImportedVersion, nameMap } from './ops/materializeImportedVersion.js'
import { normalizeName } from '../src/ingest/preview.js'
import { normalizeScheduleInputs, SCHEDULE_INPUT_ENTITIES } from './ops/scheduleInputNormalization.js'
import { parseTextGrid } from '../src/ingest/textGrid.js'
import { extractEntities } from '../src/ingest/extractEntities.js'
import { inferFixedEvents } from '../src/ingest/fixedEvents.js'
import { settleAmbiguousFromCamp } from '../src/ingest/settleAmbiguousFromCamp.js'
import { derivePinOnlyActivityNames } from '../src/ingest/pinOnlyActivityNames.js'
import { inferActivityRules } from '../src/ingest/activityRules.js'
import { capturePlacements } from '../src/ingest/capturePlacements.js'
import { buildReconciliationReport } from '../src/ingest/reconciliationReport.js'
import { foldTriageInputs } from '../src/screens/reconciliationTriage.js'
import { resolveFixedEventActivityIds } from '../src/engine/fixedEventActivityLink.js'
import { resolvePriorityForGeneration } from '../src/ingest/resolvePriorityForGeneration.js'
import buildSchedule from '../src/engine/buildSchedule.js'

const SAMPLE = path.join(process.cwd(), 'docs/work/specs/samples/campB-by-day.txt')
const deviceId = 'device-1'
const userId = 'u1'

let db, campId, parsed, proposal, committed

function seedDirectorCamp() {
  const { db: d } = openTemplatedDb()
  const id = randomUUID()
  d.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(id, 'Camp B', 'a'.repeat(64))
  d.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  d.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run(userId, id)
  d.prepare('INSERT INTO cohorts (id, camp_id, name, sort_order) VALUES (?, ?, ?, 0)').run(randomUUID(), id, 'Main')
  return { d, id }
}

// The director's path with every card unanswered: dry run -> report -> fold
// with no answers -> real commit.
function importUnanswered(d, id, text, answerFor = () => null) {
  const p = parseTextGrid(text)
  const prop = extractEntities(p)
  const inferredEvents = inferFixedEvents({ pages: p.pages }, prop, {})
  const { dualUseNames = [] } = inferredEvents
  // The camp's current state settles a name an earlier import already classified.
  const settled = settleAmbiguousFromCamp(inferredEvents.ambiguousEvents ?? [], {
    activities: d.prepare('SELECT name, catalog_role FROM activities WHERE camp_id = ?').all(id),
    fixedEvents: d.prepare('SELECT name FROM fixed_events WHERE camp_id = ?').all(id),
  })
  const ambiguousEvents = settled.stillAmbiguous
  const fixedEvents = [...inferredEvents.fixedEvents, ...settled.settledFixed]
  const pinOnly = derivePinOnlyActivityNames(fixedEvents, dualUseNames)
  for (const n of settled.settledFixedNames) pinOnly.add(normalizeName(n))
  const baseInputs = {
    approved: {
      groups: prop.entities.groups,
      days_of_operation: prop.entities.days_of_operation,
      time_blocks: prop.entities.time_blocks,
      activities: prop.entities.activities,
    },
    fixedEvents,
    ambiguousEvents,
    activityRules: inferActivityRules(
      prop.entities.activities, prop.activityPages, prop.seenCounts,
      prop.entities.days_of_operation.length, prop.entities.groups, pinOnly,
    ),
    pinOnlyActivityNames: [...pinOnly],
    seenCounts: prop.seenCounts ?? null,
  }
  const common = { camp_id: id, cohort_id: null, author_user_id: userId, device_id: deviceId, mode: 'add' }
  const dry = commitIngest(d, { ...common, ...baseInputs, dryRun: true })
  const report = buildReconciliationReport({
    planItems: dry.planItems ?? [],
    ambiguousEvents,
    fixedEventsReport: { ...dry.fixedEvents, created: dry.fixedEvents?.createdEntries ?? [], unchanged: dry.fixedEvents?.unchangedEntries ?? [] },
  })
  const answers = Object.fromEntries(report.decisions.map((dec) => [dec.id, answerFor(dec)]).filter(([, a]) => a))
  const folded = foldTriageInputs(baseInputs, report.decisions, answers)
  return { parsed: p, proposal: prop, report, committed: commitIngest(d, { ...common, ...baseInputs, ...folded }) }
}

beforeAll(async () => {
  ;({ d: db, id: campId } = seedDirectorCamp())
  ;({ parsed, proposal, committed } = importUnanswered(db, campId, fs.readFileSync(SAMPLE, 'utf8')))
}, 60_000)

afterAll(() => { db?.close(); cleanupTemplatedDbs() })

function scheduleInput() {
  const rowsByEntity = {}
  for (const entity of SCHEDULE_INPUT_ENTITIES) rowsByEntity[entity] = db.prepare(`SELECT * FROM ${entity}`).all()
  const { cohorts: _c, ...flat } = normalizeScheduleInputs(rowsByEntity, campId)
  return { ...flat, activities: resolvePriorityForGeneration(flat.activities), campId, replacedDayIds: [] }
}

describe('director import with every reconciliation card unanswered (campB-by-day)', () => {
  it('commits, and commits fixed events', () => {
    expect(committed.held).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM fixed_events WHERE camp_id = ?').get(campId).c).toBeGreaterThan(0)
  })

  it('every fixed_events row links to exactly one live activity', () => {
    const live = new Set(db.prepare('SELECT id FROM activities WHERE camp_id = ?').all(campId).map((r) => r.id))
    const unlinked = db.prepare('SELECT * FROM fixed_events WHERE camp_id = ?').all(campId)
      .filter((fe) => resolveFixedEventActivityIds(fe).filter((id) => live.has(id)).length !== 1)
      .map((fe) => fe.name)
    expect(unlinked).toEqual([])
  })

  it('Generate returns slots with no error findings', () => {
    const result = buildSchedule(scheduleInput())
    expect(result.findings.filter((f) => f.severity === 'error')).toEqual([])
    expect(result.slots.length).toBeGreaterThan(0)
  })

  it('Manual "Start a blank week" (fixedEventsOnly) has no error findings and places events', () => {
    const result = buildSchedule({ ...scheduleInput(), fixedEventsOnly: true })
    expect(result.findings.filter((f) => f.severity === 'error')).toEqual([])
    expect(result.slots.length).toBeGreaterThan(0)
  })

  it('materializes the imported schedule as a version on a fresh camp with no week row yet', async () => {
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_weeks WHERE camp_id = ?').get(campId).c).toBe(0)
    const writeClient = {
      async write({ entity, entity_id, field, value, author_user_id }) {
        return { status: 'applied', op: appendOp(db, { entity, entity_id, field, value, author_user_id, device_id: deviceId }) }
      },
    }
    const { placements } = capturePlacements({ pages: parsed.pages }, proposal)
    const out = await materializeImportedVersion(db, writeClient, { campId, authorUserId: userId, placements, sourceFileName: 'campB-by-day.txt' })
    expect(out.created).toBe(true)
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_snapshots WHERE id = ?').get(out.snapshotId).c).toBe(1)
    // I2: the director lands on Generated (ScheduleScreen's default route), so
    // the version must be findable there, by file name, holding the placements.
    for (const kind of ['generated', 'manual']) {
      const snaps = db.prepare(`SELECT s.name, s.slots FROM schedule_snapshots s JOIN schedule_templates t ON t.id = s.template_id WHERE t.kind = ? AND t.camp_id = ?`).all(kind, campId)
      expect(snaps.map((s) => s.name)).toEqual(['Imported from campB-by-day.txt'])
      expect(JSON.parse(snaps[0].slots).length).toBe(placements.length)
    }
  })
})

// Red Hat #2 — a numbered sibling ("Specialty 4", one day, beside a daily
// "Specialty 1..3") is admitted at low confidence so the director is ASKED.
// Left unanswered it must be held back like every other unanswered low card:
// no fixed_events row, and no pinned_event activity minted for it.
describe('an unanswered numbered-sibling event is held back, not pinned', () => {
  const pad = (s) => String(s).padEnd(20)
  const groups = ['Bunk A', 'Bunk B', 'Bunk C']
  const day = (name, withSibling) => [
    `                    ${name} — All Camp`, '',
    pad('   Time') + groups.map(pad).join(''), '',
    pad('09:00–09:45') + groups.map((_, i) => pad(`Specialty ${i + 1}`)).join(''), '',
    pad('10:00–10:45') + groups.map((_, i) => pad(withSibling && i === 0 ? 'Specialty 4' : ['Swim', 'Art', 'Music'][i])).join(''), '',
    pad('11:00–11:45') + groups.map(() => pad('Lunch')).join(''),
  ].join('\n')
  const text = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((d) => day(d, d === 'Wednesday')).join('\n\n')

  it('writes no fixed event and mints no activity for Specialty 4', () => {
    const { d, id } = seedDirectorCamp()
    const { committed: out, report } = importUnanswered(d, id, text)
    expect(out.held).toBe(false)
    expect(report.decisions.filter((dec) => dec.entityName === 'Specialty 4').map((dec) => dec.entity)).toEqual(['fixed_events'])
    expect(d.prepare("SELECT COUNT(*) c FROM fixed_events WHERE camp_id = ? AND name = 'Specialty 1'").get(id).c).toBeGreaterThan(0)
    expect(d.prepare("SELECT COUNT(*) c FROM fixed_events WHERE camp_id = ? AND name = 'Specialty 4'").get(id).c).toBe(0)
    expect(d.prepare("SELECT COUNT(*) c FROM activities WHERE camp_id = ? AND name = 'Specialty 4'").get(id).c).toBe(0)
    d.close()
  })

  it('commits Specialty 4, linked, once the director confirms it (non-vacuity)', () => {
    const { d, id } = seedDirectorCamp()
    importUnanswered(d, id, text, (dec) => (dec.entity === 'fixed_events' && dec.entityName === 'Specialty 4' ? { action: 'looks_right' } : null))
    const rows = d.prepare("SELECT activity_id FROM fixed_events WHERE camp_id = ? AND name = 'Specialty 4'").all(id)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.activity_id)).toBe(true)
    d.close()
  })
})

// Owner regression: "lunch was skipped for half of the groups". Per group AND
// per day, every Lunch/Menucha cell the file shows must be covered by a fixed
// event of that name at that block, with zero answers and with every card
// confirmed. "Lunch exists somewhere" is how this regressed.
describe.each([
  ['zero answers', () => null],
  ['every card confirmed', (dec) => (dec.entity === 'fixed_events' ? { action: 'looks_right' } : null)],
])('every group gets its meal on every day the file shows it (%s)', (_label, answerFor) => {
  let d, id, imp
  beforeAll(() => {
    ;({ d, id } = seedDirectorCamp())
    imp = importUnanswered(d, id, fs.readFileSync(SAMPLE, 'utf8'), answerFor)
  }, 60_000)
  afterAll(() => d?.close())

  it('leaves no placement out of the imported version', async () => {
    const { placements } = capturePlacements({ pages: imp.parsed.pages }, imp.proposal)
    const writeClient = {
      async write({ entity, entity_id, field, value, author_user_id }) {
        return { status: 'applied', op: appendOp(d, { entity, entity_id, field, value, author_user_id, device_id: deviceId }) }
      },
    }
    const out = await materializeImportedVersion(d, writeClient, { campId: id, authorUserId: userId, placements })
    expect({ count: out.unresolvedCount, names: [...new Set(out.unresolvedNames)] }).toEqual({ count: 0, names: [] })
  })

  it('Generate leaves every meal cell as a fixed event, never an activity', () => {
    const rowsByEntity = {}
    for (const entity of SCHEDULE_INPUT_ENTITIES) rowsByEntity[entity] = d.prepare(`SELECT * FROM ${entity}`).all()
    const { cohorts: _c, ...flat } = normalizeScheduleInputs(rowsByEntity, id)
    const result = buildSchedule({ ...flat, activities: resolvePriorityForGeneration(flat.activities), campId: id, replacedDayIds: [] })
    const fixedKeys = new Set(result.slots.filter((s) => s.type === 'fixed_event').map((s) => `${s.groupId}|${s.dayId}|${s.blockId}`))
    const { placements } = capturePlacements({ pages: imp.parsed.pages }, imp.proposal)
    const groupId = nameMap(d, 'groups', id)
    const dayId = nameMap(d, 'days_of_operation', id, 'label')
    const blockId = nameMap(d, 'time_blocks', id)
    const lost = placements.filter((p) => /^lunch\b|^menucha$/i.test(p.activityName))
      .filter((p) => !fixedKeys.has(`${groupId.get(normalizeName(p.groupName))}|${dayId.get(normalizeName(p.dayName))}|${blockId.get(normalizeName(p.blockLabel))}`))
      .map((p) => `${p.groupName}|${p.dayName}|${p.blockLabel}`)
    expect(lost).toEqual([])
  })

  it('covers every group the file gives a meal (13 of 14), per day, at the block the file shows', () => {
    const { placements } = capturePlacements({ pages: imp.parsed.pages }, imp.proposal)
    const meals = placements.filter((p) => /^lunch\b|^menucha$/i.test(p.activityName))
    const groupId = nameMap(d, 'groups', id)
    const dayId = nameMap(d, 'days_of_operation', id, 'label')
    const blockId = nameMap(d, 'time_blocks', id)
    const fixed = d.prepare('SELECT name, day_id, time_block_id, is_all_groups, group_ids FROM fixed_events WHERE camp_id = ?').all(id)
    const missing = meals.filter((p) => {
      const g = groupId.get(normalizeName(p.groupName))
      return !fixed.some((fe) => normalizeName(fe.name) === normalizeName(p.activityName)
        && fe.day_id === dayId.get(normalizeName(p.dayName))
        && fe.time_block_id === blockId.get(normalizeName(p.blockLabel))
        && (fe.is_all_groups || JSON.parse(fe.group_ids ?? '[]').includes(g)))
    }).map((p) => `${p.groupName}|${p.dayName}|${p.blockLabel}|${p.activityName}`)
    expect(new Set(meals.map((p) => p.groupName)).size).toBe(13) // the file shows no meal for CIT
    expect(missing).toEqual([])
  })
})

// OQ3 (strict, 2026-10-11): a name that is a catalogue activity AND pinned is
// classified once. Unambiguous evidence is silent; ambiguous evidence is ONE
// question, defaulting to the activity with its cells kept as placements.
describe('a catalogue activity that is also pinned is asked once (OQ3)', () => {
  const placementsFor = (text) => capturePlacements({ pages: parseTextGrid(text).pages }, extractEntities(parseTextGrid(text))).placements
  const swimQuestions = (report) => report.decisions.filter((d) => /^(Instructional |Recreational )?Swim$/.test(d.entityName ?? ''))

  async function materialize(d, id, text) {
    const writeClient = {
      async write({ entity, entity_id, field, value, author_user_id }) {
        return { status: 'applied', op: appendOp(d, { entity, entity_id, field, value, author_user_id, device_id: deviceId }) }
      },
    }
    await materializeImportedVersion(d, writeClient, { campId: id, authorUserId: userId, placements: placementsFor(text), sourceFileName: 'x.txt' })
    const snap = d.prepare('SELECT s.slots FROM schedule_snapshots s JOIN schedule_templates t ON t.id = s.template_id WHERE t.camp_id = ? LIMIT 1').get(id)
    return JSON.parse(snap.slots)
  }

  const campA = () => fs.readFileSync(path.join(process.cwd(), 'docs/work/specs/samples/campA-bunk-schedules.txt'), 'utf8')
  const swimRows = (d, id) => d.prepare("SELECT name, catalog_role FROM activities WHERE camp_id = ? AND name = 'Swim'").all(id)
  const swimEvents = (d, id) => d.prepare("SELECT COUNT(*) c FROM fixed_events WHERE camp_id = ? AND name = 'Swim'").get(id).c

  it('campA Swim unanswered: one question, an activity, no fixed event, its cells kept as placements', async () => {
    const { d, id } = seedDirectorCamp()
    const text = campA()
    const { report } = importUnanswered(d, id, text)
    expect(swimQuestions(report).map((q) => `${q.kind}:${q.entityName}`).filter((q) => q.endsWith(':Swim'))).toEqual(['name_kind:Swim'])
    expect(swimRows(d, id)).toEqual([{ name: 'Swim', catalog_role: null }])
    expect(swimEvents(d, id)).toBe(0)
    const swimId = d.prepare("SELECT id FROM activities WHERE camp_id = ? AND name = 'Swim'").get(id).id
    const cells = placementsFor(text).filter((p) => p.activityName === 'Swim').length
    expect(cells).toBeGreaterThan(0)
    const slots = await materialize(d, id, text)
    expect(slots.filter((s) => s.activity_id === swimId && !s.is_fixed_event).length).toBe(cells)
    d.close()
  })

  it('campA Swim answered "fixed time": an event plus the marker row, not a catalogue activity', () => {
    const { d, id } = seedDirectorCamp()
    importUnanswered(d, id, campA(), (dec) => (dec.id === 'name_kind:swim' ? { choice: 'fixed' } : null))
    expect(swimEvents(d, id)).toBeGreaterThan(0)
    expect(swimRows(d, id)).toEqual([{ name: 'Swim', catalog_role: 'pinned_event' }])
    d.close()
  })

  it('campA Swim answered "activity": a catalogue activity only', () => {
    const { d, id } = seedDirectorCamp()
    importUnanswered(d, id, campA(), (dec) => (dec.id === 'name_kind:swim' ? { choice: 'activity' } : null))
    expect(swimEvents(d, id)).toBe(0)
    expect(swimRows(d, id)).toEqual([{ name: 'Swim', catalog_role: null }])
    d.close()
  })

  // A one-group weekly class that shares its name with a rotating activity.
  const pad = (s) => String(s).padEnd(20)
  const groups = ['Alpha', 'Beta', 'Gamma']
  const cell = (day, b, g) => {
    if (day === 'Tuesday' && b === 2 && g !== 'Gamma') return 'Swim'
    const rotating = { Monday: ['Swim', 'Art', 'Clay'], Wednesday: ['Pool', 'Swim', 'Sew'], Thursday: ['Wood', 'Weave', 'Swim'] }
    const row = rotating[day]?.[b]
    if (row === 'Swim' && ((day === 'Monday' && b === 0 && g === 'Alpha') || (day === 'Wednesday' && b === 1 && g === 'Beta') || (day === 'Thursday' && b === 2 && g === 'Gamma'))) return 'Swim'
    return `${day.slice(0, 3)}-${g[0]}${b}`
  }
  const plantDay = (day) => [
    `                    ${day} — All Camp`, '',
    pad('   Time') + groups.map(pad).join(''), '',
    ...[0, 1, 2].flatMap((b) => [pad(['09:00–09:45', '10:00–10:45', '11:00–11:45'][b]) + groups.map((g) => pad(cell(day, b, g))).join(''), '']),
  ].join('\n')
  const plantText = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map(plantDay).join('\n\n')

  it('weekly pin sharing a name with a rotating activity: asked once; unanswered it is an activity with its cell placed', async () => {
    const { d, id } = seedDirectorCamp()
    const { report } = importUnanswered(d, id, plantText)
    expect(report.decisions.filter((q) => q.entityName === 'Swim').map((q) => q.kind)).toEqual(['name_kind'])
    expect(swimEvents(d, id)).toBe(0)
    expect(swimRows(d, id)).toEqual([{ name: 'Swim', catalog_role: null }])
    const swimId = d.prepare("SELECT id FROM activities WHERE camp_id = ? AND name = 'Swim'").get(id).id
    const tuesday = d.prepare("SELECT id FROM days_of_operation WHERE camp_id = ? AND label = 'Tuesday'").get(id).id
    const slots = await materialize(d, id, plantText)
    expect(slots.filter((s) => s.activity_id === swimId && s.day_id === tuesday && !s.is_fixed_event).length).toBe(2)
    d.close()
  })

  it('weekly pin answered "fixed time": an event plus the marker', () => {
    const { d, id } = seedDirectorCamp()
    importUnanswered(d, id, plantText, (dec) => (dec.id === 'name_kind:swim' ? { choice: 'fixed' } : null))
    expect(swimEvents(d, id)).toBeGreaterThan(0)
    expect(swimRows(d, id)).toEqual([{ name: 'Swim', catalog_role: 'pinned_event' }])
    d.close()
  })

  const bothBuckets = (d, id) => d.prepare(`
    SELECT DISTINCT a.name FROM activities a
    JOIN fixed_events f ON lower(trim(f.name)) = lower(trim(a.name)) AND f.camp_id = a.camp_id
    WHERE a.camp_id = ? AND a.catalog_role IS NOT 'pinned_event'`).all(id)
  const nameKindAsked = (report) => report.decisions.filter((q) => q.kind === 'name_kind').length

  it('re-import after "fixed": no second question, the marker stays, no name in both buckets', () => {
    const { d, id } = seedDirectorCamp()
    importUnanswered(d, id, plantText, (dec) => (dec.id === 'name_kind:swim' ? { choice: 'fixed' } : null))
    const { report } = importUnanswered(d, id, plantText)
    expect(nameKindAsked(report)).toBe(0)
    expect(swimRows(d, id)).toEqual([{ name: 'Swim', catalog_role: 'pinned_event' }])
    expect(swimEvents(d, id)).toBeGreaterThan(0)
    expect(bothBuckets(d, id)).toEqual([])
    d.close()
  })

  it('re-import after "activity": no second question, it stays an activity with no events', () => {
    const { d, id } = seedDirectorCamp()
    importUnanswered(d, id, plantText, (dec) => (dec.id === 'name_kind:swim' ? { choice: 'activity' } : null))
    const { report } = importUnanswered(d, id, plantText)
    expect(nameKindAsked(report)).toBe(0)
    expect(swimRows(d, id)).toEqual([{ name: 'Swim', catalog_role: null }])
    expect(swimEvents(d, id)).toBe(0)
    expect(bothBuckets(d, id)).toEqual([])
    d.close()
  })

  it('the decision id is the name alone, so it is stable across imports', () => {
    const a = seedDirectorCamp()
    const first = importUnanswered(a.d, a.id, plantText).report.decisions.find((q) => q.kind === 'name_kind')
    const b = seedDirectorCamp()
    const second = importUnanswered(b.d, b.id, plantText).report.decisions.find((q) => q.kind === 'name_kind')
    expect(first.id).toBe('name_kind:swim')
    expect(second.id).toBe(first.id)
    a.d.close(); b.d.close()
  })
})

// Removing the meal question (they are kept either way) must not change what ships.
describe('meal waves still ship for exactly the right groups and times', () => {
  it('Lunch 2 and Menucha: same block, same groups as the file', () => {
    const rows = db.prepare("SELECT f.name, f.is_all_groups, f.group_ids, b.name AS block FROM fixed_events f JOIN time_blocks b ON b.id = f.time_block_id WHERE f.camp_id = ? AND f.name IN ('Lunch 2','Menucha') ORDER BY f.name").all(campId)
    const byName = Object.fromEntries(rows.map((r) => [r.name, { block: r.block, groups: r.is_all_groups ? 'all' : JSON.parse(r.group_ids).map((g) => db.prepare('SELECT name FROM groups WHERE id = ?').get(g).name).sort() }]))
    expect(byName['Lunch 2'].block).toBe('12:10-12:50')
    expect(byName['Lunch 2'].groups).toEqual(['Muskrat 1', 'Muskrat 2', 'Porcupine 1', 'Porcupine 2', 'Porcupine 3'])
    expect(byName.Menucha.block).toBe('12:10-12:50')
    expect(byName.Menucha.groups).toEqual(['Beavers 1', 'Beavers 2'])
  })
})
