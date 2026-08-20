// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { openLocalDb } from '../db/localDb.js'
import { createUser, issueCampToken, issueLocalToken, ensureHostSigningKey } from '../auth/localAuth.js'
import { appendOp, DELETE_FIELD } from '../ops/operations.js'
import { startSyncServer } from './syncServer.js'
import { sendMissedOps, resolveApplyAck, waitForApplyAck } from './catchup.js'
import { sendWithAck } from './opDelivery.js'
import { ENTITIES } from '../auth/permissions.js'
import { LOGIN_MIN_INTERVAL_MS } from './rateLimit.js'
import { waitFor, sleepBecauseTimeIsUnderTest } from '../../test/helpers/waitFor.js'
import { getFreePort } from '../../test/integration/harness.js'

let PORT
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

// Authorized-by-default devices row, matching what real pairing (sub-task 2)
// or the dev-authorize-device interim path would leave behind — most tests
// in this file are about WS message handling, not device pairing, so they
// need a device that ALREADY clears handleAuthenticate's
// authorized_at/revoked_at gate.
function insertAuthorizedDevice(db, id, name) {
  db.prepare(
    `INSERT INTO devices (id, name, last_synced_at, authorized_at, device_secret_identifier, pairing_status)
     VALUES (?, ?, ?, ?, ?, 'authorized')`
  ).run(id, name, new Date().toISOString(), new Date().toISOString(), randomBytes(32).toString('hex'))
}

// Same as insertAuthorizedDevice but leaves last_synced_at NULL — needed for
// full_sync tests: sendFullSyncIfFirstPairing (syncServer.js) gates on
// last_synced_at being unset, so a pre-authorized device that will still be
// treated as "first pairing" must not have it pre-populated.
function insertAuthorizedUnsyncedDevice(db, id, name) {
  db.prepare(
    `INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status)
     VALUES (?, ?, ?, ?, 'authorized')`
  ).run(id, name, new Date().toISOString(), randomBytes(32).toString('hex'))
}

