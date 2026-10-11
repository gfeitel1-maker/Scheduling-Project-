// @vitest-environment node
//
// F3/F4 slice 3a (docs/adr/2026-10-11-import-special-days-and-field-trips.md): the one-day-file commit
// lives in commitPlan, so it is one transaction with derived ids, an import_run_id, and an Undo. Rows are
// read back from the real tables, not inferred from the call.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { commitIngest, ingestUndo } from './ingest.js'
import { appendOp } from './operations.js'
import { deriveSpecialDayPlacementId } from './electiveDerivedIds.js'
import { defaultWeekId } from '../../src/ingest/defaultWeek.js'
import path from 'node:path'
import { parseTextGrid } from '../../src/ingest/textGrid.js'
import { proposeSpecialDay } from '../../src/ingest/specialDayFile.js'
import { buildSpecialDayPlan, resolveSpecialDayPlacement } from '../../src/ingest/specialDayPlan.js'

afterAll(() => cleanupTemplatedDbs())
const deviceId = 'device-1'
const userId = 'u1'

let d, file, campId, g1, g2, relayId
beforeEach(() => {
  const t = openTemplatedDb()
  d = t.db
  file = t.file
  campId = randomUUID()
  d.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'a'.repeat(64))
  d.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  d.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run(userId, campId)
  g1 = randomUUID()
  g2 = randomUUID()
  relayId = randomUUID()
  for (const [entity, id, name] of [['groups', g1, 'Red'], ['groups', g2, 'Blue'], ['activities', relayId, 'Relay']]) {
    appendOp(d, { entity, entity_id: id, field: 'name', value: name, author_user_id: userId, device_id: deviceId })
    appendOp(d, { entity, entity_id: id, field: 'camp_id', value: campId, author_user_id: userId, device_id: deviceId })
  }
})
afterEach(() => {
  d.close()
  if (fs.existsSync(file)) fs.unlinkSync(file)
})

const plan = (over = {}) => ({
  name: 'Maccabiah',
  columns: [{ columnName: 'Red', groupId: g1 }, { columnName: 'Blue', groupId: g2 }],
  timeBlocks: [
    { name: '9:15-9:45', sort_order: 0, start_time: '9:15', end_time: '9:45' },
    { name: '10:15', sort_order: 1, start_time: '10:15', end_time: null },
  ],
  activities: [{ name: 'Relay', activityId: relayId }, { name: 'Tug', activityId: null }],
  newActivityNames: ['Tug'],
  slots: [
    { columnName: 'Red', blockName: '9:15-9:45', activityName: 'Relay' },
    { columnName: 'Blue', blockName: '10:15', activityName: 'Tug' },
  ],
  notes: 'From the imported file - cells that named a person:\nRed 10:15: Pool - Unit Heads',
  ready: true,
  blockedBy: [],
  ...over,
})

const commit = (specialDay, extra = {}) => commitIngest(d, {
  camp_id: campId, approved: {}, links: {}, specialDay, author_user_id: userId, device_id: deviceId, mode: 'add', ...extra,
})
const ids = (table) => d.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map((r) => r.id)
const counts = () => Object.fromEntries(['special_days', 'special_day_time_blocks', 'special_day_slots'].map((t) => [t, ids(t).length]))

