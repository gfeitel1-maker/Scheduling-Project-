// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { openLocalDb } from '../db/localDb.js'
import { createUser, issueCampToken, ensureHostSigningKey } from '../auth/localAuth.js'
import { appendOp } from '../ops/operations.js'
import { startSyncServer } from './syncServer.js'
import { createSyncClient } from './syncClient.js'
import { getFreePort } from '../../test/integration/harness.js'

let PORT
let hostDb, hostFile, clientDb, clientFile, server, campId, userId, deviceId, token

function connect() {
  return new WebSocket(`ws://localhost:${PORT}`)
}

function onceOpen(ws) {
  return new Promise((resolve) => ws.once('open', resolve))
}

function onceMessageOfType(ws, type) {
  return new Promise((resolve) => {
    function handler(data) {
      const msg = JSON.parse(data.toString())
      if (msg.type === type) {
        ws.off('message', handler)
        resolve(msg)
      }
    }
    ws.on('message', handler)
  })
}

beforeEach(async () => {
  hostFile = path.join(os.tmpdir(), `shoresh-bulk-sync-host-${Date.now()}-${Math.random()}.sqlite`)
  hostDb = openLocalDb(hostFile)

  clientFile = path.join(os.tmpdir(), `shoresh-bulk-sync-client-${Date.now()}-${Math.random()}.sqlite`)
  clientDb = openLocalDb(clientFile)

  campId = randomUUID()
  hostDb.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'd'.repeat(64))
  clientDb.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'd'.repeat(64))

  // Host Ed25519 key (docs/adr/2026-07-25-device-trust-revocation.md) —
  // hostDb issues/verifies 'camp' tokens; clientDb needs the matching public
  // key too, since it also calls verifySessionToken (see below).
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

  // template_slots.group_id/activity_id carry FK references on both dbs -
  // seed everything the bulk-replace row sets below point at.
  for (const db of [hostDb, clientDb]) {
    for (const groupId of ['group-1', 'group-2']) {
      db.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run(groupId, campId, groupId)
    }
    for (const activityId of ['swim', 'kayak', 'hiking']) {
      db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)').run(activityId, campId, activityId)
    }
  }

  token = issueCampToken(hostDb, userId, deviceId)

  PORT = await getFreePort()
  server = startSyncServer(hostDb, { port: PORT })
})

afterEach(() => {
  server.close()
  hostDb.close()
  clientDb.close()
  fs.unlinkSync(hostFile)
  fs.unlinkSync(clientFile)
})

describe('bulk_replace: idempotent retry', () => {
  it('submitting the same client_write_id twice does not double-apply (op-log gains no duplicate entry)', async () => {
    const ws1 = connect()
    await onceOpen(ws1)
    ws1.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    await new Promise((r) => setTimeout(r, 50))

    const rows = [
      { id: 'idem-slot-1', template_id: 'template-idem', group_id: 'group-1', activity_id: 'swim', day_id: 'day-1', time_block_id: 'block-1' },
    ]
    const clientWriteId = randomUUID()

    const first = onceMessageOfType(ws1, 'op_applied')
    ws1.send(JSON.stringify({ type: 'submit_bulk_replace_op', op: { entity: 'template_slots', scope_id: 'template-idem', rows, client_write_id: clientWriteId } }))
    const firstReply = await first
    expect(firstReply.op.entity_id).toBe('template-idem')

    const second = onceMessageOfType(ws1, 'op_applied')
    ws1.send(JSON.stringify({ type: 'submit_bulk_replace_op', op: { entity: 'template_slots', scope_id: 'template-idem', rows, client_write_id: clientWriteId } }))
    const secondReply = await second

    // Same op returned both times - the retry did not mint a new op.
    expect(secondReply.op.id).toBe(firstReply.op.id)

    const opCount = hostDb.prepare('SELECT COUNT(*) as c FROM operations WHERE entity_id = ?').get('template-idem').c
    expect(opCount).toBe(1)

    const slotCount = hostDb.prepare('SELECT COUNT(*) as c FROM template_slots WHERE template_id = ?').get('template-idem').c
    expect(slotCount).toBe(1)

    ws1.close()
  })
})

