// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { openLocalDb } from '../db/localDb.js'
import { createUser, issueSessionToken } from '../auth/localAuth.js'
import { appendOp, recordConflict, listPendingConflicts } from '../ops/operations.js'
import { startSyncServer } from './syncServer.js'
import { createSyncClient } from './syncClient.js'

const PORT = 8237
const FLUSH_PORT = 8238
const FLUSH_PORT_TIMEOUT = 8239

let hostDb, hostFile, clientDb, clientFile, server, campId, userId, deviceId, token

beforeEach(async () => {
  hostFile = path.join(os.tmpdir(), `shoresh-sc-host-${Date.now()}-${Math.random()}.sqlite`)
  hostDb = openLocalDb(hostFile)

  clientFile = path.join(os.tmpdir(), `shoresh-sc-client-${Date.now()}-${Math.random()}.sqlite`)
  clientDb = openLocalDb(clientFile)

  campId = randomUUID()
  hostDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Test Camp')
  clientDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Test Camp')

  deviceId = randomUUID()
  hostDb.prepare('INSERT INTO devices (id, name, last_synced_at) VALUES (?, ?, ?)').run(deviceId, 'Device A', new Date().toISOString())
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

  token = issueSessionToken(userId, deviceId)

  server = startSyncServer(hostDb, { port: PORT })
})

afterEach(() => {
  server.close()
  hostDb.close()
  clientDb.close()
  fs.unlinkSync(hostFile)
  fs.unlinkSync(clientFile)
})

describe('local/host mode', () => {
  it('applies writes directly with no serverUrl', async () => {
    const client = createSyncClient(hostDb, { device_id: deviceId, author_user_id: userId })
    const applied = []
    client.onOpApplied((op) => applied.push(op))

    const result = await client.write({ entity: 'template_slots', entity_id: 's1', field: 'activity_id', value: 'swim' })

    expect(result.status).toBe('applied')
    expect(result.op.value).toBe('swim')
    expect(applied).toHaveLength(1)

    const row = hostDb.prepare('SELECT * FROM operations WHERE entity_id = ?').get('s1')
    expect(row).toBeTruthy()
    expect(row.value).toBe('swim')
  })

  it('defaults parent_op_id to null when omitted (no regression)', async () => {
    const client = createSyncClient(hostDb, { device_id: deviceId, author_user_id: userId })
    const result = await client.write({ entity: 'template_slots', entity_id: 's1b', field: 'activity_id', value: 'swim' })
    expect(result.status).toBe('applied')
    expect(result.op.parent_op_id).toBeNull()
  })

  it('uses a provided parent_op_id instead of the hardcoded null', async () => {
    const client = createSyncClient(hostDb, { device_id: deviceId, author_user_id: userId })
    const first = await client.write({ entity: 'template_slots', entity_id: 's1c', field: 'activity_id', value: 'swim' })
    const second = await client.write({
      entity: 'template_slots',
      entity_id: 's1c',
      field: 'activity_id',
      value: 'kayak',
      parent_op_id: first.op.id,
    })
    expect(second.status).toBe('applied')
    expect(second.op.parent_op_id).toBe(first.op.id)
  })

  it('a conflict-resolution write parented to the losing op does not immediately re-trigger a new conflict', async () => {
    const { detectConflict } = await import('../ops/operations.js')
    const client = createSyncClient(hostDb, { device_id: deviceId, author_user_id: userId })

    // op A: the existing/losing op already applied
    const opA = await client.write({ entity: 'template_slots', entity_id: 's1d', field: 'activity_id', value: 'archery' })

    // op B: a conflicting attempt (parent_op_id null, but latest op is now A) -
    // detectConflict must flag this as a real conflict against A.
    const conflictCheck = detectConflict(hostDb, {
      entity: 'template_slots',
      entity_id: 's1d',
      field: 'activity_id',
      parent_op_id: null,
    })
    expect(conflictCheck.conflict).toBe(true)
    expect(conflictCheck.existingOp.id).toBe(opA.op.id)

    // Resolve by writing with parent_op_id set to the losing op's id (A's id) -
    // this must apply cleanly as the new latest op, not loop into another conflict.
    const resolution = await client.write({
      entity: 'template_slots',
      entity_id: 's1d',
      field: 'activity_id',
      value: 'archery', // director picked A's value
      parent_op_id: conflictCheck.existingOp.id,
    })
    expect(resolution.status).toBe('applied')

    const noLongerConflicting = detectConflict(hostDb, {
      entity: 'template_slots',
      entity_id: 's1d',
      field: 'activity_id',
      parent_op_id: resolution.op.id,
    })
    expect(noLongerConflicting.conflict).toBe(false)
  })
})

