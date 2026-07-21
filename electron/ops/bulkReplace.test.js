// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import {
  appendBulkReplaceOp,
  applyBulkReplaceProjection,
  validateBulkReplaceRows,
  isBulkReplaceOp,
  BULK_REPLACE_FIELD,
  MAX_BULK_REPLACE_ROWS,
  latestScopeOpSeq,
  detectBulkReplaceConflict,
} from './operations.js'
import { appendOp } from './operations.js'

let tmpFile
let db

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-bulk-replace-test-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('user-1', 'camp-1', 'Alice', 'hash', 'salt', 'staff')

  // template_slots.group_id/activity_id carry FK references - seed the rows
  // any test's bulk-replace row set might point at, so inserts succeed on
  // their own merits rather than accidentally exercising unrelated FK errors.
  for (const groupId of ['group-1', 'group-2']) {
    db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run(groupId, 'camp-1', groupId)
  }
  for (const activityId of ['activity-swim', 'activity-archery', 'activity-kayak', 'activity-hiking', 'activity-canoe']) {
    db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(activityId, 'camp-1', activityId)
  }
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

function seedInitialSlots(templateId) {
  db.prepare(
    'INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('slot-orig-1', templateId, 'group-1', 'activity-swim', 'day-1', 'block-1')
  db.prepare(
    'INSERT INTO template_slots (id, template_id, group_id, activity_id, day_id, time_block_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('slot-orig-2', templateId, 'group-2', 'activity-archery', 'day-1', 'block-2')
}

describe('validateBulkReplaceRows', () => {
  it('rejects an unknown entity', () => {
    const result = validateBulkReplaceRows('not_a_real_entity', [])
    expect(result.valid).toBe(false)
  })

  it('rejects a non-array rows payload', () => {
    const result = validateBulkReplaceRows('template_slots', { not: 'an array' })
    expect(result.valid).toBe(false)
  })

  it('rejects a row missing a required field', () => {
    const result = validateBulkReplaceRows('template_slots', [{ template_id: 't1' }])
    expect(result.valid).toBe(false)
  })

  it('rejects a row with a wrong-typed field', () => {
    const result = validateBulkReplaceRows('template_slots', [
      { id: 's1', template_id: 't1', group_id: 42 },
    ])
    expect(result.valid).toBe(false)
  })

  it('rejects a row with an unrecognized field', () => {
    const result = validateBulkReplaceRows('template_slots', [
      { id: 's1', template_id: 't1', not_a_column: 'x' },
    ])
    expect(result.valid).toBe(false)
  })

  it('accepts a well-formed row set', () => {
    const result = validateBulkReplaceRows('template_slots', [
      { id: 's1', template_id: 't1', group_id: 'g1', activity_id: null, day_id: null, time_block_id: null },
    ])
    expect(result.valid).toBe(true)
  })

  it('rejects a rows array exceeding MAX_BULK_REPLACE_ROWS, before touching the DB', () => {
    const oversized = Array.from({ length: MAX_BULK_REPLACE_ROWS + 1 }, (_, i) => ({
      id: `s${i}`,
      template_id: 't1',
    }))
    const result = validateBulkReplaceRows('template_slots', oversized)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/MAX_BULK_REPLACE_ROWS/)
  })

  it('accepts a row set exactly at MAX_BULK_REPLACE_ROWS', () => {
    const atLimit = Array.from({ length: MAX_BULK_REPLACE_ROWS }, (_, i) => ({
      id: `s${i}`,
      template_id: 't1',
    }))
    const result = validateBulkReplaceRows('template_slots', atLimit)
    expect(result.valid).toBe(true)
  })
})

describe('bulk_replace oversized payload never reaches the DB', () => {
  it('appendBulkReplaceOp throws before the transaction opens, leaving no op-log or table trace', () => {
    seedInitialSlots('template-oversized')
    const oversized = Array.from({ length: MAX_BULK_REPLACE_ROWS + 1 }, (_, i) => ({
      id: `over-${i}`,
      template_id: 'template-oversized',
    }))

    expect(() =>
      appendBulkReplaceOp(db, {
        entity: 'template_slots',
        scope_id: 'template-oversized',
        rows: oversized,
        author_user_id: 'user-1',
        device_id: 'device-1',
        client_write_id: 'cw-oversized',
      })
    ).toThrow()

    const rows = db.prepare('SELECT * FROM template_slots WHERE template_id = ? ORDER BY id').all('template-oversized')
    expect(rows.map((r) => r.id)).toEqual(['slot-orig-1', 'slot-orig-2'])
    const opCount = db.prepare('SELECT COUNT(*) as c FROM operations WHERE entity_id = ?').get('template-oversized').c
    expect(opCount).toBe(0)
  })
})

describe('per-scope conflict detection (round 2)', () => {
  it('latestScopeOpSeq is 0 for a scope with no ops yet', () => {
    expect(latestScopeOpSeq(db, 'template_slots', 'template-fresh')).toBe(0)
  })

  it('latestScopeOpSeq reflects a prior bulk_replace on the same scope', () => {
    const rows = [{ id: 's1', template_id: 'template-scope-a', group_id: 'group-1', activity_id: 'activity-swim', day_id: null, time_block_id: null }]
    const op = appendBulkReplaceOp(db, {
      entity: 'template_slots',
      scope_id: 'template-scope-a',
      rows,
      author_user_id: 'user-1',
      device_id: 'device-1',
      client_write_id: 'cw-scope-a',
    })
    expect(latestScopeOpSeq(db, 'template_slots', 'template-scope-a')).toBe(op.seq)
  })

  it('latestScopeOpSeq reflects a field-level op on a row currently in the scope', () => {
    const rows = [{ id: 'row-x', template_id: 'template-scope-b', group_id: 'group-1', activity_id: 'activity-swim', day_id: null, time_block_id: null }]
    appendBulkReplaceOp(db, {
      entity: 'template_slots',
      scope_id: 'template-scope-b',
      rows,
      author_user_id: 'user-1',
      device_id: 'device-1',
      client_write_id: 'cw-scope-b-1',
    })
    // A field-level edit to row-x (entity_id = the row's own id, not the scope_id).
    const fieldOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'row-x',
      field: 'activity_id',
      value: 'activity-kayak',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    expect(latestScopeOpSeq(db, 'template_slots', 'template-scope-b')).toBe(fieldOp.seq)
  })

  it('detectBulkReplaceConflict reports no conflict when based_on_seq is current', () => {
    const rows = [{ id: 's1', template_id: 'template-scope-c', group_id: 'group-1', activity_id: 'activity-swim', day_id: null, time_block_id: null }]
    const op = appendBulkReplaceOp(db, {
      entity: 'template_slots',
      scope_id: 'template-scope-c',
      rows,
      author_user_id: 'user-1',
      device_id: 'device-1',
      client_write_id: 'cw-scope-c',
    })
    const result = detectBulkReplaceConflict(db, { entity: 'template_slots', scope_id: 'template-scope-c', based_on_seq: op.seq })
    expect(result.conflict).toBe(false)
  })

  it('detectBulkReplaceConflict reports a conflict when a newer field-level op landed in scope after based_on_seq', () => {
    const rows = [{ id: 'row-y', template_id: 'template-scope-d', group_id: 'group-1', activity_id: 'activity-swim', day_id: null, time_block_id: null }]
    const bulkOp = appendBulkReplaceOp(db, {
      entity: 'template_slots',
      scope_id: 'template-scope-d',
      rows,
      author_user_id: 'user-1',
      device_id: 'device-1',
      client_write_id: 'cw-scope-d',
    })
    // Device B's snapshot is taken right after the bulk_replace (based_on_seq = bulkOp.seq).
    const staleBasedOnSeq = bulkOp.seq
    // Device A then edits row-y's activity_id concurrently.
    const fieldOp = appendOp(db, {
      entity: 'template_slots',
      entity_id: 'row-y',
      field: 'activity_id',
      value: 'activity-kayak',
      author_user_id: 'user-1',
      device_id: 'device-1',
      parent_op_id: null,
    })
    const result = detectBulkReplaceConflict(db, { entity: 'template_slots', scope_id: 'template-scope-d', based_on_seq: staleBasedOnSeq })
    expect(result.conflict).toBe(true)
    expect(result.existingOp.id).toBe(fieldOp.id)
  })
})

describe('appendBulkReplaceOp', () => {
  it('deletes all current rows for the scope and inserts the new set, atomically, in one op', () => {
    seedInitialSlots('template-1')

    const rows = [
      { id: 'slot-new-1', template_id: 'template-1', group_id: 'group-1', activity_id: 'activity-kayak', day_id: 'day-1', time_block_id: 'block-1' },
      { id: 'slot-new-2', template_id: 'template-1', group_id: 'group-2', activity_id: 'activity-hiking', day_id: 'day-1', time_block_id: 'block-2' },
    ]

    const op = appendBulkReplaceOp(db, {
      entity: 'template_slots',
      scope_id: 'template-1',
      rows,
      author_user_id: 'user-1',
      device_id: 'device-1',
      client_write_id: 'cw-1',
    })

    expect(op.id).toBeTruthy()
    expect(op.entity).toBe('template_slots')
    expect(op.entity_id).toBe('template-1')
    expect(op.field).toBe(BULK_REPLACE_FIELD)
    expect(isBulkReplaceOp(op)).toBe(true)
    expect(JSON.parse(op.value)).toEqual(rows)

    const currentRows = db.prepare('SELECT * FROM template_slots WHERE template_id = ? ORDER BY id').all('template-1')
    expect(currentRows.map((r) => r.id)).toEqual(['slot-new-1', 'slot-new-2'])
    expect(currentRows.find((r) => r.id === 'slot-new-1').activity_id).toBe('activity-kayak')

    // the op itself is recorded in the operations log, exactly like any other op
    const logged = db.prepare('SELECT * FROM operations WHERE id = ?').get(op.id)
    expect(logged).toBeTruthy()
    expect(logged.entity_id).toBe('template-1')
  })

  it('does not touch the DB at all when the rows payload is malformed (validated before the transaction opens)', () => {
    seedInitialSlots('template-2')

    const malformedRows = [{ id: 'slot-bad', template_id: 'template-2', activity_id: 12345 }] // wrong type

    expect(() =>
      appendBulkReplaceOp(db, {
        entity: 'template_slots',
        scope_id: 'template-2',
        rows: malformedRows,
        author_user_id: 'user-1',
        device_id: 'device-1',
        client_write_id: 'cw-2',
      })
    ).toThrow()

    const rows = db.prepare('SELECT * FROM template_slots WHERE template_id = ? ORDER BY id').all('template-2')
    expect(rows.map((r) => r.id)).toEqual(['slot-orig-1', 'slot-orig-2'])

    const opCount = db.prepare('SELECT COUNT(*) as c FROM operations WHERE entity_id = ?').get('template-2').c
    expect(opCount).toBe(0)
  })

  it('atomicity on failure: a mid-transaction DB error (duplicate row id) leaves the ORIGINAL rows completely untouched', () => {
    seedInitialSlots('template-3')

    // Shape-valid (every row individually well-formed), but the second row
    // duplicates the first row's id - this is a real SQLite PRIMARY KEY
    // constraint violation, not a shape problem, so it is only caught
    // mid-transaction, exercising the actual rollback path.
    const rowsWithDuplicateId = [
      { id: 'dup-slot', template_id: 'template-3', group_id: 'group-1', activity_id: 'activity-swim', day_id: 'day-1', time_block_id: 'block-1' },
      { id: 'dup-slot', template_id: 'template-3', group_id: 'group-2', activity_id: 'activity-archery', day_id: 'day-1', time_block_id: 'block-2' },
    ]

    expect(() =>
      appendBulkReplaceOp(db, {
        entity: 'template_slots',
        scope_id: 'template-3',
        rows: rowsWithDuplicateId,
        author_user_id: 'user-1',
        device_id: 'device-1',
        client_write_id: 'cw-3',
      })
    ).toThrow()

    // Original rows survive completely untouched - not half-replaced, not deleted.
    const rows = db.prepare('SELECT * FROM template_slots WHERE template_id = ? ORDER BY id').all('template-3')
    expect(rows.map((r) => r.id)).toEqual(['slot-orig-1', 'slot-orig-2'])
    expect(rows.find((r) => r.id === 'slot-orig-1').activity_id).toBe('activity-swim')

    // The failed attempt must not appear in the op-log either - it never
    // genuinely took effect (whole transaction, including the operations
    // insert, rolled back together).
    const opCount = db.prepare('SELECT COUNT(*) as c FROM operations WHERE entity_id = ?').get('template-3').c
    expect(opCount).toBe(0)
  })
})

describe('applyBulkReplaceProjection (client-side replay of an already-canonical op)', () => {
  it('replays the same delete-all-then-reinsert from op.value', () => {
    seedInitialSlots('template-4')

    const rows = [
      { id: 'remote-slot-1', template_id: 'template-4', group_id: 'group-1', activity_id: 'activity-canoe', day_id: 'day-1', time_block_id: 'block-1' },
    ]
    const fakeOp = { entity: 'template_slots', entity_id: 'template-4', field: BULK_REPLACE_FIELD, value: JSON.stringify(rows) }

    applyBulkReplaceProjection(db, fakeOp)

    const current = db.prepare('SELECT * FROM template_slots WHERE template_id = ? ORDER BY id').all('template-4')
    expect(current.map((r) => r.id)).toEqual(['remote-slot-1'])
  })

  it('is a no-op (does not throw, does not touch the DB) on malformed op.value', () => {
    seedInitialSlots('template-5')
    const fakeOp = { entity: 'template_slots', entity_id: 'template-5', field: BULK_REPLACE_FIELD, value: 'not valid json' }

    expect(() => applyBulkReplaceProjection(db, fakeOp)).not.toThrow()

    const current = db.prepare('SELECT * FROM template_slots WHERE template_id = ? ORDER BY id').all('template-5')
    expect(current.map((r) => r.id)).toEqual(['slot-orig-1', 'slot-orig-2'])
  })
})