describe('special-day commit lives in commitPlan', () => {
  it('writes the day, its periods and its cells', () => {
    commit(plan())
    expect(counts()).toEqual({ special_days: 1, special_day_time_blocks: 2, special_day_slots: 2 })
    const day = d.prepare('SELECT * FROM special_days').get()
    expect(day).toMatchObject({ name: 'Maccabiah', camp_id: campId })
    expect(d.prepare("SELECT id FROM activities WHERE name = 'Tug'").all()).toHaveLength(1)
  })

  it('importing the same file twice leaves identical row counts and ids', () => {
    commit(plan())
    const first = { days: ids('special_days'), blocks: ids('special_day_time_blocks'), slots: ids('special_day_slots'), acts: ids('activities') }
    const again = commit(plan({ activities: [{ name: 'Relay', activityId: relayId }, { name: 'Tug', activityId: first.acts.find((a) => a !== relayId) }] }))
    expect({ days: ids('special_days'), blocks: ids('special_day_time_blocks'), slots: ids('special_day_slots'), acts: ids('activities') }).toEqual(first)
    expect(again.specialDay).toMatchObject({ created: false })
  })

  it('stamps the import run id on the day', () => {
    const out = commit(plan())
    const ev = d.prepare("SELECT import_run_id FROM import_evidence WHERE entity_type = 'special_days'").all()
    expect(ev.map((e) => e.import_run_id)).toEqual([out.importRunId])
  })

  it('a failure mid-commit leaves nothing', () => {
    const bad = plan({ slots: [...plan().slots, { columnName: 'Red', blockName: '10:15', activityName: 'Relay' }], columns: [{ columnName: 'Red', groupId: g1 }, { columnName: 'Blue', groupId: 'no-such-group' }] })
    expect(() => commit(bad)).toThrow()
    expect(counts()).toEqual({ special_days: 0, special_day_time_blocks: 0, special_day_slots: 0 })
    expect(d.prepare("SELECT id FROM activities WHERE name = 'Tug'").all()).toHaveLength(0)
  })

  it('refuses a plan that is not ready, writing nothing', () => {
    expect(() => commit(plan({ ready: false, blockedBy: ['unmatched_columns'] }))).toThrow(/not ready/i)
    expect(counts().special_days).toBe(0)
  })

  it('Undo import removes the day, its children and the activities it minted', () => {
    const out = commit(plan(), { captureInverse: true })
    expect(counts().special_days).toBe(1)
    const res = ingestUndo(d, { invertibleOps: out.invertibleOps, createdEntityIds: out.createdEntityIds, importRunId: out.importRunId, author_user_id: userId, device_id: deviceId, client_write_id: randomUUID() })
    expect(res.kept).toEqual([])
    expect(counts()).toEqual({ special_days: 0, special_day_time_blocks: 0, special_day_slots: 0 })
    expect(d.prepare("SELECT id FROM activities WHERE name = 'Tug'").all()).toHaveLength(0)
    expect(d.prepare("SELECT id FROM activities WHERE id = ?").all(relayId)).toHaveLength(1)
    expect(d.prepare("SELECT id FROM import_evidence WHERE entity_type = 'special_days'").all()).toHaveLength(0)
  })

  it('a minted activity gets an id derived from camp and name, so two devices converge', async () => {
    commit(plan())
    const { deriveSpecialDayActivityId } = await import('./electiveDerivedIds.js')
    const tug = d.prepare("SELECT id FROM activities WHERE name = 'Tug'").all()
    expect(tug.map((r) => r.id)).toEqual([deriveSpecialDayActivityId(campId, 'Tug')])
  })
})

describe('slice 3b bug (a): a renamed import-created activity is not overwritten by a re-import', () => {
  it('import, rename the activity, delete the day, re-import: the new name is kept and nothing is duplicated', async () => {
    const { deriveSpecialDayActivityId } = await import('./electiveDerivedIds.js')
    commit(plan())
    const tugId = deriveSpecialDayActivityId(campId, 'Tug')
    appendOp(d, { entity: 'activities', entity_id: tugId, field: 'name', value: 'Tug of War', author_user_id: userId, device_id: deviceId })
    d.prepare('DELETE FROM special_day_slots').run()
    d.prepare('DELETE FROM special_day_time_blocks').run()
    d.prepare('DELETE FROM special_days').run()
    const again = commit(plan())
    expect(d.prepare('SELECT name FROM activities WHERE id = ?').get(tugId).name).toBe('Tug of War')
    expect(d.prepare("SELECT id FROM activities WHERE camp_id = ? AND name IN ('Tug', 'Tug of War')").all(campId)).toHaveLength(1)
    expect(again.specialDay).toMatchObject({ created: true, activitiesCreated: 0 })
  })
})

