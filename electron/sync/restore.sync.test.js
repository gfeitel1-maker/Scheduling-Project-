// @vitest-environment node
//
// Integration coverage for restore across two devices.
// docs/adr/2026-07-30-restore-deleted-records-from-the-op-log.md
//
// Mandatory for this task class, and it is the only place four of the ADR's
// completion-evidence items can actually be shown:
//   - a restore requested on a CLIENT produces the same result as on the Host
//   - with the Host unreachable it QUEUES, survives a restart, and completes
//     when the Host returns
//   - draining twice produces one record, not two
//   - a Client never restores from its own history
//
// Real Host (startSyncServer), real Client (createSyncClient), real
// WebSocket. Two separate SQLite files, as two devices genuinely have.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { issueCampToken, ensureHostSigningKey } from '../auth/localAuth.js'
import { appendOp, DELETE_FIELD } from '../ops/operations.js'
import { startSyncServer } from './syncServer.js'
import { createSyncClient } from './syncClient.js'
import { listPendingRestores } from './pendingRestores.js'

const PORT = 8341

let hostDb, clientDb, server, client
let campId, adminId, staffId, deviceId, adminToken, staffToken

const files = []

function newDb(tag) {
  const file = path.join(os.tmpdir(), `shoresh-restore-sync-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

function hostWrite(entity, entity_id, field, value, author = adminId) {
  return appendOp(hostDb, { entity, entity_id, field, value, author_user_id: author, device_id: deviceId })
}

function seedGroupOnHost(id, name) {
  hostWrite('groups', id, 'camp_id', campId)
  hostWrite('groups', id, 'name', name)
  hostWrite('groups', id, 'availability', 'all')
}

async function waitFor(predicate, timeoutMs = 4000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

function connectClient() {
  return createSyncClient(clientDb, {
    device_id: deviceId,
    author_user_id: adminId,
    serverUrl: `ws://127.0.0.1:${PORT}`,
    token: adminToken,
    submitTimeoutMs: 1500,
    lockTimeoutMs: 1500,
  })
}

beforeEach(async () => {
  hostDb = newDb('host')
  clientDb = newDb('client')

  campId = randomUUID()
  for (const db of [hostDb, clientDb]) {
    db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'e'.repeat(64))
  }
  const hostKey = ensureHostSigningKey(hostDb)
  for (const db of [hostDb, clientDb]) {
    db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, campId)
  }

  deviceId = randomUUID()
  // last_synced_seq stays NULL: this models a Client that has already paired
  // (last_synced_at set, so no full_sync) and whose watermark is baselined on
  // its first authenticate WITHOUT replaying prior history — which is the
  // real first-pairing shape, and the exact reason restore has to run on the
  // Host rather than on whichever device asked.
  hostDb.prepare(
    `INSERT INTO devices (id, name, last_synced_at, authorized_at, device_secret_identifier, pairing_status)
     VALUES (?, ?, ?, ?, ?, 'authorized')`
  ).run(deviceId, 'Lakeside iPad', new Date().toISOString(), new Date().toISOString(), randomBytes(32).toString('hex'))
  clientDb.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Lakeside iPad')

  adminId = randomUUID()
  staffId = randomUUID()
  for (const db of [hostDb, clientDb]) {
    db.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
      .run(adminId, campId, 'Ruth', 'x', 'x', 'admin')
    db.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)')
      .run(staffId, campId, 'Sam', 'x', 'x', 'staff')
  }

  adminToken = issueCampToken(hostDb, adminId, deviceId)
  staffToken = issueCampToken(hostDb, staffId, deviceId)

  server = startSyncServer(hostDb, { port: PORT })
})

afterEach(async () => {
  try { client?.close() } catch { /* already closed */ }
  client = null
  try { server?.close() } catch { /* already closed */ }
  try { hostDb.close() } catch { /* already closed */ }
  try { clientDb.close() } catch { /* already closed */ }
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
  await new Promise((r) => setTimeout(r, 50))
})

