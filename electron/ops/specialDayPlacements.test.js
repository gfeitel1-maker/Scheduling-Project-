// @vitest-environment node
//
// T350 slice 2 (docs/adr/2026-10-09-special-day-binds-to-a-week-day.md D5, D8, D9): the bind/unbind
// write path and the three cascades (deleteWeek, deleteSpecialDay, duplicateWeek).
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { bindSpecialDay, unbindSpecialDay } from './specialDayPlacements.js'
import { deriveSpecialDayPlacementId } from './electiveDerivedIds.js'
import { deleteWeek } from './deleteWeek.js'
import { deleteSpecialDay } from './deleteSpecialDay.js'
import { duplicateWeek } from './duplicateWeek.js'
import { restoreEntity } from './restore.js'

afterAll(() => cleanupTemplatedDbs())

const actor = { author_user_id: 'user-1', device_id: 'device-1' }
let db
let file

beforeEach(() => {
  ;({ db, file } = openTemplatedDb())
  db.prepare("INSERT INTO camps (id, name) VALUES ('camp-1', 'Camp')").run()
  db.prepare("INSERT INTO devices (id, name) VALUES ('device-1', 'D')").run()
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES ('user-1', 'camp-1', 'A', 'h', 's', 'staff')").run()
  for (const [id, name, sort] of [['wk-1', 'Week 1', 0], ['wk-2', 'Week 2', 1]]) {
    db.prepare('INSERT INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, ?, ?, 0)')
      .run(id, 'camp-1', name, sort)
  }
  db.prepare("INSERT INTO days_of_operation (id, camp_id, label, day_of_week) VALUES ('day-tue', 'camp-1', 'Tuesday', 2)").run()
  db.prepare("INSERT INTO special_days (id, camp_id, name) VALUES ('sd-cw', 'camp-1', 'Color War')").run()
  db.prepare("INSERT INTO special_days (id, camp_id, name) VALUES ('sd-vd', 'camp-1', 'Visiting Day')").run()
})

afterEach(() => {
  db.close()
  if (file && fs.existsSync(file)) fs.unlinkSync(file)
})

const placements = () =>
  db.prepare('SELECT id, week_id, day_id, special_day_id FROM special_day_placements ORDER BY week_id').all()
const pid = (w = 'wk-1') => deriveSpecialDayPlacementId(w, 'day-tue')
const bind = (args) => bindSpecialDay(db, { weekId: 'wk-1', dayId: 'day-tue', specialDayId: 'sd-cw', ...args }, actor)

