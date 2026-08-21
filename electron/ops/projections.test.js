// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { PROJECTIONS, applyProjection, MUTUALLY_EXCLUSIVE_FIELDS, sanitizeMutuallyExclusiveRow } from './projections.js'
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

// T111 — elective cell atomic content + mutual exclusion.
// docs/work/specs/2026-08-20-elective-cell-atomic-content-design.md
//
// template_slots.activity_id and .elective_set_id are two independently
// conflict-tracked fields on the same row. Without an apply-time invariant,
// a cross-device interleave of a paired "set one, clear the other" write can
// leave both non-null with no conflict ever recorded (worked example in the
// design doc). These tests prove the eviction step in applyProjection closes
// that race by construction, for any arrival order.
describe('applyProjection T111 mutual exclusion — template_slots', () => {
  beforeEach(() => {
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run(
      'template-1',
      'camp-1',
      'Week 1'
    )
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(
      'act-1',
      'camp-1',
      'Swim'
    )
    db.prepare('INSERT INTO elective_sets (id, camp_id, name) VALUES (?, ?, ?)').run(
      'set-1',
      'camp-1',
      'Afternoon Chugim'
    )
    db.prepare('INSERT INTO template_slots (id, template_id) VALUES (?, ?)').run(
      'slot-1',
      'template-1'
    )
  })

  it('registers the exclusive pair for template_slots, symmetric both ways', () => {
    expect(MUTUALLY_EXCLUSIVE_FIELDS.template_slots).toEqual({
      activity_id: 'elective_set_id',
      elective_set_id: 'activity_id',
    })
  })

  // The headline test: replay-order interleave, not call-order. This is the
  // arrival order that produces both-non-null under plain per-field LWW with
  // no invariant (design doc's worked example) — A's clear lands first, then
  // B's clear, then B's set, then A's set, none adjacent to their own
  // device's paired write.
  //
  // N-device induction note (design doc): the invariant transition rule is a
  // pure function of (current row state, next op) — it never references
  // which/how-many devices authored ops, so this 2-device/4-op interleave is
  // a sufficient concrete exercise of the one nontrivial transition shape (a
  // "set" op evicts its partner unconditionally); a 3rd..Nth device's ops
  // would each individually reduce to the same shape already covered here.
  it('never leaves both activity_id and elective_set_id non-null, arrival order A-last', () => {
    const interleavedOps = [
      { entity: 'template_slots', entity_id: 'slot-1', field: 'elective_set_id', value: null }, // A's clear, seq1
      { entity: 'template_slots', entity_id: 'slot-1', field: 'activity_id', value: null }, // B's clear, seq2
      { entity: 'template_slots', entity_id: 'slot-1', field: 'elective_set_id', value: 'set-1' }, // B's set, seq3
      { entity: 'template_slots', entity_id: 'slot-1', field: 'activity_id', value: 'act-1' }, // A's set, seq4 (last)
    ]
    for (const op of interleavedOps) applyProjection(db, op)

    const row = db.prepare('SELECT activity_id, elective_set_id FROM template_slots WHERE id = ?').get('slot-1')
    expect(row.activity_id != null && row.elective_set_id != null).toBe(false)
    // The higher-seq setter (A's activity_id, applied last) evicts the
    // partner right when it lands — this is the assertion that would fail
    // under plain per-field LWW with no invariant.
    expect(row.activity_id).toBe('act-1')
    expect(row.elective_set_id).toBeNull()
  })

  it('never leaves both activity_id and elective_set_id non-null, arrival order B-last (mirror)', () => {
    const interleavedOps = [
      { entity: 'template_slots', entity_id: 'slot-1', field: 'activity_id', value: null }, // A's clear, seq1
      { entity: 'template_slots', entity_id: 'slot-1', field: 'elective_set_id', value: null }, // B's clear, seq2
      { entity: 'template_slots', entity_id: 'slot-1', field: 'activity_id', value: 'act-1' }, // A's set, seq3
      { entity: 'template_slots', entity_id: 'slot-1', field: 'elective_set_id', value: 'set-1' }, // B's set, seq4 (last)
    ]
    for (const op of interleavedOps) applyProjection(db, op)

    const row = db.prepare('SELECT activity_id, elective_set_id FROM template_slots WHERE id = ?').get('slot-1')
    expect(row.activity_id != null && row.elective_set_id != null).toBe(false)
    expect(row.elective_set_id).toBe('set-1')
    expect(row.activity_id).toBeNull()
  })

  it('is a no-op change in the common same-device, already-correct case (sequential, non-interleaved)', () => {
    // A single write path already clears the other field synchronously in
    // the same client call — sequential ops from one device, not interleaved
    // with another device's paired write.
    applyProjection(db, { entity: 'template_slots', entity_id: 'slot-1', field: 'activity_id', value: 'act-1' })
    applyProjection(db, { entity: 'template_slots', entity_id: 'slot-1', field: 'elective_set_id', value: null })

    const row = db.prepare('SELECT activity_id, elective_set_id FROM template_slots WHERE id = ?').get('slot-1')
    expect(row.activity_id).toBe('act-1')
    expect(row.elective_set_id).toBeNull()
  })

  it('confirms the no-op-for-other-entities behavior — template_overlays has no exclusive pair', () => {
    expect(MUTUALLY_EXCLUSIVE_FIELDS.template_overlays).toBeUndefined()
    expect(sanitizeMutuallyExclusiveRow('template_overlays', { activity_id: 'x', elective_set_id: 'y' })).toEqual({
      activity_id: 'x',
      elective_set_id: 'y',
    })
  })

  // DELETE_FIELD interaction (Red Hat round 2, test 2a/2b).
  describe('DELETE_FIELD interaction', () => {
    it('2a: the eviction guard is never reached on a delete — the row is just deleted', () => {
      applyProjection(db, { entity: 'template_slots', entity_id: 'slot-1', field: 'elective_set_id', value: 'set-1' })
      expect(
        db.prepare('SELECT elective_set_id FROM template_slots WHERE id = ?').get('slot-1').elective_set_id
      ).toBe('set-1')

      applyProjection(db, { entity: 'template_slots', entity_id: 'slot-1', field: '__deleted__', value: 1 })

      expect(db.prepare('SELECT * FROM template_slots WHERE id = ?').get('slot-1')).toBeUndefined()
    })

    it('2b: delete-then-recreate cannot leave a dangling corrective side effect from the row previous life', () => {
      applyProjection(db, { entity: 'template_slots', entity_id: 'slot-1', field: 'elective_set_id', value: 'set-1' })
      applyProjection(db, { entity: 'template_slots', entity_id: 'slot-1', field: '__deleted__', value: 1 })

      // Fresh insert via ensureExists (template_id write), then an
      // activity_id set. The freshly-inserted row has elective_set_id NULL
      // by column default, so the eviction guard's IS NOT NULL condition is
      // false and no spurious UPDATE runs against stale pre-delete state.
      applyProjection(db, { entity: 'template_slots', entity_id: 'slot-1', field: 'template_id', value: 'template-1' })
      applyProjection(db, { entity: 'template_slots', entity_id: 'slot-1', field: 'activity_id', value: 'act-1' })

      const row = db.prepare('SELECT activity_id, elective_set_id FROM template_slots WHERE id = ?').get('slot-1')
      expect(row.activity_id).toBe('act-1')
      expect(row.elective_set_id).toBeNull()
    })
  })

  // Span-head-with-tails orphaning (Red Hat round 2, test 1) — a
  // documentation/regression guard on the scope boundary, NOT a fix.
  // Decision (design doc): T111's invariant is deliberately row-scoped
  // (WHERE id = ?); it does not and cannot fix a stale tail row's
  // relationship to a converted head. That is T105's authoring-path
  // responsibility (route "convert span head to elective" through the same
  // replaceSlot/collectSpanTails multi-cell atomic write already used for
  // "replace span head with a different activity").
  it('span-head-with-tails: T111 is row-scoped and does not fix (nor is required to fix) an orphaned tail after a head-only conversion', () => {
    db.prepare('INSERT INTO template_slots (id, template_id, activity_id, is_span_head) VALUES (?, ?, ?, ?)').run(
      'slot-head',
      'template-1',
      'act-1',
      1
    )
    db.prepare('INSERT INTO template_slots (id, template_id, activity_id, is_span_head) VALUES (?, ?, ?, ?)').run(
      'slot-tail',
      'template-1',
      'act-1',
      0
    )

    // A bare single-field op that only targets the head's own row id —
    // exactly the gap the design doc names. Converts the head to an
    // elective; does NOT touch the tail row at all.
    applyProjection(db, { entity: 'template_slots', entity_id: 'slot-head', field: 'elective_set_id', value: 'set-1' })

    const head = db.prepare('SELECT * FROM template_slots WHERE id = ?').get('slot-head')
    const tail = db.prepare('SELECT * FROM template_slots WHERE id = ?').get('slot-tail')

    // The head itself is correctly single-kind — this test is not about the
    // head.
    expect(head.elective_set_id).toBe('set-1')
    expect(head.activity_id).toBeNull()

    // The tail independently satisfies the per-row invariant (trivially —
    // it never had both fields set)...
    expect(tail.activity_id != null && tail.elective_set_id != null).toBe(false)
    // ...but it is now an orphaned tail: is_span_head is false, activity_id
    // is still set, and no head row at the preceding block owns that
    // activity_id as a span head any longer (the head that used to own it
    // is now an elective cell). Reachable in principle, scoped out to T105 —
    // this assertion documents the boundary rather than closing it.
    expect(tail.is_span_head).toBe(0)
    expect(tail.activity_id).toBe('act-1')
    const owningHead = db
      .prepare('SELECT * FROM template_slots WHERE template_id = ? AND is_span_head = 1 AND activity_id = ?')
      .get('template-1', 'act-1')
    expect(owningHead).toBeUndefined()
  })
})