describe('restore requested on a Client executes on the Host and replicates back', () => {
  it('rebuilds the record on the Host and lands it on the Client', async () => {
    seedGroupOnHost('g1', 'Aleph')
    const before = hostDb.prepare('SELECT * FROM groups WHERE id = ?').get('g1')
    hostWrite('groups', 'g1', DELETE_FIELD, 1)

    client = connectClient()
    await client.waitUntilConnected()

    const result = await client.requestRestore({ entity: 'groups', entity_id: 'g1', requested_by: adminId })

    expect(result.ok).toBe(true)
    expect(result.restored_fields).toBe(3)
    expect(hostDb.prepare('SELECT * FROM groups WHERE id = ?').get('g1')).toEqual(before)

    // Replicated back over the same broadcast every other op uses.
    expect(await waitFor(() => !!clientDb.prepare('SELECT 1 FROM groups WHERE id = ?').get('g1'))).toBe(true)
    expect(clientDb.prepare('SELECT * FROM groups WHERE id = ?').get('g1')).toEqual(before)
  })

  it('never restores from the Client\'s own history — a Client that lacks it gets the Host\'s answer', async () => {
    // The exact shape of a first-pairing Client: it holds the materialized
    // row but not one op of the history that built it.
    seedGroupOnHost('g1', 'Aleph')
    clientDb.prepare('INSERT INTO groups (id, camp_id, name, availability) VALUES (?, ?, ?, ?)')
      .run('g1', campId, 'Aleph', 'all')
    hostWrite('groups', 'g1', DELETE_FIELD, 1)
    clientDb.prepare('DELETE FROM groups WHERE id = ?').run('g1')
    expect(clientDb.prepare('SELECT COUNT(*) c FROM operations').get().c).toBe(0)

    client = connectClient()
    await client.waitUntilConnected()

    const result = await client.requestRestore({ entity: 'groups', entity_id: 'g1', requested_by: adminId })

    expect(result.ok).toBe(true)
    expect(await waitFor(() => !!clientDb.prepare('SELECT 1 FROM groups WHERE id = ?').get('g1'))).toBe(true)
    expect(clientDb.prepare('SELECT name FROM groups WHERE id = ?').get('g1').name).toBe('Aleph')
  })

  it('refuses users over the wire, so the allowlist is not a renderer-side courtesy', async () => {
    hostWrite('users', 'u-gone', 'camp_id', campId)
    hostWrite('users', 'u-gone', 'name', 'Removed')
    hostWrite('users', 'u-gone', 'pin_hash', 'secret-hash')
    hostWrite('users', 'u-gone', 'pin_salt', 'secret-salt')
    hostWrite('users', 'u-gone', DELETE_FIELD, 1)
    const opsBefore = hostDb.prepare('SELECT COUNT(*) c FROM operations').get().c

    client = connectClient()
    await client.waitUntilConnected()

    const result = await client.requestRestore({ entity: 'users', entity_id: 'u-gone', requested_by: adminId })

    expect(result).toEqual({ error: 'not-restorable' })
    expect(hostDb.prepare('SELECT COUNT(*) c FROM operations').get().c).toBe(opsBefore)
    expect(hostDb.prepare('SELECT COUNT(*) c FROM users WHERE id = ?').get('u-gone').c).toBe(0)
  })

  it('refuses a staff caller, and writes nothing', async () => {
    seedGroupOnHost('g1', 'Aleph')
    hostWrite('groups', 'g1', DELETE_FIELD, 1)
    const opsBefore = hostDb.prepare('SELECT COUNT(*) c FROM operations').get().c

    client = createSyncClient(clientDb, {
      device_id: deviceId,
      author_user_id: staffId,
      serverUrl: `ws://127.0.0.1:${PORT}`,
      token: staffToken,
      submitTimeoutMs: 1500,
    })
    await client.waitUntilConnected()

    const result = await client.requestRestore({ entity: 'groups', entity_id: 'g1', requested_by: staffId })

    expect(result).toEqual({ error: 'forbidden' })
    expect(hostDb.prepare('SELECT COUNT(*) c FROM operations').get().c).toBe(opsBefore)
    expect(hostDb.prepare('SELECT COUNT(*) c FROM groups WHERE id = ?').get('g1').c).toBe(0)
  })

  // T7 (docs/adr/2026-08-15-locations-concurrent-create-collision.md addendum,
  // Finding A): a restore whose last-known name now belongs to a different,
  // live row must fail with a structured, terminal error over the wire — not
  // an unhandled SQLITE_CONSTRAINT_UNIQUE inside restoreEntity's transaction.
  //
  // T12 (Red Hat re-review, MEDIUM): the crash fix alone left the
  // director-facing message misleading — TrashScreen's fallback copy implied
  // a transient failure ("try again in a moment") for a refusal that is
  // actually deterministic and permanent. Closing that required
  // requestRestore's interactive path to ALSO forward `field`/`existing`
  // (previously dropped by `if (reply.error) return { error: reply.error }`,
  // proven to cross only the WIRE by syncServer.test.js's raw-message test,
  // not all the way to this caller) so TrashScreen can name the colliding
  // record instead of falling back to its generic "try again" text.
  it('refuses a colliding restore, resolving requestRestore with a terminal unique_field error that names the collision', async () => {
    hostWrite('locations', 'loc-deleted', 'camp_id', campId)
    hostWrite('locations', 'loc-deleted', 'name', 'Pool')
    hostWrite('locations', 'loc-deleted', 'capacity', '3')
    hostWrite('locations', 'loc-deleted', DELETE_FIELD, 1)
    // A different, live row now holds the same name.
    hostWrite('locations', 'loc-live', 'camp_id', campId)
    hostWrite('locations', 'loc-live', 'name', 'Pool')
    hostWrite('locations', 'loc-live', 'capacity', '5')
    const opsBefore = hostDb.prepare('SELECT COUNT(*) c FROM operations').get().c

    client = connectClient()
    await client.waitUntilConnected()

    const result = await client.requestRestore({ entity: 'locations', entity_id: 'loc-deleted', requested_by: adminId })

    expect(result.error).toBe('unique_field')
    expect(result.field).toBe('name')
    expect(result.existing).toMatchObject({ name: 'Pool' })
    expect(hostDb.prepare('SELECT COUNT(*) c FROM operations').get().c).toBe(opsBefore)
    expect(hostDb.prepare('SELECT * FROM locations WHERE id = ?').get('loc-deleted')).toBeUndefined()
  })
})

