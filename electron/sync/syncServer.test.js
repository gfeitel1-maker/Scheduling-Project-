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
import { startSyncServer, sendMissedOps, sendWithAck } from './syncServer.js'

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

describe('Task 10 round-5 Fix 4: sendMissedOps watermark stops at the last successfully-sent op', () => {
  // A real, deterministic mid-replay socket failure is impractical to force
  // reliably over an actual network socket (by the time a real ws is torn
  // down, either nothing has been "sent" yet or everything queued in the
  // kernel buffer looks like it succeeded from send()'s perspective). This
  // exercises the real sendMissedOps against a real SQLite db, with a
  // controlled fake `ws` whose send() throws on a specific op - isolating
  // exactly the boundary condition Fix 4 is about: does the watermark stop
  // at the last op that genuinely went out, not blindly jump to the max seq
  // among all candidate rows.
  function fakeWs(deviceId, failOnEntityId) {
    const sent = []
    return {
      deviceId,
      readyState: 1,
      OPEN: 1,
      // Round-6 note: send() still supports the optional (data, callback)
      // completion-callback signature so this fake stays compatible with
      // sendWithAck. The synchronous-throw behavior is preserved as-is (it's
      // exactly the case round-6 says must keep working), while a
      // non-failing send confirms success via the callback, asynchronously,
      // just like a real ws.
      send(data, callback) {
        const parsed = JSON.parse(data)
        if (parsed.op && parsed.op.entity_id === failOnEntityId) {
          throw new Error('simulated dead socket mid-replay')
        }
        sent.push(parsed)
        if (callback) setImmediate(() => callback())
      },
      __sent: sent,
    }
  }

  it('stops the watermark at the last op that genuinely sent when a later send fails, so failed-and-later ops are re-sent next reconnect', async () => {
    // Give this device an established watermark (0) so sendMissedOps treats
    // every subsequent op as a missed-op candidate, rather than baselining.
    db.prepare('UPDATE devices SET last_synced_seq = 0 WHERE id = ?').run(deviceId)

    const opA = appendOp(db, { entity: 'template_slots', entity_id: 'catchup-a', field: 'activity_id', value: '1', author_user_id: userId, device_id: deviceId, parent_op_id: null })
    const opB = appendOp(db, { entity: 'template_slots', entity_id: 'catchup-b', field: 'activity_id', value: '2', author_user_id: userId, device_id: deviceId, parent_op_id: null })
    const opC = appendOp(db, { entity: 'template_slots', entity_id: 'catchup-c', field: 'activity_id', value: '3', author_user_id: userId, device_id: deviceId, parent_op_id: null })
    expect(opA.seq).toBeLessThan(opB.seq)
    expect(opB.seq).toBeLessThan(opC.seq)

    // Simulate the connection dying while sending op B (the middle op):
    // op A sends fine, op B's send() throws, op C is never attempted.
    const ws = fakeWs(deviceId, 'catchup-b')

    await sendMissedOps(db, ws)

    // Op A genuinely went out.
    expect(ws.__sent.some((m) => m.op.entity_id === 'catchup-a')).toBe(true)
    // Op B's send failed - must NOT be recorded as sent.
    expect(ws.__sent.some((m) => m.op.entity_id === 'catchup-b')).toBe(false)
    // Op C was never attempted (loop stops at the first failure).
    expect(ws.__sent.some((m) => m.op.entity_id === 'catchup-c')).toBe(false)

    // The watermark must stop at op A's seq, NOT jump to op C's (the max
    // seq among all candidate rows) - otherwise B and C would be falsely
    // marked delivered and permanently lost from this device's perspective.
    const row = db.prepare('SELECT last_synced_seq FROM devices WHERE id = ?').get(deviceId)
    expect(row.last_synced_seq).toBe(opA.seq)

    // Reconnecting (a fresh sendMissedOps call, simulating the next
    // connection) with a fully-working socket must re-send B and C, since
    // the watermark correctly says they were never delivered.
    const ws2 = fakeWs(deviceId, null)
    await sendMissedOps(db, ws2)
    expect(ws2.__sent.map((m) => m.op.entity_id)).toEqual(['catchup-b', 'catchup-c'])

    const rowAfter = db.prepare('SELECT last_synced_seq FROM devices WHERE id = ?').get(deviceId)
    expect(rowAfter.last_synced_seq).toBe(opC.seq)
  })

  it('when every send succeeds, the watermark still advances to the true max seq (no regression)', async () => {
    // Baseline the watermark to "everything that exists right now" (rather
    // than 0) so only the two ops appended below are missed-op candidates -
    // isolating this from any ops earlier tests/setup already created.
    const baseline = db.prepare('SELECT MAX(seq) as maxSeq FROM operations').get().maxSeq || 0
    db.prepare('UPDATE devices SET last_synced_seq = ? WHERE id = ?').run(baseline, deviceId)
    const opA = appendOp(db, { entity: 'template_slots', entity_id: 'catchup-ok-a', field: 'activity_id', value: '1', author_user_id: userId, device_id: deviceId, parent_op_id: null })
    const opB = appendOp(db, { entity: 'template_slots', entity_id: 'catchup-ok-b', field: 'activity_id', value: '2', author_user_id: userId, device_id: deviceId, parent_op_id: null })

    const ws = fakeWs(deviceId, null)
    await sendMissedOps(db, ws)

    expect(ws.__sent.map((m) => m.op.entity_id)).toEqual(['catchup-ok-a', 'catchup-ok-b'])
    const row = db.prepare('SELECT last_synced_seq FROM devices WHERE id = ?').get(deviceId)
    expect(row.last_synced_seq).toBe(opB.seq)
  })
})