describe('slice 3b bug (b): the plan is honest about columns and periods that collide or do not resolve', () => {
  it('two columns resolving to the same group are refused, nothing written', () => {
    const bad = plan({ columns: [{ columnName: 'Red', groupId: g1 }, { columnName: 'Crimson', groupId: g1 }], slots: [
      { columnName: 'Red', blockName: '9:15-9:45', activityName: 'Relay' }, { columnName: 'Crimson', blockName: '9:15-9:45', activityName: 'Tug' },
    ] })
    expect(() => commit(bad)).toThrow(/same group/i)
    expect(counts()).toEqual({ special_days: 0, special_day_time_blocks: 0, special_day_slots: 0 })
  })

  it('two periods with the same sort_order are refused, nothing written', () => {
    const bad = plan({ timeBlocks: [{ name: 'A', sort_order: 0 }, { name: 'B', sort_order: 0 }], slots: [{ columnName: 'Red', blockName: 'A', activityName: 'Relay' }, { columnName: 'Red', blockName: 'B', activityName: 'Tug' }] })
    expect(() => commit(bad)).toThrow(/same order|sort/i)
    expect(counts()).toEqual({ special_days: 0, special_day_time_blocks: 0, special_day_slots: 0 })
  })

  it('a cell naming a column or period the plan does not have is refused rather than skipped (counts stay truthful)', () => {
    const bad = plan({ slots: [...plan().slots, { columnName: 'Green', blockName: '10:15', activityName: 'Relay' }] })
    expect(() => commit(bad)).toThrow(/Green/)
    expect(counts().special_day_slots).toBe(0)
    const bad2 = plan({ slots: [...plan().slots, { columnName: 'Red', blockName: 'no such period', activityName: 'Relay' }] })
    expect(() => commit(bad2)).toThrow(/no such period/)
  })
})


describe('F3/F4 slice 4: a one-day file is placed on its (week, day) in the same transaction', () => {
  let weekId, tueId
  beforeEach(() => {
    weekId = randomUUID()
    tueId = randomUUID()
    d.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order) VALUES (?, ?, ?, ?)').run(weekId, campId, 'Week 1', 0)
    d.prepare('INSERT INTO days_of_operation (id, camp_id, label, day_of_week, sort_order) VALUES (?, ?, ?, ?, ?)').run(tueId, campId, 'Tuesday', 2, 1)
  })
  const placements = () => d.prepare('SELECT * FROM special_day_placements').all()

  it('writes one placement bound to the new day', () => {
    const out = commit(plan({ placement: { weekId, dayId: tueId } }))
    expect(placements()).toMatchObject([{ week_id: weekId, day_id: tueId, special_day_id: out.specialDay.specialDayId }])
    expect(out.specialDay).toMatchObject({ created: true, placed: true })
  })

  it('no placement requested writes none', () => {
    commit(plan())
    expect(placements()).toHaveLength(0)
  })

  it('re-import is idempotent: same placement row, nothing doubled', () => {
    commit(plan({ placement: { weekId, dayId: tueId } }))
    const first = placements()
    expect(first).toHaveLength(1)
    commit(plan({ placement: { weekId, dayId: tueId } }))
    expect(placements()).toEqual(first)
    expect(counts().special_days).toBe(1)
  })

  it('Undo removes the placement with the day', () => {
    const out = commit(plan({ placement: { weekId, dayId: tueId } }), { captureInverse: true })
    expect(placements()).toHaveLength(1)
    ingestUndo(d, { invertibleOps: out.invertibleOps, createdEntityIds: out.createdEntityIds, importRunId: out.importRunId, author_user_id: userId, device_id: deviceId, client_write_id: randomUUID() })
    expect(placements()).toHaveLength(0)
    expect(counts().special_days).toBe(0)
  })

  it('an occupied (week, day) keeps the existing binding: no new day is created, and the outcome says so', () => {
    const other = commit(plan({ name: 'Games Day', placement: { weekId, dayId: tueId } }))
    const out = commit(plan({ placement: { weekId, dayId: tueId } }))
    expect(out.specialDay).toMatchObject({ created: false, placed: false, keptExisting: true })
    expect(counts().special_days).toBe(1)
    expect(placements()).toMatchObject([{ special_day_id: other.specialDay.specialDayId }])
  })

  it('a week or day that is not this camp\'s is refused, nothing written', () => {
    expect(() => commit(plan({ placement: { weekId: 'nope', dayId: tueId } }))).toThrow(/week/i)
    expect(() => commit(plan({ placement: { weekId, dayId: 'nope' } }))).toThrow(/day/i)
    expect(counts().special_days).toBe(0)
  })
})