describe('with the Host unreachable, the request queues and survives a restart', () => {
  it('records the intent durably instead of failing, and reports it as waiting', async () => {
    seedGroupOnHost('g1', 'Aleph')
    hostWrite('groups', 'g1', DELETE_FIELD, 1)
    server.close()
    await new Promise((r) => setTimeout(r, 50))

    client = connectClient()
    const result = await client.requestRestore({ entity: 'groups', entity_id: 'g1', requested_by: adminId })

    expect(result).toEqual({ queued: true })
    // Durable, not in-memory: read back through a plain query on the file.
    expect(listPendingRestores(clientDb)).toMatchObject([
      { entity: 'groups', entity_id: 'g1', requested_by: adminId, last_error: null },
    ])
  })

  it('collapses three impatient presses into one intent', async () => {
    seedGroupOnHost('g1', 'Aleph')
    hostWrite('groups', 'g1', DELETE_FIELD, 1)
    server.close()
    await new Promise((r) => setTimeout(r, 50))

    client = connectClient()
    await client.requestRestore({ entity: 'groups', entity_id: 'g1', requested_by: adminId })
    await client.requestRestore({ entity: 'groups', entity_id: 'g1', requested_by: adminId })
    await client.requestRestore({ entity: 'groups', entity_id: 'g1', requested_by: adminId })

    expect(listPendingRestores(clientDb)).toHaveLength(1)
  })

  it('completes when the Host returns, after the app has been restarted', async () => {
    seedGroupOnHost('g1', 'Aleph')
    const before = hostDb.prepare('SELECT * FROM groups WHERE id = ?').get('g1')
    hostWrite('groups', 'g1', DELETE_FIELD, 1)
    server.close()
    await new Promise((r) => setTimeout(r, 50))

    // Press Restore with nothing to talk to.
    client = connectClient()
    expect(await client.requestRestore({ entity: 'groups', entity_id: 'g1', requested_by: adminId }))
      .toEqual({ queued: true })

    // Quit the app: this syncClient and its in-memory state are gone.
    client.close()
    client = null

    // The Host comes back, then the app is reopened — a brand-new syncClient
    // reading the same file. Nothing carries over except the table.
    server = startSyncServer(hostDb, { port: PORT })
    client = connectClient()

    expect(await waitFor(() => !!hostDb.prepare('SELECT 1 FROM groups WHERE id = ?').get('g1'))).toBe(true)
    expect(hostDb.prepare('SELECT * FROM groups WHERE id = ?').get('g1')).toEqual(before)
    expect(await waitFor(() => listPendingRestores(clientDb).length === 0)).toBe(true)
  })
})