describe('Task 10 round-6: sendMissedOps gates watermark on genuine async delivery confirmation, not just an absent synchronous throw', () => {
  // A real dead-but-not-yet-closed TCP socket is the case round-5's fix
  // couldn't handle: ws.send() returns normally (no throw) and readyState
  // stays OPEN, but the write never actually completes — the failure only
  // surfaces later via ws.send()'s completion callback. This fake models
  // exactly that: send() never throws and readyState is always OPEN, but
  // the callback for a specific op is invoked asynchronously (via
  // setImmediate, a real turn of the event loop later, not same-tick) with
  // an Error — simulating the real async-failure path this fix targets.
  function fakeAsyncFailWs(deviceId, failOnEntityId) {
    const sent = []
    return {
      deviceId,
      readyState: 1,
      OPEN: 1,
      send(data, callback) {
        const parsed = JSON.parse(data)
        sent.push(parsed)
        if (parsed.op && parsed.op.entity_id === failOnEntityId) {
          // Genuinely asynchronous: the callback fires on a later turn of
          // the event loop, exactly like a real ws reporting a completed
          // (failed) write, not a same-tick synchronous call.
          setImmediate(() => callback(new Error('simulated async write failure')))
        } else {
          setImmediate(() => callback())
        }
      },
      __sent: sent,
    }
  }

  it('stops the watermark at the last op whose callback genuinely confirmed success, when a later op fails asynchronously without throwing and without flipping readyState', async () => {
    // Baseline the watermark to "everything that exists right now" (rather
    // than 0) so only the three ops appended below are missed-op
    // candidates - isolating this from the ops createUser's setup already
    // appended (see the round-5 "no regression" test above for the same
    // pattern).
    const baseline = db.prepare('SELECT MAX(seq) as maxSeq FROM operations').get().maxSeq || 0
    db.prepare('UPDATE devices SET last_synced_seq = ? WHERE id = ?').run(baseline, deviceId)

    const opA = appendOp(db, { entity: 'template_slots', entity_id: 'async-a', field: 'activity_id', value: '1', author_user_id: userId, device_id: deviceId, parent_op_id: null })
    const opB = appendOp(db, { entity: 'template_slots', entity_id: 'async-b', field: 'activity_id', value: '2', author_user_id: userId, device_id: deviceId, parent_op_id: null })
    const opC = appendOp(db, { entity: 'template_slots', entity_id: 'async-c', field: 'activity_id', value: '3', author_user_id: userId, device_id: deviceId, parent_op_id: null })

    // op B's send() call itself does not throw, and readyState stays OPEN
    // throughout — the only signal that it failed is the async callback.
    const ws = fakeAsyncFailWs(deviceId, 'async-b')

    await sendMissedOps(db, ws)

    // send() was attempted for both A and B (B's send() call didn't throw),
    // but C must never have been attempted, since the loop must stop once
    // B's callback confirms failure.
    expect(ws.__sent.map((m) => m.op.entity_id)).toEqual(['async-a', 'async-b'])

    // The watermark must stop at op A's seq — the last op whose callback
    // genuinely confirmed success — not advance past op B just because
    // ws.send() didn't throw synchronously for it.
    const row = db.prepare('SELECT last_synced_seq FROM devices WHERE id = ?').get(deviceId)
    expect(row.last_synced_seq).toBe(opA.seq)

    // Reconnecting with a fully-working socket must re-send B and C, since
    // the watermark correctly says they were never confirmed delivered.
    const ws2 = fakeAsyncFailWs(deviceId, null)
    await sendMissedOps(db, ws2)
    expect(ws2.__sent.map((m) => m.op.entity_id)).toEqual(['async-b', 'async-c'])

    const rowAfter = db.prepare('SELECT last_synced_seq FROM devices WHERE id = ?').get(deviceId)
    expect(rowAfter.last_synced_seq).toBe(opC.seq)
  })

  it('stops sending immediately once the socket goes non-OPEN between ops, even if the prior op\'s callback already confirmed success', async () => {
    const baseline = db.prepare('SELECT MAX(seq) as maxSeq FROM operations').get().maxSeq || 0
    db.prepare('UPDATE devices SET last_synced_seq = ? WHERE id = ?').run(baseline, deviceId)

    const opA = appendOp(db, { entity: 'template_slots', entity_id: 'closemid-a', field: 'activity_id', value: '1', author_user_id: userId, device_id: deviceId, parent_op_id: null })
    appendOp(db, { entity: 'template_slots', entity_id: 'closemid-b', field: 'activity_id', value: '2', author_user_id: userId, device_id: deviceId, parent_op_id: null })

    const sent = []
    const ws = {
      deviceId,
      readyState: 1,
      OPEN: 1,
      send(data, callback) {
        const parsed = JSON.parse(data)
        sent.push(parsed)
        // Simulate the socket dying (close/error) right after op A's send
        // is confirmed, before op B's send is attempted.
        setImmediate(() => {
          ws.readyState = 3 // CLOSED
          callback()
        })
      },
    }

    await sendMissedOps(db, ws)

    // Only op A was ever attempted — sendWithAck's readyState check before
    // op B's send must have caught the now-dead socket and stopped, rather
    // than calling ws.send() again on a closed connection.
    expect(sent.map((m) => m.op.entity_id)).toEqual(['closemid-a'])

    const row = db.prepare('SELECT last_synced_seq FROM devices WHERE id = ?').get(deviceId)
    expect(row.last_synced_seq).toBe(opA.seq)
  })
})