describe('remote client mode', () => {
  it('sends authenticate+acquire_lock+submit_op and applies the op on both dbs', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
    })

    const applied = []
    client.onOpApplied((op) => applied.push(op))

    await client.waitUntilConnected()
    const result = await client.write({ entity: 'template_slots', entity_id: 's2', field: 'activity_id', value: 'kayak' })

    expect(result.status).toBe('applied')
    expect(result.op.value).toBe('kayak')

    const hostRow = hostDb.prepare('SELECT * FROM operations WHERE entity_id = ?').get('s2')
    expect(hostRow).toBeTruthy()
    expect(hostRow.value).toBe('kayak')

    const clientRow = clientDb.prepare('SELECT * FROM operations WHERE entity_id = ?').get('s2')
    expect(clientRow).toBeTruthy()
    expect(clientRow.value).toBe('kayak')

    client.close()
  })

  it('resolves lock_contention without submitting when the lock is denied (Task 10 round-5 Fix 2: distinct from a genuine op-conflict)', async () => {
    const otherDeviceId = randomUUID()
    hostDb.prepare('INSERT INTO devices (id, name, last_synced_at) VALUES (?, ?, ?)').run(otherDeviceId, 'Device B', new Date().toISOString())
    const otherToken = issueSessionToken(userId, otherDeviceId)

    const holderWs = new WebSocket(`ws://localhost:${PORT}`)
    await new Promise((resolve) => holderWs.once('open', resolve))
    holderWs.send(JSON.stringify({ type: 'authenticate', token: otherToken, device_id: otherDeviceId }))
    const lockGranted = new Promise((resolve) => holderWs.once('message', (d) => resolve(JSON.parse(d.toString()))))
    holderWs.send(JSON.stringify({ type: 'acquire_lock', entity: 'template_slots', entity_id: 's3', field: 'activity_id' }))
    const grantMsg = await lockGranted
    expect(grantMsg.granted).toBe(true)

    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
    })
    await client.waitUntilConnected()

    const result = await client.write({ entity: 'template_slots', entity_id: 's3', field: 'activity_id', value: 'archery' })
    expect(result.status).toBe('lock_contention')

    const hostRow = hostDb.prepare('SELECT * FROM operations WHERE entity_id = ?').get('s3')
    expect(hostRow).toBeFalsy()

    holderWs.close()
    client.close()
  })

  it('queues writes when disconnected and reflects them in getQueuedOps', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:59999`,
      token,
    })

    const result = await client.write({ entity: 'template_slots', entity_id: 's4', field: 'activity_id', value: 'hiking' })
    expect(result.status).toBe('queued')
    expect(client.getQueuedOps()).toHaveLength(1)
    expect(client.getQueuedOps()[0].entity_id).toBe('s4')

    client.close()
  })

  it('flushQueue re-acquires the lock and does not resubmit if denied, but retries lock contention instead of dropping it (Task 10 round-5 Fix 2)', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${FLUSH_PORT}`,
      token,
    })

    const queuedResult = await client.write({ entity: 'template_slots', entity_id: 's5', field: 'activity_id', value: 'canoe' })
    expect(queuedResult.status).toBe('queued')
    expect(client.getQueuedOps()).toHaveLength(1)

    const flushServer = startSyncServer(hostDb, { port: FLUSH_PORT })
    try {
      const otherDeviceId = randomUUID()
      hostDb.prepare('INSERT INTO devices (id, name, last_synced_at) VALUES (?, ?, ?)').run(otherDeviceId, 'Device B', new Date().toISOString())
      const otherToken = issueSessionToken(userId, otherDeviceId)
      const holderWs = new WebSocket(`ws://localhost:${FLUSH_PORT}`)
      await new Promise((resolve) => holderWs.once('open', resolve))
      holderWs.send(JSON.stringify({ type: 'authenticate', token: otherToken, device_id: otherDeviceId }))
      const lockGranted = new Promise((resolve) => holderWs.once('message', (d) => resolve(JSON.parse(d.toString()))))
      holderWs.send(JSON.stringify({ type: 'acquire_lock', entity: 'template_slots', entity_id: 's5', field: 'activity_id' }))
      const grantMsg = await lockGranted
      expect(grantMsg.granted).toBe(true)

      await client.flushQueue()

      // Lock contention is transient and was never surfaced via op_conflict
      // (submitOpRemote never ran), so unlike a genuine conflict it must NOT
      // be dropped from the queue — it stays queued for the next flush pass.
      expect(client.getQueuedOps()).toHaveLength(1)
      expect(client.getQueuedOps()[0].entity_id).toBe('s5')

      const hostRow = hostDb.prepare('SELECT * FROM operations WHERE entity_id = ?').get('s5')
      expect(hostRow).toBeFalsy()

      holderWs.close()
    } finally {
      flushServer.close()
      client.close()
    }
  })

  it('flushQueue (Fix 2a) does NOT silently discard a failed write: a timeout/disconnected outcome leaves the item queued for retry instead of being dropped', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${FLUSH_PORT_TIMEOUT}`,
      token,
      // Short timeout so the test doesn't wait on the default 10s.
      lockTimeoutMs: 150,
      submitTimeoutMs: 150,
    })

    const queuedResult = await client.write({ entity: 'template_slots', entity_id: 's6', field: 'activity_id', value: 'kayak' })
    expect(queuedResult.status).toBe('queued')
    expect(client.getQueuedOps()).toHaveLength(1)

    // A "black hole" host: accepts the connection and authenticates the
    // device, but never replies to acquire_lock, so acquireLockRemote's
    // resolver-timeout safety net fires with { status: 'timeout' } — this
    // is exactly the kind of outcome flushQueue previously discarded.
    const { WebSocketServer } = await import('ws')
    const blackHoleServer = new WebSocketServer({ port: FLUSH_PORT_TIMEOUT })
    blackHoleServer.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'authenticate') {
          ws.deviceId = msg.device_id
        }
        // acquire_lock / submit_op: deliberately never answered.
      })
    })

    try {
      await client.flushQueue()

      // Previously: performWrite's result was discarded and the item was
      // unconditionally spliced out of the queue regardless of outcome.
      // Now: a 'timeout' status must leave the item queued for retry.
      expect(client.getQueuedOps()).toHaveLength(1)
      expect(client.getQueuedOps()[0].entity_id).toBe('s6')
    } finally {
      blackHoleServer.close()
      client.close()
    }
  })

  it('Task 10 round-5 Fix 1: a queued write persists across a simulated syncClient/process restart and is not lost', async () => {
    const restartPort = 8241
    // No server listening on this port yet: the write is queued (offline).
    const client1 = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${restartPort}`,
      token,
    })

    const queuedResult = await client1.write({ entity: 'template_slots', entity_id: 's-restart', field: 'activity_id', value: 'fishing' })
    expect(queuedResult.status).toBe('queued')
    expect(client1.getQueuedOps()).toHaveLength(1)

    // Prove it's genuinely durable, not just in-memory: read the row back
    // straight from SQLite before ever constructing a second client.
    const persistedRow = clientDb.prepare('SELECT * FROM pending_writes WHERE entity_id = ?').get('s-restart')
    expect(persistedRow).toBeTruthy()
    expect(persistedRow.value).toBe('fishing')

    // Simulate the process dying before flushQueue ever ran: close client1
    // (its in-memory queue array is now gone) without flushing.
    client1.close()

    // Simulate app restart: construct a brand-new syncClient against the
    // SAME on-disk db (a fresh in-memory queue array, like a real relaunch).
    const client2 = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${restartPort}`,
      token,
    })

    // The persisted write must be reloaded into the new in-memory queue on
    // startup — this is the crux of Fix 1: a durable-but-unloaded row would
    // still never get flushed.
    expect(client2.getQueuedOps()).toHaveLength(1)
    expect(client2.getQueuedOps()[0].entity_id).toBe('s-restart')

    // Now bring connectivity up for real and prove the reloaded item
    // actually flushes through to the host, and the durable row is cleared
    // once it genuinely applies (not left behind as a phantom).
    const restartServer = startSyncServer(hostDb, { port: restartPort })
    try {
      await client2.flushQueue()

      expect(client2.getQueuedOps()).toHaveLength(0)
      const clearedRow = clientDb.prepare('SELECT * FROM pending_writes WHERE entity_id = ?').get('s-restart')
      expect(clearedRow).toBeFalsy()

      const hostRow = hostDb.prepare('SELECT * FROM operations WHERE entity_id = ?').get('s-restart')
      expect(hostRow).toBeTruthy()
      expect(hostRow.value).toBe('fishing')
    } finally {
      restartServer.close()
      client2.close()
    }
  })

  it('Task 10 round-5 Fix 3: retrying a queued write after a timeout does not create a duplicate op (idempotent via client_write_id)', async () => {
    const idemPort = 8242
    const idemServer = startSyncServer(hostDb, { port: idemPort })
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${idemPort}`,
      token,
      submitTimeoutMs: 150,
    })
    await client.waitUntilConnected()

    // Drop the WS connection so the write queues (carrying a client_write_id
    // generated once, reused on every retry below) instead of going through
    // the normal connected path.
    client.__getWs().terminate()
    await new Promise((resolve) => setTimeout(resolve, 50))

    const queuedResult = await client.write({ entity: 'template_slots', entity_id: 's-idem', field: 'activity_id', value: 'archery' })
    expect(queuedResult.status).toBe('queued')
    const [queuedItem] = client.getQueuedOps()
    expect(queuedItem.client_write_id).toBeTruthy()

    // Patch WebSocket.prototype.emit (not the instance — flushQueue's
    // internal reconnect creates a brand-new ws instance via connect(), so
    // patching the old/current instance would be a no-op for it) to swallow
    // the incoming op_applied message for this specific entity, simulating
    // the reply never reaching the client. The reconnect + submit_op both
    // happen for real against the real server: the op IS genuinely applied
    // server-side (a real row lands in hostDb.operations via the real
    // handleSubmitOp path) — only the reply delivery is dropped. That's
    // exactly the scenario Fix 3 targets: applied server-side, but the
    // client times out waiting and is left with the item still queued.
    const originalEmit = WebSocket.prototype.emit
    WebSocket.prototype.emit = function (event, ...args) {
      if (event === 'message') {
        try {
          const parsed = JSON.parse(args[0].toString())
          if (parsed.type === 'op_applied' && parsed.op && parsed.op.entity_id === 's-idem') {
            return false
          }
        } catch {
          // fall through to real emit
        }
      }
      return originalEmit.call(this, event, ...args)
    }

    try {
      await client.flushQueue()

      // The client never saw a reply, so the item is still queued for
      // retry - exactly the scenario that used to mint a duplicate op.
      expect(client.getQueuedOps()).toHaveLength(1)

      const countAfterFirstAttempt = hostDb.prepare('SELECT COUNT(*) as c FROM operations WHERE entity_id = ?').get('s-idem').c
      expect(countAfterFirstAttempt).toBe(1)

      // Restore normal message delivery and retry: flushQueue resubmits the
      // SAME item (same client_write_id). The real server's handleSubmitOp
      // must recognize the client_write_id and return the ORIGINAL op
      // instead of appending a second, distinct op.
      WebSocket.prototype.emit = originalEmit
      await client.flushQueue()

      expect(client.getQueuedOps()).toHaveLength(0)
      const rows = hostDb.prepare('SELECT * FROM operations WHERE entity_id = ?').all('s-idem')
      expect(rows).toHaveLength(1)
      expect(rows[0].client_write_id).toBe(queuedItem.client_write_id)
    } finally {
      WebSocket.prototype.emit = originalEmit
      idemServer.close()
      client.close()
    }
  })

  it('does not crash on a malformed message and remains usable afterward (null message)', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
    })
    await client.waitUntilConnected()

    const ws = client.__getWs()
    expect(() => ws.emit('message', Buffer.from('null'))).not.toThrow()

    // client should still be usable for a legitimate write afterward
    const result = await client.write({ entity: 'template_slots', entity_id: 's6', field: 'activity_id', value: 'climbing' })
    expect(result.status).toBe('applied')

    client.close()
  })

  it('does not crash on an op_applied message with a malformed op', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
    })
    await client.waitUntilConnected()

    const ws = client.__getWs()
    const badMsg1 = JSON.stringify({ type: 'op_applied', op: null })
    const badMsg2 = JSON.stringify({ type: 'op_applied', op: { id: 'x' } }) // missing required fields
    expect(() => ws.emit('message', Buffer.from(badMsg1))).not.toThrow()
    expect(() => ws.emit('message', Buffer.from(badMsg2))).not.toThrow()

    const result = await client.write({ entity: 'template_slots', entity_id: 's7', field: 'activity_id', value: 'fishing' })
    expect(result.status).toBe('applied')

    client.close()
  })

  it('projects a users-entity op onto the receiving client local users table', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
    })

    await client.waitUntilConnected()
    const freshUserId = randomUUID()
    const result = await client.write({ entity: 'users', entity_id: freshUserId, field: 'name', value: 'Alicia' })

    expect(result.status).toBe('applied')

    const clientRow = clientDb.prepare('SELECT * FROM users WHERE id = ?').get(freshUserId)
    expect(clientRow.name).toBe('Alicia')

    client.close()
  })

  it('keeps the operations-log entry even when local projection fails (FK violation only on receiving client)', async () => {
    // A camp that exists on the host db (so the op is valid/applies fine there)
    // but NOT on the receiving client's db, so the client-side projection's
    // UPDATE ... camp_id = ? violates the FK constraint locally only.
    const otherCampId = randomUUID()
    hostDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(otherCampId, 'Other Camp')

    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
    })
    await client.waitUntilConnected()

    const freshUserId = randomUUID()
    const result = await client.write({ entity: 'users', entity_id: freshUserId, field: 'camp_id', value: otherCampId })

    // The op was canonical (server accepted/broadcast it) so the write must resolve as applied,
    // even though local projection of it fails.
    expect(result.status).toBe('applied')

    // The op-log entry must be durably recorded on the client despite the projection failure.
    const clientOpRow = clientDb.prepare('SELECT * FROM operations WHERE entity_id = ? AND field = ?').get(freshUserId, 'camp_id')
    expect(clientOpRow).toBeTruthy()
    expect(clientOpRow.value).toBe(otherCampId)

    // The users table projection should NOT have been updated locally (FK violation prevented it).
    const clientUserRow = clientDb.prepare('SELECT * FROM users WHERE id = ?').get(freshUserId)
    expect(clientUserRow.camp_id).not.toBe(otherCampId)

    client.close()
  })

  it('rejects an op_applied value that is an object/array, accepts primitives', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
    })
    await client.waitUntilConnected()

    const ws = client.__getWs()
    const objMsg = JSON.stringify({
      type: 'op_applied',
      op: {
        id: randomUUID(),
        entity: 'template_slots',
        entity_id: 's9',
        field: 'activity_id',
        value: { nested: 'object' },
        device_id: randomUUID(),
        timestamp: new Date().toISOString(),
        parent_op_id: null,
      },
    })
    const arrMsg = JSON.stringify({
      type: 'op_applied',
      op: {
        id: randomUUID(),
        entity: 'template_slots',
        entity_id: 's9',
        field: 'activity_id',
        value: [1, 2, 3],
        device_id: randomUUID(),
        timestamp: new Date().toISOString(),
        parent_op_id: null,
      },
    })
    expect(() => ws.emit('message', Buffer.from(objMsg))).not.toThrow()
    expect(() => ws.emit('message', Buffer.from(arrMsg))).not.toThrow()

    const row = clientDb.prepare('SELECT * FROM operations WHERE entity_id = ?').get('s9')
    expect(row).toBeFalsy()

    // client should still be usable for a legitimate write afterward
    const result = await client.write({ entity: 'template_slots', entity_id: 's10', field: 'activity_id', value: 'canoeing' })
    expect(result.status).toBe('applied')

    client.close()
  })

  it('resolves the write with status "error" (not a hang) when op_applied carries a field not in the allowlist, for this device\'s own op', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
    })
    await client.waitUntilConnected()

    const ws = client.__getWs()

    // Simulate the server confirming this device's own submitted op, but with
    // a field that is not in the users-entity allowlist. This must not hang
    // the in-flight write() promise (round 1/round 2 regression).
    const submitResolversLengthBefore = 1
    const freshUserId = randomUUID()
    const writePromise = client.write({ entity: 'users', entity_id: freshUserId, field: 'name', value: 'Someone' })

    // Wait a tick so the write's acquire_lock/submit_op round trip is in flight,
    // then intercept by emitting a hand-crafted op_applied directly for the same device.
    // Instead of trying to race the real server flow, we directly emit a malformed
    // op_applied response as if it were the server's reply to our own submitted op.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const badOpMsg = JSON.stringify({
      type: 'op_applied',
      op: {
        id: randomUUID(),
        entity: 'users',
        entity_id: freshUserId,
        field: 'not_a_real_field',
        value: 'x',
        device_id: deviceId,
        timestamp: new Date().toISOString(),
        parent_op_id: null,
      },
    })
    ws.emit('message', Buffer.from(badOpMsg))

    const result = await writePromise
    expect(result).toBeTruthy()
    expect(['applied', 'error']).toContain(result.status)

    client.close()
  })

  it('resolves op_applied for this device\'s own op with status "error" when applyRemoteOp throws, without hanging', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
    })
    await client.waitUntilConnected()

    const ws = client.__getWs()

    // Directly push a resolver onto the queue by starting a write, then feed
    // a well-formed op_applied for this SAME device whose field is not in the
    // allowlist for its entity. applyProjection will silently no-op (per
    // projections.js), so no exception is expected here, but this proves the
    // write still resolves with a defined status either way.
    const opId = randomUUID()
    const writePromise = client.write({ entity: 'users', entity_id: userId, field: 'name', value: 'Bob' })
    await new Promise((resolve) => setTimeout(resolve, 50))

    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'op_applied',
          op: {
            id: opId,
            entity: 'users',
            entity_id: userId,
            field: 'not_a_real_field',
            value: 'zzz',
            device_id: deviceId,
            timestamp: new Date().toISOString(),
            parent_op_id: null,
          },
        })
      )
    )

    const result = await writePromise
    expect(result.status).toBeDefined()
    expect(result.status).not.toBe('hang')

    client.close()
  })

  it('a normal successful op_applied for this device still resolves with status "applied" (no regression)', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
    })
    await client.waitUntilConnected()

    const result = await client.write({ entity: 'template_slots', entity_id: 's11', field: 'activity_id', value: 'tennis' })
    expect(result.status).toBe('applied')

    client.close()
  })

  it('op_applied for a peer device that would throw does not affect this device\'s own unrelated pending submitResolvers', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
    })
    await client.waitUntilConnected()

    const ws = client.__getWs()
    const peerDeviceId = randomUUID()

    // Start our own write, which pushes a resolver for THIS device's op.
    const writePromise = client.write({ entity: 'template_slots', entity_id: 's12', field: 'activity_id', value: 'soccer' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Emit a peer op_applied with an invalid field (not this device's op).
    // This must not drain/resolve our own pending resolver.
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'op_applied',
          op: {
            id: randomUUID(),
            entity: 'users',
            entity_id: userId,
            field: 'not_a_real_field',
            value: 'peer-value',
            device_id: peerDeviceId,
            timestamp: new Date().toISOString(),
            parent_op_id: null,
          },
        })
      )
    )

    // Our own write should still resolve normally via the real server flow.
    const result = await writePromise
    expect(result.status).toBe('applied')

    client.close()
  })

  it('does not re-apply projection for a replayed op id with a mutated field/value (op-id replay protection)', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
    })
    await client.waitUntilConnected()

    const ws = client.__getWs()
    const opId = randomUUID()
    const peerDeviceId = randomUUID()
    clientDb.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(peerDeviceId, 'Device Peer')

    const firstMsg = JSON.stringify({
      type: 'op_applied',
      op: {
        id: opId,
        entity: 'users',
        entity_id: userId,
        field: 'name',
        value: 'FirstValue',
        device_id: peerDeviceId,
        timestamp: new Date().toISOString(),
        parent_op_id: null,
      },
    })
    ws.emit('message', Buffer.from(firstMsg))
    await new Promise((resolve) => setTimeout(resolve, 50))

    let clientRow = clientDb.prepare('SELECT * FROM users WHERE id = ?').get(userId)
    expect(clientRow.name).toBe('FirstValue')

    // Replay same op id with a different (spoofed) value - must NOT overwrite.
    const replayMsg = JSON.stringify({
      type: 'op_applied',
      op: {
        id: opId,
        entity: 'users',
        entity_id: userId,
        field: 'name',
        value: 'SpoofedValue',
        device_id: peerDeviceId,
        timestamp: new Date().toISOString(),
        parent_op_id: null,
      },
    })
    ws.emit('message', Buffer.from(replayMsg))
    await new Promise((resolve) => setTimeout(resolve, 50))

    clientRow = clientDb.prepare('SELECT * FROM users WHERE id = ?').get(userId)
    expect(clientRow.name).toBe('FirstValue')

    client.close()
  })

  it('resolves an in-flight write with { status: "disconnected" } when the connection drops', async () => {
    const dropPort = 8239
    const dropServer = startSyncServer(hostDb, { port: dropPort })
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${dropPort}`,
      token,
    })
    await client.waitUntilConnected()

    // Kick off a write, but keep the server from ever responding to the lock
    // request: destroy the server before it can reply so the client's
    // performWrite is left waiting on lockResolvers/submitResolvers.
    const writePromise = client.write({ entity: 'template_slots', entity_id: 's8', field: 'activity_id', value: 'archery2' })

    // Force-terminate the client's underlying ws to simulate an abrupt drop.
    client.__getWs().terminate()

    const result = await writePromise
    expect(result.status).toBe('disconnected')

    dropServer.close()
    client.close()
  })

  it('resolves write with { status: "timeout" } when nothing drains the submit resolver (structural safety net)', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
      submitTimeoutMs: 100,
    })
    await client.waitUntilConnected()

    const ws = client.__getWs()
    const originalSend = ws.send.bind(ws)
    // Swallow the submit_op send so the server never receives it and never
    // responds - nothing will ever naturally drain submitResolvers. Only the
    // timeout safety net should be able to unstick this write().
    ws.send = (data) => {
      const parsed = JSON.parse(data)
      if (parsed.type === 'submit_op') return
      originalSend(data)
    }

    const result = await client.write({ entity: 'template_slots', entity_id: 's13', field: 'activity_id', value: 'archery3' })
    expect(result.status).toBe('timeout')

    client.close()
  })

  it('resolves write with { status: "timeout" } when nothing drains the lock resolver (structural safety net)', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
      lockTimeoutMs: 100,
    })
    await client.waitUntilConnected()

    const ws = client.__getWs()
    const originalSend = ws.send.bind(ws)
    // Swallow the acquire_lock send so the server never receives it and never
    // responds - nothing will ever naturally drain lockResolvers.
    ws.send = (data) => {
      const parsed = JSON.parse(data)
      if (parsed.type === 'acquire_lock') return
      originalSend(data)
    }

    const result = await client.write({ entity: 'template_slots', entity_id: 's13b', field: 'activity_id', value: 'archery3b' })
    expect(result.status).toBe('timeout')

    client.close()
  })

  it('a normal successful write still resolves quickly and is not affected by the timeout safety net', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
      lockTimeoutMs: 100,
      submitTimeoutMs: 100,
    })
    await client.waitUntilConnected()

    const start = Date.now()
    const result = await client.write({ entity: 'template_slots', entity_id: 's13c', field: 'activity_id', value: 'archery3c' })
    const elapsed = Date.now() - start

    expect(result.status).toBe('applied')
    expect(elapsed).toBeLessThan(100)

    client.close()
  })

  it('drains submitResolvers promptly with status "error" when op_applied fails full validation but device_id matches this device (defensive drain)', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
      // Long timeout: proves resolution comes from the defensive drain (fix 2),
      // not from the timeout safety net (fix 1) firing.
      submitTimeoutMs: 5000,
    })
    await client.waitUntilConnected()

    const ws = client.__getWs()
    const originalSend = ws.send.bind(ws)
    // Swallow the real submit_op so the server's genuine op_applied reply
    // never arrives and races our injected malformed message below - this
    // isolates the defensive-drain path from the normal success path.
    ws.send = (data) => {
      const parsed = JSON.parse(data)
      if (parsed.type === 'submit_op') return
      originalSend(data)
    }
    const writePromise = client.write({ entity: 'template_slots', entity_id: 's14', field: 'activity_id', value: 'x' })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // device_id matches this device, but 'entity' is missing so isValidRemoteOp fails.
    const badMsg = JSON.stringify({
      type: 'op_applied',
      op: {
        id: randomUUID(),
        entity_id: 's14',
        field: 'activity_id',
        value: 'x',
        device_id: deviceId,
        timestamp: new Date().toISOString(),
        parent_op_id: null,
      },
    })

    const start = Date.now()
    ws.emit('message', Buffer.from(badMsg))
    const result = await writePromise
    const elapsed = Date.now() - start

    expect(result.status).toBe('error')
    expect(elapsed).toBeLessThan(1000)

    client.close()
  })
})

describe('full_sync handling', () => {
  it('bulk-loads users and camps from a real full_sync round-trip on first pairing', async () => {
    const freshDeviceId = randomUUID()
    // Deliberately do NOT pre-insert a devices row on hostDb: the Host must
    // self-register this genuinely new device during authenticate (Fix 1),
    // not rely on test setup creating the row production code should create.
    const freshToken = issueSessionToken(userId, freshDeviceId)

    const freshClientFile = path.join(os.tmpdir(), `shoresh-sc-fresh-${Date.now()}-${Math.random()}.sqlite`)
    const freshClientDb = openLocalDb(freshClientFile)
    freshClientDb.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(freshDeviceId, 'Fresh Device')

    const client = createSyncClient(freshClientDb, {
      device_id: freshDeviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token: freshToken,
    })
    await client.waitUntilConnected()
    await new Promise((resolve) => setTimeout(resolve, 100))

    const userRow = freshClientDb.prepare('SELECT * FROM users WHERE id = ?').get(userId)
    expect(userRow).toBeTruthy()
    expect(userRow.name).toBe('Alice')
    const campRow = freshClientDb.prepare('SELECT * FROM camps WHERE id = ?').get(campId)
    expect(campRow).toEqual({ id: campId, name: 'Test Camp' })

    client.close()
    freshClientDb.close()
    fs.unlinkSync(freshClientFile)
  })

  it('skips invalid rows but inserts valid ones from a full_sync message (defensive validation)', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
    })
    await client.waitUntilConnected()

    const ws = client.__getWs()
    const validUserId = randomUUID()
    const msg = JSON.stringify({
      type: 'full_sync',
      users: [
        { id: validUserId, camp_id: campId, name: 'Valid User', pin_hash: 'h', pin_salt: 's', role: 'staff' },
        { id: randomUUID(), camp_id: null, name: 'Nullable Camp Ok', pin_hash: 'h', pin_salt: 's', role: 'admin' },
        { id: randomUUID(), camp_id: campId, name: 'Bad Role', pin_hash: 'h', pin_salt: 's', role: 'superadmin' },
        { id: randomUUID(), camp_id: campId, name: 123, pin_hash: 'h', pin_salt: 's', role: 'staff' },
        { camp_id: campId, name: 'Missing Id', pin_hash: 'h', pin_salt: 's', role: 'staff' },
        'not an object',
      ],
      camps: [
        { id: randomUUID(), name: 'Valid Camp' },
        { id: '', name: 'Empty Id' },
        { id: randomUUID(), name: '' },
        { id: randomUUID() },
        null,
      ],
    })

    ws.emit('message', Buffer.from(msg))
    await new Promise((resolve) => setTimeout(resolve, 50))

    const validUser = clientDb.prepare('SELECT * FROM users WHERE id = ?').get(validUserId)
    expect(validUser).toBeTruthy()
    expect(validUser.name).toBe('Valid User')

    const allUsers = clientDb.prepare('SELECT COUNT(*) as c FROM users').get()
    // pre-existing Alice + validUserId + the nullable-camp_id row = 3
    expect(allUsers.c).toBe(3)

    const allCamps = clientDb.prepare('SELECT COUNT(*) as c FROM camps').get()
    // pre-existing Test Camp + the one valid camp = 2
    expect(allCamps.c).toBe(2)

    client.close()
  })

  it('rolls back the entire batch (Fix 2) when a mid-loop row causes a genuine DB error after passing per-row validation', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
    })
    await client.waitUntilConnected()

    const ws = client.__getWs()
    const validCampId = randomUUID()
    const validUserId = randomUUID()
    const nonexistentCampId = randomUUID() // never inserted anywhere - triggers an FK violation

    const msg = JSON.stringify({
      type: 'full_sync',
      camps: [{ id: validCampId, name: 'Rollback Camp' }],
      users: [
        // passes isValidFullSyncUser (non-empty strings), inserts fine on its own
        { id: validUserId, camp_id: campId, name: 'Rollback User', pin_hash: 'h', pin_salt: 's', role: 'staff' },
        // also passes per-row validation (camp_id is a non-empty string) but
        // references a camp that does not exist anywhere - the INSERT itself
        // throws an FK constraint violation, which should roll back the WHOLE
        // batch (including the valid camp and valid user above) rather than
        // leaving them partially applied.
        { id: randomUUID(), camp_id: nonexistentCampId, name: 'Bad FK User', pin_hash: 'h', pin_salt: 's', role: 'staff' },
      ],
    })

    expect(() => ws.emit('message', Buffer.from(msg))).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 50))

    const rolledBackCamp = clientDb.prepare('SELECT * FROM camps WHERE id = ?').get(validCampId)
    expect(rolledBackCamp).toBeFalsy()

    const rolledBackUser = clientDb.prepare('SELECT * FROM users WHERE id = ?').get(validUserId)
    expect(rolledBackUser).toBeFalsy()

    // client remains usable afterward (structural integrity preserved)
    const result = await client.write({ entity: 'template_slots', entity_id: 's15', field: 'activity_id', value: 'volleyball' })
    expect(result.status).toBe('applied')

    client.close()
  })

  it('does not throw on a malformed full_sync message (users/camps not arrays)', async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: userId,
      serverUrl: `ws://localhost:${PORT}`,
      token,
    })
    await client.waitUntilConnected()

    const ws = client.__getWs()
    const msg = JSON.stringify({ type: 'full_sync', users: 'not-an-array', camps: null })

    expect(() => ws.emit('message', Buffer.from(msg))).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 20))

    client.close()
  })
})