describe('F3/F4 slice 4 review: placement honours the director\'s selection and the holder that is really there', () => {
  let weekId, tueId
  beforeEach(() => {
    weekId = randomUUID()
    tueId = randomUUID()
    d.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order) VALUES (?, ?, ?, ?)').run(weekId, campId, 'Week 1', 0)
    d.prepare('INSERT INTO days_of_operation (id, camp_id, label, day_of_week, sort_order) VALUES (?, ?, ?, ?, ?)').run(tueId, campId, 'Tuesday', 2, 1)
  })
  const placements = () => d.prepare('SELECT * FROM special_day_placements').all()

  it('re-import of an existing UNPLACED day whose week and day now resolve places it: the placement is the only new row', () => {
    commit(plan())
    const before = { counts: counts(), acts: ids('activities'), days: ids('special_days') }
    expect(placements()).toHaveLength(0)
    const out = commit(plan({ placement: { weekId, dayId: tueId } }))
    expect(out.specialDay).toMatchObject({ created: false, placed: true })
    expect(out.specialDay.keptExisting).toBeUndefined()
    expect({ counts: counts(), acts: ids('activities'), days: ids('special_days') }).toEqual(before)
    expect(placements()).toMatchObject([{ week_id: weekId, day_id: tueId, special_day_id: before.days[0] }])
  })

  it('re-placing into an occupied (week, day) still keeps the existing binding', () => {
    commit(plan({ name: 'Games Day', placement: { weekId, dayId: tueId } }))
    commit(plan())
    const out = commit(plan({ placement: { weekId, dayId: tueId } }))
    expect(out.specialDay).toMatchObject({ created: false, placed: false, keptExisting: true })
    expect(placements()).toHaveLength(1)
  })

  it('a hand-built day of the same name that already holds the (week, day) is reported placed, not kept-existing', () => {
    const handId = randomUUID()
    appendOp(d, { entity: 'special_days', entity_id: handId, field: 'name', value: 'Maccabiah', author_user_id: userId, device_id: deviceId })
    appendOp(d, { entity: 'special_days', entity_id: handId, field: 'camp_id', value: campId, author_user_id: userId, device_id: deviceId })
    const placementId = deriveSpecialDayPlacementId(weekId, tueId)
    for (const [field, value] of [['week_id', weekId], ['day_id', tueId], ['special_day_id', handId]]) {
      appendOp(d, { entity: 'special_day_placements', entity_id: placementId, field, value, author_user_id: userId, device_id: deviceId })
    }
    const out = commit(plan({ placement: { weekId, dayId: tueId } }))
    expect(out.specialDay).toMatchObject({ created: false, specialDayId: handId, placed: true })
    expect(out.specialDay.keptExisting).toBeUndefined()
    expect(counts().special_days).toBe(1)
    expect(placements()).toHaveLength(1)
  })
})

describe('first import on a fresh camp: a one-day file placed on Week 1 creates it in the same transaction', () => {
  it('no weeks at all: the placement on the deterministic Week 1 creates the week, the day and the placement together', () => {
    const tueId = randomUUID()
    d.prepare('INSERT INTO days_of_operation (id, camp_id, label, day_of_week, sort_order) VALUES (?, ?, ?, ?, ?)').run(tueId, campId, 'Tuesday', 2, 1)
    expect(d.prepare('SELECT COUNT(*) c FROM schedule_weeks').get().c).toBe(0)
    const out = commit(plan({ placement: { weekId: defaultWeekId(campId), dayId: tueId } }))
    expect(out.specialDay).toMatchObject({ created: true, placed: true })
    expect(d.prepare('SELECT id, name FROM schedule_weeks').all()).toEqual([{ id: defaultWeekId(campId), name: 'Week 1' }])
    expect(d.prepare('SELECT week_id, day_id FROM special_day_placements').all()).toEqual([{ week_id: defaultWeekId(campId), day_id: tueId }])
  })

  it('a failure after the week is created rolls the week back too', () => {
    const tueId = randomUUID()
    d.prepare('INSERT INTO days_of_operation (id, camp_id, label, day_of_week, sort_order) VALUES (?, ?, ?, ?, ?)').run(tueId, campId, 'Tuesday', 2, 1)
    const bad = plan({ placement: { weekId: defaultWeekId(campId), dayId: tueId }, columns: [{ columnName: 'Red', groupId: g1 }, { columnName: 'Blue', groupId: 'no-such-group' }] })
    expect(() => commit(bad)).toThrow()
    expect(d.prepare('SELECT COUNT(*) c FROM schedule_weeks').get().c).toBe(0)
  })
})