beforeEach(async () => {
  tmpFile = path.join(os.tmpdir(), `shoresh-sync-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)

  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'b'.repeat(64))

  // Host Ed25519 key, per docs/adr/2026-07-25-device-trust-revocation.md —
  // this db plays the Host's own db throughout this file (startSyncServer
  // runs against it), so it needs a host_signing_key to issue 'camp' tokens
  // and camps.signing_public_key so verifySessionToken (called by
  // handleAuthenticate) can verify them.
  const hostKey = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, campId)

  deviceId = randomUUID()
  insertAuthorizedDevice(db, deviceId, 'Device A')

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

  token = issueCampToken(db, userId, deviceId)

  PORT = await getFreePort()
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
    insertAuthorizedDevice(db, otherDeviceId, 'Device B')
    const otherToken = issueCampToken(db, userId, otherDeviceId)
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

// D2/D3/T2 (docs/adr/2026-08-15-locations-concurrent-create-collision.md):
// the everyday two-device same-name race — this is "Path 2" in the ADR, the
// path that actually fires when two devices race to create the same new
// name, since every Client write round-trips through the Host's one
// synchronous handleSubmitOp/appendOp.
describe('submit_op: locations UNIQUE(camp_id, name) collision (D2/D3/T2)', () => {
  it('sends op_rejected (not op_applied) on a colliding create, appends no operations row, and leaves the winning row byte-unchanged', async () => {
    const ws1 = connect()
    await onceOpen(ws1)
    // No wait after authenticate: this is a single TCP connection, so the
    // Host processes the authenticate frame (synchronously setting
    // ws.deviceId) before the submit_op frame that follows it, matching the
    // immediate-send pattern already used elsewhere in this file (e.g. the
    // acquire_lock tests above) rather than a fixed-duration sleep.
    ws1.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))

    // Device A creates "Pool" and it applies.
    ws1.send(
      JSON.stringify({
        type: 'submit_op',
        op: { entity: 'locations', entity_id: 'loc-a', field: 'name', value: 'Pool', author_user_id: userId, parent_op_id: null },
      })
    )
    const applied = await onceMessage(ws1)
    expect(applied.type).toBe('op_applied')

    const winningRowBefore = db.prepare('SELECT * FROM locations WHERE id = ?').get('loc-a')
    expect(winningRowBefore.name).toBe('Pool')
    const opCountBefore = db.prepare('SELECT COUNT(*) as c FROM operations').get().c

    // Device B concurrently creates a DIFFERENT row with the SAME name.
    const rejectedPromise = onceMessage(ws1)
    ws1.send(
      JSON.stringify({
        type: 'submit_op',
        op: { entity: 'locations', entity_id: 'loc-b', field: 'name', value: 'Pool', author_user_id: userId, parent_op_id: null },
      })
    )
    const rejectedMsg = await rejectedPromise
    expect(rejectedMsg.type).toBe('op_rejected')
    expect(rejectedMsg.reason).toBe('unique_field')
    expect(rejectedMsg.field).toBe('name')
    expect(rejectedMsg.existing).toMatchObject({ id: 'loc-a', name: 'Pool' })

    // No new row for loc-b, no new operations row for the rejected submission,
    // and the winning row is byte-unchanged.
    const loserRow = db.prepare('SELECT * FROM locations WHERE id = ?').get('loc-b')
    expect(loserRow).toBeUndefined()
    const opCountAfter = db.prepare('SELECT COUNT(*) as c FROM operations').get().c
    expect(opCountAfter).toBe(opCountBefore)
    const winningRowAfter = db.prepare('SELECT * FROM locations WHERE id = ?').get('loc-a')
    expect(winningRowAfter).toEqual(winningRowBefore)

    ws1.close()
  })

  it('rejects a RENAME of an existing location into another existing location\'s name, the same way a create collision is rejected', async () => {
    const ws1 = connect()
    await onceOpen(ws1)
    // No wait after authenticate — see the sibling test above.
    ws1.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))

    ws1.send(
      JSON.stringify({
        type: 'submit_op',
        op: { entity: 'locations', entity_id: 'loc-pool', field: 'name', value: 'Pool', author_user_id: userId, parent_op_id: null },
      })
    )
    await onceMessage(ws1)
    ws1.send(
      JSON.stringify({
        type: 'submit_op',
        op: { entity: 'locations', entity_id: 'loc-gym', field: 'name', value: 'Gym', author_user_id: userId, parent_op_id: null },
      })
    )
    const gymCreated = await onceMessage(ws1)

    // Rename "Gym" to "Pool" — a name another existing row already holds.
    // parent_op_id points at the prior op for this SAME entity_id/field
    // (an honest "based on the state I actually observed" write) so
    // detectConflict — a DIFFERENT check, keyed on one entity_id — reports
    // no conflict and this genuinely reaches detectUniqueFieldCollision.
    const rejectedPromise = onceMessage(ws1)
    ws1.send(
      JSON.stringify({
        type: 'submit_op',
        op: { entity: 'locations', entity_id: 'loc-gym', field: 'name', value: 'Pool', author_user_id: userId, parent_op_id: gymCreated.op.id },
      })
    )
    const rejectedMsg = await rejectedPromise
    expect(rejectedMsg.type).toBe('op_rejected')
    expect(rejectedMsg.existing.id).toBe('loc-pool')

    const gymRow = db.prepare('SELECT * FROM locations WHERE id = ?').get('loc-gym')
    expect(gymRow.name).toBe('Gym') // unchanged — the rename never applied

    ws1.close()
  })

  it('does not flag a rename of a location to its own current name (self no-op)', async () => {
    const ws1 = connect()
    await onceOpen(ws1)
    // No wait after authenticate — see the sibling test above.
    ws1.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))

    ws1.send(
      JSON.stringify({
        type: 'submit_op',
        op: { entity: 'locations', entity_id: 'loc-pool', field: 'name', value: 'Pool', author_user_id: userId, parent_op_id: null },
      })
    )
    const poolCreated = await onceMessage(ws1)

    const appliedAgainPromise = onceMessage(ws1)
    ws1.send(
      JSON.stringify({
        type: 'submit_op',
        op: { entity: 'locations', entity_id: 'loc-pool', field: 'name', value: 'Pool', author_user_id: userId, parent_op_id: poolCreated.op.id },
      })
    )
    const msg = await appliedAgainPromise
    expect(msg.type).toBe('op_applied')

    ws1.close()
  })
})

// T7 (docs/adr/2026-08-15-locations-concurrent-create-collision.md addendum,
// Finding A): restoreEntity's colliding-restore refusal must reach the wire
// as a structured restore_result, forwarding `field`/`existing` the same way
// op_rejected already does — not just the bare `error` string.
describe('restore_request: locations UNIQUE(camp_id, name) collision guard (T7 / Finding A)', () => {
  it('sends restore_result with error "unique_field", forwarding field and existing', async () => {
    appendOp(db, { entity: 'locations', entity_id: 'loc-deleted', field: 'camp_id', value: campId, author_user_id: userId, device_id: deviceId })
    appendOp(db, { entity: 'locations', entity_id: 'loc-deleted', field: 'name', value: 'Pool', author_user_id: userId, device_id: deviceId })
    appendOp(db, { entity: 'locations', entity_id: 'loc-deleted', field: DELETE_FIELD, value: 1, author_user_id: userId, device_id: deviceId })
    // A different, live row now holds the same name.
    appendOp(db, { entity: 'locations', entity_id: 'loc-live', field: 'camp_id', value: campId, author_user_id: userId, device_id: deviceId })
    appendOp(db, { entity: 'locations', entity_id: 'loc-live', field: 'name', value: 'Pool', author_user_id: userId, device_id: deviceId })

    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))

    ws.send(JSON.stringify({ type: 'restore_request', request_id: 'req-1', entity: 'locations', entity_id: 'loc-deleted' }))
    const msg = await onceMessageOfType(ws, 'restore_result')

    expect(msg).toMatchObject({
      type: 'restore_result',
      request_id: 'req-1',
      error: 'unique_field',
      field: 'name',
      existing: { id: 'loc-live', name: 'Pool' },
    })

    ws.close()
  })

  it('an ordinary refusal reason (not-deleted) still carries no field/existing (no regression)', async () => {
    appendOp(db, { entity: 'locations', entity_id: 'loc-live', field: 'camp_id', value: campId, author_user_id: userId, device_id: deviceId })
    appendOp(db, { entity: 'locations', entity_id: 'loc-live', field: 'name', value: 'Beach', author_user_id: userId, device_id: deviceId })

    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))

    ws.send(JSON.stringify({ type: 'restore_request', request_id: 'req-2', entity: 'locations', entity_id: 'loc-live' }))
    const msg = await onceMessageOfType(ws, 'restore_result')

    expect(msg).toEqual({ type: 'restore_result', request_id: 'req-2', error: 'not-deleted' })

    ws.close()
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
    insertAuthorizedDevice(db, otherDeviceId, 'Device B')
    const otherToken = issueCampToken(db, userId, otherDeviceId)
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
    insertAuthorizedDevice(db, otherDeviceId, 'Device B')
    const otherToken = issueCampToken(db, userId, otherDeviceId)
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

describe('device self-registration + revocation gate at authenticate (docs/adr/2026-07-25-device-trust-revocation.md)', () => {
  it('self-registers a genuinely new device as pending, then rejects the connection since a devices row existing no longer implies it may log in', async () => {
    const newDeviceId = randomUUID()
    // Deliberately do NOT pre-insert a devices row here: this is exactly the
    // real-world scenario (a brand-new device that the Host has never seen).
    // The self-registration fix in handleAuthenticate must create this row
    // itself — but per the device-trust-revocation design, that row lands as
    // 'pending', and the connection must be rejected, not granted full_sync.
    const newToken = issueCampToken(db, userId, newDeviceId)

    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token: newToken, device_id: newDeviceId }))
    await onceClose(ws)
    expect(ws.readyState).toBe(WebSocket.CLOSED)

    const row = db.prepare('SELECT pairing_status, authorized_at FROM devices WHERE id = ?').get(newDeviceId)
    expect(row).toBeTruthy()
    expect(row.pairing_status).toBe('pending')
    expect(row.authorized_at).toBeNull()
  })

  it('a revoked device is rejected at authenticate — the connection never gets full_sync or any other reply', async () => {
    const revokedDeviceId = randomUUID()
    insertAuthorizedDevice(db, revokedDeviceId, 'Revoked Device')
    db.prepare("UPDATE devices SET revoked_at = ?, revocation_reason = 'lost' WHERE id = ?").run(
      new Date().toISOString(),
      revokedDeviceId
    )
    const revokedToken = issueCampToken(db, userId, revokedDeviceId)

    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token: revokedToken, device_id: revokedDeviceId }))
    await onceClose(ws)
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })

  it('rejects a local-type token outright, even for an otherwise-authorized device', async () => {
    // issueLocalToken requires this device's OWN device_secret_identifier —
    // deviceId already has one from insertAuthorizedDevice in beforeEach.
    const localToken = issueLocalToken(db, userId, deviceId)

    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token: localToken, device_id: deviceId }))
    await onceClose(ws)
    expect(ws.readyState).toBe(WebSocket.CLOSED)
  })
})

describe('C3 fail-first characterization: device-trust reason harmonization at the reachable never-authorized-but-revoked state (docs/adr/2026-08-17-sync-auth-layer-deepening.md)', () => {
  // Reachable because revokeDevice (electron/main.js) only requires the
  // device to exist, not that it was ever authorized.
  function insertRevokedNeverAuthorizedDevice(db, id, name) {
    db.prepare(
      `INSERT INTO devices (id, name, revoked_at, revocation_reason, device_secret_identifier, pairing_status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    ).run(id, name, new Date().toISOString(), 'lost', randomBytes(32).toString('hex'))
  }

  // ADR C3: handleAuthenticate now sources its reason from
  // deviceTrustReason's revoked-wins precedence. Pre-C3, handleAuthenticate
  // checked !authorized_at BEFORE revoked_at, so this state closed 4403
  // ('device_not_authorized'). This was verified fail-first during
  // development — this assertion was written and run against the
  // pre-refactor code, where it passed with 4403/'device_not_authorized',
  // before the call site was switched to deviceTrustReason and the
  // expectation flipped to match; both steps landed together in this one C3
  // commit, so there is no separate fail-first commit to point to. Post-C3 it
  // closes 4404 ('device_revoked'). Confirmed UX-neutral: syncClient.js's
  // reasonForAuthRejectedCode maps both 4403 and 4404 to the identical
  // director-facing message.
  it('handleAuthenticate closes 4404 for a device revoked without ever having been authorized — C3 harmonization', async () => {
    const targetDeviceId = randomUUID()
    insertRevokedNeverAuthorizedDevice(db, targetDeviceId, 'Revoked Never Authorized')
    const targetToken = issueCampToken(db, userId, targetDeviceId)

    const ws = connect()
    await onceOpen(ws)
    const closePromise = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
    ws.send(JSON.stringify({ type: 'authenticate', token: targetToken, device_id: targetDeviceId }))

    const { code } = await closePromise
    expect(code).toBe(4404)
  })

  // handleLogin never exposes a reason (oracle-resistance) — unchanged by C3.
  // Included for table-driven completeness, not because it's expected to change.
  it('handleLogin responds with an opaque login_failed (no reason) for a device revoked without ever having been authorized', async () => {
    const targetDeviceId = randomUUID()
    const secret = randomBytes(32).toString('hex')
    db.prepare(
      `INSERT INTO devices (id, name, revoked_at, revocation_reason, device_secret_identifier, pairing_status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    ).run(targetDeviceId, 'Revoked Never Authorized', new Date().toISOString(), 'lost', secret)

    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({
      type: 'login',
      device_id: targetDeviceId,
      name: 'Alice',
      pin: '1234',
      device_secret_identifier: secret,
    }))

    const reply = await onceMessage(ws)
    expect(reply).toEqual({ type: 'login_failed' })

    ws.close()
  })

  // renew_token already implements revoked-wins today — unchanged by C3.
  // Included for table-driven completeness, not because it's expected to change.
  it('renew_token responds device_revoked and closes 4404 for a device revoked without ever having been authorized (already revoked-wins, pre- and post-C3)', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    // An authenticated-only probe (acquire_lock), sent right after
    // authenticate and awaited before the DB mutation below, is the
    // deterministic sync point: handleAuthenticate is not itself awaited by
    // its caller, so a fixed sleep can't prove it actually ran — but
    // acquire_lock is gated on `ws.deviceId` (handleAuthenticate sets it
    // synchronously, see syncServer.js), so a `lock_result` reply is only
    // possible once authenticate has genuinely completed. Without this gate,
    // the DB mutation (pure in-process JS) can race ahead of the real
    // network round-trip authenticate needs, land BEFORE the server even
    // processes `authenticate`, and make handleAuthenticate itself see the
    // device as already-revoked and close 4404 there — never reaching
    // renew_token's own revoked-wins check, which is what this test means to
    // exercise.
    ws.send(
      JSON.stringify({ type: 'acquire_lock', entity: 'template_slots', entity_id: 'renew-token-sync-probe', field: 'activity_id' })
    )
    await onceMessageOfType(ws, 'lock_result')

    // Flip the already-authenticated device to never-authorized-but-revoked
    // mid-session, matching the existing "revoke mid-session" test's shape.
    db.prepare("UPDATE devices SET authorized_at = NULL, revoked_at = ?, revocation_reason = 'lost' WHERE id = ?")
      .run(new Date().toISOString(), deviceId)

    ws.send(JSON.stringify({ type: 'renew_token', token }))
    const reply = await onceMessageOfType(ws, 'token_renewal_failed')
    expect(reply.reason).toBe('device_revoked')

    await onceClose(ws)
    ws.close()
  })
})

describe('C3 table-driven: outcome/reason/close-code across found/authorized/revoked at handleAuthenticate and handleLogin', () => {
  // Explicit close-code/reason coverage for the two reachable, never-revoked
  // deny states — these were previously exercised (elsewhere in this file)
  // only by "connection closed", without asserting the specific code. Named
  // per docs/adr/2026-08-17-sync-auth-layer-deepening.md's test-strategy
  // requirement to prove seven of eight found/authorized/revoked combinations
  // are unchanged post-refactor. device_not_found is unreachable at
  // handleAuthenticate (it self-registers a pending row for any unknown
  // device before this check runs).
  it('handleAuthenticate closes 4403/device_not_authorized for a device that has never been authorized (unchanged by C3)', async () => {
    const targetDeviceId = randomUUID()
    db.prepare("INSERT INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run(targetDeviceId, 'Pending Device')
    const targetToken = issueCampToken(db, userId, targetDeviceId)

    const ws = connect()
    await onceOpen(ws)
    const closePromise = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
    ws.send(JSON.stringify({ type: 'authenticate', token: targetToken, device_id: targetDeviceId }))

    const { code, reason } = await closePromise
    expect(code).toBe(4403)
    expect(reason).toBe('device_not_authorized')
  })

  it('handleAuthenticate closes 4404/device_revoked for a device authorized then revoked (unchanged by C3)', async () => {
    const targetDeviceId = randomUUID()
    insertAuthorizedDevice(db, targetDeviceId, 'Revoked Device')
    db.prepare("UPDATE devices SET revoked_at = ?, revocation_reason = 'lost' WHERE id = ?").run(new Date().toISOString(), targetDeviceId)
    const targetToken = issueCampToken(db, userId, targetDeviceId)

    const ws = connect()
    await onceOpen(ws)
    const closePromise = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
    ws.send(JSON.stringify({ type: 'authenticate', token: targetToken, device_id: targetDeviceId }))

    const { code, reason } = await closePromise
    expect(code).toBe(4404)
    expect(reason).toBe('device_revoked')
  })

  it('handleLogin responds with an opaque login_failed for a device authorized then revoked (unchanged by C3)', async () => {
    const targetDeviceId = randomUUID()
    const secret = randomBytes(32).toString('hex')
    insertAuthorizedDevice(db, targetDeviceId, 'Revoked Device')
    db.prepare('UPDATE devices SET device_secret_identifier = ? WHERE id = ?').run(secret, targetDeviceId)
    db.prepare("UPDATE devices SET revoked_at = ?, revocation_reason = 'lost' WHERE id = ?").run(new Date().toISOString(), targetDeviceId)

    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({
      type: 'login',
      device_id: targetDeviceId,
      name: 'Alice',
      pin: '1234',
      device_secret_identifier: secret,
    }))

    const reply = await onceMessage(ws)
    expect(reply).toEqual({ type: 'login_failed' })

    ws.close()
  })
})

describe('full_sync on first pairing', () => {
  it('sends full_sync with all users and camps on an ALREADY-AUTHORIZED new device\'s first successful authenticate', async () => {
    const newDeviceId = randomUUID()
    // Pre-authorized here (standing in for sub-task 2's real pairing-approval
    // flow / the dev-authorize-device interim path) — self-registration
    // alone (a bare devices row) is deliberately NOT enough to reach
    // full_sync, per the "rejects...pending" test above.
    insertAuthorizedUnsyncedDevice(db, newDeviceId, 'Pre-Authorized New Device')
    const newToken = issueCampToken(db, userId, newDeviceId)

    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token: newToken, device_id: newDeviceId }))
    const msg = await onceMessage(ws)

    expect(msg.type).toBe('full_sync')
    expect(msg.users).toEqual([
      { id: userId, camp_id: campId, name: 'Alice', pin_hash: expect.any(String), pin_salt: expect.any(String), role: 'admin' },
    ])
    expect(msg.camps).toEqual([
      {
        id: campId,
        name: 'Test Camp',
        signing_secret: 'b'.repeat(64),
        signing_public_key: expect.any(String),
      },
    ])
    // Extended domain snapshot (T7 fix): every camp-scoped domain table
    // ships too, as empty arrays here since none has any data yet.
    for (const table of [
      'cohorts', 'days_of_operation', 'groups', 'tiers', 'time_blocks', 'activities',
      'anchor_activities', 'schedule_templates', 'day_override_templates',
      'template_slots', 'template_overlays', 'day_override_template_slots',
    ]) {
      expect(msg[table], `expected msg.${table} to be []`).toEqual([])
    }

    // last_synced_at must NOT be set on transport delivery alone — only once
    // the Client's application-level full_sync_applied ack arrives (T7 fix,
    // design doc §2.4).
    let row = db.prepare('SELECT last_synced_at FROM devices WHERE id = ?').get(newDeviceId)
    expect(row.last_synced_at).toBeNull()

    ws.send(JSON.stringify({ type: 'full_sync_applied' }))
    await new Promise((r) => setTimeout(r, 100))

    row = db.prepare('SELECT last_synced_at FROM devices WHERE id = ?').get(newDeviceId)
    expect(row.last_synced_at).toBeTruthy()

    ws.close()
  })

  it('does not send full_sync again on a second authenticate from the same device', async () => {
    const newDeviceId = randomUUID()
    insertAuthorizedUnsyncedDevice(db, newDeviceId, 'Pre-Authorized New Device 2')
    const newToken = issueCampToken(db, userId, newDeviceId)

    const ws1 = connect()
    await onceOpen(ws1)
    ws1.send(JSON.stringify({ type: 'authenticate', token: newToken, device_id: newDeviceId }))
    const firstMsg = await onceMessage(ws1)
    expect(firstMsg.type).toBe('full_sync')
    // Ack it — without this, last_synced_at stays NULL and a second
    // authenticate would correctly (per the T7 fix) retry the snapshot.
    ws1.send(JSON.stringify({ type: 'full_sync_applied' }))
    await new Promise((r) => setTimeout(r, 100))
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

describe('T85 Risk 1: re-authenticate on the SAME already-authenticated socket (shift change)', () => {
  // Red Hat's finding: the existing "does not send full_sync again on a
  // second authenticate" test above uses a NEW ws for its second
  // authenticate — that never touches the bug, since a fresh ws has no
  // pending ack registry entry to clobber. loginRemote (syncClient.js)
  // sends its post-login `authenticate` on the SAME, never-closed ws on
  // every successful login (shift change: same device, new user) — this
  // reproduces exactly that shape.
  it('does not run a second catch-up pass, refreshes ws.userId/ws.token, and leaves the watermark untouched', async () => {
    // deviceId/token/userId (Alice, admin) are already authorized+established
    // in the top-level beforeEach, on an already-synced device (no full_sync
    // path involved here — this is purely about the sendMissedOps catch-up).
    const staffUser = await createUser(
      db,
      { camp_id: campId, name: 'Bob', pin: '5678', role: 'staff' },
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
    const bobToken = issueCampToken(db, staffUser.id, deviceId)

    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    // Let the first authenticate's sendMissedOps establish its baseline
    // (first-time branch: silently sets last_synced_seq, sends nothing).
    await sleepBecauseTimeIsUnderTest(50) // time-under-test: crossing-interval

    const baselineSeq = db.prepare('SELECT last_synced_seq FROM devices WHERE id = ?').get(deviceId).last_synced_seq
    expect(baselineSeq).not.toBeNull()

    // Append a genuine op AFTER the baseline was established — under the
    // pre-fix bug, a second sendMissedOps run on re-authenticate would pick
    // this up as a "missed op" and push it down this same ws as an
    // op_applied catch-up message.
    appendOp(db, {
      entity: 'template_slots',
      entity_id: 'shift-change-missed-op',
      field: 'activity_id',
      value: 'swim',
      author_user_id: null,
      device_id: deviceId,
      parent_op_id: null,
    })

    let sawOpApplied = false
    const opAppliedListener = (data) => {
      const parsed = JSON.parse(data.toString())
      if (parsed.type === 'op_applied') sawOpApplied = true
    }
    ws.on('message', opAppliedListener)

    // Re-authenticate on the SAME ws, as a different user — the shift-change
    // shape loginRemote produces.
    ws.send(JSON.stringify({ type: 'authenticate', token: bobToken, device_id: deviceId }))

    // Give a re-fired sendMissedOps every chance to have delivered the
    // missed op by now (it sends synchronously off the message handler, no
    // ack round-trip required to enqueue the send).
    await sleepBecauseTimeIsUnderTest(150) // time-under-test: proving-absence

    ws.off('message', opAppliedListener)
    expect(sawOpApplied).toBe(false)

    // The watermark must not have moved — no second sendMissedOps ran to
    // advance it, so it must still read exactly what the first run set.
    const afterSeq = db.prepare('SELECT last_synced_seq FROM devices WHERE id = ?').get(deviceId).last_synced_seq
    expect(afterSeq).toBe(baselineSeq)

    // ws.userId/ws.token WERE refreshed to Bob (staff): a restore request
    // (admin-only for every entity, regardless of role-specific write
    // grants) must now be refused, which it would only be if authorize() is
    // consulting Bob's current token/role rather than Alice's stale admin one.
    ws.send(JSON.stringify({ type: 'restore_request', request_id: 'r1', entity: 'groups', entity_id: 'does-not-exist' }))
    const restoreReply = await onceMessageOfType(ws, 'restore_result')
    expect(restoreReply).toEqual({ type: 'restore_result', request_id: 'r1', error: 'forbidden' })

    ws.close()
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
    const ws = {
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
        // T85 Part 2: this describe block is about TRANSPORT send failure,
        // not receiver-apply failure — a real Client that received the op
        // genuinely applies it and acks. Simulate that immediately so these
        // pre-existing transport-level assertions aren't gated on
        // waitForApplyAck's timeout.
        if (parsed.type === 'op_applied') {
          setImmediate(() => {
            resolveApplyAck(ws, parsed.op.id)
          })
        }
      },
      __sent: sent,
    }
    return ws
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

    // asOfSeq (the new required 3rd arg, design doc §2.5) is unused by
    // sendMissedOps whenever last_synced_seq is already established (as it
    // is here, set to 0 above) — it only matters for the first-time
    // baselining branch, exercised separately below. 0 is a harmless
    // placeholder for that reason.
    await sendMissedOps(db, ws, 0)

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
    await sendMissedOps(db, ws2, 0)
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
    appendOp(db, { entity: 'template_slots', entity_id: 'catchup-ok-a', field: 'activity_id', value: '1', author_user_id: userId, device_id: deviceId, parent_op_id: null })
    const opB = appendOp(db, { entity: 'template_slots', entity_id: 'catchup-ok-b', field: 'activity_id', value: '2', author_user_id: userId, device_id: deviceId, parent_op_id: null })

    const ws = fakeWs(deviceId, null)
    await sendMissedOps(db, ws, baseline)

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
    const ws = {
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
          // T85 Part 2: this describe block is about TRANSPORT-level async
          // failure, not receiver-apply failure — a real Client whose
          // send() genuinely confirms also applies and acks. Simulate that
          // via a SIBLING setImmediate (not nested inside the callback's
          // own) so it runs only after the microtask chain resuming
          // sendMissedOps's `await sendWithAck(...)` has had a turn to run
          // and register waitForApplyAck's resolver — otherwise
          // the pending ack registry entry is still unset when this fires.
          if (parsed.type === 'op_applied') {
            setImmediate(() => {
              resolveApplyAck(ws, parsed.op.id)
            })
          }
        }
      },
      __sent: sent,
    }
    return ws
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
    appendOp(db, { entity: 'template_slots', entity_id: 'async-b', field: 'activity_id', value: '2', author_user_id: userId, device_id: deviceId, parent_op_id: null })
    const opC = appendOp(db, { entity: 'template_slots', entity_id: 'async-c', field: 'activity_id', value: '3', author_user_id: userId, device_id: deviceId, parent_op_id: null })

    // op B's send() call itself does not throw, and readyState stays OPEN
    // throughout — the only signal that it failed is the async callback.
    const ws = fakeAsyncFailWs(deviceId, 'async-b')

    await sendMissedOps(db, ws, baseline)

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
    await sendMissedOps(db, ws2, baseline)
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
        // T85 Part 2: op A's transport send DID genuinely confirm before the
        // socket died, and a real Client that received it applies and acks
        // it — simulate that via a SIBLING setImmediate (see the identical
        // reasoning in fakeAsyncFailWs above) so the watermark assertion
        // below isn't gated on waitForApplyAck's timeout. The socket already
        // reads CLOSED by the time this fires, which is exactly what proves
        // op B is never attempted via sendWithAck's own readyState guard,
        // not via this ack ever being withheld.
        if (parsed.type === 'op_applied') {
          setImmediate(() => {
            resolveApplyAck(ws, parsed.op.id)
          })
        }
      },
    }

    await sendMissedOps(db, ws, baseline)

    // Only op A was ever attempted — sendWithAck's readyState check before
    // op B's send must have caught the now-dead socket and stopped, rather
    // than calling ws.send() again on a closed connection.
    expect(sent.map((m) => m.op.entity_id)).toEqual(['closemid-a'])

    const row = db.prepare('SELECT last_synced_seq FROM devices WHERE id = ?').get(deviceId)
    expect(row.last_synced_seq).toBe(opA.seq)
  })
})

// docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md — T85 Part 2.
// Distinct from the round-5/round-6 describe blocks above: those simulate a
// TRANSPORT-level failure (sendWithAck resolves false). This simulates the
// opposite — transport genuinely succeeds for every op (sendWithAck resolves
// true every time) — and isolates the NEW gate this ADR adds: the receiver
// never sends op_applied_ack for one specific op, as if it applied it
// (the real Client's applyRemoteOp threw) or an old, pre-fix Client that
// doesn't send the ack message at all.
describe('T85 Part 2: sendMissedOps gates watermark on a genuine receiver op_applied_ack, not transport delivery alone', () => {
  // ackEntityIds: the set of ops this fake Client genuinely "applies" and
  // acks (mirrors syncClient.js's real op_applied handler sending
  // op_applied_ack only once applyRemoteOp did not throw). Any op NOT in
  // this set has its transport send succeed but is never acked — modeling
  // both a receiver-apply failure and an old Client that never sends this
  // message type at all.
  function fakeWsSelectiveAck(deviceId, ackEntityIds) {
    const sent = []
    const ws = {
      deviceId,
      readyState: 1,
      OPEN: 1,
      send(data, callback) {
        const parsed = JSON.parse(data)
        sent.push(parsed)
        if (callback) setImmediate(() => callback())
        if (parsed.op && ackEntityIds.has(parsed.op.entity_id)) {
          // Sibling setImmediate, not nested in the callback's own — see the
          // identical ordering note on fakeAsyncFailWs above: this must run
          // only after the microtask chain resuming sendMissedOps's `await
          // sendWithAck(...)` has registered waitForApplyAck's resolver.
          setImmediate(() => {
            resolveApplyAck(ws, parsed.op.id)
          })
        }
      },
      __sent: sent,
    }
    return ws
  }

  it('stops the watermark at op N-1 when op N transport-sends successfully but its op_applied_ack never arrives, and never attempts ops after N', async () => {
    const baseline = db.prepare('SELECT MAX(seq) as maxSeq FROM operations').get().maxSeq || 0
    db.prepare('UPDATE devices SET last_synced_seq = ? WHERE id = ?').run(baseline, deviceId)

    const opA = appendOp(db, { entity: 'template_slots', entity_id: 'ack-a', field: 'activity_id', value: '1', author_user_id: userId, device_id: deviceId, parent_op_id: null })
    appendOp(db, { entity: 'template_slots', entity_id: 'ack-b', field: 'activity_id', value: '2', author_user_id: userId, device_id: deviceId, parent_op_id: null })
    appendOp(db, { entity: 'template_slots', entity_id: 'ack-c', field: 'activity_id', value: '3', author_user_id: userId, device_id: deviceId, parent_op_id: null })

    // Only op A is genuinely acked. Op B's transport send succeeds (it IS
    // attempted) but never gets an op_applied_ack — a short ackTimeoutMs
    // keeps this test fast instead of waiting out the 8s production default.
    const ws = fakeWsSelectiveAck(deviceId, new Set(['ack-a']))
    await sendMissedOps(db, ws, baseline, 30)

    // Both A and B's transport sends were attempted...
    expect(ws.__sent.map((m) => m.op.entity_id)).toEqual(['ack-a', 'ack-b'])
    // ...but C is never even attempted, since the loop breaks once B's
    // apply-ack times out.
    expect(ws.__sent.some((m) => m.op.entity_id === 'ack-c')).toBe(false)

    // The watermark advances only through A (N-1), never to B (N) or beyond
    // — transport delivery alone must never be mistaken for receiver truth.
    const row = db.prepare('SELECT last_synced_seq FROM devices WHERE id = ?').get(deviceId)
    expect(row.last_synced_seq).toBe(opA.seq)
  })

  it('a genuinely-acked op DOES advance the watermark past it (no regression on the happy path)', async () => {
    const baseline = db.prepare('SELECT MAX(seq) as maxSeq FROM operations').get().maxSeq || 0
    db.prepare('UPDATE devices SET last_synced_seq = ? WHERE id = ?').run(baseline, deviceId)

    appendOp(db, { entity: 'template_slots', entity_id: 'ack-ok-a', field: 'activity_id', value: '1', author_user_id: userId, device_id: deviceId, parent_op_id: null })
    const opB = appendOp(db, { entity: 'template_slots', entity_id: 'ack-ok-b', field: 'activity_id', value: '2', author_user_id: userId, device_id: deviceId, parent_op_id: null })

    const ws = fakeWsSelectiveAck(deviceId, new Set(['ack-ok-a', 'ack-ok-b']))
    await sendMissedOps(db, ws, baseline, 30)

    expect(ws.__sent.map((m) => m.op.entity_id)).toEqual(['ack-ok-a', 'ack-ok-b'])
    const row = db.prepare('SELECT last_synced_seq FROM devices WHERE id = ?').get(deviceId)
    expect(row.last_synced_seq).toBe(opB.seq)
  })
})