// Regression suite for the "turning a week exclusion ON never persists a row"
// bug. week_activity_exclusions / week_group_exclusions each have TWO NOT NULL
// columns — week_id plus a real FK (activity_id / group_id). ensureExists used
// to seed only week_id, so the INSERT OR IGNORE tripped the second column's NOT
// NULL constraint and was silently dropped (SQLite's IGNORE covers NOT NULL,
// not just UNIQUE/PK). The row was never created; both subsequent field UPDATEs
// matched zero rows. The whole path (toggleActivityExclusion(true) etc.) looked
// like it worked while persisting nothing.
//
// These exercise the REAL appendOp op-log path — two field ops in the exact
// order the write path emits them (week_id first, then the FK) — which is the
// only layer where the bug is visible: the fake-client repository tests and the
// mocked-localClient screen tests never touch SQLite.
describe('applyProjection for week_activity_exclusions / week_group_exclusions', () => {
  beforeEach(() => {
    // operations.device_id is NOT NULL REFERENCES devices(id); the exclusion
    // tables' week_id/activity_id/group_id are real FKs — with foreign_keys = ON
    // every referenced row must exist or the failure is an FK error, not the
    // behavior under test.
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
    db.prepare('INSERT INTO schedule_weeks (id, camp_id, name) VALUES (?, ?, ?)').run(
      'week-1',
      'camp-1',
      'Week 1'
    )
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(
      'act-swim',
      'camp-1',
      'swim'
    )
    db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run(
      'grp-3',
      'camp-1',
      'Group 3'
    )
  })

  it('registers both exclusion tables with the expected fields allowlist', () => {
    expect(PROJECTIONS.week_activity_exclusions.fields).toEqual(['week_id', 'activity_id'])
    expect(PROJECTIONS.week_group_exclusions.fields).toEqual(['week_id', 'group_id'])
  })

  // The headline regression, via the real op-log path: excluding an activity in
  // a week writes week_id then activity_id as two appendOp calls. Before the
  // fix, no row existed afterwards.
  it('persists a week_activity_exclusions row after the week_id + activity_id write sequence', () => {
    appendOp(db, {
      entity: 'week_activity_exclusions', entity_id: 'wae-1',
      field: 'week_id', value: 'week-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'week_activity_exclusions', entity_id: 'wae-1',
      field: 'activity_id', value: 'act-swim',
      author_user_id: 'user-1', device_id: 'device-1',
    })

    const row = db.prepare('SELECT * FROM week_activity_exclusions WHERE id = ?').get('wae-1')
    expect(row).toBeTruthy()
    expect(row.week_id).toBe('week-1')
    expect(row.activity_id).toBe('act-swim')
  })

  it('persists a week_group_exclusions row after the week_id + group_id write sequence', () => {
    appendOp(db, {
      entity: 'week_group_exclusions', entity_id: 'wge-1',
      field: 'week_id', value: 'week-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'week_group_exclusions', entity_id: 'wge-1',
      field: 'group_id', value: 'grp-3',
      author_user_id: 'user-1', device_id: 'device-1',
    })

    const row = db.prepare('SELECT * FROM week_group_exclusions WHERE id = ?').get('wge-1')
    expect(row).toBeTruthy()
    expect(row.week_id).toBe('week-1')
    expect(row.group_id).toBe('grp-3')
  })

  // Order-independence: the fix reconstructs the sibling field from the op-log
  // regardless of which field's op arrives first, so a reversed write sequence
  // (FK before week_id) must still land exactly one complete row.
  it('persists the row even if the FK field is written before week_id', () => {
    appendOp(db, {
      entity: 'week_activity_exclusions', entity_id: 'wae-rev',
      field: 'activity_id', value: 'act-swim',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    // After only the activity_id op, the row cannot exist yet (week_id, a NOT
    // NULL FK, is still unknown).
    expect(db.prepare('SELECT * FROM week_activity_exclusions WHERE id = ?').get('wae-rev')).toBeUndefined()

    appendOp(db, {
      entity: 'week_activity_exclusions', entity_id: 'wae-rev',
      field: 'week_id', value: 'week-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })

    const row = db.prepare('SELECT * FROM week_activity_exclusions WHERE id = ?').get('wae-rev')
    expect(row).toBeTruthy()
    expect(row.week_id).toBe('week-1')
    expect(row.activity_id).toBe('act-swim')
  })

  // The op-log half never broke — only the projection did — so the durable log
  // is not what this guards; the materialized row is.
  it('after the week_id-only op alone, no row exists yet (both NOT NULL FKs unmet)', () => {
    appendOp(db, {
      entity: 'week_activity_exclusions', entity_id: 'wae-partial',
      field: 'week_id', value: 'week-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT * FROM week_activity_exclusions WHERE id = ?').get('wae-partial')).toBeUndefined()
    // ...but the op is still durably logged.
    const loggedOp = db
      .prepare('SELECT * FROM operations WHERE entity = ? AND entity_id = ? AND field = ?')
      .get('week_activity_exclusions', 'wae-partial', 'week_id')
    expect(loggedOp).toBeTruthy()
  })

  // T89: schedule_weeks is the odd one out among ensureWeekJoinRow's FK
  // parents — it is never stub-seeded, so a week_*_exclusions op that
  // outraces the week-level op (any device that hasn't yet seen this
  // schedule_weeks row) throws SQLITE_CONSTRAINT_FOREIGNKEY on the exclusion
  // INSERT. That throw is caught by the generic handler in syncClient.js and
  // logged, but the op is still marked applied — the exclusion silently never
  // materializes. Mirrors T85's devices-row stub-seed for the same class of
  // out-of-order FK failure. Deliberately does NOT pre-insert schedule_weeks
  // in this block's beforeEach — 'week-never-seen' must be genuinely absent
  // going into applyProjection.
  it('stub-seeds the schedule_weeks parent when a week_activity_exclusions op arrives for a week never seen locally', () => {
    expect(db.prepare('SELECT * FROM schedule_weeks WHERE id = ?').get('week-never-seen')).toBeUndefined()

    appendOp(db, {
      entity: 'week_activity_exclusions', entity_id: 'wae-orphan',
      field: 'week_id', value: 'week-never-seen',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    appendOp(db, {
      entity: 'week_activity_exclusions', entity_id: 'wae-orphan',
      field: 'activity_id', value: 'act-swim',
      author_user_id: 'user-1', device_id: 'device-1',
    })

    const row = db.prepare('SELECT * FROM week_activity_exclusions WHERE id = ?').get('wae-orphan')
    expect(row).toBeTruthy()
    expect(row.week_id).toBe('week-never-seen')
    expect(row.activity_id).toBe('act-swim')

    const stubWeek = db.prepare('SELECT * FROM schedule_weeks WHERE id = ?').get('week-never-seen')
    expect(stubWeek).toBeTruthy()
    expect(stubWeek.camp_id).toBe('camp-1')
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

// M5 — regression guard for week_location_exclusions persistence. This is the
// third instance of the two-NOT-NULL week_*_exclusions pattern and now uses the
// shared ensureWeekJoinRow helper (projections.js), same as its activity/group
// siblings above: the row materializes only once BOTH week_id and location_id
// are known (reconstructed from the op-log), so it is order-independent and
// needs no placeholder. Drives the real appendOp -> applyProjection -> ensureExists
// path against real SQLite — the only layer where the historical week_id-only
// seed silently dropped the row.
describe('applyProjection for week_location_exclusions (M5)', () => {
  beforeEach(() => {
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
    db.prepare(
      'INSERT INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, ?, ?, ?)'
    ).run('week-1', 'camp-1', 'Week 1', 0, 0)
    db.prepare('INSERT INTO locations (id, camp_id, name) VALUES (?, ?, ?)').run(
      'loc-pool',
      'camp-1',
      'Pool'
    )
  })

  it('persists a week_location_exclusions row after the week_id + location_id write sequence', () => {
    appendOp(db, {
      entity: 'week_location_exclusions', entity_id: 'wlx-1',
      field: 'week_id', value: 'week-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    // Under the shared helper the row does NOT exist yet — location_id (also
    // NOT NULL) is still unknown. (The retired '' placeholder would have created
    // a garbage row here; the helper deliberately waits.)
    expect(db.prepare('SELECT * FROM week_location_exclusions WHERE id = ?').get('wlx-1')).toBeUndefined()

    appendOp(db, {
      entity: 'week_location_exclusions', entity_id: 'wlx-1',
      field: 'location_id', value: 'loc-pool',
      author_user_id: 'user-1', device_id: 'device-1',
    })

    const row = db.prepare('SELECT * FROM week_location_exclusions WHERE id = ?').get('wlx-1')
    expect(row).toBeTruthy()
    expect(row.week_id).toBe('week-1')
    expect(row.location_id).toBe('loc-pool')
  })

  it('persists the row even if location_id is written before week_id (order-independent)', () => {
    appendOp(db, {
      entity: 'week_location_exclusions', entity_id: 'wlx-rev',
      field: 'location_id', value: 'loc-pool',
      author_user_id: 'user-1', device_id: 'device-1',
    })
    expect(db.prepare('SELECT * FROM week_location_exclusions WHERE id = ?').get('wlx-rev')).toBeUndefined()

    appendOp(db, {
      entity: 'week_location_exclusions', entity_id: 'wlx-rev',
      field: 'week_id', value: 'week-1',
      author_user_id: 'user-1', device_id: 'device-1',
    })

    const row = db.prepare('SELECT * FROM week_location_exclusions WHERE id = ?').get('wlx-rev')
    expect(row).toBeTruthy()
    expect(row.week_id).toBe('week-1')
    expect(row.location_id).toBe('loc-pool')
  })
})