describe('bindSpecialDay', () => {
  it('writes all three fields as op-log entries in one atomic unit, under the derived id', () => {
    const result = bind()
    expect(result.ok).toBe(true)
    expect(placements()).toEqual([{ id: pid(), week_id: 'wk-1', day_id: 'day-tue', special_day_id: 'sd-cw' }])
    const fields = db
      .prepare("SELECT field FROM operations WHERE entity = 'special_day_placements' AND entity_id = ? ORDER BY rowid")
      .all(pid())
      .map((r) => r.field)
    expect(fields.sort()).toEqual(['day_id', 'special_day_id', 'week_id'])
  })

  it('is idempotent: a retry leaves one row bound to the same special day', () => {
    bind()
    expect(bind().ok).toBe(true)
    expect(placements()).toHaveLength(1)
  })

  it('refuses to replace an occupied day without an explicit confirm, naming the current binding', () => {
    bind()
    expect(bind({ specialDayId: 'sd-vd' })).toEqual({ ok: false, reason: 'occupied', currentSpecialDayId: 'sd-cw' })
    expect(placements()[0].special_day_id).toBe('sd-cw')
  })

  it('replaces an occupied day when confirmed, rewriting all three fields on the same id', () => {
    bind()
    const before = db.prepare('SELECT COUNT(*) c FROM operations').get().c
    expect(bind({ specialDayId: 'sd-vd', replace: true }).ok).toBe(true)
    expect(placements()).toEqual([{ id: pid(), week_id: 'wk-1', day_id: 'day-tue', special_day_id: 'sd-vd' }])
    expect(db.prepare('SELECT COUNT(*) c FROM operations').get().c - before).toBe(3)
  })

  it('is atomic: if the third field write throws, no placement row and no op survive', () => {
    db.exec(`CREATE TEMP TRIGGER fail_third BEFORE INSERT ON operations
      WHEN NEW.entity = 'special_day_placements' AND NEW.field = 'special_day_id'
      BEGIN SELECT RAISE(ABORT, 'planted failure'); END;`)
    expect(() => bind()).toThrow(/planted failure/)
    expect(placements()).toEqual([])
    expect(db.prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'special_day_placements'").get().c).toBe(0)
  })

  it('refuses an unknown week, an unknown day, and an unknown or foreign-camp special day (D9)', () => {
    db.prepare("INSERT INTO camps (id, name) VALUES ('camp-2', 'Other')").run()
    db.prepare("INSERT INTO special_days (id, camp_id, name) VALUES ('sd-foreign', 'camp-2', 'Theirs')").run()
    db.prepare("INSERT INTO days_of_operation (id, camp_id, label, day_of_week) VALUES ('day-foreign', 'camp-2', 'Wed', 3)").run()
    expect(bind({ weekId: 'wk-nope' })).toEqual({ ok: false, reason: 'unknown-week' })
    expect(bind({ dayId: 'day-nope' })).toEqual({ ok: false, reason: 'unknown-day' })
    expect(bind({ dayId: 'day-foreign' })).toEqual({ ok: false, reason: 'unknown-day' })
    expect(bind({ specialDayId: 'sd-nope' })).toEqual({ ok: false, reason: 'unknown-special-day' })
    expect(bind({ specialDayId: 'sd-foreign' })).toEqual({ ok: false, reason: 'unknown-special-day' })
    expect(placements()).toEqual([])
  })
})

describe('unbindSpecialDay', () => {
  it('deletes the placement through the op log and leaves the special day itself saved', () => {
    bind()
    expect(unbindSpecialDay(db, { weekId: 'wk-1', dayId: 'day-tue' }, actor).ok).toBe(true)
    expect(placements()).toEqual([])
    expect(db.prepare("SELECT id FROM special_days WHERE id = 'sd-cw'").get()).toEqual({ id: 'sd-cw' })
    expect(
      db.prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'special_day_placements' AND field = '__deleted__' AND entity_id = ?").get(pid()).c
    ).toBe(1)
  })

  it('is a no-op on an unbound day (a retry after a dropped write re-reads, never double-applies)', () => {
    expect(unbindSpecialDay(db, { weekId: 'wk-1', dayId: 'day-tue' }, actor)).toEqual({ ok: true, ops: [] })
  })

  it('restore of an unbound placement stays refused (D8): undo is re-binding', () => {
    bind()
    unbindSpecialDay(db, { weekId: 'wk-1', dayId: 'day-tue' }, actor)
    expect(restoreEntity(db, { entity: 'special_day_placements', entity_id: pid(), ...actor }))
      .toEqual({ error: 'not-restorable' })
  })
})

describe('cascades', () => {
  it('deleteWeek removes the week\'s placements (the hard week_id FK would otherwise block it)', () => {
    bind()
    const result = deleteWeek(db, { weekId: 'wk-1', campId: 'camp-1' }, actor)
    expect(result.ok).toBe(true)
    expect(placements()).toEqual([])
    expect(db.prepare("SELECT id FROM schedule_weeks WHERE id = 'wk-1'").get()).toBeUndefined()
  })

  it('deleteSpecialDay removes its placements in every week and leaves other special days\' bindings', () => {
    bind()
    bind({ weekId: 'wk-2' })
    db.prepare("INSERT INTO days_of_operation (id, camp_id, label, day_of_week) VALUES ('day-wed', 'camp-1', 'Wednesday', 3)").run()
    bind({ dayId: 'day-wed', specialDayId: 'sd-vd' })
    expect(deleteSpecialDay(db, { specialDayId: 'sd-cw' }, actor).ok).toBe(true)
    expect(placements().map((p) => p.special_day_id)).toEqual(['sd-vd'])
  })

  it('deleteSpecialDay closes an unresolved special_day_id conflict on a placement it deletes', () => {
    bind()
    const insertConflict = db.prepare(
      'INSERT INTO conflicts (id, entity, entity_id, field, incoming_op, existing_op, existing_op_id, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)'
    )
    insertConflict.run('c-sdp', 'special_day_placements', pid(), 'special_day_id', '{}', '{}', 'op-other-device', new Date().toISOString())
    insertConflict.run('c-unrelated', 'special_days', 'sd-vd', 'name', '{}', '{}', 'op-x', new Date().toISOString())
    expect(deleteSpecialDay(db, { specialDayId: 'sd-cw' }, actor).ok).toBe(true)
    expect(db.prepare('SELECT id FROM conflicts WHERE resolved_at IS NULL').all()).toEqual([{ id: 'c-unrelated' }])
  })

  it('duplicateWeek copies placements under the DERIVED id of the new week, all three fields', () => {
    bind()
    const { newWeekId } = duplicateWeek(db, { sourceWeekId: 'wk-1', campId: 'camp-1' }, actor)
    const copy = db.prepare('SELECT id, week_id, day_id, special_day_id FROM special_day_placements WHERE week_id = ?').get(newWeekId)
    expect(copy).toEqual({ id: pid(newWeekId), week_id: newWeekId, day_id: 'day-tue', special_day_id: 'sd-cw' })
    expect(placements()).toHaveLength(2)
  })
})