describe('bulk_replace: malformed/partial rows payload', () => {
  it('rejects a non-array rows payload without crashing the connection or touching the DB', async () => {
    const ws1 = connect()
    await onceOpen(ws1)
    ws1.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    await new Promise((r) => setTimeout(r, 50))

    const errorPromise = onceMessageOfType(ws1, 'error')
    ws1.send(JSON.stringify({ type: 'submit_bulk_replace_op', op: { entity: 'template_slots', scope_id: 'template-bad', rows: 'not-an-array' } }))
    const errorMsg = await errorPromise
    expect(errorMsg.type).toBe('error')

    const opCount = hostDb.prepare('SELECT COUNT(*) as c FROM operations WHERE entity_id = ?').get('template-bad').c
    expect(opCount).toBe(0)
    const slotCount = hostDb.prepare('SELECT COUNT(*) as c FROM template_slots WHERE template_id = ?').get('template-bad').c
    expect(slotCount).toBe(0)

    // connection must still be alive/responsive afterwards
    const ws2 = connect()
    await onceOpen(ws2)
    ws2.close()
    ws1.close()
  })

  it('rejects a row with a wrong-typed field (deep row validation) without touching the DB', async () => {
    const ws1 = connect()
    await onceOpen(ws1)
    ws1.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    await new Promise((r) => setTimeout(r, 50))

    const errorPromise = onceMessageOfType(ws1, 'error')
    ws1.send(
      JSON.stringify({
        type: 'submit_bulk_replace_op',
        op: {
          entity: 'template_slots',
          scope_id: 'template-bad2',
          rows: [{ id: 'x', template_id: 'template-bad2', activity_id: 999 }],
        },
      })
    )
    await errorPromise

    const slotCount = hostDb.prepare('SELECT COUNT(*) as c FROM template_slots WHERE template_id = ?').get('template-bad2').c
    expect(slotCount).toBe(0)

    ws1.close()
  })
})

describe('bulk_replace: real conflict detection (round 2)', () => {
  it('a concurrent field-level edit to a row in scope is detected as a conflict, not silently overwritten', async () => {
    const ws1 = connect()
    await onceOpen(ws1)
    ws1.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    await new Promise((r) => setTimeout(r, 50))

    // Seed the scope with an initial bulk_replace so there's a row to
    // concurrently edit, and so Device B has a real based_on_seq to
    // (deliberately) go stale against.
    const initialRows = [
      { id: 'conf-slot-1', template_id: 'template-conflict', group_id: 'group-1', activity_id: 'swim', day_id: 'day-1', time_block_id: 'block-1' },
    ]
    const seedApplied = onceMessageOfType(ws1, 'op_applied')
    ws1.send(
      JSON.stringify({
        type: 'submit_bulk_replace_op',
        op: { entity: 'template_slots', scope_id: 'template-conflict', rows: initialRows, client_write_id: randomUUID(), based_on_seq: 0 },
      })
    )
    const seedReply = await seedApplied
    const staleBasedOnSeq = seedReply.op.seq

    // Device A: a normal field-level op on the one row in scope
    // (entity_id = the row's own id, not the scope_id).
    const fieldOpApplied = onceMessageOfType(ws1, 'op_applied')
    ws1.send(
      JSON.stringify({
        type: 'submit_op',
        op: { entity: 'template_slots', entity_id: 'conf-slot-1', field: 'activity_id', value: 'kayak', parent_op_id: null, client_write_id: randomUUID() },
      })
    )
    await fieldOpApplied

    // Device B: submits a bulk_replace for the SAME scope whose
    // based_on_seq predates Device A's field-level edit above (it only
    // knows about the seed, not A's subsequent write).
    const conflictReply = onceMessageOfType(ws1, 'op_conflict')
    ws1.send(
      JSON.stringify({
        type: 'submit_bulk_replace_op',
        op: {
          entity: 'template_slots',
          scope_id: 'template-conflict',
          rows: [
            { id: 'conf-slot-stale', template_id: 'template-conflict', group_id: 'group-2', activity_id: 'hiking', day_id: 'day-1', time_block_id: 'block-1' },
          ],
          client_write_id: randomUUID(),
          based_on_seq: staleBasedOnSeq,
        },
      })
    )
    const conflict = await conflictReply
    expect(conflict.type).toBe('op_conflict')

    // The conflict was recorded durably.
    const pendingConflicts = hostDb.prepare('SELECT * FROM conflicts WHERE resolved_at IS NULL').all()
    expect(pendingConflicts.length).toBe(1)

    // Device A's field-level op was durably recorded in the op-log (this
    // codebase does not yet register a `template_slots` field-level
    // projection, so the projected table row itself isn't mutated by a
    // per-field op today — that's a separate, pre-existing gap, not this
    // task's scope; what matters HERE is that the op-log entry exists with
    // a seq newer than Device B's based_on_seq, which is exactly what
    // latestScopeOpSeq/detectBulkReplaceConflict keys off of).
    const fieldOpLogged = hostDb.prepare('SELECT * FROM operations WHERE entity_id = ? AND field = ?').get('conf-slot-1', 'activity_id')
    expect(fieldOpLogged).toBeTruthy()
    expect(fieldOpLogged.value).toBe('kayak')

    // Device B's stale bulk_replace was NOT silently applied: the scope
    // still has exactly the row from the seed bulk_replace — not Device
    // B's rejected row set (conf-slot-stale / hiking).
    const currentRows = hostDb.prepare('SELECT * FROM template_slots WHERE template_id = ? ORDER BY id').all('template-conflict')
    expect(currentRows.map((r) => r.id)).toEqual(['conf-slot-1'])

    ws1.close()
  })
})

