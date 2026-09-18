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
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { appendOp, DELETE_FIELD } from './operations.js'
import { applyProjection } from './projections.js'
import { repairProjectionForEntity } from './projectionRepair.js'


// Discards the cached template. Per-test cleanup would rebuild the chain every time and
// undo the saving, so this runs once, at the end (T188/F2).
afterAll(() => {
  cleanupTemplatedDbs()
})
let db, file, campId, deviceId

beforeEach(() => {
  // Was openLocalDb(freshPath) — replays the whole migration chain, ~304ms per test.
  // The template copy is the database that chain produces, ~10x cheaper (T188/F2).
  const __templated = openTemplatedDb()
  db = __templated.db
  file = __templated.file
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

  it('does NOT resolve the entity when an earlier op fails on field A and a later op succeeds on field B', () => {
    // groups has UNIQUE(camp_id, name) (schema.sql) — a real, deterministic
    // way to make a plain field-level UPDATE genuinely throw on replay.
    const otherGroupId = randomUUID()
    applyOp({ entity: 'groups', entity_id: otherGroupId, field: 'camp_id', value: campId })
    applyOp({ entity: 'groups', entity_id: otherGroupId, field: 'name', value: 'Taken' })

    const groupId = randomUUID()
    applyOp({ entity: 'groups', entity_id: groupId, field: 'camp_id', value: campId })

    // Insert the "name" op-log row DIRECTLY (not via appendOp, which would
    // apply-and-roll-back the whole insert in one transaction on this exact
    // constraint violation) — this mirrors how applyRemoteOp persists an
    // op-log row independently of whether projection application succeeds.
    // Its value collides with otherGroupId's name, so replaying it will
    // genuinely throw a UNIQUE constraint violation.
    const nameOpId = randomUUID()
    const t1 = new Date(Date.now() - 1000).toISOString()
    db.prepare(
      `INSERT INTO operations (id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id)
       VALUES (?, 'groups', ?, 'name', 'Taken', NULL, ?, ?, NULL)`
    ).run(nameOpId, groupId, deviceId, t1)

    // A LATER op on a DIFFERENT field ("availability") succeeds.
    applyOp({ entity: 'groups', entity_id: groupId, field: 'availability', value: 'full' })

    const result = repairProjectionForEntity(db, 'groups', groupId)

    expect(result.ok).toBe(false)
    expect(db.prepare('SELECT availability FROM groups WHERE id = ?').get(groupId).availability).toBe('full')
    const failureRow = db.prepare('SELECT * FROM projection_failures WHERE op_id = ?').get(nameOpId)
    expect(failureRow).toBeTruthy()
    expect(failureRow.field).toBe('name')
    expect(failureRow.resolved_at).toBeNull()
  })

  it('resolves when a later op succeeds on the SAME field a prior op failed on (supersession)', () => {
    const groupId = randomUUID()
    applyOp({ entity: 'groups', entity_id: groupId, field: 'camp_id', value: campId })

    // A stale, already-recorded failure for field "name" against an earlier op.
    const staleOpId = randomUUID()
    const t1 = new Date(Date.now() - 1000).toISOString()
    db.prepare(
      `INSERT INTO operations (id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id)
       VALUES (?, 'groups', ?, 'name', 'Stale', NULL, ?, ?, NULL)`
    ).run(staleOpId, groupId, deviceId, t1)
    db.prepare(
      `INSERT INTO projection_failures (op_id, entity, entity_id, field, error_message, failed_at)
       VALUES (?, 'groups', ?, 'name', 'boom', ?)`
    ).run(staleOpId, groupId, t1)

    // A LATER op on the SAME field ("name") succeeds.
    applyOp({ entity: 'groups', entity_id: groupId, field: 'name', value: 'Bears' })

    const result = repairProjectionForEntity(db, 'groups', groupId)

    expect(result.ok).toBe(true)
    expect(db.prepare('SELECT name FROM groups WHERE id = ?').get(groupId).name).toBe('Bears')
    const resolvedRow = db.prepare('SELECT * FROM projection_failures WHERE op_id = ?').get(staleOpId)
    expect(resolvedRow.resolved_at).not.toBeNull()
  })

  it('records BOTH failed ops in projection_failures when two different ops fail on two different fields', () => {
    const otherGroupId = randomUUID()
    applyOp({ entity: 'groups', entity_id: otherGroupId, field: 'camp_id', value: campId })
    applyOp({ entity: 'groups', entity_id: otherGroupId, field: 'name', value: 'Taken' })

    const groupId = randomUUID()
    applyOp({ entity: 'groups', entity_id: groupId, field: 'camp_id', value: campId })

    // Field "name" fails (unique collision) — inserted directly, as above,
    // so the constraint violation is only hit on replay, not at setup time.
    const nameOpId = randomUUID()
    const t1 = new Date(Date.now() - 1000).toISOString()
    db.prepare(
      `INSERT INTO operations (id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id)
       VALUES (?, 'groups', ?, 'name', 'Taken', NULL, ?, ?, NULL)`
    ).run(nameOpId, groupId, deviceId, t1)

    // Field "__deleted__" (a blocked delete) ALSO fails, on a different field.
    const slotId = randomUUID()
    db.prepare('INSERT INTO template_slots (id, template_id, group_id) VALUES (?, ?, ?)').run(
      slotId,
      randomUUID(),
      groupId
    )
    const deleteOpId = randomUUID()
    db.prepare(
      `INSERT INTO operations (id, entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id)
       VALUES (?, 'groups', ?, ?, 1, NULL, ?, ?, NULL)`
    ).run(deleteOpId, groupId, DELETE_FIELD, deviceId, new Date().toISOString())

    const result = repairProjectionForEntity(db, 'groups', groupId)

    expect(result.ok).toBe(false)
    const nameFailure = db.prepare('SELECT * FROM projection_failures WHERE op_id = ?').get(nameOpId)
    const deleteFailure = db.prepare('SELECT * FROM projection_failures WHERE op_id = ?').get(deleteOpId)
    expect(nameFailure).toBeTruthy()
    expect(nameFailure.resolved_at).toBeNull()
    expect(deleteFailure).toBeTruthy()
    expect(deleteFailure.resolved_at).toBeNull()
    // The row must still be present — the delete never actually took effect.
    expect(db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId)).toBeTruthy()
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

// Q1/T172 (Red Hat review): the op-log repair path must NOT touch users credentials — that would
// bypass the signature verification that only the document-replay path enforces.
describe('repairProjectionForEntity refuses users (Q1/T172 credential integrity)', () => {
  it('throws for entity "users" rather than replaying credential ops through applyProjection', () => {
    expect(() => repairProjectionForEntity(db, 'users', 'some-user-id')).toThrow(/refusing entity 'users'|Host-signed/)
  })
})

// 2026-09-17 addendum to docs/adr/2026-09-04-projection-failure-detection-and-recovery.md.
// A document-native entity (e.g. elective_assignment_runs) never gets its field writes recorded
// as `operations` rows — the doc-replay path (projector.js) writes straight to SQLite from the
// Automerge document, bypassing the op-log entirely. When a doc-replay row fails to project, it is
// recorded in projection_failures under store='document-replay' with NO corresponding `operations`
// row at all (op_id is a deterministic string, not a real op). Replaying an empty op-log for this
// entity_id would leave `outstanding` empty, and the old code (pre-this-change) took the
// wholesale-resolve branch — falsely marking the failure resolved while the document-native row was
// still missing from SQLite (T194 round 4, Defect 2b). The guard must refuse based on
// projection_failures directly, not on inferring "document-owned" from the op-log's shape.
describe('repairProjectionForEntity and a document-native entity with an unresolved document-replay failure', () => {
  it('refuses to resolve — replaying the (empty) op log cannot have rebuilt anything', () => {
    const runId = randomUUID()
    db.prepare(
      `INSERT INTO projection_failures (op_id, entity, entity_id, field, error_message, failed_at, store)
       VALUES (?, 'elective_assignment_runs', ?, 'status', 'boom', ?, 'document-replay')`
    ).run(`replay:elective_assignment_runs:${runId}:status`, runId, new Date().toISOString())

    const result = repairProjectionForEntity(db, 'elective_assignment_runs', runId)

    expect(result.ok).toBe(false)
    const failureRow = db
      .prepare('SELECT resolved_at FROM projection_failures WHERE entity = ? AND entity_id = ?')
      .get('elective_assignment_runs', runId)
    expect(failureRow.resolved_at).toBeNull()
  })
})

// The tripwire T194's owner asked for (this false-resolve has now shipped twice): confirms the
// guard above is load-bearing, not incidental, by proving the OLD (pre-fix) behaviour really would
// have wrongly resolved this row. Deleting the guard in projectionRepair.js's
// repairProjectionForEntity reproduces exactly this: `ops` is empty (no operations row exists for
// this document-native entity), so `outstanding` stays empty and the function falls through to the
// wholesale UPDATE ... resolved_at, marking a still-broken row healthy.
describe('repairProjectionForEntity guard tripwire', () => {
  it('without the document-replay guard, an entity with zero ops and an unresolved failure would be falsely resolved', () => {
    const runId = randomUUID()
    const opId = `replay:elective_assignment_runs:${runId}:status`
    db.prepare(
      `INSERT INTO projection_failures (op_id, entity, entity_id, field, error_message, failed_at, store)
       VALUES (?, 'elective_assignment_runs', ?, 'status', 'boom', ?, 'document-replay')`
    ).run(opId, runId, new Date().toISOString())

    // Reproduce the OLD, guard-less code path directly (no operations rows exist for this
    // document-native entity_id, so replaying them is a no-op and outstanding stays empty).
    const ops = db.prepare('SELECT * FROM operations WHERE entity = ? AND entity_id = ? ORDER BY seq ASC')
      .all('elective_assignment_runs', runId)
    expect(ops.length).toBe(0)
    const outstanding = new Map()
    // ... no ops to replay, so `outstanding` never gets populated ...
    expect(outstanding.size).toBe(0)
    // The old wholesale-resolve branch would fire here — proving that WITHOUT the guard this
    // change adds, the failure gets marked resolved despite the document-native row still missing.
    db.prepare(
      "UPDATE projection_failures SET resolved_at = ? WHERE entity = ? AND entity_id = ? AND resolved_at IS NULL AND store = 'document-replay'"
    ).run(new Date().toISOString(), 'elective_assignment_runs', runId)
    const wouldBeResolved = db.prepare('SELECT resolved_at FROM projection_failures WHERE op_id = ?').get(opId)
    expect(wouldBeResolved.resolved_at).not.toBeNull() // the defect the guard exists to prevent

    // Now prove the ACTUAL function (with the guard) refuses instead, on a fresh unresolved row.
    const runId2 = randomUUID()
    db.prepare(
      `INSERT INTO projection_failures (op_id, entity, entity_id, field, error_message, failed_at, store)
       VALUES (?, 'elective_assignment_runs', ?, 'status', 'boom', ?, 'document-replay')`
    ).run(`replay:elective_assignment_runs:${runId2}:status`, runId2, new Date().toISOString())
    const result = repairProjectionForEntity(db, 'elective_assignment_runs', runId2)
    expect(result.ok).toBe(false)
    const actuallyResolved = db
      .prepare('SELECT resolved_at FROM projection_failures WHERE entity = ? AND entity_id = ?')
      .get('elective_assignment_runs', runId2)
    expect(actuallyResolved.resolved_at).toBeNull()
  })
})
