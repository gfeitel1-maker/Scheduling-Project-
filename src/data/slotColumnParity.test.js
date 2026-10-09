// @vitest-environment jsdom
//
// Every template_slots writer must carry every template_slots column. Before
// this file, mapSlotToRow never wrote elective_set_id/event_id/is_released, the
// bulk_replace column list had no is_released, and saved versions (the
// Versions panel's and deleteRecord's safety snapshot) kept none of
// is_span_head/is_released/elective_set_id/event_id — so Generate emptied
// elective and event cells, and restore/duplicate dropped released state.
//
// The parity block enumerates columns from the REAL schema (PRAGMA table_info on
// a templated db), so a future column that some writer forgets fails here. Each
// case drives the production writer itself, not a copy of its mapping.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import fs from 'node:fs'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../electron/db/testDbTemplate.js'
import { appendOp, appendBulkReplaceOp } from '../../electron/ops/operations.js'
import { duplicateWeek } from '../../electron/ops/duplicateWeek.js'
import { deleteRecord } from '../../electron/ops/deleteRecord.js'
import { deriveScheduleTemplateId } from '../../electron/ops/scheduleTemplateId.js'
import buildSchedule from '../engine/buildSchedule.js'
import { normalizeSlots } from '../utils/normalizeSlots.js'
import { derivePreplacedSlots } from '../screens/schedule/preplacedSlots.js'
import { useSnapshots } from '../screens/schedule/useSnapshots.js'
import { createScheduleRepository } from './scheduleRepository.js'

afterAll(() => cleanupTemplatedDbs())

let db, file, repo
const WEEK = 'week-1'
const TEMPLATES = { manual: deriveScheduleTemplateId(WEEK, 'manual'), generated: deriveScheduleTemplateId(WEEK, 'generated') }
const AUTHOR = { author_user_id: 'user-1', device_id: 'dev-1' }

beforeEach(() => {
  ;({ db, file } = openTemplatedDb())
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('dev-1', 'Device')
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp')
  db.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run('user-1', 'camp-1', 'A', 'h', 's', 'admin')
  for (const g of ['g1', 'g2']) db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run(g, 'camp-1', g)
  db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run('swim', 'camp-1', 'swim')
  db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, ?, 0, 0)').run(WEEK, 'camp-1', 'Week 1')
  for (const [kind, id] of Object.entries(TEMPLATES)) {
    db.prepare('INSERT INTO schedule_templates (id, camp_id, week_id, kind, name) VALUES (?, ?, ?, ?, ?)').run(id, 'camp-1', WEEK, kind, '')
  }
  // The real write path for both localClient calls the repository makes here.
  const localClient = {
    write: async (_tok, entity, entity_id, field, value) => {
      appendOp(db, { entity, entity_id, field, value, ...AUTHOR })
      return { status: 'applied' }
    },
    list: async (entity) => db.prepare(`SELECT * FROM ${entity}`).all(),
    listByScope: async (entity, scopeId) => db.prepare(`SELECT * FROM ${entity} WHERE template_id = ?`).all(scopeId),
    bulkReplace: async (_tok, entity, scope_id, rows) => appendBulkReplaceOp(db, { entity, scope_id, rows, ...AUTHOR }),
  }
  repo = createScheduleRepository({ localClient, getToken: () => 'tok' })
})

afterEach(() => {
  db.close()
  if (fs.existsSync(file)) fs.unlinkSync(file)
})

const rowsFor = (templateId, groupId = 'g1') =>
  db.prepare('SELECT * FROM template_slots WHERE template_id = ? AND group_id = ? ORDER BY time_block_id').all(templateId, groupId)
const latestSnapshotId = () => db.prepare('SELECT id FROM schedule_snapshots ORDER BY created_at DESC LIMIT 1').get().id
const slotColumns = () => db.pragma('table_info(template_slots)').map(c => c.name)

