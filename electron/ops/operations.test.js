// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { appendOp, latestOp, detectConflict, recordConflict, listPendingConflicts, DELETE_FIELD } from './operations.js'

let tmpFile
let db

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-ops-test-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('user-1', 'camp-1', 'Alice', 'hash', 'salt', 'staff')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

describe('appendOp', () => {
  it('inserts an op and it is retrievable via latestOp', () => {
    const op = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-1',
      field: 'activity_id',
      value: 'activity-1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    expect(op.id).toBeTruthy()
    expect(op.seq).toBeTruthy()
    expect(op.timestamp).toBeTruthy()

    const found = latestOp(db, 'template_slots', 'slot-1', 'activity_id')
    expect(found).toBeTruthy()
    expect(found.id).toBe(op.id)
    expect(found.seq).toBe(op.seq)
  })

  it('works when author_user_id is null (system-attributed op)', () => {
    const op = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-2',
      field: 'activity_id',
      value: 'activity-2',
      author_user_id: null,
      device_id: 'device-1',
      parent_op_id: null,
    })

    expect(op.author_user_id).toBeNull()
    const found = latestOp(db, 'template_slots', 'slot-2', 'activity_id')
    expect(found.id).toBe(op.id)
    expect(found.author_user_id).toBeNull()
  })
})

