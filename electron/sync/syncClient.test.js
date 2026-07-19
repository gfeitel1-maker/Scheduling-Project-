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
