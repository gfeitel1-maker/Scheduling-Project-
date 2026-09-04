// @vitest-environment node
//
// docs/adr/2026-09-04-projection-failure-detection-and-recovery.md — section 2
// (recovery) and section 4 (regression scenario), the repairProjectionForEntity
// half. The detect-side instrumentation (applyRemoteOp's two catch sites) is
// covered in electron/sync/syncClient.test.js, since it can only be exercised
// through a real op_applied message the way the rest of that file already
// tests applyRemoteOp.
//
// Fixture note: the ADR's own worked example uses `locations` blocked by a
// referencing `template_slots` row, but locations.* columns are deliberately
// FK-by-convention with NO DB-level FOREIGN KEY (schema.sql, per
// docs/adr/2026-08-15-locations-concurrent-create-collision.md) — a real
// SQLITE_CONSTRAINT_FOREIGNKEY can never fire for a locations delete on this
// schema. `groups`, referenced by template_slots.group_id with a genuine DB
// FK (schema.sql, no ON DELETE clause = default RESTRICT), reproduces the
// exact reachable case applyRemoteOp's own existing catch comment describes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { appendOp, DELETE_FIELD } from './operations.js'
import { applyProjection } from './projections.js'
import { repairProjectionForEntity } from './projectionRepair.js'

let db, file, campId, deviceId

beforeEach(() => {
  file = path.join(os.tmpdir(), `shoresh-repair-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(file)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Test Camp')
  deviceId = randomUUID()
  db.prepare("INSERT INTO devices (id, name, pairing_status) VALUES (?, ?, 'authorized')").run(deviceId, 'Device A')
})

afterEach(() => {
  db.close()
  fs.unlinkSync(file)
})

function applyOp(op) {
  const appended = appendOp(db, { ...op, author_user_id: null, device_id: deviceId, parent_op_id: null })
  applyProjection(db, appended)
  return appended
}

describe('repairProjectionForEntity', () => {
  it('replays every op for the entity in seq order and resolves any prior projection_failures row on full success', () => {
    const groupId = randomUUID()
    applyOp({ entity: 'groups', entity_id: groupId, field: 'camp_id', value: campId })
    const nameOp = applyOp({ entity: 'groups', entity_id: groupId, field: 'name', value: 'Bears' })

    // Simulate a previously-recorded failure for this entity (as the catch
    // site in applyRemoteOp would have written) — op_id must reference a real
    // operations row (FK).
    db.prepare(
      `INSERT INTO projection_failures (op_id, entity, entity_id, field, error_message, failed_at)
       VALUES (?, 'groups', ?, 'name', 'boom', ?)`
    ).run(nameOp.id, groupId, new Date().toISOString())

    const result = repairProjectionForEntity(db, 'groups', groupId)

    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT name FROM groups WHERE id = ?').get(groupId).name).toBe('Bears')
    const failureRows = db.prepare('SELECT * FROM projection_failures WHERE entity_id = ?').all(groupId)
    expect(failureRows).toHaveLength(1)
    expect(failureRows[0].resolved_at).not.toBeNull()
  })

  it('keeps replaying past a failing op and reports the last failure, without rolling back ops that succeeded earlier in the same pass', () => {
    const groupId = randomUUID()
    applyOp({ entity: 'groups', entity_id: groupId, field: 'camp_id', value: campId })
    applyOp({ entity: 'groups', entity_id: groupId, field: 'name', value: 'Bears' })

    // A referencing template_slots row that will block the group's delete.
    const slotId = randomUUID()
    db.prepare('INSERT INTO template_slots (id, template_id, group_id) VALUES (?, ?, ?)').run(
      slotId,
      randomUUID(),
      groupId
    )
    // appendOp couples the op-log INSERT and applyProjection in ONE
    // transaction (it assumes a local, first-party write can't legitimately
    // fail projection) — a throw there would roll back the op-log row too,
    // which is the opposite of what this scenario needs to exercise. Insert
    // the op-log row directly instead, mirroring how applyRemoteOp does it:
    // the INSERT is durable regardless of what projection does next.
    const opId = randomUUID()
    const timestamp = new Date().toISOString()
    db.prepare(
      `INSERT INTO operations (id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id)
       VALUES (?, 'groups', ?, ?, 1, NULL, ?, ?, NULL)`
    ).run(opId, groupId, DELETE_FIELD, deviceId, timestamp)
    const deleteOp = { id: opId }
    expect(() => applyProjection(db, { entity: 'groups', entity_id: groupId, field: DELETE_FIELD })).toThrow()

    const result = repairProjectionForEntity(db, 'groups', groupId)

    expect(result.ok).toBe(false)
    expect(result.reason).toBeTruthy()
    // The row is still present: the blocked delete did not silently succeed.
    expect(db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId)).toBeTruthy()

    const failureRow = db.prepare('SELECT * FROM projection_failures WHERE op_id = ?').get(deleteOp.id)
    expect(failureRow).toBeTruthy()
    expect(failureRow.entity).toBe('groups')
    expect(failureRow.entity_id).toBe(groupId)
    expect(failureRow.resolved_at).toBeNull()

    // Remove the blocker and repair again: this time it succeeds.
    db.prepare('DELETE FROM template_slots WHERE id = ?').run(slotId)
    const secondResult = repairProjectionForEntity(db, 'groups', groupId)
    expect(secondResult.ok).toBe(true)
    expect(db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId)).toBeUndefined()
    const resolvedRow = db.prepare('SELECT * FROM projection_failures WHERE op_id = ?').get(deleteOp.id)
    expect(resolvedRow.resolved_at).not.toBeNull()
  })

  it('is idempotent — replaying the same fully-succeeded op sequence twice reproduces the same end state', () => {
    const groupId = randomUUID()
    applyOp({ entity: 'groups', entity_id: groupId, field: 'camp_id', value: campId })
    applyOp({ entity: 'groups', entity_id: groupId, field: 'name', value: 'Bears' })

    const first = repairProjectionForEntity(db, 'groups', groupId)
    const second = repairProjectionForEntity(db, 'groups', groupId)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(db.prepare('SELECT name FROM groups WHERE id = ?').get(groupId).name).toBe('Bears')
  })
})