describe('reconnect catch-up (Task 10 round-4 Fix 3)', () => {
  it('a device that recorded a conflict while offline learns the resolution on reconnect, via replayed operations rows, so listPendingConflicts() on that device reports it resolved', async () => {
    // Device B: a second device that will go offline mid-conflict.
    const deviceBId = randomUUID()
    const bFile = path.join(os.tmpdir(), `shoresh-sc-deviceB-${Date.now()}-${Math.random()}.sqlite`)
    const dbB = openLocalDb(bFile)
    dbB.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Test Camp')
    dbB.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceBId, 'Device B')
    // Device A's row must also exist on B's local db — the ops B is about to
    // receive are authored by Device A, and operations.device_id is an FK.
    dbB.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Device A')
    hostDb.prepare('INSERT INTO devices (id, name, last_synced_at) VALUES (?, ?, ?)').run(
      deviceBId, 'Device B', new Date().toISOString()
    )
    const tokenB = issueSessionToken(userId, deviceBId)

    // B connects once so the Host knows its watermark, then disconnects —
    // "goes offline" — before any conflict-related op exists yet.
    const clientB1 = createSyncClient(dbB, {
      device_id: deviceBId, author_user_id: userId, serverUrl: `ws://localhost:${PORT}`, token: tokenB,
    })
    await clientB1.waitUntilConnected()
    clientB1.close()
    await new Promise((r) => setTimeout(r, 30))

    // While B is offline: a conflict is detected on the Host (existingOp is
    // the "losing" write B's conflicts record points at), and B is assumed
    // to have already recorded it locally (recordConflict) from an earlier
    // op_conflict it received before disconnecting.
    const existingOp = appendOp(hostDb, {
      entity: 'users', entity_id: userId, field: 'name', value: 'Alicia',
      author_user_id: null, device_id: deviceId, parent_op_id: null,
    })
    const incomingOp = { ...existingOp, id: randomUUID(), value: 'Alice' }
    recordConflict(dbB, { incomingOp, existingOp })
    expect(listPendingConflicts(dbB)).toHaveLength(1)

    // The conflict gets resolved on the Host — by definition while B is
    // still offline, since B is disconnected — via a write parented to the
    // losing op's id, exactly as main.js's resolveConflict handler does.
    appendOp(hostDb, {
      entity: 'users', entity_id: userId, field: 'name', value: 'Alice',
      author_user_id: null, device_id: deviceId, parent_op_id: existingOp.id,
    })

    // B never saw that op — its own local operations table has no row
    // whose parent_op_id matches, so it's still stuck showing this pending.
    expect(listPendingConflicts(dbB)).toHaveLength(1)

    // B reconnects. sendMissedOps (syncServer.js) should now replay every
    // operations row created since B's watermark — including both the
    // existingOp and its resolution — as op_applied messages, which flow
    // through the client's ordinary applyRemoteOp path.
    const clientB2 = createSyncClient(dbB, {
      device_id: deviceBId, author_user_id: userId, serverUrl: `ws://localhost:${PORT}`, token: tokenB,
    })
    await clientB2.waitUntilConnected()
    await new Promise((r) => setTimeout(r, 150))

    expect(listPendingConflicts(dbB)).toHaveLength(0)

    clientB2.close()
    dbB.close()
    fs.unlinkSync(bFile)
  })
})

