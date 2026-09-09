// @vitest-environment node
//
// The device-local write path, tested directly rather than through the
// WebSocket client that currently delegates to it.
//
// This file exists because the module OUTLIVES its current caller. Stage 6c
// deletes syncClient.js; the 73 tests in syncClient.test.js that presently
// exercise this code through the `!serverUrl` branch go with it. What is pinned
// here is what must still be true afterwards, when this is simply how every
// device writes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { createLocalWriteClient } from './localWriteClient.js'

let db
let dbFile
let campId
let deviceId
let userId

beforeEach(() => {
  dbFile = path.join(os.tmpdir(), `shoresh-lwc-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(dbFile)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Test Camp', 'c'.repeat(64))
  deviceId = randomUUID()
  db.prepare(
    `INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status)
     VALUES (?, ?, ?, ?, 'authorized')`
  ).run(deviceId, 'This device', new Date().toISOString(), 'd'.repeat(64))
  userId = randomUUID()
  db.prepare(
    `INSERT INTO users (id, camp_id, name, role, pin_hash, pin_salt)
     VALUES (?, ?, ?, 'admin', ?, ?)`
  ).run(userId, campId, 'Dana', 'h'.repeat(64), 's'.repeat(32))
})

afterEach(() => {
  try { db?.close() } catch { /* already closed */ }
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    try { fs.rmSync(f, { force: true }) } catch { /* best effort */ }
  }
})

describe('createLocalWriteClient', () => {
  it('applies a write to this device immediately, with no transport involved', async () => {
    const client = createLocalWriteClient(db, { device_id: deviceId, author_user_id: userId })

    const result = await client.write({
      entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swimming',
    })

    // 'applied', never 'queued'. A local write is never in flight, so there is
    // no state between asking and done — the distinction the op-log transport
    // needed does not exist here.
    expect(result.status).toBe('applied')
    const row = db.prepare('SELECT name FROM activities WHERE id = ?').get('act-1')
    expect(row?.name).toBe('Swimming')
  })

  it('records the op against the acting user, not the construction-time fallback', async () => {
    // T22 regression. The per-call author used to be dropped in favour of the
    // closure value — null, fixed before anyone had logged in — so every op
    // recorded no author and Trash and record history said "Unknown" for
    // almost everything. Pinned because the failure is invisible at the write
    // site: the write succeeds, and only the history is wrong.
    const client = createLocalWriteClient(db, { device_id: deviceId, author_user_id: null })

    await client.write({
      entity: 'activities', entity_id: 'act-2', field: 'name', value: 'Archery', author_user_id: userId,
    })

    const op = db.prepare(
      'SELECT author_user_id FROM operations WHERE entity_id = ? ORDER BY seq DESC LIMIT 1'
    ).get('act-2')
    expect(op.author_user_id).toBe(userId)
  })

  it('falls back to the construction-time author when a caller genuinely has none', async () => {
    // Bootstrap and pairing are honestly unattributed — the fallback is not a
    // bug, it is the other half of the rule above.
    const client = createLocalWriteClient(db, { device_id: deviceId, author_user_id: userId })

    await client.write({ entity: 'activities', entity_id: 'act-3', field: 'name', value: 'Canoeing' })

    const op = db.prepare(
      'SELECT author_user_id FROM operations WHERE entity_id = ? ORDER BY seq DESC LIMIT 1'
    ).get('act-3')
    expect(op.author_user_id).toBe(userId)
  })

  it('stamps the writing device on the op', async () => {
    // The history ledger's peer-to-device mapping depends on this being right;
    // see docs/work/evidence/2026-09-08-retired-ws-scenarios.md (scenario 24).
    const client = createLocalWriteClient(db, { device_id: deviceId, author_user_id: userId })

    await client.write({ entity: 'activities', entity_id: 'act-4', field: 'name', value: 'Pottery' })

    const op = db.prepare(
      'SELECT device_id FROM operations WHERE entity_id = ? ORDER BY seq DESC LIMIT 1'
    ).get('act-4')
    expect(op.device_id).toBe(deviceId)
  })

  it('defaults to human provenance so a hand edit survives re-import', async () => {
    // S2a. NULL would also decode to human, so the default is about intent
    // being legible in the row rather than inferred at read time.
    const client = createLocalWriteClient(db, { device_id: deviceId, author_user_id: userId })

    await client.write({ entity: 'activities', entity_id: 'act-5', field: 'name', value: 'Drama' })

    const op = db.prepare(
      'SELECT source FROM operations WHERE entity_id = ? ORDER BY seq DESC LIMIT 1'
    ).get('act-5')
    expect(op.source).toBe('human')
  })

  it('rejects a unique-field collision cleanly instead of throwing a raw SQLite error', async () => {
    // D2/D3 (docs/adr/2026-08-15-locations-concurrent-create-collision.md).
    // This is the one rejection that survives the transport: it is decided by
    // THIS device against its own data, so it does not depend on a Host.
    const client = createLocalWriteClient(db, { device_id: deviceId, author_user_id: userId })
    await client.write({ entity: 'locations', entity_id: 'loc-1', field: 'name', value: 'Lakeside' })

    const rejected = []
    client.onOpRejected((msg) => rejected.push(msg))
    const result = await client.write({
      entity: 'locations', entity_id: 'loc-2', field: 'name', value: 'Lakeside',
    })

    expect(result.status).toBe('rejected')
    expect(result.reason).toBe('unique_field')
    expect(result.existing.id).toBe('loc-1')
    // The listener fires too: a rejection with no live caller waiting (D4)
    // would otherwise reach the director through nothing at all.
    expect(rejected).toHaveLength(1)
    // And nothing was written.
    expect(db.prepare('SELECT COUNT(*) AS c FROM locations').get().c).toBe(1)
  })

  it('notifies op-applied listeners with the op that was written', async () => {
    const client = createLocalWriteClient(db, { device_id: deviceId, author_user_id: userId })
    const applied = []
    client.onOpApplied((op) => applied.push(op))

    await client.write({ entity: 'activities', entity_id: 'act-6', field: 'name', value: 'Hiking' })

    expect(applied).toHaveLength(1)
    expect(applied[0].entity_id).toBe('act-6')
  })

  it('calls onOpWritten for each op so a caller can do its own fan-out', async () => {
    // The op-log Host used this to broadcast its own edit to connected Clients.
    // The hook is injected rather than built in, which is what lets the
    // transport go away without this module changing.
    const seen = []
    const client = createLocalWriteClient(db, {
      device_id: deviceId, author_user_id: userId, onOpWritten: (op) => seen.push(op),
    })

    await client.write({ entity: 'activities', entity_id: 'act-7', field: 'name', value: 'Music' })

    expect(seen).toHaveLength(1)
    expect(seen[0].entity_id).toBe('act-7')
  })

  it('does not fan out a rejected write', async () => {
    const seen = []
    const client = createLocalWriteClient(db, {
      device_id: deviceId, author_user_id: userId, onOpWritten: (op) => seen.push(op),
    })
    await client.write({ entity: 'locations', entity_id: 'loc-3', field: 'name', value: 'Field' })
    seen.length = 0

    await client.write({ entity: 'locations', entity_id: 'loc-4', field: 'name', value: 'Field' })

    expect(seen).toHaveLength(0)
  })

  it('writes a bulk replace as a single op', async () => {
    const client = createLocalWriteClient(db, { device_id: deviceId, author_user_id: userId })
    await client.write({ entity: 'schedule_templates', entity_id: 'tpl-1', field: 'name', value: 'Week 1' })

    const result = await client.writeBulkReplace({
      entity: 'template_slots',
      scope_id: 'tpl-1',
      rows: [
        { id: 'slot-1', template_id: 'tpl-1' },
        { id: 'slot-2', template_id: 'tpl-1' },
      ],
    })

    expect(result.status).toBe('applied')
    expect(db.prepare('SELECT COUNT(*) AS c FROM template_slots WHERE template_id = ?').get('tpl-1').c).toBe(2)
  })

  it('reports nothing queued and nothing pending, because it never defers a write', async () => {
    const client = createLocalWriteClient(db, { device_id: deviceId, author_user_id: userId })
    await client.write({ entity: 'activities', entity_id: 'act-8', field: 'name', value: 'Soccer' })

    expect(client.getQueuedOps()).toEqual([])
    expect(client.getPendingRestores()).toEqual([])
  })

  it('imports nothing from the WebSocket transport', async () => {
    // The structural guarantee behind the whole extraction: this module must
    // still load once syncServer.js/syncClient.js/pendingWrites.js are deleted.
    // A test that only exercised behaviour would keep passing right up until
    // the deletion and fail then, which is the wrong moment to find out.
    const src = fs.readFileSync(new URL('./localWriteClient.js', import.meta.url), 'utf8')
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
    expect(imports).toEqual(['node:crypto', '../ops/operations.js'])
  })
})
