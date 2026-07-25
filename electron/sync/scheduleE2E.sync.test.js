// @vitest-environment node
//
// Sub-plan E Task 5 (final verification) regression coverage. Per the task
// brief: a genuine live two-separate-Electron-process UI check (Host +
// Client, real app windows) is NOT achievable in this environment — Camp
// Setup cannot be completed locally (Units has an unsatisfiable Cohorts
// prerequisite with no reachable UI path, confirmed across three prior
// Tester rounds on Tasks 2-4). This file is the closest mechanically
// achievable proxy: a REAL two-actor sync test (Host via startSyncServer,
// Client via createSyncClient, over a real WebSocket connection) exercising
// the full round trip named in the Task 5 success predicate — build a
// schedule (bulk_replace template_slots), regenerate it (bulk_replace
// again), create a manual snapshot (schedule_snapshots field-level write),
// restore it (bulk_replace template_slots + template_overlays) — and
// confirming a separately-connected Client ends up with the identical final
// state as the Host after sync. It does not substitute for a real
// multi-process UI check; see VERIFIER report for the explicit gap
// disclosure.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { createUser, issueCampToken, ensureHostSigningKey } from '../auth/localAuth.js'
import { appendOp } from '../ops/operations.js'
import { startSyncServer } from './syncServer.js'
import { createSyncClient } from './syncClient.js'

const PORT = 8338

let hostDb, hostFile, clientDb, clientFile, server, campId, userId, deviceId, token, templateId

beforeEach(async () => {
  hostFile = path.join(os.tmpdir(), `shoresh-schedule-e2e-host-${Date.now()}-${Math.random()}.sqlite`)
  hostDb = openLocalDb(hostFile)

  clientFile = path.join(os.tmpdir(), `shoresh-schedule-e2e-client-${Date.now()}-${Math.random()}.sqlite`)
  clientDb = openLocalDb(clientFile)

  campId = randomUUID()
  hostDb.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'e'.repeat(64))
  clientDb.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'e'.repeat(64))

  const hostKey = ensureHostSigningKey(hostDb)
  hostDb.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, campId)
  clientDb.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, campId)

  deviceId = randomUUID()
  hostDb.prepare(
    `INSERT INTO devices (id, name, last_synced_at, authorized_at, device_secret_identifier, pairing_status)
     VALUES (?, ?, ?, ?, ?, 'authorized')`
  ).run(deviceId, 'Device A', new Date().toISOString(), new Date().toISOString(), randomBytes(32).toString('hex'))
  clientDb.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Device A')

  const user = await createUser(
    hostDb,
    { camp_id: campId, name: 'Alice', pin: '1234', role: 'admin' },
    async ({ entity, entity_id, field, value }) => {
      const op = appendOp(hostDb, {
        entity,
        entity_id,
        field,
        value,
        author_user_id: null,
        device_id: deviceId,
        parent_op_id: null,
      })
      return { status: 'applied', op }
    }
  )
  userId = user.id
  clientDb.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, campId, 'Alice', 'x', 'x', 'admin')

  // Seed FK targets (groups/activities/schedule_templates) on both dbs,
  // matching bulkReplace.sync.test.js's pattern.
  templateId = 'template-e2e'
  for (const db of [hostDb, clientDb]) {
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name) VALUES (?, ?, ?)').run(templateId, campId, 'Main Template')
    for (const groupId of ['group-1', 'group-2']) {
      db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run(groupId, campId, groupId)
    }
    for (const activityId of ['swim', 'kayak', 'hiking']) {
      db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(activityId, campId, activityId)
    }
    // template_overlays.day_id (unlike template_slots.day_id) is a real FK
    // to days_of_operation(id) — seed it so the overlay bulk_replace below
    // doesn't fail the FOREIGN KEY constraint.
    db.prepare('INSERT INTO days_of_operation (id, camp_id, label) VALUES (?, ?, ?)').run('day-1', campId, 'Day 1')
  }

  token = issueCampToken(hostDb, userId, deviceId)

  server = startSyncServer(hostDb, { port: PORT })
})

