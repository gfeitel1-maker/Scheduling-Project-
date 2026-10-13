// @vitest-environment node
//
// Restore from a backup made with at-rest encryption ON (the default). A backup is a byte copy of the
// encrypted db, so the pick step must open it with the device key. Uses the REAL encrypting driver;
// like sqliteCipher.integration.test.js it SKIPS locally where the driver cannot load, and on CI
// (CI=true) it never skips: a missing driver there fails the file instead.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import { openLocalDb } from './localDb.js'
import { makeDocCipher } from './docCipher.js'
import { writeUserBackup } from './projectManager.js'
import { checkPickedBackup, restoreFromBackup } from './backupRestore.js'
import { appendOp } from '../ops/operations.js'
import { seedAllFromSqlite } from '../automerge/seed.js'
import { saveDoc } from '../sync/automerge/docStore.js'

const require = createRequire(import.meta.url)
let driverAvailable = false
try { require('better-sqlite3-multiple-ciphers')(':memory:').close(); driverAvailable = true } catch { /* reported below */ }
const onCI = Boolean(process.env.CI)

let tmp, cipher, campId, dbKey
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-restore-enc-'))
  cipher = makeDocCipher(randomBytes(32))
  campId = randomUUID()
  dbKey = randomBytes(32)
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function newCampDb(file, key, id = campId) {
  const db = openLocalDb(file, { key })
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(id, 'Camp Probe')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES ('u1', ?, 'Ruth', 'h', 's', 'admin')").run(id)
  return db
}
function addLocation(db, name) {
  const lid = randomUUID()
  const op = (field, value) => appendOp(db, { entity: 'locations', entity_id: lid, field, value, device_id: 'd1', author_user_id: 'u1' })
  op('camp_id', db.prepare('SELECT id FROM camps LIMIT 1').get().id)
  op('name', name)
}
const names = (db) => db.prepare('SELECT name FROM locations ORDER BY name').all().map((r) => r.name)
function backup(db, dbPath) {
  saveDoc(tmp, campId, seedAllFromSqlite(db), cipher)
  db.pragma('wal_checkpoint(TRUNCATE)')
  return writeUserBackup(dbPath, tmp, campId, undefined, null, db)
}

it.runIf(onCI)('the encrypting driver loads on CI (the real-crypto proof must not be skipped there)', () => {
  expect(driverAvailable).toBe(true)
})

describe.skipIf(!driverAvailable && !onCI)('restore from an encrypted backup — real driver', () => {
  it('accepts a backup made with encryption on, and restoring it brings back the backed-up data', async () => {
    const dbPath = path.join(tmp, 'live.sqlite')
    const db = newCampDb(dbPath, dbKey)
    addLocation(db, 'Lake')
    const backupDbPath = backup(db, dbPath)
    addLocation(db, 'Pool')
    saveDoc(tmp, campId, seedAllFromSqlite(db), cipher)
    expect(names(db)).toEqual(['Lake', 'Pool'])

    const picked = checkPickedBackup(backupDbPath, { db, cipher, dbKey })
    expect(picked.error).toBeUndefined()
    expect(typeof picked.backupDate).toBe('string')

    const installed = []
    const r = await restoreFromBackup({
      sourcePath: backupDbPath, dbPath, userDataPath: tmp, db, cipher,
      flushDoc() {}, stopSync: async () => {}, startSync() {}, discardDoc() {},
      openDb: () => openLocalDb(dbPath, { key: dbKey }),
      installDb: async (d) => { installed.push(d) },
    })
    expect(r).toEqual({ restored: true })
    expect(names(installed[0])).toEqual(['Lake'])
    installed[0].close()
  })

  it('refuses an encrypted backup written under a different key', () => {
    const dbPath = path.join(tmp, 'live.sqlite')
    const db = newCampDb(dbPath, dbKey)
    const backupDbPath = backup(db, dbPath)
    expect(checkPickedBackup(backupDbPath, { db, cipher, dbKey: randomBytes(32) }).error).toBe('invalid_file')
  })

  it('refuses a corrupt copy of an encrypted backup', () => {
    const dbPath = path.join(tmp, 'live.sqlite')
    const db = newCampDb(dbPath, dbKey)
    const backupDbPath = backup(db, dbPath)
    const bytes = fs.readFileSync(backupDbPath)
    fs.writeFileSync(backupDbPath, Buffer.concat([bytes.subarray(0, 2048), randomBytes(4096)]))
    expect(checkPickedBackup(backupDbPath, { db, cipher, dbKey }).error).toBe('invalid_file')
  })

  it('refuses an encrypted backup from a different camp', () => {
    const dbPath = path.join(tmp, 'live.sqlite')
    const db = newCampDb(dbPath, dbKey)
    const backupDbPath = backup(db, dbPath)
    const other = openLocalDb(path.join(tmp, 'other.sqlite'), { key: dbKey })
    other.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(randomUUID(), 'Other Camp')
    expect(checkPickedBackup(backupDbPath, { db: other, cipher, dbKey }).error).toBe('backup_wrong_camp')
    other.close()
  })
})

describe('restore pick without encryption', () => {
  it('still accepts a plaintext backup when no key is in use', () => {
    const dbPath = path.join(tmp, 'live.sqlite')
    const db = newCampDb(dbPath, null)
    addLocation(db, 'Lake')
    const backupDbPath = backup(db, dbPath)
    expect(checkPickedBackup(backupDbPath, { db, cipher, dbKey: null }).error).toBeUndefined()
    db.close()
  })

  it('refuses a file that is not a Shoresh backup', () => {
    const dbPath = path.join(tmp, 'live.sqlite')
    const db = newCampDb(dbPath, null)
    const notDb = path.join(tmp, 'notes.db')
    fs.writeFileSync(notDb, 'this is not a database, just some notes about the camp')
    expect(checkPickedBackup(notDb, { db, cipher, dbKey: null }).error).toBe('invalid_file')
    db.close()
  })
})
