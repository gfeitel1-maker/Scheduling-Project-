// @vitest-environment node
//
// T205 round 3 (Red Hat HIGH): resolvePendingDomainStateMigrations discarded
// appendOp's return and cleared resolved_at UNCONDITIONALLY. appendOp never
// throws on a document-write failure — it returns the op with
// op[DOCUMENT_OUTCOME] set to 'failed' (electron/ops/operations.js) instead of
// 'applied'. So a transient document-write failure would still clear the
// marker, sync would resume, and a peer's projectAll delete-reconcile would
// RESURRECT the exact duplicate row v70 deleted — the CRDT-merge resurrection
// this whole ticket exists to prevent, with the safety net disarmed. This
// file plants a REAL (non-'applied') outcome by stubbing at the seam
// operations.js itself uses (recordLocalWrite, liveDoc.js) — the least-mocking
// point that still exercises the genuine DOCUMENT_OUTCOME plumbing rather than
// re-implementing it.
import { vi, describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let poisonedEntityId = null

vi.mock('../sync/automerge/liveDoc.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    recordLocalWrite: (db, args, op) => {
      if (args.entity_id === poisonedEntityId) {
        throw new Error('simulated transient document-write failure')
      }
      return actual.recordLocalWrite(db, args, op)
    },
  }
})

const { openLocalDb } = await import('./localDb.js')
const { resolvePendingDomainStateMigrations, shouldRefuseSyncForDomainMigration } = await import(
  './migrationDomainState.js'
)

const files = []

afterEach(() => {
  poisonedEntityId = null
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-resolve-failclosed-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = openLocalDb(file)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device')
  return db
}

function insertMarker(db, losers) {
  db.prepare(
    `INSERT INTO domain_state_migration_pending (version, detail, created_at) VALUES (70, ?, ?)`
  ).run(JSON.stringify({ note: 'test', losers }), new Date().toISOString())
}

describe('T205 round 3: resolvePendingDomainStateMigrations fails CLOSED on a non-applied document outcome', () => {
  it('leaves resolved_at NULL and keeps sync refused when the tombstone does not land', () => {
    const db = freshDb()
    poisonedEntityId = 'loser-poisoned'
    insertMarker(db, [{ entity: 'days_of_operation', entity_id: 'loser-poisoned' }])

    const resolvedVersions = resolvePendingDomainStateMigrations(db, { device_id: 'device-1' })

    expect(resolvedVersions).toEqual([])
    const marker = db.prepare('SELECT resolved_at FROM domain_state_migration_pending WHERE version = 70').get()
    expect(marker.resolved_at).toBeNull()

    const unresolvedMarkers = db
      .prepare('SELECT version FROM domain_state_migration_pending WHERE resolved_at IS NULL')
      .all()
    expect(
      shouldRefuseSyncForDomainMigration({ docExists: true, riskyThisLaunch: [], unresolvedMarkers })
    ).toBe(true)
    db.close()
  })

  it('a partial batch (one loser fails) leaves the WHOLE marker unresolved, not just the failed loser', () => {
    const db = freshDb()
    poisonedEntityId = 'loser-c'
    insertMarker(db, [
      { entity: 'days_of_operation', entity_id: 'loser-a' },
      { entity: 'days_of_operation', entity_id: 'loser-b' },
      { entity: 'days_of_operation', entity_id: 'loser-c' },
    ])

    const resolvedVersions = resolvePendingDomainStateMigrations(db, { device_id: 'device-1' })

    expect(resolvedVersions).toEqual([])
    const marker = db.prepare('SELECT resolved_at FROM domain_state_migration_pending WHERE version = 70').get()
    expect(marker.resolved_at).toBeNull()
    db.close()
  })

  it('CONTROL: the happy path (no poisoned loser) still resolves — proves the stub does not break normal resolution', () => {
    const db = freshDb()
    poisonedEntityId = null
    insertMarker(db, [{ entity: 'days_of_operation', entity_id: 'loser-healthy' }])

    const resolvedVersions = resolvePendingDomainStateMigrations(db, { device_id: 'device-1' })

    expect(resolvedVersions).toEqual([70])
    const marker = db.prepare('SELECT resolved_at FROM domain_state_migration_pending WHERE version = 70').get()
    expect(marker.resolved_at).not.toBeNull()
    db.close()
  })

  it('a subsequent successful retry resolves the marker (idempotent re-run after the transient failure clears)', () => {
    const db = freshDb()
    poisonedEntityId = 'loser-poisoned'
    insertMarker(db, [{ entity: 'days_of_operation', entity_id: 'loser-poisoned' }])

    expect(resolvePendingDomainStateMigrations(db, { device_id: 'device-1' })).toEqual([])

    poisonedEntityId = null // the transient failure clears
    const retried = resolvePendingDomainStateMigrations(db, { device_id: 'device-1' })

    expect(retried).toEqual([70])
    const marker = db.prepare('SELECT resolved_at FROM domain_state_migration_pending WHERE version = 70').get()
    expect(marker.resolved_at).not.toBeNull()
    const deleteOp = db
      .prepare("SELECT * FROM operations WHERE entity = 'days_of_operation' AND entity_id = 'loser-poisoned' AND field = '__deleted__'")
      .get()
    expect(deleteOp).toBeTruthy()
    db.close()
  })
})
