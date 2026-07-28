// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { PROJECTIONS, applyProjection } from './projections.js'
import { appendOp } from './operations.js'

let tmpFile
let db

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-projections-test-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('user-1', 'camp-1', 'Alice', 'hash', 'salt', 'staff')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('PROJECTIONS registry', () => {
  it('registers camps with a fields allowlist and a singleton-guarding ensureExists', () => {
    expect(PROJECTIONS.camps.table).toBe('camps')
    expect(PROJECTIONS.camps.key).toBe('id')
    expect(PROJECTIONS.camps.fields).toEqual(['name'])
    expect(typeof PROJECTIONS.camps.ensureExists).toBe('function')
  })

  it('registers users with a fields allowlist and ensureExists', () => {
    expect(PROJECTIONS.users.table).toBe('users')
    expect(PROJECTIONS.users.key).toBe('id')
    expect(PROJECTIONS.users.fields).toEqual(['camp_id', 'name', 'pin_hash', 'pin_salt', 'role'])
    expect(typeof PROJECTIONS.users.ensureExists).toBe('function')
  })

  it('registers cohorts with a fields allowlist and ensureExists', () => {
    expect(PROJECTIONS.cohorts.table).toBe('cohorts')
    expect(PROJECTIONS.cohorts.key).toBe('id')
    expect(PROJECTIONS.cohorts.fields).toEqual([
      'camp_id',
      'name',
      'session_week_start',
      'session_week_end',
      'capacity_source',
      'anchor_model',
      'sort_order',
    ])
    expect(typeof PROJECTIONS.cohorts.ensureExists).toBe('function')
  })
})

describe('applyProjection for camps', () => {
  it('updates the existing camp row name via the real op-log path', () => {
    applyProjection(db, { entity: 'camps', entity_id: 'camp-1', field: 'name', value: 'Camp Renamed' })
    const row = db.prepare('SELECT * FROM camps WHERE id = ?').get('camp-1')
    expect(row.name).toBe('Camp Renamed')
  })

  it('ensureExists does not create a second camps row and does not clobber signing_secret', () => {
    const before = db.prepare('SELECT COUNT(*) as count FROM camps').get().count
    const secretBefore = db.prepare('SELECT signing_secret FROM camps WHERE id = ?').get('camp-1')
      .signing_secret

    applyProjection(db, { entity: 'camps', entity_id: 'camp-1', field: 'name', value: 'Still One Row' })

    const after = db.prepare('SELECT COUNT(*) as count FROM camps').get().count
    const secretAfter = db.prepare('SELECT signing_secret FROM camps WHERE id = ?').get('camp-1')
      .signing_secret
    expect(after).toBe(before)
    expect(secretAfter).toBe(secretBefore)
  })

  it('rejects a mismatched entity_id rather than silently creating a second camps row (round-2 singleton guard)', () => {
    const before = db.prepare('SELECT COUNT(*) as count FROM camps').get().count

    expect(() =>
      applyProjection(db, { entity: 'camps', entity_id: 'some-other-camp-id', field: 'name', value: 'Evil' })
    ).toThrow()

    const after = db.prepare('SELECT COUNT(*) as count FROM camps').get().count
    expect(after).toBe(before)
    const evilRow = db.prepare('SELECT * FROM camps WHERE id = ?').get('some-other-camp-id')
    expect(evilRow).toBeUndefined()
  })
})

