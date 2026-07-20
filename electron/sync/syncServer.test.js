// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { openLocalDb } from '../db/localDb.js'
import { createUser, issueSessionToken } from '../auth/localAuth.js'
import { appendOp } from '../ops/operations.js'
import { startSyncServer } from './syncServer.js'

const PORT = 8137

let db, tmpFile, server, campId, userId, deviceId, token

function connect() {
  return new WebSocket(`ws://localhost:${PORT}`)
}

function onceMessage(ws) {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())))
  })
}

function onceOpen(ws) {
  return new Promise((resolve) => ws.once('open', resolve))
}

function onceClose(ws) {
  return new Promise((resolve) => ws.once('close', resolve))
}

beforeEach(async () => {
  tmpFile = path.join(os.tmpdir(), `shoresh-sync-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)

  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Test Camp')

  deviceId = randomUUID()
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Device A')

  const user = await createUser(
    db,
    { camp_id: campId, name: 'Alice', pin: '1234', role: 'admin' },
    async ({ entity, entity_id, field, value }) => {
      const op = appendOp(db, {
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

  token = issueSessionToken(userId, deviceId)

  server = startSyncServer(db, { port: PORT })
})

afterEach(() => {
  server.close()
  db.close()
  fs.unlinkSync(tmpFile)
})

describe('authentication', () => {
  it('grants a lock after valid authenticate + acquire_lock', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    ws.send(
      JSON.stringify({
        type: 'acquire_lock',
        entity: 'template_slots',
        entity_id: 's1',
        field: 'activity_id',
      })
    )
    const msg = await onceMessage(ws)
    expect(msg).toEqual({ type: 'lock_result', granted: true })
    ws.close()
  })

  it('closes the connection on an invalid token', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token: 'garbage.token', device_id: deviceId }))
    await onceClose(ws)
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('ignores messages sent before authentication', async () => {
    const ws1 = connect()
    await onceOpen(ws1)
    ws1.send(
      JSON.stringify({
        type: 'acquire_lock',
        entity: 'template_slots',
        entity_id: 's2',
        field: 'activity_id',
      })
    )

    // give the server a moment to (not) process it
    await new Promise((r) => setTimeout(r, 100))

    const ws2 = connect()
    await onceOpen(ws2)
    ws2.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    ws2.send(
      JSON.stringify({
        type: 'acquire_lock',
        entity: 'template_slots',
        entity_id: 's2',
        field: 'activity_id',
      })
    )
    const msg = await onceMessage(ws2)
    expect(msg).toEqual({ type: 'lock_result', granted: true })

    ws1.close()
    ws2.close()
  })

  it('rejects authentication when device_id does not match the token', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token, device_id: randomUUID() }))
    await onceClose(ws)
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })
})

describe('submit_op', () => {
  it('broadcasts op_applied to other authenticated clients and stores the authenticated device_id', async () => {
    const ws1 = connect()
    await onceOpen(ws1)
    ws1.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))

    const otherDeviceId = randomUUID()
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(otherDeviceId, 'Device B')
    const otherToken = issueSessionToken(userId, otherDeviceId)
    const ws2 = connect()
    await onceOpen(ws2)
    ws2.send(JSON.stringify({ type: 'authenticate', token: otherToken, device_id: otherDeviceId }))

    await new Promise((r) => setTimeout(r, 50))

    const broadcastPromise = onceMessage(ws2)

    ws1.send(
      JSON.stringify({
        type: 'submit_op',
        op: {
          entity: 'template_slots',
          entity_id: 's3',
          field: 'activity_id',
          value: 'swim',
          author_user_id: userId,
          parent_op_id: null,
        },
      })
    )

    const broadcast = await broadcastPromise
    expect(broadcast.type).toBe('op_applied')
    expect(broadcast.op.entity_id).toBe('s3')

    const row = db.prepare('SELECT * FROM operations WHERE entity_id = ?').get('s3')
    expect(row.device_id).toBe(deviceId)

    ws1.close()
    ws2.close()
  })

  it('sends op_conflict instead of broadcasting when detectConflict reports a conflict', async () => {
    const ws1 = connect()
    await onceOpen(ws1)
    ws1.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    await new Promise((r) => setTimeout(r, 50))

    // establish an existing op for entity s4/activity_id
    ws1.send(
      JSON.stringify({
        type: 'submit_op',
        op: {
          entity: 'template_slots',
          entity_id: 's4',
          field: 'activity_id',
          value: 'first',
          author_user_id: userId,
          parent_op_id: null,
        },
      })
    )
    await onceMessage(ws1) // op_applied for first op (broadcast to self? no - only to others)

    const countBefore = db.prepare('SELECT COUNT(*) as c FROM operations WHERE entity_id = ?').get('s4').c

    const conflictPromise = onceMessage(ws1)
    // submit a conflicting op with a bogus parent_op_id
    ws1.send(
      JSON.stringify({
        type: 'submit_op',
        op: {
          entity: 'template_slots',
          entity_id: 's4',
          field: 'activity_id',
          value: 'second',
          author_user_id: userId,
          parent_op_id: 'nonexistent-parent',
        },
      })
    )
    const conflictMsg = await conflictPromise
    expect(conflictMsg.type).toBe('op_conflict')

    const countAfter = db.prepare('SELECT COUNT(*) as c FROM operations WHERE entity_id = ?').get('s4').c
    expect(countAfter).toBe(countBefore)

    ws1.close()
  })
})

describe('malformed message resilience (Fix 1)', () => {
  it('does not crash the server when an unauthenticated client sends the literal text "null"', async () => {
    const ws1 = connect()
    await onceOpen(ws1)
    ws1.send('null')

    await new Promise((r) => setTimeout(r, 100))

    // server must still be alive and responsive for a fresh connection
    const ws2 = connect()
    await onceOpen(ws2)
    ws2.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    ws2.send(
      JSON.stringify({
        type: 'acquire_lock',
        entity: 'template_slots',
        entity_id: 'resilience-1',
        field: 'activity_id',
      })
    )
    const msg = await onceMessage(ws2)
    expect(msg).toEqual({ type: 'lock_result', granted: true })

    ws1.close()
    ws2.close()
  })

  it('responds with an error (not a crash) when submit_op is missing op', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    await new Promise((r) => setTimeout(r, 50))

    const errPromise = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'submit_op' }))
    const err = await errPromise
    expect(err.type).toBe('error')

    // server still alive/responsive
    const ws2 = connect()
    await onceOpen(ws2)
    ws2.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    ws2.send(
      JSON.stringify({
        type: 'acquire_lock',
        entity: 'template_slots',
        entity_id: 'resilience-2',
        field: 'activity_id',
      })
    )
    const msg = await onceMessage(ws2)
    expect(msg).toEqual({ type: 'lock_result', granted: true })

    ws.close()
    ws2.close()
  })

  it('responds with an error (not a crash) when acquire_lock is missing entity', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    await new Promise((r) => setTimeout(r, 50))

    const errPromise = onceMessage(ws)
    ws.send(JSON.stringify({ type: 'acquire_lock' }))
    const err = await errPromise
    expect(err.type).toBe('error')

    const ws2 = connect()
    await onceOpen(ws2)
    ws2.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    ws2.send(
      JSON.stringify({
        type: 'acquire_lock',
        entity: 'template_slots',
        entity_id: 'resilience-3',
        field: 'activity_id',
      })
    )
    const msg = await onceMessage(ws2)
    expect(msg).toEqual({ type: 'lock_result', granted: true })

    ws.close()
    ws2.close()
  })
})

describe('lock release on disconnect (Fix 2)', () => {
  it('releases a lock held by a device when its connection closes', async () => {
    const wsA = connect()
    await onceOpen(wsA)
    wsA.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    await new Promise((r) => setTimeout(r, 50))

    const lockPromise = onceMessage(wsA)
    wsA.send(
      JSON.stringify({
        type: 'acquire_lock',
        entity: 'template_slots',
        entity_id: 'disconnect-lock',
        field: 'activity_id',
      })
    )
    const lockMsg = await lockPromise
    expect(lockMsg).toEqual({ type: 'lock_result', granted: true })

    wsA.close()
    await new Promise((r) => setTimeout(r, 100))

    const otherDeviceId = randomUUID()
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(otherDeviceId, 'Device B')
    const otherToken = issueSessionToken(userId, otherDeviceId)
    const wsB = connect()
    await onceOpen(wsB)
    wsB.send(JSON.stringify({ type: 'authenticate', token: otherToken, device_id: otherDeviceId }))
    await new Promise((r) => setTimeout(r, 50))

    const lockPromiseB = onceMessage(wsB)
    wsB.send(
      JSON.stringify({
        type: 'acquire_lock',
        entity: 'template_slots',
        entity_id: 'disconnect-lock',
        field: 'activity_id',
      })
    )
    const lockMsgB = await lockPromiseB
    expect(lockMsgB).toEqual({ type: 'lock_result', granted: true })

    wsB.close()
  })
})

describe('port bind failure resilience (Task 8 Fix C)', () => {
  it('does not crash the process when a second server tries to bind the same port', async () => {
    const tmpFile2 = path.join(os.tmpdir(), `shoresh-sync-collision-${Date.now()}-${Math.random()}.sqlite`)
    const db2 = openLocalDb(tmpFile2)

    let secondServer
    expect(() => {
      secondServer = startSyncServer(db2, { port: PORT })
    }).not.toThrow()

    // give the underlying bind attempt a moment to fail
    await new Promise((r) => setTimeout(r, 200))

    // the original server on this port must still be alive/responsive
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    ws.send(
      JSON.stringify({
        type: 'acquire_lock',
        entity: 'template_slots',
        entity_id: 'port-collision-check',
        field: 'activity_id',
      })
    )
    const msg = await onceMessage(ws)
    expect(msg).toEqual({ type: 'lock_result', granted: true })
    ws.close()

    secondServer.close()
    db2.close()
    fs.unlinkSync(tmpFile2)
  })
})

describe('safe broadcast (Fix 3)', () => {
  it('does not throw when broadcasting to a client whose readyState is not OPEN', async () => {
    const ws1 = connect()
    await onceOpen(ws1)
    ws1.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))

    const otherDeviceId = randomUUID()
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(otherDeviceId, 'Device B')
    const otherToken = issueSessionToken(userId, otherDeviceId)
    const ws2 = connect()
    await onceOpen(ws2)
    ws2.send(JSON.stringify({ type: 'authenticate', token: otherToken, device_id: otherDeviceId }))

    await new Promise((r) => setTimeout(r, 50))

    // simulate a client that's still tracked in wss.clients but no longer OPEN
    for (const client of server.wss.clients) {
      if (client.deviceId === otherDeviceId) {
        Object.defineProperty(client, 'readyState', { value: 3, configurable: true }) // CLOSED
      }
    }

    ws1.send(
      JSON.stringify({
        type: 'submit_op',
        op: {
          entity: 'template_slots',
          entity_id: 'broadcast-safety',
          field: 'activity_id',
          value: 'swim',
          author_user_id: userId,
          parent_op_id: null,
        },
      })
    )

    await new Promise((r) => setTimeout(r, 100))

    // server still alive/responsive afterward
    const ws3 = connect()
    await onceOpen(ws3)
    ws3.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    ws3.send(
      JSON.stringify({
        type: 'acquire_lock',
        entity: 'template_slots',
        entity_id: 'broadcast-safety-check',
        field: 'activity_id',
      })
    )
    const msg = await onceMessage(ws3)
    expect(msg).toEqual({ type: 'lock_result', granted: true })

    ws1.close()
    ws2.close()
    ws3.close()
  })
})