describe('bulk_replace: non-conflicting case still applies cleanly (round-1 happy-path regression)', () => {
  it('a bulk_replace whose based_on_seq IS current applies with no conflict', async () => {
    const ws1 = connect()
    await onceOpen(ws1)
    ws1.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    await new Promise((r) => setTimeout(r, 50))

    const rows = [
      { id: 'clean-slot-1', template_id: 'template-clean', group_id: 'group-1', activity_id: 'swim', day_id: 'day-1', time_block_id: 'block-1' },
    ]
    const applied = onceMessageOfType(ws1, 'op_applied')
    ws1.send(
      JSON.stringify({
        type: 'submit_bulk_replace_op',
        op: { entity: 'template_slots', scope_id: 'template-clean', rows, client_write_id: randomUUID(), based_on_seq: 0 },
      })
    )
    const reply = await applied
    expect(reply.type).toBe('op_applied')
    expect(reply.op.entity_id).toBe('template-clean')

    const currentRows = hostDb.prepare('SELECT * FROM template_slots WHERE template_id = ? ORDER BY id').all('template-clean')
    expect(currentRows.map((r) => r.id)).toEqual(['clean-slot-1'])

    ws1.close()
  })

  it('omitting based_on_seq entirely (older-client shape) still applies cleanly against a fresh scope', async () => {
    const ws1 = connect()
    await onceOpen(ws1)
    ws1.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    await new Promise((r) => setTimeout(r, 50))

    const rows = [
      { id: 'noseq-slot-1', template_id: 'template-noseq', group_id: 'group-1', activity_id: 'swim', day_id: 'day-1', time_block_id: 'block-1' },
    ]
    const applied = onceMessageOfType(ws1, 'op_applied')
    ws1.send(
      JSON.stringify({
        type: 'submit_bulk_replace_op',
        op: { entity: 'template_slots', scope_id: 'template-noseq', rows, client_write_id: randomUUID() },
      })
    )
    const reply = await applied
    expect(reply.type).toBe('op_applied')

    ws1.close()
  })
})

describe('bulk_replace: MAX_BULK_REPLACE_ROWS enforced over the wire', () => {
  it('rejects an oversized rows array before the DB is touched', async () => {
    const ws1 = connect()
    await onceOpen(ws1)
    ws1.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    await new Promise((r) => setTimeout(r, 50))

    const oversized = Array.from({ length: 5001 }, (_, i) => ({ id: `over-${i}`, template_id: 'template-oversized-wire' }))
    const errorPromise = onceMessageOfType(ws1, 'error')
    ws1.send(
      JSON.stringify({
        type: 'submit_bulk_replace_op',
        op: { entity: 'template_slots', scope_id: 'template-oversized-wire', rows: oversized, client_write_id: randomUUID() },
      })
    )
    await errorPromise

    const opCount = hostDb.prepare('SELECT COUNT(*) as c FROM operations WHERE entity_id = ?').get('template-oversized-wire').c
    expect(opCount).toBe(0)
    const slotCount = hostDb.prepare('SELECT COUNT(*) as c FROM template_slots WHERE template_id = ?').get('template-oversized-wire').c
    expect(slotCount).toBe(0)

    ws1.close()
  })
})

describe('bulk_replace: replication Host -> Client', () => {
  it('a bulk_replace applied on the Host syncs correctly to a Client via op_applied', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
    })

    const applied = []
    client.onOpApplied((op) => applied.push(op))

    await client.waitUntilConnected()

    const rows = [
      { id: 'sync-slot-1', template_id: 'template-sync', group_id: 'group-1', activity_id: 'kayak', day_id: 'day-1', time_block_id: 'block-1' },
      { id: 'sync-slot-2', template_id: 'template-sync', group_id: 'group-2', activity_id: 'hiking', day_id: 'day-1', time_block_id: 'block-2' },
    ]

    const result = await client.writeBulkReplace({ entity: 'template_slots', scope_id: 'template-sync', rows })
    expect(result.status).toBe('applied')

    // Host side: op-log + table both reflect the bulk replace.
    const hostOp = hostDb.prepare('SELECT * FROM operations WHERE entity_id = ?').get('template-sync')
    expect(hostOp).toBeTruthy()
    const hostRows = hostDb.prepare('SELECT * FROM template_slots WHERE template_id = ? ORDER BY id').all('template-sync')
    expect(hostRows.map((r) => r.id)).toEqual(['sync-slot-1', 'sync-slot-2'])

    // Client side: the op replicated back through op_applied and was
    // materialized into the Client's own template_slots table.
    const clientOp = clientDb.prepare('SELECT * FROM operations WHERE entity_id = ?').get('template-sync')
    expect(clientOp).toBeTruthy()
    const clientRows = clientDb.prepare('SELECT * FROM template_slots WHERE template_id = ? ORDER BY id').all('template-sync')
    expect(clientRows.map((r) => r.id)).toEqual(['sync-slot-1', 'sync-slot-2'])
    expect(clientRows.find((r) => r.id === 'sync-slot-1').activity_id).toBe('kayak')

    client.close()
  })
})
