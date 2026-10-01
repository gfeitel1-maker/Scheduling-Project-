// T321 (docs/adr/2026-10-01-camper-id-high-entropy-format.md) — schema v85: the
// new camper_identity_keys table, plus the back-fill of one row per EXISTING
// ext/name-mode camper (acceptance criterion 6). Mirrors
// electiveRunDurability.migration.test.js's shape: a hand-built pre-v85
// fixture (not derived from the down path), a fresh-db check, and a
// migrated-upgrade check.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, initSchema, openLocalDb } from './localDb.js'
import { deriveCamperId } from '../ops/electiveDerivedIds.js'

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

const freshDb = () => openLocalDb(tmpFile('v85-fresh'))
const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0
const hasIndex = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name=?").get(name).c > 0

// Hand-built pre-v85 shape, seeded with campers in all three OLD-style modes —
// an `ext`-mode and a `name`-mode camper whose `id` is literally
// deriveCamperId's output (the pre-ADR behaviour, commitElectiveRun.js:326),
// plus a `sub`-mode provisional subject, which the ADR says must NOT get a
// back-filled row (nothing to look up by until it is named).
function preV85Db(tag = 'v85-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.exec('DROP TABLE IF EXISTS camper_identity_keys')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 85').run()

  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()

  const extId = deriveCamperId('camp1', { externalId: 'CM-4417' })
  const nameId = deriveCamperId('camp1', { displayName: 'Ari Green' })
  const subId = deriveCamperId('camp1', { submissionKey: 'sub-abc', arrivalId: 'arrive-1' })

  db.prepare(
    'INSERT INTO campers (id, camp_id, display_name, external_id) VALUES (?, ?, ?, ?)'
  ).run(extId, 'camp1', 'Dana Cohen', 'CM-4417')
  db.prepare(
    'INSERT INTO campers (id, camp_id, display_name) VALUES (?, ?, ?)'
  ).run(nameId, 'camp1', 'Ari Green')
  db.prepare(
    'INSERT INTO campers (id, camp_id, display_name, is_unattributed) VALUES (?, ?, ?, 1)'
  ).run(subId, 'camp1', 'planner.csv')

  return { db, extId, nameId, subId }
}

describe('migration v85: version and table/index presence', () => {
  it('declares schema version 85 on a fresh db', () => {
    const db = freshDb()
    // A fresh db always lands at the current head, whatever that is — pinning it to a
    // literal (85) broke on every later schema bump (T322 S3a's v86, ...) for a fact
    // this test was never actually checking. What's actually under test — that v85's
    // OWN migration marker landed — is the row count below, which is a legitimate
    // literal because v85 is v85 forever, regardless of what head the app is at.
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 85').get().c).toBe(1)
    db.close()
  })

  it('creates camper_identity_keys and its camper_id index on a fresh db', () => {
    const db = freshDb()
    expect(hasTable(db, 'camper_identity_keys')).toBe(true)
    expect(hasIndex(db, 'idx_camper_identity_keys_camper')).toBe(true)
    db.close()
  })

  it('creates camper_identity_keys on an upgraded pre-v85 db', () => {
    const { db } = preV85Db()
    expect(hasTable(db, 'camper_identity_keys')).toBe(false)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(hasTable(db, 'camper_identity_keys')).toBe(true)
    db.close()
  })
})

describe('migration v85: back-fill (acceptance criterion 6)', () => {
  it('back-fills one row for an existing ext-mode camper, re-deriving the lookup key from external_id', () => {
    const { db, extId } = preV85Db()
    initSchema(db)
    const lookupId = deriveCamperId('camp1', { externalId: 'CM-4417' })
    const row = db.prepare('SELECT * FROM camper_identity_keys WHERE id = ?').get(lookupId)
    expect(row).toBeTruthy()
    expect(row.camp_id).toBe('camp1')
    expect(row.key_mode).toBe('ext')
    expect(row.key_value).toBe('CM-4417')
    expect(row.camper_id).toBe(extId)
    db.close()
  })

  it('back-fills one row for an existing name-mode camper, re-deriving the lookup key from display_name', () => {
    const { db, nameId } = preV85Db()
    initSchema(db)
    const lookupId = deriveCamperId('camp1', { displayName: 'Ari Green' })
    const row = db.prepare('SELECT * FROM camper_identity_keys WHERE id = ?').get(lookupId)
    expect(row).toBeTruthy()
    expect(row.key_mode).toBe('name')
    // ADR decision 5: key_value is the CANONICAL key (lowercased, whitespace
    // stripped), not the raw display name.
    expect(row.key_value).toBe('arigreen')
    expect(row.camper_id).toBe(nameId)
    db.close()
  })

  it('does NOT back-fill a row for a sub-mode (unattributed) camper', () => {
    const { db, subId } = preV85Db()
    initSchema(db)
    expect(db.prepare('SELECT COUNT(*) c FROM camper_identity_keys WHERE camper_id = ?').get(subId).c).toBe(0)
    db.close()
  })

  it('does not change campers.id for any existing row', () => {
    const { db, extId, nameId, subId } = preV85Db()
    initSchema(db)
    expect(db.prepare('SELECT id FROM campers WHERE id = ?').get(extId)).toBeTruthy()
    expect(db.prepare('SELECT id FROM campers WHERE id = ?').get(nameId)).toBeTruthy()
    expect(db.prepare('SELECT id FROM campers WHERE id = ?').get(subId)).toBeTruthy()
    db.close()
  })

  // Acceptance criterion 6, stated directly: a sheet re-imported post-migration
  // for an already-known camper resolves to the SAME camper_id it always has,
  // via the back-filled lookup row — not a freshly-minted random one.
  it('a re-derived lookup key resolves to the pre-existing camper id, not a fresh one', () => {
    const { db, extId } = preV85Db()
    initSchema(db)
    const lookupId = deriveCamperId('camp1', { externalId: 'CM-4417' })
    const resolved = db.prepare('SELECT camper_id FROM camper_identity_keys WHERE id = ?').get(lookupId)?.camper_id
    expect(resolved).toBe(extId)
  })
})
