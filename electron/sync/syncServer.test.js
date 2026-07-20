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

// Task 10 round-4 Fix 3: a reconnecting device may now receive one or more
// catch-up `op_applied` messages (missed operations) immediately after
// authenticate, ahead of a reply to whatever it sends next — that's the
// intended new behavior, not a bug. Tests that care about a specific
// reply type (e.g. lock_result) should wait for that type specifically
// rather than assuming it's the very next raw message on the socket.
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

function onceClose(ws) {
  return new Promise((resolve) => ws.once('close', resolve))
}

beforeEach(async () => {
  tmpFile = path.join(os.tmpdir(), `shoresh-sync-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)

  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Test Camp')

  deviceId = randomUUID()
  db.prepare('INSERT INTO devices (id, name, last_synced_at) VALUES (?, ?, ?)').run(deviceId, 'Device A', new Date().toISOString())

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
    db.prepare('INSERT INTO devices (id, name, last_synced_at) VALUES (?, ?, ?)').run(otherDeviceId, 'Device B', new Date().toISOString())
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
    db.prepare('INSERT INTO devices (id, name, last_synced_at) VALUES (?, ?, ?)').run(otherDeviceId, 'Device B', new Date().toISOString())
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
    db.prepare('INSERT INTO devices (id, name, last_synced_at) VALUES (?, ?, ?)').run(otherDeviceId, 'Device B', new Date().toISOString())
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
    const msg = await onceMessageOfType(ws3, 'lock_result')
    expect(msg).toEqual({ type: 'lock_result', granted: true })

    ws1.close()
    ws2.close()
    ws3.close()
  })
})

describe('full_sync on first pairing', () => {
  it('sends full_sync with all users and camps on a genuinely new device\'s first successful authenticate (no pre-existing devices row)', async () => {
    const newDeviceId = randomUUID()
    // Deliberately do NOT pre-insert a devices row here: this is exactly the
    // real-world scenario (a brand-new device that the Host has never seen)
    // that round 1's tests masked by manually inserting the row production
    // code never created. The self-registration fix in handleAuthenticate
    // must create this row itself.
    const newToken = issueSessionToken(userId, newDeviceId)

    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token: newToken, device_id: newDeviceId }))
    const msg = await onceMessage(ws)

    expect(msg.type).toBe('full_sync')
    expect(msg.users).toEqual([
      { id: userId, camp_id: campId, name: 'Alice', pin_hash: expect.any(String), pin_salt: expect.any(String), role: 'admin' },
    ])
    expect(msg.camps).toEqual([{ id: campId, name: 'Test Camp' }])

    const row = db.prepare('SELECT last_synced_at FROM devices WHERE id = ?').get(newDeviceId)
    expect(row.last_synced_at).toBeTruthy()

    ws.close()
  })

  it('does not send full_sync again on a second authenticate from the same device', async () => {
    const newDeviceId = randomUUID()
    // No pre-existing devices row - the first authenticate below must
    // self-register it via production code, not test setup.
    const newToken = issueSessionToken(userId, newDeviceId)

    const ws1 = connect()
    await onceOpen(ws1)
    ws1.send(JSON.stringify({ type: 'authenticate', token: newToken, device_id: newDeviceId }))
    const firstMsg = await onceMessage(ws1)
    expect(firstMsg.type).toBe('full_sync')
    ws1.close()

    const ws2 = connect()
    await onceOpen(ws2)
    ws2.send(JSON.stringify({ type: 'authenticate', token: newToken, device_id: newDeviceId }))
    ws2.send(
      JSON.stringify({
        type: 'acquire_lock',
        entity: 'template_slots',
        entity_id: 'full-sync-second-auth',
        field: 'activity_id',
      })
    )
    const msg = await onceMessage(ws2)
    expect(msg).toEqual({ type: 'lock_result', granted: true })
    ws2.close()
  })
})