describe('applyProjection for cohorts', () => {
  it('creates a new cohort row (via ensureExists) scoped to the existing camp, field by field', () => {
    applyProjection(db, { entity: 'cohorts', entity_id: 'cohort-1', field: 'camp_id', value: 'camp-1' })
    applyProjection(db, { entity: 'cohorts', entity_id: 'cohort-1', field: 'name', value: 'Main' })
    applyProjection(db, {
      entity: 'cohorts',
      entity_id: 'cohort-1',
      field: 'session_week_start',
      value: 1,
    })
    const row = db.prepare('SELECT * FROM cohorts WHERE id = ?').get('cohort-1')
    expect(row).toBeTruthy()
    expect(row.camp_id).toBe('camp-1')
    expect(row.name).toBe('Main')
    expect(row.session_week_start).toBe('1.0')
  })

  it('does not violate the NOT NULL camp_id constraint on the placeholder insert', () => {
    expect(() =>
      applyProjection(db, { entity: 'cohorts', entity_id: 'cohort-2', field: 'name', value: 'Second' })
    ).not.toThrow()
    const row = db.prepare('SELECT camp_id FROM cohorts WHERE id = ?').get('cohort-2')
    expect(row.camp_id).toBe('camp-1')
  })

  it('is a no-op for a field not in the cohorts allowlist', () => {
    applyProjection(db, { entity: 'cohorts', entity_id: 'cohort-3', field: 'name', value: 'Third' })
    expect(() =>
      applyProjection(db, { entity: 'cohorts', entity_id: 'cohort-3', field: 'not_a_real_field', value: 'x' })
    ).not.toThrow()
    const row = db.prepare('SELECT * FROM cohorts WHERE id = ?').get('cohort-3')
    expect(row.name).toBe('Third')
  })
})

describe('applyProjection __deleted__ sentinel', () => {
  it('deletes the row when op.field is __deleted__', () => {
    applyProjection(db, { entity: 'cohorts', entity_id: 'cohort-del-1', field: 'camp_id', value: 'camp-1' })
    applyProjection(db, { entity: 'cohorts', entity_id: 'cohort-del-1', field: 'name', value: 'ToDelete' })
    expect(db.prepare('SELECT * FROM cohorts WHERE id = ?').get('cohort-del-1')).toBeTruthy()

    applyProjection(db, { entity: 'cohorts', entity_id: 'cohort-del-1', field: '__deleted__', value: 1 })

    expect(db.prepare('SELECT * FROM cohorts WHERE id = ?').get('cohort-del-1')).toBeUndefined()
  })

  it('is a no-op (does not throw, does not create a row) when deleting a row that never existed', () => {
    expect(() =>
      applyProjection(db, { entity: 'cohorts', entity_id: 'never-existed', field: '__deleted__', value: 1 })
    ).not.toThrow()
    expect(db.prepare('SELECT * FROM cohorts WHERE id = ?').get('never-existed')).toBeUndefined()
  })

  it('is a no-op for an unregistered entity even with the delete sentinel', () => {
    expect(() =>
      applyProjection(db, { entity: 'not_a_real_entity', entity_id: 'x', field: '__deleted__', value: 1 })
    ).not.toThrow()
  })
})