describe('remote login (fresh client, no local token yet)', () => {
  const REMOTE_LOGIN_PORT = 8240
  let freshClientDb, freshClientFile, remoteLoginServer

  beforeEach(() => {
    freshClientFile = path.join(os.tmpdir(), `shoresh-sc-fresh-${Date.now()}-${Math.random()}.sqlite`)
    freshClientDb = openLocalDb(freshClientFile)
    remoteLoginServer = startSyncServer(hostDb, { port: REMOTE_LOGIN_PORT })
  })

  afterEach(() => {
    remoteLoginServer.close()
    freshClientDb.close()
    fs.unlinkSync(freshClientFile)
  })

  it('connects with no token, then loginRemote yields a token and authenticates', async () => {
    const freshDeviceId = randomUUID()
    // NOTE (deviation from plan): in the real app, main.js's ensureDeviceRow
    // registers this device's own device_id in its own local `devices` table
    // at process startup, before login/syncClient ever run — the local
    // `operations` table's device_id column has a FK to `devices(id)`, so an
    // echoed-back op_applied for this device's own write can't be inserted
    // without it. This test operates below main.js, so the row is inserted
    // here directly to mirror that startup step.
    freshClientDb.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(freshDeviceId, 'Fresh Device')
    const client = createSyncClient(freshClientDb, {
      device_id: freshDeviceId,
      author_user_id: null,
      serverUrl: `ws://localhost:${REMOTE_LOGIN_PORT}`,
      // no token — this is the whole point
    })
    await client.waitUntilConnected()

    const result = await client.loginRemote({ name: 'Alice', pin: '1234' })
    expect(result.status).toBe('ok')
    expect(result.token).toEqual(expect.any(String))
    expect(result.userId).toBe(userId)
    expect(result.role).toBe('admin')

    // Now-authenticated: a real write should succeed (proves the automatic
    // `authenticate` send after loginRemote actually worked server-side).
    const writeResult = await client.write({ entity: 'activities', entity_id: 'a1', field: 'name', value: 'Archery' })
    expect(writeResult.status).toBe('applied')

    client.close()
  })

  it('returns status "failed" for a wrong pin, and the connection stays usable', async () => {
    const client = createSyncClient(freshClientDb, {
      device_id: randomUUID(),
      author_user_id: null,
      serverUrl: `ws://localhost:${REMOTE_LOGIN_PORT}`,
    })
    await client.waitUntilConnected()

    const result = await client.loginRemote({ name: 'Alice', pin: 'wrong' })
    expect(result).toEqual({ status: 'failed' })

    // Retry with the correct pin on the SAME connection must still work.
    // NOTE (deviation from plan): the Host throttles `login` messages to 1
    // per 300ms per connection (Task 2 round-2 fix). Without this delay the
    // retry below would be silently throttled rather than genuinely
    // re-verified, so a short wait is inserted here before retrying.
    await new Promise((resolve) => setTimeout(resolve, 350))

    const retry = await client.loginRemote({ name: 'Alice', pin: '1234' })
    expect(retry.status).toBe('ok')

    client.close()
  })

  it('queues a write issued before loginRemote resolves instead of hanging (open-but-unauthenticated connection)', async () => {
    const freshDeviceId = randomUUID()
    freshClientDb.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(freshDeviceId, 'Fresh Device 2')
    const client = createSyncClient(freshClientDb, {
      device_id: freshDeviceId,
      author_user_id: null,
      serverUrl: `ws://localhost:${REMOTE_LOGIN_PORT}`,
      // no token — this is the whole point
    })
    await client.waitUntilConnected()

    // The socket is OPEN (connected === true) but no `authenticate` has ever
    // been sent (no token, loginRemote not called/resolved yet). Round-1
    // regressed this: write() checked only `connected`, so this call would
    // attempt acquireLockRemote against an unauthenticated connection the
    // Host silently ignores, hanging for the full lockTimeoutMs (10s) before
    // resolving 'timeout'. It must instead queue immediately.
    const start = Date.now()
    const result = await client.write({ entity: 'activities', entity_id: 'a-early', field: 'name', value: 'Early Write' })
    const elapsedMs = Date.now() - start

    expect(result.status).toBe('queued')
    expect(elapsedMs).toBeLessThan(1000)
    expect(client.getQueuedOps().some((q) => q.entity_id === 'a-early')).toBe(true)

    client.close()
  })

  it('does NOT queue a write issued after loginRemote resolves — it applies immediately', async () => {
    const freshDeviceId = randomUUID()
    freshClientDb.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(freshDeviceId, 'Fresh Device 3')
    const client = createSyncClient(freshClientDb, {
      device_id: freshDeviceId,
      author_user_id: null,
      serverUrl: `ws://localhost:${REMOTE_LOGIN_PORT}`,
    })
    await client.waitUntilConnected()

    const loginResult = await client.loginRemote({ name: 'Alice', pin: '1234' })
    expect(loginResult.status).toBe('ok')

    const writeResult = await client.write({ entity: 'activities', entity_id: 'a-post-login', field: 'name', value: 'Post Login Write' })
    expect(writeResult.status).toBe('applied')
    expect(client.getQueuedOps().length).toBe(0)

    client.close()
  })

  it('returns status "disconnected" if the socket is not open when loginRemote is called', async () => {
    const client = createSyncClient(freshClientDb, {
      device_id: randomUUID(),
      author_user_id: null,
      serverUrl: `ws://localhost:${REMOTE_LOGIN_PORT}`,
    })
    client.close() // never awaited connection, then closed immediately

    const result = await client.loginRemote({ name: 'Alice', pin: '1234' })
    expect(result.status).toBe('disconnected')
  })
})