afterEach(() => {
  server.close()
  hostDb.close()
  clientDb.close()
  fs.unlinkSync(hostFile)
  fs.unlinkSync(clientFile)
})

describe('Sub-plan E Task 5: full schedule round trip replicates Host -> Client', () => {
  // FIXED (see docs/adr/2026-07-24-bulk-replace-seq-fix.md): `applyRemoteOp`
  // in electron/sync/syncClient.js used to insert a received op WITHOUT its
  // Host-assigned `seq`, so each device's local `operations.seq` was that
  // device's own independent AUTOINCREMENT counter, not the Host's
  // canonical one — `latestScopeOpSeq`/`detectBulkReplaceConflict` compared
  // a client's locally-numbered `based_on_seq` against the Host's own seq
  // counter as if they were the same numbering space, spuriously
  // conflicting on nearly every second bulk_replace to the same scope (e.g.
  // "build a schedule, then Regenerate it"). Fixed by adding a nullable
  // `operations.host_seq` column (migration version 18): `applyRemoteOp` now
  // persists the Host's real `op.seq` into `host_seq`, and
  // `latestScopeOpSeq` reads `COALESCE(host_seq, seq)` so it uses the
  // Host-canonical value on a Client and plain `seq` (unaffected) on the
  // Host.
  it('build -> regenerate -> snapshot create -> restore ends with identical template_slots/template_overlays on Host and Client', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
    })
    await client.waitUntilConnected()

    // 1. Build a schedule: initial bulk_replace of template_slots.
    const builtRows = [
      { id: 'slot-1', template_id: templateId, group_id: 'group-1', activity_id: 'swim', day_id: 'day-1', time_block_id: 'block-1' },
      { id: 'slot-2', template_id: templateId, group_id: 'group-2', activity_id: 'hiking', day_id: 'day-1', time_block_id: 'block-2' },
    ]
    let result = await client.writeBulkReplace({ entity: 'template_slots', scope_id: templateId, rows: builtRows })
    expect(result.status).toBe('applied')

    // 2. Regenerate: a second bulk_replace against the same scope (delete-then-reinsert).
    const regeneratedRows = [
      { id: 'slot-3', template_id: templateId, group_id: 'group-1', activity_id: 'kayak', day_id: 'day-1', time_block_id: 'block-1' },
      { id: 'slot-4', template_id: templateId, group_id: 'group-2', activity_id: 'swim', day_id: 'day-1', time_block_id: 'block-2' },
    ]
    result = await client.writeBulkReplace({ entity: 'template_slots', scope_id: templateId, rows: regeneratedRows })
    expect(result.status).toBe('applied')

    // Also give the regenerated schedule one overlay, via bulk_replace (per
    // Task 3: template_overlays is extended into the same bulk_replace
    // allowlist, not a second bulk mechanism).
    // from_block_order/to_block_order are stringified before bulk_replace,
    // matching ScheduleScreen.jsx's restoreSnapshot() (validateBulkReplaceRows
    // requires every row field to be a string or null).
    const overlayRows = [
      { id: 'overlay-1', template_id: templateId, unit_id: 'group-1', day_id: 'day-1', from_block_order: '1', to_block_order: '2', label: 'Field trip' },
    ]
    result = await client.writeBulkReplace({ entity: 'template_overlays', scope_id: templateId, rows: overlayRows })
    expect(result.status).toBe('applied')

    // 3. Create a manual snapshot: schedule_snapshots is NOT a bulk_replace
    // entity (per schema.sql's own comment: slots/overlays are JSON-text
    // columns, an explicitly scoped exception to field-level sync) - so
    // snapshot creation goes through ordinary per-field write() calls, one
    // per field, exactly as ScheduleScreen.jsx's writeFields() helper does.
    const snapshotId = 'snapshot-1'
    const snapshotFields = {
      template_id: templateId,
      name: 'Manual Snapshot',
      is_auto: 0,
      created_at: new Date().toISOString(),
      slots: JSON.stringify(regeneratedRows),
      overlays: JSON.stringify(overlayRows),
    }
    for (const [field, value] of Object.entries(snapshotFields)) {
      const writeResult = await client.write({ entity: 'schedule_snapshots', entity_id: snapshotId, field, value })
      expect(writeResult.status).toBe('applied')
    }

    // The op-log entries themselves replicate to the Host regardless (every
    // write() call goes through the same op-log path) - confirm that part
    // works before checking whether the row was actually materialized.
    const snapshotOps = hostDb.prepare('SELECT * FROM operations WHERE entity = ? AND entity_id = ?').all('schedule_snapshots', snapshotId)
    expect(snapshotOps.length).toBe(Object.keys(snapshotFields).length)

    // Confirm the schedule_snapshots ROW itself (not just the op-log) was
    // materialized on the Host, and that it replicated to the Client — this
    // is the part of Task 4's JSON-text-column snapshot storage no prior
    // task's automated tests covered end-to-end.
    const hostSnapshotRow = hostDb.prepare('SELECT * FROM schedule_snapshots WHERE id = ?').get(snapshotId)
    expect(hostSnapshotRow, 'Host schedule_snapshots row was not materialized from the field-level op-log writes').toBeTruthy()
    expect(hostSnapshotRow?.name).toBe('Manual Snapshot')
    expect(hostSnapshotRow?.slots).toBe(JSON.stringify(regeneratedRows))
    expect(hostSnapshotRow?.overlays).toBe(JSON.stringify(overlayRows))

    const clientSnapshotRow = clientDb.prepare('SELECT * FROM schedule_snapshots WHERE id = ?').get(snapshotId)
    expect(clientSnapshotRow, 'Client schedule_snapshots row did not replicate from Host').toBeTruthy()
    expect(clientSnapshotRow?.name).toBe(hostSnapshotRow?.name)
    expect(clientSnapshotRow?.slots).toBe(hostSnapshotRow?.slots)
    expect(clientSnapshotRow?.overlays).toBe(hostSnapshotRow?.overlays)

    // 4. Restore the snapshot: bulk_replace template_slots + template_overlays
    // back to the snapshot's stored rows (mirrors ScheduleScreen.jsx's
    // restoreSnapshot()).
    const restoredSlots = JSON.parse(hostSnapshotRow.slots)
    const restoredOverlays = JSON.parse(hostSnapshotRow.overlays)

    result = await client.writeBulkReplace({ entity: 'template_slots', scope_id: templateId, rows: restoredSlots })
    expect(result.status).toBe('applied')
    result = await client.writeBulkReplace({ entity: 'template_overlays', scope_id: templateId, rows: restoredOverlays })
    expect(result.status).toBe('applied')

    // 5. Confirm the Client sees the same final state as the Host after sync.
    const hostFinalSlots = hostDb.prepare('SELECT * FROM template_slots WHERE template_id = ? ORDER BY id').all(templateId)
    const clientFinalSlots = clientDb.prepare('SELECT * FROM template_slots WHERE template_id = ? ORDER BY id').all(templateId)
    expect(clientFinalSlots.map((r) => ({ id: r.id, activity_id: r.activity_id, group_id: r.group_id }))).toEqual(
      hostFinalSlots.map((r) => ({ id: r.id, activity_id: r.activity_id, group_id: r.group_id }))
    )
    // The snapshot was taken of the REGENERATED schedule (slot-3/slot-4),
    // not the originally-built one — restoring it reproduces that same
    // row set, not the pre-regenerate slot-1/slot-2.
    expect(hostFinalSlots.map((r) => r.id)).toEqual(['slot-3', 'slot-4'])

    const hostFinalOverlays = hostDb.prepare('SELECT * FROM template_overlays WHERE template_id = ? ORDER BY id').all(templateId)
    const clientFinalOverlays = clientDb.prepare('SELECT * FROM template_overlays WHERE template_id = ? ORDER BY id').all(templateId)
    expect(clientFinalOverlays).toEqual(hostFinalOverlays)

    client.close()
  })
})