// The real Versions hook over the real repository, on the generated route.
function renderSnapshots({ events = [{ id: 'ev-1' }], electiveSets = [{ id: 'es-1' }] } = {}) {
  const tid = TEMPLATES.generated
  const routeState = {
    route: 'generated',
    existingTemplates: { generated: true, manual: true },
    templateIdFor: () => tid,
    templateId: tid,
    slotsByRoute: { generated: normalizeSlots(db.prepare('SELECT * FROM template_slots WHERE template_id = ?').all(tid)), manual: [] },
    setSnapshotsByRoute: vi.fn(), setSnapshots: vi.fn(), setSlots: vi.fn(), setFindings: vi.fn(), setDismissedFindingKeys: vi.fn(),
  }
  const setActionError = vi.fn()
  const { result } = renderHook(() => useSnapshots({
    routeState, repo, setActionError, recalcStats: vi.fn(), resetUndoRedo: vi.fn(),
    groups: [{ id: 'g1' }], activities: [{ id: 'swim' }], days: [{ id: 'd1' }],
    timeBlocks: ['b1', 'b2', 'b3'].map(id => ({ id })), fixedEvents: [{ id: 'fe-1' }],
    events, electiveSets, weekId: WEEK,
  }))
  return { result, setActionError }
}

describe('Generate / regenerate keep authored cells (both routes)', () => {
  const group = { id: 'g1', name: 'g1', tier_id: 't1', availability: 'all' }
  const day = { id: 'd1', label: 'Mon', day_of_week: 1, sort_order: 0 }
  const blocks = ['b1', 'b2', 'b3'].map((id, i) => ({ id, name: id, start_time: `0${i + 7}:00`, end_time: `0${i + 7}:45`, sort_order: i, part_of_day: 'morning' }))
  const swim = { id: 'swim', name: 'Swim', is_locked: 1, priority: 'high', max_per_week: 5, min_per_week: 0, is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }

  function generateFrom(templateId) {
    const preplacedSlots = derivePreplacedSlots(normalizeSlots(rowsFor(templateId)), [swim])
    return buildSchedule({
      groups: [group], tiers: [{ id: 't1', name: 'T' }], days: [day], timeBlocks: blocks, activities: [swim], fixedEvents: [],
      campId: 'camp-1', preplacedSlots,
      electiveSetActivities: [{ id: 'm1', elective_set_id: 'es-1', activity_id: 'swim' }],
      events: [{ id: 'ev-1', name: 'Show', location_id: null }],
    }).slots
  }

  for (const route of ['manual', 'generated']) {
    it(`${route}: elective, event and locked cells survive Generate then regenerate`, async () => {
      const tid = TEMPLATES[route]
      db.prepare("INSERT INTO template_slots (id, template_id, group_id, day_id, time_block_id, elective_set_id, is_released) VALUES ('s1', ?, 'g1', 'd1', 'b1', 'es-1', 1)").run(tid)
      db.prepare("INSERT INTO template_slots (id, template_id, group_id, day_id, time_block_id, event_id) VALUES ('s2', ?, 'g1', 'd1', 'b2', 'ev-1')").run(tid)
      db.prepare("INSERT INTO template_slots (id, template_id, group_id, day_id, time_block_id, activity_id) VALUES ('s3', ?, 'g1', 'd1', 'b3', 'swim')").run(tid)

      await repo.replaceWeek(tid, generateFrom(tid))
      await repo.replaceWeek(tid, generateFrom(tid))

      const [b1, b2, b3] = rowsFor(tid)
      expect(b1.elective_set_id).toBe('es-1')
      expect(b2.event_id).toBe('ev-1')
      expect(b3.activity_id).toBe('swim')
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

  it('Versions panel: saveSnapshot -> restoreSnapshot', async () => {
    const tid = TEMPLATES.generated
    const source = seedFullRows(tid)
    const { result, setActionError } = renderSnapshots()
    await act(async () => { await result.current.saveSnapshot('v1', false) })
    db.prepare('DELETE FROM template_slots').run()
    await act(async () => { await result.current.restoreSnapshot({ id: latestSnapshotId() }) })
    expect(setActionError).not.toHaveBeenCalledWith(expect.any(String))
    expectSameContent(source, rowsFor(tid))
  })

  it("deleteRecord's safety snapshot -> restoreSnapshot", async () => {
    const tid = TEMPLATES.generated
    const source = seedFullRows(tid)
    db.prepare("INSERT INTO template_slots (id, template_id, group_id, day_id, time_block_id, activity_id) VALUES ('g2-slot', ?, 'g2', 'd1', 'b1', 'swim')").run(tid)
    const out = deleteRecord(db, { entity: 'groups', entity_id: 'g2', ...AUTHOR })
    expect(out.error).toBeUndefined()
    const { result } = renderSnapshots()
    db.prepare('DELETE FROM template_slots').run()
    await act(async () => { await result.current.restoreSnapshot({ id: latestSnapshotId() }) })
    expectSameContent(source, rowsFor(tid))
  })

  it('bulk_replace of stored rows', () => {
    const tid = TEMPLATES.generated
    const source = seedFullRows(tid)
    const rows = source.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? null : String(v)])))
    appendBulkReplaceOp(db, { entity: 'template_slots', scope_id: tid, rows, ...AUTHOR })
    expectSameContent(source, rowsFor(tid))
  })

  it('duplicate week', () => {
    const source = seedFullRows(TEMPLATES.manual)
    const { newWeekId } = duplicateWeek(db, { sourceWeekId: WEEK, campId: 'camp-1' }, AUTHOR)
    expectSameContent(source, rowsFor(deriveScheduleTemplateId(newWeekId, 'manual')))
  })

  it('Generate (engine slot -> row) writes every column the engine can author', async () => {
    // is_released is the one exemption: the engine has no released input — a
    // released cell is deliberately NOT pre-placed (derivePreplacedSlots), so
    // regenerate is free to put anything there.
    const engineSlot = { groupId: 'g1', dayId: 'd1', blockId: 'b1', type: 'activity', activityId: 'swim', fixedEventId: 'fe-1', electiveSetId: null, eventId: null, is_span_head: true, flags: {} }
    let written
    const captureRepo = createScheduleRepository({ localClient: { bulkReplace: async (_t, _e, _s, rows) => { written = rows } }, getToken: () => 'tok' })
    await captureRepo.replaceWeek(TEMPLATES.generated, [engineSlot])
    expect(written).toHaveLength(1)
    const missing = slotColumns().filter(c => c !== 'is_released' && !(c in written[0]))
    expect(missing).toEqual([])
  })
})

describe('restore skips cells whose event or elective set is gone', () => {
  it('drops a cell referencing a deleted event or elective set instead of restoring a dangling id', async () => {
    const tid = TEMPLATES.generated
    db.prepare("INSERT INTO template_slots (id, template_id, group_id, day_id, time_block_id, elective_set_id) VALUES ('e1', ?, 'g1', 'd1', 'b1', 'es-1')").run(tid)
    db.prepare("INSERT INTO template_slots (id, template_id, group_id, day_id, time_block_id, event_id) VALUES ('e2', ?, 'g1', 'd1', 'b2', 'ev-1')").run(tid)
    db.prepare("INSERT INTO template_slots (id, template_id, group_id, day_id, time_block_id, activity_id) VALUES ('e3', ?, 'g1', 'd1', 'b3', 'swim')").run(tid)
    const { result } = renderSnapshots({ events: [], electiveSets: [] })
    await act(async () => { await result.current.saveSnapshot('v1', false) })
    await act(async () => { await result.current.restoreSnapshot({ id: latestSnapshotId() }) })
    expect(rowsFor(tid).map(r => r.time_block_id)).toEqual(['b3'])
  })
})