describe('F3/F4 slice 5: no catalog activity is minted where an equivalent one exists', () => {
  let towId
  beforeEach(() => {
    towId = randomUUID()
    appendOp(d, { entity: 'activities', entity_id: towId, field: 'name', value: 'Tug of War', author_user_id: userId, device_id: deviceId })
    appendOp(d, { entity: 'activities', entity_id: towId, field: 'camp_id', value: campId, author_user_id: userId, device_id: deviceId })
  })
  const tugPlan = (name) => plan({
    activities: [{ name, activityId: null }],
    slots: [{ columnName: 'Red', blockName: '9:15-9:45', activityName: name }],
  })
  const activityCount = () => d.prepare('SELECT COUNT(*) c FROM activities').get().c

  it.each(['tug of war ', 'Tug  of  War', 'TugOfWar'])('"%s" mints nothing and its cell points at the existing activity', (name) => {
    const before = activityCount()
    const out = commit(tugPlan(name))
    expect(activityCount()).toBe(before)
    expect(out.specialDay.activitiesCreated).toBe(0)
    expect(d.prepare('SELECT activity_id FROM special_day_slots').all()).toEqual([{ activity_id: towId }])
  })

  it.each(['Tug-of-War', 'Tug_of_War', 'Tug of War!'])('"%s" mints nothing with NO alias: punctuation reads as a space', (name) => {
    const before = activityCount()
    const out = commit(tugPlan(name))
    expect(activityCount()).toBe(before)
    expect(out.specialDay.activitiesCreated).toBe(0)
    expect(d.prepare('SELECT activity_id FROM special_day_slots').all()).toEqual([{ activity_id: towId }])
  })

  it('"Arts & Crafts" and "Arts and Crafts" stay two activities (pinned: & is not the word "and")', () => {
    appendOp(d, { entity: 'activities', entity_id: randomUUID(), field: 'name', value: 'Arts and Crafts', author_user_id: userId, device_id: deviceId })
    const before = activityCount()
    commit(tugPlan('Arts & Crafts'))
    expect(activityCount()).toBe(before + 1)
  })

  it('"T-Ball" matches an existing "Tball" (pinned: the same typo class as "Lunch2" / "Lunch 2")', () => {
    const tball = randomUUID()
    appendOp(d, { entity: 'activities', entity_id: tball, field: 'name', value: 'Tball', author_user_id: userId, device_id: deviceId })
    appendOp(d, { entity: 'activities', entity_id: tball, field: 'camp_id', value: campId, author_user_id: userId, device_id: deviceId })
    const before = activityCount()
    commit(tugPlan('T-Ball'))
    expect(activityCount()).toBe(before)
    expect(d.prepare('SELECT activity_id FROM special_day_slots').all()).toEqual([{ activity_id: tball }])
  })

  it('"Tug-of-War" mints nothing when the director confirmed it as an alias of "Tug of War"', () => {
    d.prepare("INSERT INTO source_aliases (id, camp_id, entity_type, cohort_id, source_label, entity_id, status, confirmed_at) VALUES (?, ?, 'activities', NULL, 'Tug-of-War', ?, 'active', '2026-01-01')").run(randomUUID(), campId, towId)
    const before = activityCount()
    commit(tugPlan('Tug-of-War'))
    expect(activityCount()).toBe(before)
    expect(d.prepare('SELECT activity_id FROM special_day_slots').all()).toEqual([{ activity_id: towId }])
  })

  it('a genuinely new name still mints, and Undo removes it', () => {
    const before = activityCount()
    const out = commit(tugPlan('Water Balloon Toss'), { captureInverse: true })
    expect(activityCount()).toBe(before + 1)
    ingestUndo(d, { invertibleOps: out.invertibleOps, createdEntityIds: out.createdEntityIds, importRunId: out.importRunId, author_user_id: userId, device_id: deviceId, client_write_id: randomUUID() })
    expect(activityCount()).toBe(before)
  })
})

