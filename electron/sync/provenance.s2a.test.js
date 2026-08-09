// @vitest-environment node
// S2a — provenance over the wire: Security V1 (a submitted op can never inject
// 'import') and replication (an already-committed op's source is preserved).
// docs/adr/2026-08-08-s2a-field-provenance-and-hand-edit-protection.md §2, §4.

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
import { waitFor } from '../../test/helpers/waitFor.js'

const PORT = 8231

let hostDb, hostFile, clientDb, clientFile, server, campId, userId, deviceId, token

function insertAuthorizedHostDevice(db, id, name) {
  db.prepare(
    `INSERT INTO devices (id, name, last_synced_at, authorized_at, device_secret_identifier, pairing_status)
     VALUES (?, ?, ?, ?, ?, 'authorized')`
  ).run(id, name, new Date().toISOString(), new Date().toISOString(), randomBytes(32).toString('hex'))
}

beforeEach(async () => {
  hostFile = path.join(os.tmpdir(), `shoresh-s2a-host-${Date.now()}-${Math.random()}.sqlite`)
  hostDb = openLocalDb(hostFile)
  clientFile = path.join(os.tmpdir(), `shoresh-s2a-client-${Date.now()}-${Math.random()}.sqlite`)
  clientDb = openLocalDb(clientFile)

  campId = randomUUID()
  hostDb.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'c'.repeat(64))
  clientDb.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'c'.repeat(64))

  const hostKey = ensureHostSigningKey(hostDb)
  hostDb.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, campId)
  clientDb.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, campId)

  deviceId = randomUUID()
  insertAuthorizedHostDevice(hostDb, deviceId, 'Device A')
  clientDb.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Device A')

  const user = await createUser(
    hostDb,
    { camp_id: campId, name: 'Alice', pin: '1234', role: 'admin' },
    async ({ entity, entity_id, field, value }) => {
      const op = appendOp(hostDb, { entity, entity_id, field, value, author_user_id: null, device_id: deviceId, parent_op_id: null })
      return { status: 'applied', op }
    }
  )
  userId = user.id
  clientDb.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, campId, 'Alice', 'x', 'x', 'admin')

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

function connect() {
  return new WebSocket(`ws://localhost:${PORT}`)
}
function onceOpen(ws) {
  return new Promise((resolve) => ws.once('open', resolve))
}

describe('Security V1 (evidence #4, CRITICAL)', () => {
  it("a submit_op forging source:'import' is stored as 'human', never 'import'", async () => {
    const ws = connect()
    await onceOpen(ws)
    // Messages on one connection are processed in order server-side, and
    // handleAuthenticate is synchronous — submit_op is handled after the
    // socket is authenticated with no need for a timed wait.
    ws.send(JSON.stringify({ type: 'authenticate', token, device_id: deviceId }))
    ws.send(JSON.stringify({
      type: 'submit_op',
      op: {
        entity: 'template_slots',
        entity_id: 'forge-1',
        field: 'activity_id',
        value: 'swim',
        author_user_id: userId,
        parent_op_id: null,
        source: 'import', // the forgery attempt
      },
    }))

    await waitFor(() => hostDb.prepare('SELECT 1 FROM operations WHERE entity_id = ?').get('forge-1'),
      { message: 'forged op stored' })

    const row = hostDb.prepare('SELECT source FROM operations WHERE entity_id = ?').get('forge-1')
    expect(row.source).toBe('human')
    expect(row.source).not.toBe('import')
    ws.close()
  })
})

describe('replication preserves stored source (evidence #5)', () => {
  it("a client-submitted write is stored 'human' on both host and client", async () => {
    const client = createSyncClient(clientDb, {
      device_id: deviceId, author_user_id: userId, serverUrl: `ws://localhost:${PORT}`, token,
    })
    await client.waitUntilConnected()
    const result = await client.write({ entity: 'template_slots', entity_id: 'h1', field: 'activity_id', value: 'kayak' })
    expect(result.status).toBe('applied')

    expect(hostDb.prepare('SELECT source FROM operations WHERE entity_id = ?').get('h1').source).toBe('human')
    await waitFor(() => clientDb.prepare('SELECT 1 FROM operations WHERE entity_id = ?').get('h1'),
      { message: 'client stored op' })
    expect(clientDb.prepare('SELECT source FROM operations WHERE entity_id = ?').get('h1').source).toBe('human')
    client.close()
  })

  it("an 'import' op committed host-side replicates to the client as 'import' (applyRemoteOp preserves it)", async () => {
    // Establish the connecting device's watermark baseline at the current max,
    // so ops written AFTER this are delivered as catch-up op_applied messages
    // (the same path a host-local commitPlan import reaches a client through).
    const base = hostDb.prepare('SELECT MAX(seq) m FROM operations').get().m ?? 0
    hostDb.prepare('UPDATE devices SET last_synced_seq = ? WHERE id = ?').run(base, deviceId)

    // Simulate a host-local commitPlan import write.
    const gid = randomUUID()
    appendOp(hostDb, { entity: 'groups', entity_id: gid, field: 'camp_id', value: campId, device_id: deviceId, source: 'import' })
    appendOp(hostDb, { entity: 'groups', entity_id: gid, field: 'name', value: 'Imported Bunk', device_id: deviceId, source: 'import' })

    const client = createSyncClient(clientDb, {
      device_id: deviceId, author_user_id: userId, serverUrl: `ws://localhost:${PORT}`, token,
    })
    await client.waitUntilConnected()

    await waitFor(() => clientDb.prepare('SELECT 1 FROM operations WHERE entity_id = ? AND field = ?').get(gid, 'name'),
      { message: 'client received catch-up import op' })

    const nameOp = clientDb.prepare('SELECT source FROM operations WHERE entity_id = ? AND field = ?').get(gid, 'name')
    expect(nameOp.source).toBe('import')
    const campOp = clientDb.prepare('SELECT source FROM operations WHERE entity_id = ? AND field = ?').get(gid, 'camp_id')
    expect(campOp.source).toBe('import')
    client.close()
  })
})
