// @vitest-environment node
//
// Every template_slots writer must carry every template_slots column. Before
// this file, mapSlotToRow never wrote elective_set_id/event_id/is_released, the
// bulk_replace column list had no is_released, and a saved version kept none of
// is_span_head/is_released/elective_set_id/event_id — so Generate emptied
// elective and event cells, and restore/duplicate dropped released state.
//
// The parity block enumerates columns from the REAL schema (PRAGMA table_info on
// a templated db), so a future column that some writer forgets fails here.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../electron/db/testDbTemplate.js'
import { appendBulkReplaceOp } from '../../electron/ops/operations.js'
import { duplicateWeek } from '../../electron/ops/duplicateWeek.js'
import { deriveScheduleTemplateId } from '../../electron/ops/scheduleTemplateId.js'
import buildSchedule from '../engine/buildSchedule.js'
import { normalizeSlots } from '../utils/normalizeSlots.js'
import { createScheduleRepository, toSnapshotSlot } from './scheduleRepository.js'

afterAll(() => cleanupTemplatedDbs())

let db, file, repo
const WEEK = 'week-1'
const TEMPLATES = { manual: deriveScheduleTemplateId(WEEK, 'manual'), generated: deriveScheduleTemplateId(WEEK, 'generated') }

beforeEach(() => {
  ;({ db, file } = openTemplatedDb())
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('dev-1', 'Device')
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp')
  db.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run('user-1', 'camp-1', 'A', 'h', 's', 'admin')
  db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('g1', 'camp-1', 'g1')
  db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('swim', 'camp-1', 'swim')
  db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, ?, 0, 0)').run(WEEK, 'camp-1', 'Week 1')
  for (const [kind, id] of Object.entries(TEMPLATES)) {
    db.prepare('INSERT INTO schedule_templates (id, camp_id, week_id, kind, name) VALUES (?, ?, ?, ?, ?)').run(id, 'camp-1', WEEK, kind, '')
  }
  const localClient = {
    bulkReplace: async (_tok, entity, scope_id, rows) =>
      appendBulkReplaceOp(db, { entity, scope_id, rows, author_user_id: 'user-1', device_id: 'dev-1' }),
  }
  repo = createScheduleRepository({ localClient, getToken: () => 'tok' })
})

afterEach(() => {
  db.close()
  if (fs.existsSync(file)) fs.unlinkSync(file)
})

const rowsFor = (templateId) =>
  db.prepare('SELECT * FROM template_slots WHERE template_id = ? ORDER BY time_block_id').all(templateId)
const slotColumns = () => db.pragma('table_info(template_slots)').map(c => c.name)

describe('Generate / regenerate keep authored cells (both routes)', () => {
  const group = { id: 'g1', name: 'g1', tier_id: 't1', availability: 'all' }
  const day = { id: 'd1', label: 'Mon', day_of_week: 1, sort_order: 0 }
  const blocks = ['b1', 'b2', 'b3'].map((id, i) => ({ id, name: id, start_time: `0${i + 7}:00`, end_time: `0${i + 7}:45`, sort_order: i, part_of_day: 'morning' }))

  // Mirrors useGeneration.generate()'s preplaced derivation from stored rows.
  function generateFrom(templateId) {
    const stored = normalizeSlots(rowsFor(templateId))
    const preplacedSlots = [
      ...stored.filter(s => s.elective_set_id).map(s => ({ groupId: s.group_id, dayId: s.day_id, blockId: s.time_block_id, electiveSetId: s.elective_set_id })),
      ...stored.filter(s => s.event_id).map(s => ({ groupId: s.group_id, dayId: s.day_id, blockId: s.time_block_id, eventId: s.event_id })),
    ]
    return buildSchedule({
      groups: [group], tiers: [{ id: 't1', name: 'T' }], days: [day], timeBlocks: blocks, activities: [], fixedEvents: [],
      campId: 'camp-1', preplacedSlots,
      electiveSetActivities: [{ id: 'm1', elective_set_id: 'es-1', activity_id: 'swim' }],
      events: [{ id: 'ev-1', name: 'Show', location_id: null }],
    }).slots
  }

  for (const route of ['manual', 'generated']) {
    it(`${route}: elective_set_id and event_id survive Generate then regenerate`, async () => {
      const tid = TEMPLATES[route]
      db.prepare("INSERT INTO template_slots (id, template_id, group_id, day_id, time_block_id, elective_set_id, is_released) VALUES ('s1', ?, 'g1', 'd1', 'b1', 'es-1', 1)").run(tid)
      db.prepare("INSERT INTO template_slots (id, template_id, group_id, day_id, time_block_id, event_id) VALUES ('s2', ?, 'g1', 'd1', 'b2', 'ev-1')").run(tid)

      await repo.replaceWeek(tid, generateFrom(tid))
      await repo.replaceWeek(tid, generateFrom(tid))

      const [b1, b2] = rowsFor(tid)
      expect(b1.elective_set_id).toBe('es-1')
      expect(b2.event_id).toBe('ev-1')
    })
  }
})