describe('F3/F4 slice 4: the synthetic one-day files (s02, s05, s09) place when the name says a weekday', () => {
  const SYN = path.join(process.cwd(), 'docs/work/specs/samples/synthetic')
  const FILES = JSON.parse(fs.readFileSync(path.join(SYN, 'manifest.json'), 'utf8')).specialDayFiles
  it.each(FILES.map((f) => [f.slug.slice(0, 3), f]))('%s', (_slug, f) => {
    const weekId = randomUUID()
    const tueId = randomUUID()
    d.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order) VALUES (?, ?, ?, ?)').run(weekId, campId, 'Week 1', 0)
    d.prepare('INSERT INTO days_of_operation (id, camp_id, label, day_of_week, sort_order) VALUES (?, ?, ?, ?, ?)').run(tueId, campId, 'Tuesday', 2, 1)
    for (const name of f.groups) {
      const id = randomUUID()
      appendOp(d, { entity: 'groups', entity_id: id, field: 'name', value: name, author_user_id: userId, device_id: deviceId })
      appendOp(d, { entity: 'groups', entity_id: id, field: 'camp_id', value: campId, author_user_id: userId, device_id: deviceId })
    }
    const proposal = proposeSpecialDay(parseTextGrid(fs.readFileSync(path.join(SYN, f.file), 'utf8')).pages)
    const built = buildSpecialDayPlan(proposal, {
      groups: d.prepare('SELECT * FROM groups WHERE camp_id = ?').all(campId),
      activities: d.prepare('SELECT * FROM activities WHERE camp_id = ?').all(campId),
      specialDays: [],
    })
    const live = { days: d.prepare('SELECT * FROM days_of_operation').all(), weeks: [{ id: weekId }], weekId }
    const bare = resolveSpecialDayPlacement({ texts: [path.basename(f.file)], ...live })
    expect(bare.placement).toBeNull()
    expect(bare.flag).toBeTruthy()
    const named = resolveSpecialDayPlacement({ texts: [`Tuesday ${path.basename(f.file)}`], ...live })
    commit({ ...built, placement: named.placement })
    expect(d.prepare('SELECT COUNT(*) c FROM special_day_placements').get().c).toBe(1)
  })
})

describe('meals and camp events in a one-day file are events, never plain catalogue activities', () => {
  const days = (extra) => plan({
    activities: [{ name: 'Lunch', activityId: null }, { name: 'Mifkad', activityId: null }],
    newActivityNames: [],
    slots: [
      { columnName: 'Red', blockName: '9:15-9:45', activityName: 'Lunch' },
      { columnName: 'Blue', blockName: '10:15', activityName: 'Mifkad' },
    ],
    ...extra,
  })
  const rowsNamed = (name) => d.prepare('SELECT id, catalog_role FROM activities WHERE camp_id = ? AND name = ?').all(campId, name)

  it('mints a meal as a pinned_event marker', () => {
    commit(days())
    const rows = rowsNamed('Lunch')
    expect(rows).toHaveLength(1)
    expect(rows[0].catalog_role).toBe('pinned_event')
    const cell = d.prepare('SELECT activity_id FROM special_day_slots WHERE activity_id = ?').get(rows[0].id)
    expect(cell).toBeTruthy()
  })

  it('reuses the activity behind a camp fixed event of that name', () => {
    const markerId = randomUUID()
    const feId = randomUUID()
    for (const [entity, id, fields] of [
      ['activities', markerId, { camp_id: campId, name: 'Flag Raising', catalog_role: 'pinned_event' }],
      ['fixed_events', feId, { camp_id: campId, name: 'Mifkad', activity_id: markerId }],
    ]) for (const [field, value] of Object.entries(fields)) appendOp(d, { entity, entity_id: id, field, value, author_user_id: userId, device_id: deviceId })
    commit(days())
    expect(rowsNamed('Mifkad')).toEqual([])
    expect(d.prepare('SELECT COUNT(*) c FROM special_day_slots WHERE activity_id = ?').get(markerId).c).toBe(1)
  })

  it('a second one-day file with the same meal mints nothing twice', () => {
    commit(days())
    commit(days({ name: 'Another Day' }))
    expect(rowsNamed('Lunch')).toHaveLength(1)
  })
})

