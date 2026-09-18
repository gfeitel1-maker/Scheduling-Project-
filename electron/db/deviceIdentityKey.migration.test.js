// @vitest-environment node
//
// Migration v67 — device_identity_key, the per-device persistent libp2p
// transport identity (T162, docs/adr/2026-09-14-device-identity-and-token-
// binding.md §1/§5). NOTE: the ADR/ticket text was written against v60 when
// this repo was at v59; v60-v65 are already taken by other work, so this
// migration is v67 (v66 went to T194's participant substrate) — the version
// number is corrected here, the design is not.
//
// Same shape as importDecisions.migration.test.js (v63): fresh-vs-migrated
// schema equivalence and the LOCAL-ONLY guarantee this design rests on — plus
// the clean-cutover assertion (ADR §2): every existing devices.libp2p_peer_id
// is nulled by this migration, because a value written under the old
// "regenerated every restart" regime is not tied to any device's new
// persistent identity.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { PROJECTIONS } from '../ops/projections.js'
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES } from '../ops/campScopedEntities.js'
import { ENTITIES } from '../auth/permissions.js'
import { MODELED_ENTITIES } from '../automerge/campDocument.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function tmpFile(tag) {
  const file = path.join(os.tmpdir(), `shoresh-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return file
}

function freshDb() {
  return openLocalDb(tmpFile('v67-fresh'))
}

function migratedDb() {
  const db = new Database(tmpFile('v67-migrated'))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.exec('DROP TABLE IF EXISTS device_identity_key')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 66').run()
  return db
}

const tableInfo = (db) =>
  db.pragma('table_info(device_identity_key)').map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

const tableSql = (db) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'device_identity_key'").get()?.sql

describe('migration v67: device_identity_key', () => {
  it('creates the table on a fresh database and declares schema version 67', () => {
    const db = freshDb()
    // 67, not 66. This asserted `version = 66` after the rebase and still passed —
    // on T194's v66 row, not ours. A test that reads another migration's stamp is
    // not testing this migration at all.
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 67').get().c).toBe(1)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(69)
    expect(db.prepare('SELECT COUNT(*) c FROM device_identity_key').get().c).toBe(0)
    db.close()
  })

  it('migrates a pre-v66 database forward, adding only this table', () => {
    const db = migratedDb()
    expect(getSchemaVersion(db)).toBe(65)
    expect(tableSql(db)).toBeUndefined()

    initSchema(db)

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM device_identity_key').get().c).toBe(0)
    db.close()
  })

  it('gives a fresh db and a migrated db identical device_identity_key columns and DDL', () => {
    const fresh = freshDb()
    const migrated = migratedDb()
    initSchema(migrated)

    expect(tableInfo(migrated)).toEqual(tableInfo(fresh))
    // The DDL is written twice — schema.sql and localDb.js's v66 block — and
    // the two copies can drift silently. sqlite_master stores the original
    // statement text, so this is the only assertion that catches it.
    expect(tableSql(migrated)).toBe(tableSql(fresh))

    expect(getSchemaVersion(migrated)).toBe(CURRENT_SCHEMA_VERSION)
    expect(getSchemaVersion(fresh)).toBe(CURRENT_SCHEMA_VERSION)
    fresh.close()
    migrated.close()
  }, 30000)

  it('is idempotent — re-running v66 on an already-migrated db does not error', () => {
    const db = freshDb()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM device_identity_key').get().c).toBe(0)
    db.close()
  })

  it('clean cutover (ADR §2): a devices row with a non-NULL libp2p_peer_id before migration is NULL after', () => {
    const db = migratedDb()
    db.prepare('INSERT INTO devices (id, name, libp2p_peer_id) VALUES (?, ?, ?)').run(
      'd1', 'Device 1', 'stale-peer-id-from-a-past-process-lifetime'
    )
    expect(db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get('d1').libp2p_peer_id).toBe(
      'stale-peer-id-from-a-past-process-lifetime'
    )

    initSchema(db)

    expect(db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get('d1').libp2p_peer_id).toBeNull()
    db.close()
  })
})

describe('device_identity_key is host-local and cannot replicate', () => {
  it('is absent from every registry that would give it a sync or read path', () => {
    expect(Object.keys(PROJECTIONS)).not.toContain('device_identity_key')
    expect(DIRECT_CAMP_ENTITIES.has('device_identity_key')).toBe(false)
    expect(Object.keys(PARENT_SCOPED_ENTITIES)).not.toContain('device_identity_key')
    expect(ENTITIES).not.toContain('device_identity_key')
    expect(MODELED_ENTITIES.has('device_identity_key')).toBe(false)
  })
})
