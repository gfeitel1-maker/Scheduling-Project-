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
  const user = createUser(db, { camp_id: campId, name: 'Alice', pin: '1234', role: 'admin' })
  userId = user.id

  deviceId = randomUUID()
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Device A')

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