describe('one-day events: dangling event activity, spacing, cross-import order, undo, plan agreement', () => {
  const mk = (entity, id, fields) => { for (const [field, value] of Object.entries(fields)) appendOp(d, { entity, entity_id: id, field, value, author_user_id: userId, device_id: deviceId }) }
  const oneDayFile = (title, names) => proposeSpecialDay([{
    title, columns: ['Red', 'Blue'],
    rows: [{ label: '9:15-9:45', cells: [names[0], names[0]] }, { label: '10:15', cells: [names[1], names[1]] }],
  }])
  const live = () => ({
    groups: d.prepare('SELECT id, name FROM groups WHERE camp_id = ?').all(campId),
    activities: d.prepare('SELECT id, name, catalog_role FROM activities WHERE camp_id = ?').all(campId),
    specialDays: d.prepare('SELECT id, name FROM special_days WHERE camp_id = ?').all(campId),
    fixedEvents: d.prepare('SELECT name, activity_id FROM fixed_events WHERE camp_id = ?').all(campId),
  })
  const rowsNamed = (name) => d.prepare('SELECT id, catalog_role FROM activities WHERE camp_id = ? AND name = ?').all(campId, name)

  it('a dangling event activity_id: the plan lists the name as an event and the commit mints a marker', () => {
    mk('fixed_events', randomUUID(), { camp_id: campId, name: 'Mifkad', activity_id: randomUUID() })
    const p = buildSpecialDayPlan(oneDayFile('Dangling Day', ['Mifkad', 'Relay']), live())
    expect(p.eventNames).toEqual(['Mifkad'])
    expect(p.reusedActivityNames).not.toContain('Mifkad')
    commit(p)
    expect(rowsNamed('Mifkad')).toMatchObject([{ catalog_role: 'pinned_event' }])
  })

  it('"Ga Ga" in the file is the fixed event "GaGa": no catalogue activity is minted', () => {
    const markerId = randomUUID()
    mk('activities', markerId, { camp_id: campId, name: 'Gaga Marker', catalog_role: 'pinned_event' })
    mk('fixed_events', randomUUID(), { camp_id: campId, name: 'GaGa', activity_id: markerId })
    const p = buildSpecialDayPlan(oneDayFile('Spacing Day', ['Ga Ga', 'Relay']), live())
    commit(p)
    expect(rowsNamed('Ga Ga')).toEqual([])
    expect(d.prepare('SELECT COUNT(*) c FROM special_day_slots WHERE activity_id = ?').get(markerId).c).toBeGreaterThan(0)
  })

  const weeklyLunch = () => {
    const marker = rowsNamed('Lunch')
    expect(marker).toHaveLength(1)
    const feId = randomUUID()
    mk('fixed_events', feId, { camp_id: campId, name: 'Lunch', activity_id: marker[0].id })
    return { feId, markerId: marker[0].id }
  }

  it('(a) one-day Lunch, then a weekly fixed event Lunch: one Lunch activity, referenced by the event', () => {
    commit(buildSpecialDayPlan(oneDayFile('Day One', ['Lunch', 'Relay']), live()))
    const { markerId } = weeklyLunch()
    expect(rowsNamed('Lunch')).toHaveLength(1)
    expect(d.prepare("SELECT activity_id FROM fixed_events WHERE name = 'Lunch'").get().activity_id).toBe(markerId)
  })

  it('(b) undoing the one-day import keeps a marker a fixed event still references', () => {
    const out = commit(buildSpecialDayPlan(oneDayFile('Day One', ['Lunch', 'Relay']), live()), { captureInverse: true })
    const { markerId } = weeklyLunch()
    expect(JSON.stringify(out.createdEntityIds)).toContain(markerId)
    const res = ingestUndo(d, { invertibleOps: out.invertibleOps, createdEntityIds: out.createdEntityIds, importRunId: out.importRunId, author_user_id: userId, device_id: deviceId, client_write_id: randomUUID() })
    expect(JSON.stringify(res.kept)).toContain(markerId)
    expect(d.prepare('SELECT 1 FROM special_days').get()).toBeUndefined()
    const dangling = d.prepare('SELECT fe.id FROM fixed_events fe LEFT JOIN activities a ON a.id = fe.activity_id WHERE fe.activity_id IS NOT NULL AND a.id IS NULL').all()
    expect(dangling).toEqual([])
    expect(rowsNamed('Lunch').map((r) => r.id)).toEqual([markerId])
  })

  it('the plan\'s newActivityNames / eventNames equal what the commit actually creates', () => {
    const before = new Set(ids('activities'))
    const p = buildSpecialDayPlan(oneDayFile('Agree Day', ['Lunch', 'Relay2']), live())
    commit(p)
    const created = d.prepare('SELECT name, catalog_role FROM activities WHERE camp_id = ?').all(campId)
      .filter((r) => !before.has(d.prepare('SELECT id FROM activities WHERE name = ?').get(r.name).id))
    expect(created.filter((r) => r.catalog_role !== 'pinned_event').map((r) => r.name)).toEqual(p.newActivityNames)
    expect(created.filter((r) => r.catalog_role === 'pinned_event').map((r) => r.name)).toEqual(p.eventNames)
  })
})