// ADR docs/adr/2026-08-17-sync-auth-layer-deepening.md, Slice 2 (C4): the
// pre-C4 mechanism stashed a single ack resolver directly on `ws`
// (ws.pendingCatchupAckOpId/ws.pendingCatchupAckResolve) — a second
// concurrent waitForApplyAck on the SAME ws overwrote the first's resolver,
// so the first invocation's real ack would resolve the wrong (or no) waiter.
// This is the direct, load-bearing proof that the keyed
// `ws.pendingApplyAcks` Map (catchup.js) fixes that: two DIFFERENT op_ids
// genuinely pending at once on the same connection now coexist in the Map
// and each resolves only via its own resolveApplyAck(ws, opId) call.
describe('C4: keyed apply-ack registry — different op_ids pending concurrently on the same ws do not clobber', () => {
  it('two overlapping sendMissedOps runs on the same ws each resolve their own op_id without cross-resolving the other', async () => {
    const baseline = db.prepare('SELECT MAX(seq) as maxSeq FROM operations').get().maxSeq || 0
    db.prepare('UPDATE devices SET last_synced_seq = ? WHERE id = ?').run(baseline, deviceId)

    const opA = appendOp(db, { entity: 'template_slots', entity_id: 'keyed-a', field: 'activity_id', value: '1', author_user_id: userId, device_id: deviceId, parent_op_id: null })
    const opB = appendOp(db, { entity: 'template_slots', entity_id: 'keyed-b', field: 'activity_id', value: '2', author_user_id: userId, device_id: deviceId, parent_op_id: null })

    // Transport always succeeds; application-level acks are driven entirely
    // by the test via resolveApplyAck, so the exact interleaving that
    // produces two different op_ids pending at once is fully controlled
    // rather than raced against real timers.
    const ws = {
      deviceId,
      readyState: 1,
      OPEN: 1,
      send(data, callback) {
        if (callback) setImmediate(() => callback())
      },
    }

    // Run 1: sends opA, gets acked, moves on to opB and is left pending there.
    const run1 = sendMissedOps(db, ws, baseline, 5000)
    await waitFor(() => ws.pendingApplyAcks?.has(opA.id))
    resolveApplyAck(ws, opA.id)
    await waitFor(() => ws.pendingApplyAcks?.has(opB.id))

    // Run 2 starts on the SAME ws/device while run1 is still pending on
    // opB — the double-fired-handleAuthenticate shape the ADR describes.
    // It independently re-reads the same watermark (run1 hasn't advanced it
    // yet) and starts its own replay from opA.
    const run2 = sendMissedOps(db, ws, baseline, 5000)
    await waitFor(() => ws.pendingApplyAcks?.has(opA.id))

    // Load-bearing assertion: both op_ids are genuinely pending at once, in
    // the SAME registry — the exact shape that clobbered under the old
    // single-slot fields.
    expect(ws.pendingApplyAcks.size).toBe(2)

    // Resolve run1's key (opB) first. This must NOT disturb run2's still-
    // pending opA entry — proving the two keys are independent.
    resolveApplyAck(ws, opB.id)
    expect(ws.pendingApplyAcks.has(opA.id)).toBe(true)
    expect(ws.pendingApplyAcks.has(opB.id)).toBe(false)

    // Now resolve run2's opA wait; run2 moves on to its own opB attempt.
    resolveApplyAck(ws, opA.id)
    await waitFor(() => ws.pendingApplyAcks?.has(opB.id))
    resolveApplyAck(ws, opB.id)

    await Promise.all([run1, run2])

    // Neither run timed out or stalled on the other's key — both replayed
    // through to opB, so the final watermark reflects a full, successful
    // catch-up regardless of which run's UPDATE lands last.
    const row = db.prepare('SELECT last_synced_seq FROM devices WHERE id = ?').get(deviceId)
    expect(row.last_synced_seq).toBe(opB.seq)
  })

  it('a timeout still resolves false and cleans up its own Map entry', async () => {
    const baseline = db.prepare('SELECT MAX(seq) as maxSeq FROM operations').get().maxSeq || 0
    db.prepare('UPDATE devices SET last_synced_seq = ? WHERE id = ?').run(baseline, deviceId)

    const opA = appendOp(db, { entity: 'template_slots', entity_id: 'keyed-timeout-a', field: 'activity_id', value: '1', author_user_id: userId, device_id: deviceId, parent_op_id: null })

    const ws = {
      deviceId,
      readyState: 1,
      OPEN: 1,
      send(data, callback) {
        // Transport succeeds; the application-level ack simply never arrives.
        if (callback) setImmediate(() => callback())
      },
    }

    await sendMissedOps(db, ws, baseline, 30)

    // The loop broke on the never-acked op, so the watermark must not have
    // advanced past it, and the Map entry it registered must be gone —
    // not leaked past the timeout.
    const row = db.prepare('SELECT last_synced_seq FROM devices WHERE id = ?').get(deviceId)
    expect(row.last_synced_seq).toBe(baseline)
    expect(ws.pendingApplyAcks.has(opA.id)).toBe(false)
  })
})