// Regression suite for the "manual schedule edits silently do nothing" bug.
// template_slots had no PROJECTIONS entry at all, so applyProjection's
// `if (!projection) return` discarded every field-level write to it: the op
// was appended to the operations log (and replicated) while the row itself
// was never touched. Engine generation kept working only because it goes
// through bulkReplace, which writes rows directly and never consults
// PROJECTIONS.
describe('applyProjection for template_slots', () => {
  beforeEach(() => {
    // operations.device_id is NOT NULL REFERENCES devices(id), and
    // template_slots.activity_id REFERENCES activities(id) — with
    // `PRAGMA foreign_keys = ON` (localDb.js) both must be real rows or the
    // op-log insert / the projected UPDATE fails on the FK rather than on
    // the behavior under test.
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run(
      'template-1',
      'camp-1',
      'Week 1'
    )
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(
      'act-flag-football',
      'camp-1',
      'flag football'
    )
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(
      'act-basketball',
      'camp-1',
      'basketball'
    )
    // A slot as generation would have left it — the exact starting state of
    // the production repro (an occupied cell showing "flag football").
    db.prepare(
      'INSERT INTO template_slots (id, template_id, activity_id) VALUES (?, ?, ?)'
    ).run('slot-1', 'template-1', 'act-flag-football')
  })

  it('registers template_slots with a fields allowlist and ensureExists', () => {
    expect(PROJECTIONS.template_slots).toBeTruthy()
    expect(PROJECTIONS.template_slots.table).toBe('template_slots')
    expect(PROJECTIONS.template_slots.key).toBe('id')
    expect(typeof PROJECTIONS.template_slots.ensureExists).toBe('function')
  })

  // Every field ScheduleScreen.jsx's writeFields() actually sends for a
  // template_slots row. appendOp throws 'field not allowed for entity' for
  // anything absent here the moment the entity is registered, so an
  // incomplete allowlist would convert the silent no-op into a hard failure.
  it('allowlists every field ScheduleScreen writeFields sends', () => {
    for (const field of ['activity_id', 'flags', 'is_released', 'is_span_head']) {
      expect(PROJECTIONS.template_slots.fields).toContain(field)
    }
  })

  // The headline regression: reproduces production op seq 293 exactly — a
  // drag-and-drop onto an occupied cell, through the real appendOp op-log
  // path rather than calling applyProjection directly.
  it('applies an activity_id write to the row, not just to the operations log', () => {
    appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-1',
      field: 'activity_id',
      value: 'act-basketball',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    // The op was always logged — that half never broke, which is why the bug
    // looked like a sync problem rather than a projection problem.
    const loggedOp = db
      .prepare('SELECT * FROM operations WHERE entity = ? AND entity_id = ? AND field = ?')
      .get('template_slots', 'slot-1', 'activity_id')
    expect(loggedOp).toBeTruthy()
    expect(loggedOp.value).toBe('act-basketball')

    // ...and this is the half that silently did nothing.
    const row = db.prepare('SELECT * FROM template_slots WHERE id = ?').get('slot-1')
    expect(row.activity_id).toBe('act-basketball')
  })

  it('applies an activity_id write via applyProjection directly', () => {
    applyProjection(db, {
      entity: 'template_slots',
      entity_id: 'slot-1',
      field: 'activity_id',
      value: 'act-basketball',
    })
    const row = db.prepare('SELECT * FROM template_slots WHERE id = ?').get('slot-1')
    expect(row.activity_id).toBe('act-basketball')
  })

  // ScheduleScreen clears a cell with `activity_id: null` (the span-tail
  // clear path), so null must round-trip rather than being treated as absent.
  it('applies a null activity_id write (clearing a cell)', () => {
    applyProjection(db, {
      entity: 'template_slots',
      entity_id: 'slot-1',
      field: 'activity_id',
      value: null,
    })
    const row = db.prepare('SELECT * FROM template_slots WHERE id = ?').get('slot-1')
    expect(row.activity_id).toBe(null)
  })

  it('is a no-op for a field not in the template_slots allowlist', () => {
    expect(() =>
      applyProjection(db, {
        entity: 'template_slots',
        entity_id: 'slot-1',
        field: 'not_a_real_field',
        value: 'x',
      })
    ).not.toThrow()
    const row = db.prepare('SELECT * FROM template_slots WHERE id = ?').get('slot-1')
    expect(row.activity_id).toBe('act-flag-football')
  })

  // Parent-scoped entity: template_slots has no camp_id column at all (same
  // as day_override_template_slots/schedule_snapshots), so ensureExists must
  // never consult or create a camps row.
  it('ensureExists does not touch the camps table', () => {
    const before = db.prepare('SELECT COUNT(*) as count FROM camps').get().count
    applyProjection(db, {
      entity: 'template_slots',
      entity_id: 'slot-new',
      field: 'activity_id',
      value: 'act-basketball',
    })
    const after = db.prepare('SELECT COUNT(*) as count FROM camps').get().count
    expect(after).toBe(before)
  })

  // template_id is NOT NULL with no default, so the row can only be created
  // once the parent link is known — mirrors day_override_template_slots and
  // schedule_snapshots.
  it('ensureExists creates the row when template_id is written first', () => {
    applyProjection(db, {
      entity: 'template_slots',
      entity_id: 'slot-new',
      field: 'template_id',
      value: 'template-1',
    })
    const row = db.prepare('SELECT * FROM template_slots WHERE id = ?').get('slot-new')
    expect(row).toBeTruthy()
    expect(row.template_id).toBe('template-1')
  })

  // A non-template_id field arriving for a row that does not exist must skip
  // the insert (it cannot satisfy the NOT NULL FK) and let the UPDATE be a
  // harmless zero-row no-op, rather than raising a constraint violation.
  it('skips the insert (no throw, no row) when a non-template_id field arrives for a missing row', () => {
    expect(() =>
      applyProjection(db, {
        entity: 'template_slots',
        entity_id: 'slot-missing',
        field: 'activity_id',
        value: 'act-basketball',
      })
    ).not.toThrow()
    expect(db.prepare('SELECT * FROM template_slots WHERE id = ?').get('slot-missing')).toBeUndefined()
  })

  it('deletes the row via the __deleted__ sentinel', () => {
    applyProjection(db, {
      entity: 'template_slots',
      entity_id: 'slot-1',
      field: '__deleted__',
      value: 1,
    })
    expect(db.prepare('SELECT * FROM template_slots WHERE id = ?').get('slot-1')).toBeUndefined()
  })
})