describe('slot column parity: every writer round-trips every template_slots column', () => {
  // Three rows because activity_id / elective_set_id / event_id are mutually
  // exclusive; together they put a non-null value in every column.
  function seedFullRows(templateId) {
    const rows = [
      { time_block_id: 'b1', activity_id: 'swim', fixed_event_id: 'fe-1', is_fixed_event: 1, is_span_head: 1, is_released: 1, flags: '{"UNFILLABLE":true}' },
      { time_block_id: 'b2', elective_set_id: 'es-1', is_fixed_event: 0, is_span_head: 0, is_released: 0, flags: '{}' },
      { time_block_id: 'b3', event_id: 'ev-1', is_fixed_event: 0, is_span_head: 1, is_released: 1, flags: '{}' },
    ].map((r, i) => ({ id: `src-${i}`, template_id: templateId, group_id: 'g1', day_id: 'd1', ...r }))
    for (const row of rows) {
      const cols = Object.keys(row)
      db.prepare(`INSERT INTO template_slots (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => row[c]))
    }
    const unpopulated = slotColumns().filter(c => rows.every(r => r[c] == null))
    expect(unpopulated, 'parity fixture must give every schema column a value — add the new column to seedFullRows').toEqual([])
    return rowsFor(templateId)
  }

  function expectSameContent(source, copied) {
    const content = slotColumns().filter(c => c !== 'id' && c !== 'template_id')
    const pick = r => Object.fromEntries(content.map(c => [c, r[c] == null ? null : String(r[c])]))
    expect(copied.map(pick)).toEqual(source.map(pick))
  }

  it('save version -> restore version', async () => {
    const tid = TEMPLATES.generated
    const source = seedFullRows(tid)
    const snapshot = JSON.parse(JSON.stringify(normalizeSlots(source).map(toSnapshotSlot)))
    await repo.restoreSnapshotRows(tid, snapshot)
    expectSameContent(source, rowsFor(tid))
  })

  it('bulk_replace of stored rows', () => {
    const tid = TEMPLATES.generated
    const source = seedFullRows(tid)
    const rows = source.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? null : String(v)])))
    appendBulkReplaceOp(db, { entity: 'template_slots', scope_id: tid, rows, author_user_id: 'user-1', device_id: 'dev-1' })
    expectSameContent(source, rowsFor(tid))
  })

  it('duplicate week', () => {
    const source = seedFullRows(TEMPLATES.manual)
    const { newWeekId } = duplicateWeek(db, { sourceWeekId: WEEK, campId: 'camp-1' }, { author_user_id: 'user-1', device_id: 'dev-1' })
    expectSameContent(source, rowsFor(deriveScheduleTemplateId(newWeekId, 'manual')))
  })

  it('Generate (engine slot -> row) writes every column the engine can author', async () => {
    // is_released is the one exemption: the engine has no released input — a
    // released cell is deliberately NOT pre-placed (useGeneration.generate), so
    // regenerate is free to put anything there.
    const tid = TEMPLATES.generated
    const engineSlot = { groupId: 'g1', dayId: 'd1', blockId: 'b1', type: 'activity', activityId: 'swim', fixedEventId: 'fe-1', electiveSetId: null, eventId: null, is_span_head: true, flags: {} }
    let written
    const captureRepo = createScheduleRepository({ localClient: { bulkReplace: async (_t, _e, _s, rows) => { written = rows } }, getToken: () => 'tok' })
    await captureRepo.replaceWeek(tid, [engineSlot])
    const missing = slotColumns().filter(c => c !== 'is_released' && !(c in written[0]))
    expect(missing).toEqual([])
  })
})