// ADR docs/adr/2026-08-17-sync-auth-layer-deepening.md, Slice 2 (C4),
// round-2 review finding (Red Hat): the keyed `ws.pendingApplyAcks` Map
// fixes the clobber ONLY for two DIFFERENT op_ids pending on the same ws
// (proved above). It does NOT fix two waiters registered for the SAME
// op_id — the second registration overwrites the first at that one Map
// key, exactly like the pre-C4 single-slot field. This is inert in
// production today because isReauthenticate (syncServer.js) is the sole
// thing preventing two overlapping sendMissedOps runs on one ws, and any
// such overlap would collide on the SAME op_id (both runs read the same
// end-of-run watermark and so both start replay from the identical first
// op). This test pins the current, known-limitation behavior so a future
// change that weakens isReauthenticate, or a naive edit to the Map
// mechanism, cannot silently regress it without a red test.
describe('C4 known limitation: two waiters for the SAME op_id on one ws still clobber', () => {
  it('the second-registered waiter resolves true; the first-registered waiter times out false', async () => {
    const ws = {}
    const opId = 'same-op-id-both-waiters'

    // Mirrors the shape two overlapping sendMissedOps runs would produce if
    // isReauthenticate ever failed to prevent the overlap: both wait on the
    // identical op_id on the same ws. The first waiter gets a short timeout
    // so the test doesn't wait out a production-length one to prove it lost.
    const firstWaiterTimesOut = waitForApplyAck(ws, opId, 50)
    const secondWaiterWins = waitForApplyAck(ws, opId, 5000)

    resolveApplyAck(ws, opId)

    await expect(secondWaiterWins).resolves.toBe(true)
    await expect(firstWaiterTimesOut).resolves.toBe(false)
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
    await sendMissedOps(db, ws, baseline, 20)

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

describe('unauthenticated login message', () => {
  // Sub-task 4: handleLogin now requires an authorized device with matching
  // device_secret_identifier before reaching the PIN check. All tests in
  // this describe must pre-insert at least one authorized device and include
  // device_secret_identifier in their login messages.
  let loginDeviceId, loginDeviceSecret

  beforeEach(() => {
    loginDeviceId = randomUUID()
    loginDeviceSecret = randomBytes(32).toString('hex')
    db.prepare(
      "INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status) VALUES (?, ?, ?, ?, 'authorized')"
    ).run(loginDeviceId, 'Login Test Device', new Date().toISOString(), loginDeviceSecret)
  })

  it('responds login_ok with a token bound to the requesting device_id', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'login', device_id: loginDeviceId, name: 'Alice', pin: '1234', device_secret_identifier: loginDeviceSecret }))

    const reply = await onceMessage(ws)
    expect(reply.type).toBe('login_ok')
    expect(reply.token).toEqual(expect.any(String))
    expect(reply.userId).toBe(userId)
    expect(reply.role).toBe('admin')

    ws.close()
  })

  it('responds login_failed for a wrong pin, without closing the connection', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'login', device_id: loginDeviceId, name: 'Alice', pin: 'wrong', device_secret_identifier: loginDeviceSecret }))

    const reply = await onceMessage(ws)
    expect(reply.type).toBe('login_failed')
    expect(ws.readyState).toBe(WebSocket.OPEN)

    ws.close()
  })

  it('responds login_failed with lockout info after 5 failed attempts', async () => {
    const ws = connect()
    await onceOpen(ws)

    // Spaced comfortably past the per-connection login throttle (300ms) so
    // this test exercises the per-name lockout in attemptLogin, not the
    // throttle added below.
    for (let i = 0; i < 5; i++) {
      ws.send(JSON.stringify({ type: 'login', device_id: loginDeviceId, name: 'Alice', pin: 'wrong', device_secret_identifier: loginDeviceSecret }))
      await onceMessage(ws)
      // 310ms clears the 300ms per-connection login throttle so each
      // iteration reaches attemptLogin.
      // time-under-test: crossing-interval
      await sleepBecauseTimeIsUnderTest(310)
    }
    ws.send(JSON.stringify({ type: 'login', device_id: loginDeviceId, name: 'Alice', pin: '1234', device_secret_identifier: loginDeviceSecret }))
    const reply = await onceMessage(ws)
    expect(reply.type).toBe('login_failed')
    expect(reply.locked).toBe(true)
    expect(reply.retryAfterMs).toBeGreaterThan(0)

    ws.close()
  })

  // T26: un-skipped for real, by driving the clock instead of racing it.
  //
  // This was skipped for years as "timing-sensitive ... environmental". It was
  // not environmental. The throttle compared Date.now() at processing time
  // while each attemptLogin ran scryptSync (~67ms idle, far more when starved)
  // against a 300ms window — so how many of a burst got through was a direct
  // function of machine speed. A first attempt to fix it by polling failed
  // honestly, 6 replies against toBeLessThan(5), because polling repairs races
  // about WHEN something happened, not assertions about HOW MANY events fit in
  // a wall-clock window.
  //
  // With an injected clock the assertion becomes exact: not "fewer than five",
  // but "exactly one".
  it('drops every message of a burst except the first, and none of the dropped ones touch the lockout', async () => {
    // Frozen clock. Nothing advances it during the burst, so the throttle
    // window cannot elapse no matter how slow the machine is.
    let fakeNow = 1_000_000
    // Counting the calls is also the test's synchronisation: handleLogin calls
    // now() exactly once per message that clears the device-secret gate, so
    // 20 calls means all 20 have been processed. That is a real signal, not a
    // guess at a duration.
    let nowCalls = 0
    const THROTTLE_PORT = await getFreePort()
    const throttleServer = startSyncServer(db, {
      port: THROTTLE_PORT,
      now: () => { nowCalls += 1; return fakeNow },
    })

    try {
      const ws = new WebSocket(`ws://localhost:${THROTTLE_PORT}`)
      await onceOpen(ws)
      const replies = []
      ws.on('message', (data) => replies.push(JSON.parse(data.toString())))

      for (let i = 0; i < 20; i++) {
        ws.send(JSON.stringify({ type: 'login', device_id: loginDeviceId, name: 'Alice', pin: 'wrong', device_secret_identifier: loginDeviceSecret }))
      }

      // Both conditions matter and neither implies the other: nowCalls proves
      // the server has handled all 20, and the reply proves the one that got
      // through has finished its round trip. Only one message can pass a
      // frozen clock, so once both hold, nothing further can arrive.
      await waitFor(
        () => nowCalls === 20 && replies.length >= 1,
        { message: 'the server never processed all 20 messages and answered the first' }
      )

      // Exactly one reached attemptLogin. The other 19 were dropped before
      // touching the database at all.
      expect(replies).toHaveLength(1)
      expect(replies[0].type).toBe('login_failed')

      // And the 19 dropped ones never reached the per-name lockout counter:
      // 5 genuine wrong attempts would lock Alice out, so if the flood had
      // gotten through, the correct PIN below would come back locked.
      fakeNow += LOGIN_MIN_INTERVAL_MS
      ws.send(JSON.stringify({ type: 'login', device_id: loginDeviceId, name: 'Alice', pin: '1234', device_secret_identifier: loginDeviceSecret }))
      const reply = await onceMessage(ws)
      expect(reply.type).toBe('login_ok')

      ws.close()
    } finally {
      throttleServer.close()
    }
  })

  it('defaults to the real clock, so what ships is not the injected one', async () => {
    // The seam exists for the test above; this makes sure the test above is
    // not the only thing it is true of. A server started without `now` must
    // still throttle, using real elapsed time.
    const ws = connect()
    await onceOpen(ws)
    const replies = []
    ws.on('message', (data) => replies.push(JSON.parse(data.toString())))

    ws.send(JSON.stringify({ type: 'login', device_id: loginDeviceId, name: 'Alice', pin: 'wrong', device_secret_identifier: loginDeviceSecret }))
    await onceMessage(ws)
    // Immediately again, well inside the 300ms window on any machine.
    ws.send(JSON.stringify({ type: 'login', device_id: loginDeviceId, name: 'Alice', pin: 'wrong', device_secret_identifier: loginDeviceSecret }))

    // The second must be dropped. This is an absence assertion and so needs a
    // real wait; it is sound in the "too fast" direction — a slow machine makes
    // the second message arrive LATER, never sooner, and later only helps the
    // throttle. The only way this misreads is if the machine is so slow that
    // 300ms elapses between two back-to-back sends, at which point the send
    // itself outlasted the window it is testing.
    // The second login reply must never arrive within the throttle window.
    // time-under-test: proving-absence
    await sleepBecauseTimeIsUnderTest(200)
    expect(replies).toHaveLength(1)

    ws.close()
  })

  it('does not throttle a human-paced retry spaced beyond the throttle interval (round 2 fix)', async () => {
    const ws = connect()
    await onceOpen(ws)

    ws.send(JSON.stringify({ type: 'login', device_id: loginDeviceId, name: 'Alice', pin: 'wrong', device_secret_identifier: loginDeviceSecret }))
    const reply1 = await onceMessage(ws)
    expect(reply1.type).toBe('login_failed')

    // A real user retrying after seeing "wrong pin" comfortably clears the
    // 300ms throttle window; this attempt must not be dropped.
    // time-under-test: crossing-interval — 350ms clears the 300ms throttle.
    await sleepBecauseTimeIsUnderTest(350)
    ws.send(JSON.stringify({ type: 'login', device_id: loginDeviceId, name: 'Alice', pin: '1234', device_secret_identifier: loginDeviceSecret }))
    const reply2 = await onceMessage(ws)
    expect(reply2.type).toBe('login_ok')

    ws.close()
  })

  it('does not set ws.deviceId as a side effect of login alone (still requires authenticate)', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'login', device_id: loginDeviceId, name: 'Alice', pin: '1234', device_secret_identifier: loginDeviceSecret }))
    await onceMessage(ws)

    // A subsequent acquire_lock without ever sending `authenticate` must be
    // silently ignored, exactly like today's behavior for any message sent
    // before authenticate succeeds.
    ws.send(JSON.stringify({ type: 'acquire_lock', entity: 'x', entity_id: 'y', field: 'z' }))
    let gotReply = false
    ws.once('message', () => { gotReply = true })
    // An unauthenticated acquire_lock must never get a reply.
    // time-under-test: proving-absence
    await sleepBecauseTimeIsUnderTest(200)
    expect(gotReply).toBe(false)

    ws.close()
  })

  it('ignores a malformed login message (missing pin) without crashing the connection', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'login', device_id: loginDeviceId, name: 'Alice', device_secret_identifier: loginDeviceSecret }))

    // Send a well-formed, unrelated message afterward and confirm the
    // connection is still alive and responsive.
    ws.send(JSON.stringify({ type: 'login', device_id: loginDeviceId, name: 'Alice', pin: '1234', device_secret_identifier: loginDeviceSecret }))
    const reply = await onceMessage(ws)
    expect(reply.type).toBe('login_ok')

    ws.close()
  })
})