describe('appendOp projection', () => {
  it('updates the real users row when entity is users', () => {
    appendOp(db, {
      entity: 'users',
      entity_id: 'user-1',
      field: 'name',
      value: 'Alicia',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const row = db.prepare('SELECT name FROM users WHERE id = ?').get('user-1')
    expect(row.name).toBe('Alicia')
  })
})

describe('appendOp field allowlist + transaction', () => {
  it('throws for a field not in the allowlist and does not insert an operations row', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n

    expect(() =>
      appendOp(db, {
        entity: 'users',
        entity_id: 'user-1',
        field: 'not_a_real_field',
        value: 'x',
        author_user_id: 'user-1',
        device_id: 'device-1',
        parent_op_id: null,
      })
    ).toThrow()

    const after = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n
    expect(after).toBe(before)

    const row = db.prepare('SELECT name FROM users WHERE id = ?').get('user-1')
    expect(row.name).toBe('Alice')
  })

  it('creates a brand-new users row via ensureExists when appending the first op for that entity_id', () => {
    appendOp(db, {
      entity: 'users',
      entity_id: 'brand-new-user',
      field: 'name',
      value: 'Fresh',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get('brand-new-user')
    expect(row).toBeTruthy()
    expect(row.name).toBe('Fresh')
    expect(row.role).toBe('staff')
  })
})

describe('appendOp DELETE_FIELD sentinel', () => {
  it('is accepted (not rejected by the fields allowlist) for a registered projection entity, and applies as a real row delete', () => {
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-2', 'Camp Two')
    appendOp(db, {
      entity: 'cohorts',
      entity_id: 'cohort-to-delete',
      field: 'camp_id',
      value: 'camp-2',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    expect(db.prepare('SELECT * FROM cohorts WHERE id = ?').get('cohort-to-delete')).toBeTruthy()

    const before = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n
    const op = appendOp(db, {
      entity: 'cohorts',
      entity_id: 'cohort-to-delete',
      field: DELETE_FIELD,
      value: 1,
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    const after = db.prepare('SELECT COUNT(*) AS n FROM operations').get().n

    expect(op.field).toBe('__deleted__')
    expect(after).toBe(before + 1)
    expect(db.prepare('SELECT * FROM cohorts WHERE id = ?').get('cohort-to-delete')).toBeUndefined()
  })
})

describe('latestOp', () => {
  it('orders by seq, not timestamp, returning the most recently appended op', () => {
    const op1 = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-3',
      field: 'activity_id',
      value: 'v1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    const op2 = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-3',
      field: 'activity_id',
      value: 'v2',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: op1.id,
    })

    const found = latestOp(db, 'template_slots', 'slot-3', 'activity_id')
    expect(found.id).toBe(op2.id)
    expect(found.seq).toBeGreaterThan(op1.seq)
  })

  it('returns undefined when there is no op for the entity/entity_id/field', () => {
    const found = latestOp(db, 'template_slots', 'nonexistent-slot', 'activity_id')
    expect(found).toBeUndefined()
  })
})

describe('detectConflict', () => {
  it('reports no conflict when incoming op parent_op_id matches the current latest op id', () => {
    const parentOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-4',
      field: 'activity_id',
      value: 'v1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const incomingOp = {
      entity: 'template_slots',
      entity_id: 'slot-4',
      field: 'activity_id',
      value: 'v2',
      parent_op_id: parentOp.id,
    }

    const result = detectConflict(db, incomingOp)
    expect(result.conflict).toBe(false)
  })

  it('reports a conflict when two ops diverge from the same parent', () => {
    const parentOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-5',
      field: 'activity_id',
      value: 'v1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const appliedOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-5',
      field: 'activity_id',
      value: 'v2',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: parentOp.id,
    })

    const incomingOp = {
      entity: 'template_slots',
      entity_id: 'slot-5',
      field: 'activity_id',
      value: 'v3',
      parent_op_id: parentOp.id,
    }

    const result = detectConflict(db, incomingOp)
    expect(result.conflict).toBe(true)
    expect(result.existingOp.id).toBe(appliedOp.id)
  })
})

describe('detectConflict: DELETE_FIELD vs. concurrent field-edit (Round 2 Security MEDIUM #2)', () => {
  it('reports a conflict when an incoming delete races a concurrent field-edit op it never observed', () => {
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-2', 'Camp Two')
    const createOp = appendOp(db, {
      entity: 'cohorts',
      entity_id: 'cohort-race-1',
      field: 'camp_id',
      value: 'camp-2',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    // A concurrent field edit lands after the delete's snapshot (createOp).
    const editOp = appendOp(db, {
      entity: 'cohorts',
      entity_id: 'cohort-race-1',
      field: 'name',
      value: 'Renamed',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const incomingDelete = {
      entity: 'cohorts',
      entity_id: 'cohort-race-1',
      field: DELETE_FIELD,
      value: 1,
      parent_op_id: createOp.id, // stale — never saw editOp
    }

    const result = detectConflict(db, incomingDelete)
    expect(result.conflict).toBe(true)
    expect(result.existingOp.id).toBe(editOp.id)
  })

  it('reports a conflict when an incoming field-edit races a concurrent delete it never observed', () => {
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-3', 'Camp Three')
    const createOp = appendOp(db, {
      entity: 'cohorts',
      entity_id: 'cohort-race-2',
      field: 'camp_id',
      value: 'camp-3',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    const deleteOp = appendOp(db, {
      entity: 'cohorts',
      entity_id: 'cohort-race-2',
      field: DELETE_FIELD,
      value: 1,
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const incomingEdit = {
      entity: 'cohorts',
      entity_id: 'cohort-race-2',
      field: 'name',
      value: 'Should not resurrect the row',
      parent_op_id: createOp.id, // stale — never saw deleteOp
    }

    const result = detectConflict(db, incomingEdit)
    expect(result.conflict).toBe(true)
    expect(result.existingOp.id).toBe(deleteOp.id)
  })

  it('does not conflict when the field-edit correctly cites the delete as its parent (deliberate resurrect/recreate)', () => {
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-4', 'Camp Four')
    const deleteOp = appendOp(db, {
      entity: 'cohorts',
      entity_id: 'cohort-race-3',
      field: DELETE_FIELD,
      value: 1,
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    const incomingEdit = {
      entity: 'cohorts',
      entity_id: 'cohort-race-3',
      field: 'name',
      value: 'Recreated',
      parent_op_id: deleteOp.id,
    }

    const result = detectConflict(db, incomingEdit)
    expect(result.conflict).toBe(false)
  })
})

describe('recordConflict + listPendingConflicts (Task 10 round 3, Fix 3: conflict rehydration)', () => {
  it('(a) a conflict that arose before "restart" and was never resolved IS present in the rehydrated list', () => {
    const parentOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-10',
      field: 'activity_id',
      value: 'v1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    const existingOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-10',
      field: 'activity_id',
      value: 'v2',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: parentOp.id,
    })
    const incomingOp = {
      id: 'incoming-op-id',
      entity: 'template_slots',
      entity_id: 'slot-10',
      field: 'activity_id',
      value: 'v3',
      device_id: 'device-2',
      timestamp: new Date().toISOString(),
      parent_op_id: parentOp.id,
    }

    recordConflict(db, { incomingOp, existingOp })

    // Simulate a restart: a fresh call against the same db, no in-memory
    // broadcast state at all — this is exactly what usePendingConflicts'
    // mount-time fetch relies on.
    const pending = listPendingConflicts(db)
    expect(pending).toHaveLength(1)
    expect(pending[0].type).toBe('op_conflict')
    expect(pending[0].existingOp.id).toBe(existingOp.id)
    expect(pending[0].incomingOp.id).toBe('incoming-op-id')
  })

  it('(b) a conflict that was fully resolved before "restart" is NOT present in the rehydrated list', () => {
    const parentOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-11',
      field: 'activity_id',
      value: 'v1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    const existingOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-11',
      field: 'activity_id',
      value: 'v2',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: parentOp.id,
    })
    const incomingOp = {
      id: 'incoming-op-id-2',
      entity: 'template_slots',
      entity_id: 'slot-11',
      field: 'activity_id',
      value: 'v3',
      device_id: 'device-2',
      timestamp: new Date().toISOString(),
      parent_op_id: parentOp.id,
    }

    recordConflict(db, { incomingOp, existingOp })

    // Resolve exactly like main.js's resolveConflict() does: a new op whose
    // parent_op_id is the existingOp's id, regardless of which side was kept.
    appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-11',
      field: 'activity_id',
      value: 'v3-kept',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: existingOp.id,
    })

    const pending = listPendingConflicts(db)
    expect(pending).toHaveLength(0)
  })

  it('lazily marks a now-resolved row resolved_at so repeated calls stay cheap', () => {
    const existingOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-12',
      field: 'activity_id',
      value: 'v1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    const incomingOp = {
      id: 'incoming-op-id-3',
      entity: 'template_slots',
      entity_id: 'slot-12',
      field: 'activity_id',
      value: 'v2',
      device_id: 'device-2',
      timestamp: new Date().toISOString(),
      parent_op_id: null,
    }
    const conflictId = recordConflict(db, { incomingOp, existingOp })

    appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-12',
      field: 'activity_id',
      value: 'v2-kept',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: existingOp.id,
    })

    listPendingConflicts(db)
    const row = db.prepare('SELECT resolved_at FROM conflicts WHERE id = ?').get(conflictId)
    expect(row.resolved_at).toBeTruthy()
  })

  it('multiple distinct unresolved conflicts on different keys are all returned', () => {
    const existingOpA = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-13',
      field: 'activity_id',
      value: 'a1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    const existingOpB = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'slot-14',
      field: 'activity_id',
      value: 'b1',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })

    recordConflict(db, {
      incomingOp: { id: 'ia', entity: 'template_slots', entity_id: 'slot-13', field: 'activity_id', value: 'a2', device_id: 'device-2', timestamp: new Date().toISOString(), parent_op_id: null },
      existingOp: existingOpA,
    })
    recordConflict(db, {
      incomingOp: { id: 'ib', entity: 'template_slots', entity_id: 'slot-14', field: 'activity_id', value: 'b2', device_id: 'device-2', timestamp: new Date().toISOString(), parent_op_id: null },
      existingOp: existingOpB,
    })

    const pending = listPendingConflicts(db)
    expect(pending).toHaveLength(2)
  })
})