describe('applyProjection camp_id guard', () => {
  it('applies a camp_id write on users that matches the device camp id', () => {
    applyProjection(db, { entity: 'users', entity_id: 'user-1', field: 'camp_id', value: 'camp-1' })
    const row = db.prepare('SELECT camp_id FROM users WHERE id = ?').get('user-1')
    expect(row.camp_id).toBe('camp-1')
  })

  it('rejects a camp_id write on users with a mismatched value and leaves the row unchanged', () => {
    expect(() =>
      applyProjection(db, { entity: 'users', entity_id: 'user-1', field: 'camp_id', value: 'evil-camp' })
    ).not.toThrow()
    const row = db.prepare('SELECT camp_id FROM users WHERE id = ?').get('user-1')
    expect(row.camp_id).toBe('camp-1')
  })

  it('applies a camp_id write on groups that matches the device camp id', () => {
    applyProjection(db, { entity: 'groups', entity_id: 'group-1', field: 'camp_id', value: 'camp-1' })
    const row = db.prepare('SELECT camp_id FROM groups WHERE id = ?').get('group-1')
    expect(row.camp_id).toBe('camp-1')
  })

  it('rejects a camp_id write on groups with a mismatched value and never creates the row', () => {
    expect(() =>
      applyProjection(db, { entity: 'groups', entity_id: 'group-evil', field: 'camp_id', value: 'evil-camp' })
    ).not.toThrow()
    const row = db.prepare('SELECT * FROM groups WHERE id = ?').get('group-evil')
    expect(row).toBeUndefined()
  })

  it('rejects a camp_id write on cohorts with a mismatched value and never creates the row', () => {
    expect(() =>
      applyProjection(db, { entity: 'cohorts', entity_id: 'cohort-evil', field: 'camp_id', value: 'evil-camp' })
    ).not.toThrow()
    const row = db.prepare('SELECT * FROM cohorts WHERE id = ?').get('cohort-evil')
    expect(row).toBeUndefined()
  })

  it('rejects any camp_id write on a zero-camps db', () => {
    const tmpFile2 = path.join(os.tmpdir(), `shoresh-projections-test-zero-${Date.now()}-${Math.random()}.sqlite`)
    const db2 = openLocalDb(tmpFile2)
    expect(() =>
      applyProjection(db2, { entity: 'users', entity_id: 'user-x', field: 'camp_id', value: 'anything' })
    ).not.toThrow()
    const row = db2.prepare('SELECT * FROM users WHERE id = ?').get('user-x')
    expect(row).toBeUndefined()
    db2.close()
    if (fs.existsSync(tmpFile2)) fs.unlinkSync(tmpFile2)
  })
})