describe('WS authorize() gating (Phase 2 Task 3)', () => {
  // The IPC layer's authorize() gates (Task 2) only protect the renderer/
  // IPC path. A device connecting directly to this Host's WebSocket
  // listener with a staff token must be gated identically, or the WS
  // listener is a wide-open bypass of the IPC-layer checks.
  let staffToken, staffDeviceId

  beforeEach(async () => {
    staffDeviceId = randomUUID()
    insertAuthorizedDevice(db, staffDeviceId, 'Staff Device')
    const staffUser = await createUser(
      db,
      { camp_id: campId, name: 'Bob', pin: '5678', role: 'staff' },
      async ({ entity, entity_id, field, value }) => {
        const op = appendOp(db, {
          entity,
          entity_id,
          field,
          value,
          author_user_id: null,
          device_id: staffDeviceId,
          parent_op_id: null,
        })
        return { status: 'applied', op }
      }
    )
    staffToken = issueCampToken(db, staffUser.id, staffDeviceId)
  })

  it('denies a staff device submit_bulk_replace_op (admin-only action)', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token: staffToken, device_id: staffDeviceId }))

    ws.send(
      JSON.stringify({
        type: 'submit_bulk_replace_op',
        op: { entity: 'template_slots', scope_id: 'scope1', rows: [] },
      })
    )
    const reply = await onceMessage(ws)
    expect(reply.type).toBe('error')

    ws.close()
  })

  it('denies a staff device submit_op with DELETE_FIELD (admin-only delete)', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token: staffToken, device_id: staffDeviceId }))

    ws.send(
      JSON.stringify({
        type: 'submit_op',
        op: {
          entity: 'template_slots',
          entity_id: 's1',
          field: '__deleted__',
          value: null,
          parent_op_id: null,
        },
      })
    )
    const reply = await onceMessage(ws)
    expect(reply.type).toBe('error')

    ws.close()
  })

  it('allows a staff device an ordinary submit_op write', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token: staffToken, device_id: staffDeviceId }))

    ws.send(
      JSON.stringify({
        type: 'submit_op',
        op: {
          entity: 'template_slots',
          entity_id: 's1',
          field: 'activity_id',
          value: 'act1',
          parent_op_id: null,
        },
      })
    )
    const reply = await onceMessage(ws)
    expect(reply.type).toBe('op_applied')

    ws.close()
  })

  it('denies a staff device acquire_lock on an admin-only write action (camps.name)', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token: staffToken, device_id: staffDeviceId }))

    ws.send(
      JSON.stringify({
        type: 'acquire_lock',
        entity: 'camps',
        entity_id: campId,
        field: 'name',
      })
    )
    const reply = await onceMessage(ws)
    expect(reply.type).toBe('error')

    ws.close()
  })

  it('rejects submit_op/acquire_lock/submit_bulk_replace_op for a socket that never authenticated (no ws.token to authorize with)', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(
      JSON.stringify({
        type: 'submit_op',
        op: { entity: 'template_slots', entity_id: 's1', field: 'activity_id', value: 'x', parent_op_id: null },
      })
    )
    let gotReply = false
    ws.once('message', () => { gotReply = true })
    // An unauthenticated submit_op must never get a reply.
    // time-under-test: proving-absence
    await sleepBecauseTimeIsUnderTest(200)
    expect(gotReply).toBe(false)

    ws.close()
  })

  it('allows a staff device an ordinary acquire_lock (staff-permitted write action)', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token: staffToken, device_id: staffDeviceId }))

    ws.send(
      JSON.stringify({
        type: 'acquire_lock',
        entity: 'template_slots',
        entity_id: 's9',
        field: 'activity_id',
      })
    )
    const reply = await onceMessageOfType(ws, 'lock_result')
    expect(reply).toEqual({ type: 'lock_result', granted: true })

    ws.close()
  })

  it('allows an admin device submit_bulk_replace_op (admin-only action)', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))

    ws.send(
      JSON.stringify({
        type: 'submit_bulk_replace_op',
        op: { entity: 'template_slots', scope_id: 'scope-admin-ok', rows: [] },
      })
    )
    const reply = await onceMessageOfType(ws, 'op_applied')
    expect(reply.type).toBe('op_applied')

    ws.close()
  })

  // Design doc testing-plan item 2: exhaustive per-entity sweep on the WS
  // path, not a sampling — every entity in permissions.js's ENTITIES list
  // must accept an ordinary field write from a staff device via submit_op.
  it('allows a staff device an ordinary submit_op write for every entity in the permission matrix', async () => {
    // Imported from the real permission matrix (not hand-copied) so this
    // sweep can't silently degrade to a sample if a future entity is added
    // to permissions.js and this list isn't updated in lockstep.
    // Not every entity's PROJECTIONS.fields (electron/ops/projections.js)
    // includes a literal 'name' field — days_of_operation uses 'label' and
    // day_override_template_slots has no name-shaped field at all. Writing
    // an unregistered field throws inside appendOp, which the WS layer
    // turns into an 'error' reply, not 'op_applied' — false failure
    // unrelated to this sweep's actual purpose (proving the authorization
    // gate, not the projection field allowlist, doesn't regress staff
    // access).
    const WRITABLE_FIELD_BY_ENTITY = {
      groups: 'name',
      tiers: 'name',
      activities: 'name',
      cohorts: 'name',
      days_of_operation: 'label',
      time_blocks: 'name',
      anchor_activities: 'name',
      schedule_templates: 'name',
      day_override_templates: 'name',
      schedule_weeks: 'name',
      template_slots: 'activity_id',
      template_overlays: 'label',
      schedule_snapshots: 'name',
      day_override_template_slots: 'time_block_id',
      // Exclusion rows have no name-shaped field; 'week_id' is the field their
      // projection's ensureExists keys on (electron/ops/projections.js:205-226).
      week_activity_exclusions: 'week_id',
      week_group_exclusions: 'week_id',
      locations: 'name',
      // location_id, not week_id: week_id triggers ensureExists (INSERT with a
      // FK to schedule_weeks), and the sweep's 'V' is not a real week. Writing a
      // non-ensureExists field UPDATEs zero rows and still logs the op — same
      // trick template_slots uses with activity_id.
      week_location_exclusions: 'location_id',
      // T40 slice 1: same tricks as day_override_template_slots/template_slots
      // above — 'name' isn't special_day_time_blocks' parent-key field
      // (special_day_id), so ensureExists no-ops instead of FK-linking to a
      // nonexistent parent; special_day_slots' ensureExists needs all three of
      // special_day_id/group_id/time_block_id, so 'activity_id' alone no-ops.
      special_days: 'name',
      special_day_time_blocks: 'name',
      special_day_slots: 'activity_id',
      // T41 slice 1: elective_set_activities' ensureExists needs both
      // elective_set_id and activity_id, so 'activity_id' alone no-ops —
      // same trick as special_day_slots above.
      elective_sets: 'name',
      elective_set_activities: 'activity_id',
    }
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token: staffToken, device_id: staffDeviceId }))

    for (const entity of ENTITIES) {
      ws.send(
        JSON.stringify({
          type: 'submit_op',
          op: { entity, entity_id: `sweep-${entity}`, field: WRITABLE_FIELD_BY_ENTITY[entity], value: 'V', parent_op_id: null },
        })
      )
      const reply = await onceMessageOfType(ws, 'op_applied')
      expect(reply.type, `entity ${entity}`).toBe('op_applied')
    }

    ws.close()
  }, 15000)

  // Design doc testing-plan item 3, WS half of the load-bearing role-change
  // test — Task 3's Red Hat review specifically flagged that "role is
  // re-derived fresh per call, no caching on an open connection" was proven
  // by code trace but not pinned by a test. This reuses the SAME WebSocket
  // connection and the SAME already-issued token across a role flip; the
  // only thing that changes is the `users.role` row in the db.
  describe('role-change-takes-effect (WS path, same connection + same token reused)', () => {
    it('an admin device is denied submit_bulk_replace_op after being demoted to staff mid-connection, without reconnecting or re-authenticating', async () => {
      const ws = connect()
      await onceOpen(ws)
      ws.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))

      // Confirm the connection starts out genuinely admin-capable.
      ws.send(
        JSON.stringify({
          type: 'submit_bulk_replace_op',
          op: { entity: 'template_slots', scope_id: 'scope-before-demote', rows: [] },
        })
      )
      const firstReply = await onceMessageOfType(ws, 'op_applied')
      expect(firstReply.type).toBe('op_applied')

      // Simulate another admin demoting this user elsewhere — the open
      // socket/connection and its stored ws.token are untouched.
      db.prepare("UPDATE users SET role = 'staff' WHERE id = ?").run(userId)

      ws.send(
        JSON.stringify({
          type: 'submit_bulk_replace_op',
          op: { entity: 'template_slots', scope_id: 'scope-after-demote', rows: [] },
        })
      )
      const secondReply = await onceMessageOfType(ws, 'error')
      expect(secondReply.type).toBe('error')

      ws.close()
    })

    it('a staff device is denied then allowed submit_bulk_replace_op on the SAME connection after being promoted to admin mid-connection', async () => {
      const ws = connect()
      await onceOpen(ws)
      ws.send(JSON.stringify({ type: 'authenticate', token: staffToken, device_id: staffDeviceId }))

      ws.send(
        JSON.stringify({
          type: 'submit_bulk_replace_op',
          op: { entity: 'template_slots', scope_id: 'scope-before-promote', rows: [] },
        })
      )
      const firstReply = await onceMessageOfType(ws, 'error')
      expect(firstReply.type).toBe('error')

      // Another admin promotes this staff user — same open connection, same
      // ws.token, no fresh login/authenticate message.
      const staffUserId = db.prepare('SELECT id FROM users WHERE name = ?').get('Bob').id
      db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(staffUserId)

      ws.send(
        JSON.stringify({
          type: 'submit_bulk_replace_op',
          op: { entity: 'template_slots', scope_id: 'scope-after-promote', rows: [] },
        })
      )
      const secondReply = await onceMessageOfType(ws, 'op_applied')
      expect(secondReply.type).toBe('op_applied')

      ws.close()
    })
  })
})