describe('draining is idempotent', () => {
  it('draining twice produces one record, and the second pass emits no ops', async () => {
    seedGroupOnHost('g1', 'Aleph')
    hostWrite('groups', 'g1', DELETE_FIELD, 1)
    server.close()
    await new Promise((r) => setTimeout(r, 50))

    client = connectClient()
    await client.requestRestore({ entity: 'groups', entity_id: 'g1', requested_by: adminId })
    client.close()

    server = startSyncServer(hostDb, { port: PORT })
    client = connectClient()
    expect(await waitFor(() => listPendingRestores(clientDb).length === 0)).toBe(true)
    const opsAfterFirstDrain = hostDb.prepare('SELECT COUNT(*) c FROM operations').get().c

    await client.drainPendingRestores()

    expect(hostDb.prepare('SELECT COUNT(*) c FROM groups WHERE id = ?').get('g1').c).toBe(1)
    expect(hostDb.prepare('SELECT COUNT(*) c FROM operations').get().c).toBe(opsAfterFirstDrain)
  })

  it('treats a record another device already restored as done, not as an error', async () => {
    seedGroupOnHost('g1', 'Aleph')
    hostWrite('groups', 'g1', DELETE_FIELD, 1)
    clientDb.prepare(
      `INSERT INTO pending_restores (pending_id, entity, entity_id, requested_by, requested_at)
       VALUES ('p1', 'groups', 'g1', ?, ?)`
    ).run(adminId, new Date().toISOString())
    // Another device got there first; the row is already back on this Client.
    clientDb.prepare('INSERT INTO groups (id, camp_id, name) VALUES (?, ?, ?)').run('g1', campId, 'Aleph')

    client = connectClient()
    await client.waitUntilConnected()
    await client.drainPendingRestores()

    expect(listPendingRestores(clientDb)).toEqual([])
    expect(clientDb.prepare('SELECT COUNT(*) c FROM groups').get().c).toBe(1)
  })
})

describe('a queued restore that can no longer succeed fails visibly', () => {
  it('keeps the row and records why, rather than letting it disappear', async () => {
    // A queued request whose target the Host has no history for — the
    // 'no-history' terminal refusal.
    clientDb.prepare(
      `INSERT INTO pending_restores (pending_id, entity, entity_id, requested_by, requested_at)
       VALUES ('p1', 'groups', 'ghost', ?, ?)`
    ).run(adminId, new Date().toISOString())
    hostWrite('groups', 'ghost', DELETE_FIELD, 1)

    client = connectClient()
    await client.waitUntilConnected()
    await client.drainPendingRestores()

    expect(listPendingRestores(clientDb)).toMatchObject([
      { entity: 'groups', entity_id: 'ghost', last_error: 'no-history' },
    ])
  })

  it('does not send a request for an entity that is no longer restorable', async () => {
    clientDb.prepare(
      `INSERT INTO pending_restores (pending_id, entity, entity_id, requested_by, requested_at)
       VALUES ('p1', 'schedule_templates', 't1', ?, ?)`
    ).run(adminId, new Date().toISOString())

    client = connectClient()
    await client.waitUntilConnected()
    await client.drainPendingRestores()

    expect(listPendingRestores(clientDb)).toMatchObject([
      { entity: 'schedule_templates', entity_id: 't1', last_error: 'not-restorable' },
    ])
  })
})