describe('applyProjection', () => {
  it('updates the real row for a registered entity', () => {
    applyProjection(db, { entity: 'users', entity_id: 'user-1', field: 'name', value: 'Bob' })
    const row = db.prepare('SELECT name FROM users WHERE id = ?').get('user-1')
    expect(row.name).toBe('Bob')
  })

  // Was written against `template_slots` back when it genuinely had no
  // PROJECTIONS entry. That absence was the bug (see the template_slots
  // describe block below), so this case needs an entity that is actually
  // unregistered to still be testing what it claims to test.
  it('is a no-op for an unregistered entity', () => {
    expect(() =>
      applyProjection(db, { entity: 'not_a_registered_entity', entity_id: 'x-1', field: 'activity_id', value: 'x' })
    ).not.toThrow()
  })

  it('creates a new row (via ensureExists) when the target row does not exist, and sets the field', () => {
    expect(() =>
      applyProjection(db, { entity: 'users', entity_id: 'brand-new-user', field: 'name', value: 'Nobody' })
    ).not.toThrow()
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get('brand-new-user')
    expect(row).toBeTruthy()
    expect(row.name).toBe('Nobody')
    expect(row.role).toBe('staff')
  })

  it('does not throw and does not modify the table when the field is not in the allowlist', () => {
    expect(() =>
      applyProjection(db, { entity: 'users', entity_id: 'user-1', field: 'not_a_real_field', value: 'x' })
    ).not.toThrow()
    const row = db.prepare('SELECT name FROM users WHERE id = ?').get('user-1')
    expect(row.name).toBe('Alice')
  })

  it('rejects a malicious field string without executing it against the users table', () => {
    expect(() =>
      applyProjection(db, {
        entity: 'users',
        entity_id: 'user-1',
        field: "role = 'admin' -- ",
        value: 'x',
      })
    ).not.toThrow()
    const row = db.prepare('SELECT role FROM users WHERE id = ?').get('user-1')
    expect(row.role).toBe('staff')
  })

  it('ensureExists does not touch the camps table (no sentinel camp row)', () => {
    const before = db.prepare('SELECT COUNT(*) as count FROM camps').get().count
    applyProjection(db, { entity: 'users', entity_id: 'brand-new-user-2', field: 'name', value: 'X' })
    const after = db.prepare('SELECT COUNT(*) as count FROM camps').get().count
    expect(after).toBe(before)
    const row = db.prepare('SELECT camp_id FROM users WHERE id = ?').get('brand-new-user-2')
    expect(row.camp_id).toBe(null)
  })

  it('creates placeholder rows for two different new users without either being swallowed by INSERT OR IGNORE', () => {
    applyProjection(db, { entity: 'users', entity_id: 'new-user-a', field: 'name', value: 'A' })
    applyProjection(db, { entity: 'users', entity_id: 'new-user-b', field: 'name', value: 'B' })
    const rowA = db.prepare('SELECT * FROM users WHERE id = ?').get('new-user-a')
    const rowB = db.prepare('SELECT * FROM users WHERE id = ?').get('new-user-b')
    expect(rowA).toBeTruthy()
    expect(rowB).toBeTruthy()
    expect(rowA.camp_id).toBe(null)
    expect(rowB.camp_id).toBe(null)
  })

  it('leaves main.js-style camp lookups unaffected by placeholder user creation', () => {
    const before = db.prepare('SELECT COUNT(*) as count FROM camps').get().count
    applyProjection(db, { entity: 'users', entity_id: 'brand-new-user-3', field: 'name', value: 'Y' })
    const after = db.prepare('SELECT COUNT(*) as count FROM camps').get().count
    expect(after).toBe(before)
    const firstCamp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    expect(firstCamp).toEqual({ id: 'camp-1' })
  })
})