describe('pairing_request WS message (sub-task 2)', () => {
  // Use a dedicated server port for these tests to avoid port-reuse conflicts
  // with the outer beforeEach/afterEach server on PORT.
  let PAIR_PORT
  let pairServer
  let onPairingRequestCb

  beforeEach(async () => {
    onPairingRequestCb = null
    PAIR_PORT = await getFreePort()
    pairServer = startSyncServer(db, {
      port: PAIR_PORT,
      onPairingRequest: (id, name) => { if (onPairingRequestCb) onPairingRequestCb(id, name) },
    })
  })

  afterEach(() => {
    pairServer.close()
  })

  function pairConnect() {
    return new WebSocket(`ws://localhost:${PAIR_PORT}`)
  }

  it('registers the device as pending and calls onPairingRequest', async () => {
    let notifiedDeviceId, notifiedDeviceName
    onPairingRequestCb = (id, name) => { notifiedDeviceId = id; notifiedDeviceName = name }

    const ws = pairConnect()
    await onceOpen(ws)
    const newDeviceId = randomUUID()
    ws.send(JSON.stringify({ type: 'pairing_request', device_id: newDeviceId, device_name: 'iPad Mini' }))

    await new Promise((r) => setTimeout(r, 100))

    const row = db.prepare('SELECT id, name, pairing_status FROM devices WHERE id = ?').get(newDeviceId)
    expect(row).toBeTruthy()
    expect(row.name).toBe('iPad Mini')
    expect(row.pairing_status).toBe('pending')
    expect(notifiedDeviceId).toBe(newDeviceId)
    expect(notifiedDeviceName).toBe('iPad Mini')

    ws.close()
  })

  it('closes the unauthenticated connection when device_id or device_name is missing', async () => {
    const ws = pairConnect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'pairing_request', device_id: randomUUID() })) // missing device_name

    // sendError on an unauthenticated socket closes the connection rather than
    // sending an error message (see syncServer.js sendError)
    await onceClose(ws)
    expect(ws.readyState).not.toBe(WebSocket.OPEN)
  })

  it('sendPairingApproved delivers pairing_approved to the pending WS', async () => {
    const ws = pairConnect()
    await onceOpen(ws)
    const newDeviceId = randomUUID()
    ws.send(JSON.stringify({ type: 'pairing_request', device_id: newDeviceId, device_name: 'Tablet' }))
    await new Promise((r) => setTimeout(r, 100))

    const secret = 'abc123secret'
    const sent = pairServer.sendPairingApproved(newDeviceId, secret)
    expect(sent).toBe(true)

    const msg = await onceMessage(ws)
    expect(msg.type).toBe('pairing_approved')
    expect(msg.device_secret_identifier).toBe(secret)

    ws.close()
  })

  it('sendPairingDenied delivers pairing_denied to the pending WS', async () => {
    const ws = pairConnect()
    await onceOpen(ws)
    const newDeviceId = randomUUID()
    ws.send(JSON.stringify({ type: 'pairing_request', device_id: newDeviceId, device_name: 'Phone' }))
    await new Promise((r) => setTimeout(r, 100))

    const sent = pairServer.sendPairingDenied(newDeviceId)
    expect(sent).toBe(true)

    const msg = await onceMessage(ws)
    expect(msg.type).toBe('pairing_denied')

    ws.close()
  })
})