describe('Red Hat follow-up: sendWithAck is bounded by a timeout so an unfired ws.send() callback cannot hang forever', () => {
  // Models the documented `ws` library edge case where the completion
  // callback passed to ws.send() is never invoked (some destroy-path
  // scenarios drop it entirely). Without a timeout racing the ack Promise,
  // this would hang forever. A short timeoutMs keeps this test fast instead
  // of waiting out the real 8s production default.
  function fakeNeverAcksWs() {
    return {
      readyState: 1,
      OPEN: 1,
      send(_data, _callback) {
        // Intentionally never invoke _callback — simulates the unfired-
        // callback edge case.
      },
    }
  }

  it('sendWithAck resolves false (not hangs) once the timeout elapses without the callback firing', async () => {
    const ws = fakeNeverAcksWs()
    const result = await sendWithAck(ws, { type: 'op_applied', op: {} }, 20)
    expect(result).toBe(false)
  })

  it('sendMissedOps treats an unfired ack callback as a failed send, stopping the loop and leaving the watermark honest', async () => {
    const baseline = db.prepare('SELECT MAX(seq) as maxSeq FROM operations').get().maxSeq || 0
    db.prepare('UPDATE devices SET last_synced_seq = ? WHERE id = ?').run(baseline, deviceId)

    appendOp(db, { entity: 'template_slots', entity_id: 'noack-a', field: 'activity_id', value: '1', author_user_id: userId, device_id: deviceId, parent_op_id: null })
    appendOp(db, { entity: 'template_slots', entity_id: 'noack-b', field: 'activity_id', value: '2', author_user_id: userId, device_id: deviceId, parent_op_id: null })

    const sent = []
    const ws = {
      deviceId,
      readyState: 1,
      OPEN: 1,
      send(data, _callback) {
        sent.push(JSON.parse(data))
        // op A's callback never fires — sendWithAck must time out and
        // resolve false rather than hang, which should stop the replay
        // loop before op B is ever attempted.
      },
    }

    // A short ackTimeoutMs keeps this test fast (it would otherwise take
    // the real 8s production default before resolving).
    await sendMissedOps(db, ws, 20)

    // op A itself is the one whose ack never confirms, so it must have been
    // attempted (send() called) but never counted as successfully delivered
    // — op B must never be attempted once op A's send fails via timeout.
    expect(sent.map((m) => m.op.entity_id)).toEqual(['noack-a'])

    // Since not even op A was confirmed delivered, the watermark must stay
    // exactly at the pre-existing baseline — it must NOT advance past an
    // unconfirmed op just because ws.send() didn't throw synchronously.
    const row = db.prepare('SELECT last_synced_seq FROM devices WHERE id = ?').get(deviceId)
    expect(row.last_synced_seq).toBe(baseline)
  })
})
