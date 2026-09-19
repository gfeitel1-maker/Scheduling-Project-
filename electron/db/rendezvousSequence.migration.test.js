// @vitest-environment node
//
// Migration v69 — rendezvous_sequence, the device-local publish sequence for signed rendezvous
// records (T210, docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md,
// Decision 2). Mirrors deviceIdentityKey.migration.test.js's shape: fresh-vs-migrated schema
// equivalence, plus the standing guard that this table can never gain a sync or read path.
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
import { nextSequence } from '../sync/automerge/rendezvousSequence.js'

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
  return openLocalDb(tmpFile('v69-fresh'))
}

function migratedDb() {
  const db = new Database(tmpFile('v69-migrated'))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.exec('DROP TABLE IF EXISTS rendezvous_sequence')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 69').run()
  return db
}

const tableInfo = (db) =>
  db.pragma('table_info(rendezvous_sequence)').map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

const tableSql = (db) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rendezvous_sequence'").get()?.sql

describe('migration v69: rendezvous_sequence', () => {
  it('creates the table on a fresh database and declares schema version 69', () => {
    const db = freshDb()
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 69').get().c).toBe(1)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(72)
    expect(db.prepare('SELECT COUNT(*) c FROM rendezvous_sequence').get().c).toBe(0)
    db.close()
  })

  it('migrates a pre-v69 database forward, adding only this table', () => {
    const db = migratedDb()
    expect(getSchemaVersion(db)).toBe(68)
    expect(tableSql(db)).toBeUndefined()

    initSchema(db)

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM rendezvous_sequence').get().c).toBe(0)
    db.close()
  })

  it('gives a fresh db and a migrated db identical rendezvous_sequence columns and DDL', () => {
    const fresh = freshDb()
    const migrated = migratedDb()
    initSchema(migrated)

    expect(tableInfo(migrated)).toEqual(tableInfo(fresh))
    // The DDL is written twice — schema.sql and localDb.js's v69 block — and the two copies can
    // drift silently. sqlite_master stores the original statement text, so this is the only
    // assertion that catches it.
    expect(tableSql(migrated)).toBe(tableSql(fresh))

    expect(getSchemaVersion(migrated)).toBe(CURRENT_SCHEMA_VERSION)
    expect(getSchemaVersion(fresh)).toBe(CURRENT_SCHEMA_VERSION)
    fresh.close()
    migrated.close()
  }, 30000)

  it('is idempotent — re-running the migration on an already-migrated db does not error', () => {
    const db = freshDb()
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM rendezvous_sequence').get().c).toBe(0)
    db.close()
  })
})

describe('nextSequence', () => {
  it('increments and returns in one transaction, starting at 1', () => {
    const db = freshDb()
    expect(nextSequence(db)).toBe(1)
    expect(nextSequence(db)).toBe(2)
    expect(nextSequence(db)).toBe(3)
    db.close()
  })
})

describe('rendezvous_sequence is host-local and cannot replicate', () => {
  it('is absent from every registry that would give it a sync or read path', () => {
    expect(Object.keys(PROJECTIONS)).not.toContain('rendezvous_sequence')
    expect(DIRECT_CAMP_ENTITIES.has('rendezvous_sequence')).toBe(false)
    expect(Object.keys(PARENT_SCOPED_ENTITIES)).not.toContain('rendezvous_sequence')
    expect(ENTITIES).not.toContain('rendezvous_sequence')
    expect(MODELED_ENTITIES.has('rendezvous_sequence')).toBe(false)
  })
})