describe('handleLogin sub-task 4: device_secret_identifier gate', () => {
  it('rejects login for a device with no authorized_at', async () => {
    const pendingDeviceId = randomUUID()
    db.prepare("INSERT INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run(pendingDeviceId, 'Pending Device')

    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({
      type: 'login',
      device_id: pendingDeviceId,
      name: 'Alice',
      pin: '1234',
      device_secret_identifier: 'some-secret',
    }))

    const reply = await onceMessage(ws)
    expect(reply.type).toBe('login_failed')
    // Reason field intentionally absent — opaque response prevents device-existence oracle
    // (Security review: collapse distinct rejection paths to the same response shape)

    ws.close()
  })

  it('rejects login when device_secret_identifier does not match', async () => {
    const anotherDeviceId = randomUUID()
    const correctSecret = 'correct-secret-abc'
    db.prepare(
      "INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status) VALUES (?, ?, ?, ?, 'authorized')"
    ).run(anotherDeviceId, 'Trusted Device', new Date().toISOString(), correctSecret)

    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({
      type: 'login',
      device_id: anotherDeviceId,
      name: 'Alice',
      pin: '1234',
      device_secret_identifier: 'wrong-secret',
    }))

    const reply = await onceMessage(ws)
    expect(reply.type).toBe('login_failed')
    // Reason field intentionally absent — opaque response prevents device-secret oracle

    ws.close()
  })
})

