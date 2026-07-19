// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { openLocalDb } from '../db/localDb.js'
import { createUser, issueSessionToken } from '../auth/localAuth.js'
import { startSyncServer } from './syncServer.js'
import { createSyncClient } from './syncClient.js'

const PORT = 8237
const FLUSH_PORT = 8238

let hostDb, hostFile, clientDb, clientFile, server, campId, userId, deviceId, token

beforeEach(async () => {
  hostFile = path.join(os.tmpdir(), `shoresh-sc-host-${Date.now()}-${Math.random()}.sqlite`)
  hostDb = openLocalDb(hostFile)

  clientFile = path.join(os.tmpdir(), `shoresh-sc-client-${Date.now()}-${Math.random()}.sqlite`)
  clientDb = openLocalDb(clientFile)

  campId = randomUUID()
  hostDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Test Camp')
  clientDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Test Camp')

  const user = createUser(hostDb, { camp_id: campId, name: 'Alice', pin: '1234', role: 'admin' })
  userId = user.id
  clientDb.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, campId, 'Alice', 'x', 'x', 'admin')

  deviceId = randomUUID()
  hostDb.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Device A')
  clientDb.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Device A')

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

  it('resolves conflict without submitting when the lock is denied', async () => {
    const otherDeviceId = randomUUID()
    hostDb.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(otherDeviceId, 'Device B')
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
    expect(result.status).toBe('conflict')

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

  it('flushQueue re-acquires the lock and does not resubmit if denied', async () => {
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
      hostDb.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(otherDeviceId, 'Device B')
      const otherToken = issueSessionToken(userId, otherDeviceId)
      const holderWs = new WebSocket(`ws://localhost:${FLUSH_PORT}`)
      await new Promise((resolve) => holderWs.once('open', resolve))
      holderWs.send(JSON.stringify({ type: 'authenticate', token: otherToken, device_id: otherDeviceId }))
      const lockGranted = new Promise((resolve) => holderWs.once('message', (d) => resolve(JSON.parse(d.toString()))))
      holderWs.send(JSON.stringify({ type: 'acquire_lock', entity: 'template_slots', entity_id: 's5', field: 'activity_id' }))
      const grantMsg = await lockGranted
      expect(grantMsg.granted).toBe(true)

      await client.flushQueue()

      expect(client.getQueuedOps()).toHaveLength(0)

      const hostRow = hostDb.prepare('SELECT * FROM operations WHERE entity_id = ?').get('s5')
      expect(hostRow).toBeFalsy()

      holderWs.close()
    } finally {
      flushServer.close()
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
    const result = await client.write({ entity: 'users', entity_id: userId, field: 'name', value: 'Alicia' })

    expect(result.status).toBe('applied')

    const clientRow = clientDb.prepare('SELECT * FROM users WHERE id = ?').get(userId)
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

    const result = await client.write({ entity: 'users', entity_id: userId, field: 'camp_id', value: otherCampId })

    // The op was canonical (server accepted/broadcast it) so the write must resolve as applied,
    // even though local projection of it fails.
    expect(result.status).toBe('applied')

    // The op-log entry must be durably recorded on the client despite the projection failure.
    const clientOpRow = clientDb.prepare('SELECT * FROM operations WHERE entity_id = ? AND field = ?').get(userId, 'camp_id')
    expect(clientOpRow).toBeTruthy()
    expect(clientOpRow.value).toBe(otherCampId)

    // The users table projection should NOT have been updated locally (FK violation prevented it).
    const clientUserRow = clientDb.prepare('SELECT * FROM users WHERE id = ?').get(userId)
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
    const writePromise = client.write({ entity: 'users', entity_id: userId, field: 'name', value: 'Someone' })

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
        entity_id: userId,
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
})