describe('renew_token WS message (sub-task 3)', () => {
  it('responds with token_renewed and a fresh token for a valid authenticated session', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    // deviceId has last_synced_at set so no full_sync is sent; just wait a tick
    await new Promise((r) => setTimeout(r, 100))

    ws.send(JSON.stringify({ type: 'renew_token', token }))
    const reply = await onceMessageOfType(ws, 'token_renewed')
    expect(reply.type).toBe('token_renewed')
    expect(reply.token).toEqual(expect.any(String))

    ws.close()
  })

  it('responds with token_renewal_failed when the token is invalid', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    await new Promise((r) => setTimeout(r, 100))

    ws.send(JSON.stringify({ type: 'renew_token', token: 'not-a-real-token' }))
    const reply = await onceMessageOfType(ws, 'token_renewal_failed')
    expect(reply.type).toBe('token_renewal_failed')
    expect(reply.reason).toBe('invalid_token')

    ws.close()
  })

  it('responds with token_renewal_failed and closes the connection when the device is revoked', async () => {
    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    await new Promise((r) => setTimeout(r, 100))

    // Revoke the device mid-session
    db.prepare("UPDATE devices SET revoked_at = ?, revocation_reason = 'lost' WHERE id = ?")
      .run(new Date().toISOString(), deviceId)

    ws.send(JSON.stringify({ type: 'renew_token', token }))
    const reply = await onceMessageOfType(ws, 'token_renewal_failed')
    expect(reply.reason).toBe('device_revoked')

    // Server should proactively close the connection
    await onceClose(ws)

    ws.close()
  })

  // C3 pins renew_token's not-found reason as 'device_not_found' (was the
  // old ternary's 'device_not_authorized' fallback pre-C3 — see
  // deviceTrust.js). The state is practically unreachable in production
  // (operations.device_id's FK prevents deleting a devices row for any
  // device that has synced, and this specific device has NOT synced any op,
  // which is exactly what makes the deletion below legal here), and the
  // client discards token_renewal_failed.reason anyway — but it is worth
  // pinning so a future change to the label is visible in a test diff.
  it('responds with token_renewal_failed reason device_not_found when the device row no longer exists (C3 label pin)', async () => {
    const targetDeviceId = randomUUID()
    insertAuthorizedDevice(db, targetDeviceId, 'Soon To Be Deleted')
    const targetToken = issueCampToken(db, userId, targetDeviceId)

    const ws = connect()
    await onceOpen(ws)
    ws.send(JSON.stringify({ type: 'authenticate', token: targetToken, device_id: targetDeviceId }))
    // An authenticated-only probe (acquire_lock), sent right after
    // authenticate and awaited before the DB mutation below, is the
    // deterministic sync point: handleAuthenticate is not itself awaited by
    // its caller, so a fixed sleep can't prove it actually ran — but
    // acquire_lock is gated on `ws.deviceId` (handleAuthenticate sets it
    // synchronously, see syncServer.js), so a `lock_result` reply is only
    // possible once authenticate has genuinely completed. Without this gate,
    // the DB mutation (pure in-process JS) can race ahead of the real
    // network round-trip authenticate needs and delete the devices row
    // BEFORE the server even processes `authenticate` — making
    // handleAuthenticate's own self-registration re-create it (INSERT OR
    // IGNORE), which defeats the "row genuinely doesn't exist" scenario this
    // test means to exercise at renew_token.
    ws.send(
      JSON.stringify({ type: 'acquire_lock', entity: 'template_slots', entity_id: 'renew-token-sync-probe', field: 'activity_id' })
    )
    await onceMessageOfType(ws, 'lock_result')

    // Legal only because targetDeviceId has never authored an operation —
    // no operations row's FK references it.
    db.prepare('DELETE FROM devices WHERE id = ?').run(targetDeviceId)

    ws.send(JSON.stringify({ type: 'renew_token', token: targetToken }))
    const reply = await onceMessageOfType(ws, 'token_renewal_failed')
    expect(reply.reason).toBe('device_not_found')

    ws.close()
  })
})
