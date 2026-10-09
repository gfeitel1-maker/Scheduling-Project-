// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import { openLocalDb } from './localDb.js'
import { makeDocCipher } from './docCipher.js'
import { writeUserBackup } from './projectManager.js'
import { validateBackupPair, applyBackupFiles, restoreFromBackup, RestoreRefusal } from './backupRestore.js'
import { appendOp } from '../ops/operations.js'
import { seedAllFromSqlite } from '../automerge/seed.js'
import { saveDoc, loadDoc, docPath } from '../sync/automerge/docStore.js'
import { projectAll } from '../automerge/projector.js'
import { saveDoc as encodeDoc, loadDoc as decodeDoc } from '../automerge/campDocument.js'
import * as Automerge from '@automerge/automerge'

let tmp, cipher, campId
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-restore-'))
  cipher = makeDocCipher(randomBytes(32))
  campId = randomUUID()
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function newCampDb(file, id = campId) {
  const db = openLocalDb(file)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(id, 'Camp Probe')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES ('u1', ?, 'Ruth', 'h', 's', 'admin')").run(id)
  return db
}
function addLocation(db, name, deviceId = 'd1') {
  const lid = randomUUID()
  const op = (field, value) => appendOp(db, { entity: 'locations', entity_id: lid, field, value, device_id: deviceId, author_user_id: 'u1' })
  op('camp_id', db.prepare('SELECT id FROM camps LIMIT 1').get().id)
  op('name', name)
}
const names = (db) => db.prepare('SELECT name FROM locations ORDER BY name').all().map((r) => r.name)
function persistDoc(db, userData, id = campId) {
  saveDoc(userData, id, seedAllFromSqlite(db), cipher)
}

describe('doc-aware restore', () => {
  it('restoring a pair then projecting the restored document yields the backup data, not the newer data', () => {
    const dbPath = path.join(tmp, 'live.sqlite')
    let db = newCampDb(dbPath)
    addLocation(db, 'Lake')
    persistDoc(db, tmp)
    db.pragma('wal_checkpoint(TRUNCATE)')
    const backupDbPath = writeUserBackup(dbPath, tmp, campId)
    addLocation(db, 'Pool')
    persistDoc(db, tmp)
    expect(names(db)).toEqual(['Lake', 'Pool'])

    const { docSrc } = validateBackupPair(backupDbPath, { db, cipher })
    db.close()
    applyBackupFiles({ backupDbPath, dbPath, userDataPath: tmp, campId, docSrc })
    db = openLocalDb(dbPath)
    projectAll(db, loadDoc(tmp, campId, cipher))
    expect(names(db)).toEqual(['Lake'])
    db.close()
  })

  it('refuses a db-only (older) backup and changes nothing', () => {
    const dbPath = path.join(tmp, 'live.sqlite')
    const db = newCampDb(dbPath)
    persistDoc(db, tmp)
    const backupDbPath = writeUserBackup(dbPath, tmp)
    const before = fs.readFileSync(docPath(tmp, campId))
    expect(() => validateBackupPair(backupDbPath, { db, cipher })).toThrow(expect.objectContaining({ code: 'backup_no_document' }))
    expect(fs.readFileSync(docPath(tmp, campId))).toEqual(before)
  })

  it('refuses a backup from a different camp', () => {
    const other = randomUUID()
    const otherDir = path.join(tmp, 'other'); fs.mkdirSync(otherDir)
    const otherDb = newCampDb(path.join(otherDir, 'o.sqlite'), other)
    persistDoc(otherDb, otherDir, other)
    const backupDbPath = writeUserBackup(path.join(otherDir, 'o.sqlite'), otherDir, other)
    const db = newCampDb(path.join(tmp, 'live.sqlite'))
    expect(() => validateBackupPair(backupDbPath, { db, cipher })).toThrow(expect.objectContaining({ code: 'backup_wrong_camp' }))
  })

  it('refuses a document that cannot be decrypted', () => {
    const dbPath = path.join(tmp, 'live.sqlite')
    const db = newCampDb(dbPath)
    persistDoc(db, tmp)
    db.pragma('wal_checkpoint(TRUNCATE)')
    const backupDbPath = writeUserBackup(dbPath, tmp, campId)
    const otherCipher = makeDocCipher(randomBytes(32))
    expect(() => validateBackupPair(backupDbPath, { db, cipher: otherCipher })).toThrow(expect.objectContaining({ code: 'backup_document_unreadable' }))
  })

  it('merges peers\' newer data back after restore (CRDT)', () => {
    const dbPath = path.join(tmp, 'live.sqlite')
    let db = newCampDb(dbPath)
    addLocation(db, 'Lake')
    persistDoc(db, tmp)
    const peerDoc = decodeDoc(encodeDoc(loadDoc(tmp, campId, cipher)))
    db.pragma('wal_checkpoint(TRUNCATE)')
    const backupDbPath = writeUserBackup(dbPath, tmp, campId)
    const peerSide = openLocalDb(path.join(tmp, 'peer.sqlite'))
    peerSide.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp Probe')
    peerSide.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d2', 'Peer')
    peerSide.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES ('u1', ?, 'Ruth', 'h', 's', 'admin')").run(campId)
    projectAll(peerSide, peerDoc)
    addLocation(peerSide, 'Gaga Pit', 'd2')
    const peerNewer = seedAllFromSqlite(peerSide, peerDoc)

    const { docSrc } = validateBackupPair(backupDbPath, { db, cipher })
    db.close()
    applyBackupFiles({ backupDbPath, dbPath, userDataPath: tmp, campId, docSrc })
    const restored = loadDoc(tmp, campId, cipher)
    const merged = Automerge.merge(Automerge.clone(restored), peerNewer)
    db = openLocalDb(dbPath)
    projectAll(db, merged)
    expect(names(db)).toEqual(['Gaga Pit', 'Lake'])
    db.close(); peerSide.close()
  })

  it('a db step failure puts the document back; db and document both stay pre-restore', () => {
    const dbPath = path.join(tmp, 'live.sqlite')
    const db = newCampDb(dbPath)
    addLocation(db, 'Lake')
    persistDoc(db, tmp)
    db.pragma('wal_checkpoint(TRUNCATE)')
    const backupDbPath = writeUserBackup(dbPath, tmp, campId)
    addLocation(db, 'Pool')
    persistDoc(db, tmp)
    db.close()
    const docBefore = fs.readFileSync(docPath(tmp, campId))
    const dbBefore = fs.readFileSync(dbPath)
    const { docSrc } = validateBackupPair(backupDbPath, { db: newCampDb(path.join(tmp, 'x.sqlite')), cipher })
    expect(() => applyBackupFiles({
      backupDbPath, dbPath, userDataPath: tmp, campId, docSrc,
      copyDb: () => { throw new Error('disk full') },
    })).toThrow('disk full')
    expect(fs.readFileSync(docPath(tmp, campId))).toEqual(docBefore)
    expect(fs.readFileSync(dbPath)).toEqual(dbBefore)
    expect(fs.existsSync(`${docPath(tmp, campId)}.restore-prev`)).toBe(false)
  })

  it('a document step failure changes nothing and is typed', () => {
    const dbPath = path.join(tmp, 'live.sqlite')
    const db = newCampDb(dbPath)
    persistDoc(db, tmp)
    const docBefore = fs.readFileSync(docPath(tmp, campId))
    expect(() => applyBackupFiles({
      backupDbPath: dbPath, dbPath, userDataPath: tmp, campId, docSrc: path.join(tmp, 'missing.automerge'),
    })).toThrow(expect.objectContaining({ code: 'restore_document_failed' }))
    expect(fs.readFileSync(docPath(tmp, campId))).toEqual(docBefore)
  })
})

describe('restoreFromBackup (WAL, rotation, rollback)', () => {
  function setup() {
    const dbPath = path.join(tmp, 'live.sqlite')
    const db = newCampDb(dbPath)
    db.pragma('journal_mode = WAL')
    addLocation(db, 'Lake')
    persistDoc(db, tmp)
    db.pragma('wal_checkpoint(TRUNCATE)')
    const backupDbPath = writeUserBackup(dbPath, tmp, campId)
    addLocation(db, 'Pool')
    persistDoc(db, tmp)
    return { dbPath, db, backupDbPath }
  }
  const deps = (dbPath, installed, extra = {}) => ({
    dbPath, userDataPath: tmp, cipher,
    flushDoc() {}, stopSync: async () => {}, startSync() {}, discardDoc() {},
    openDb: () => openLocalDb(dbPath),
    installDb: async (d) => { installed.push(d) },
    ...extra,
  })

  it('a WAL-mode old connection with uncheckpointed rows does not leak into the restored db', async () => {
    const { dbPath, db, backupDbPath } = setup()
    const installed = []
    const r = await restoreFromBackup({ sourcePath: backupDbPath, db, ...deps(dbPath, installed) })
    expect(r).toEqual({ restored: true })
    expect(names(installed[0])).toEqual(['Lake'])
    installed[0].close()
  })

  it('applyBackupFiles removes stale -wal/-shm sidecars', () => {
    const { dbPath, db, backupDbPath } = setup()
    const { docSrc } = validateBackupPair(backupDbPath, { db, cipher })
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true)
    applyBackupFiles({ backupDbPath, dbPath, userDataPath: tmp, campId, docSrc })
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false)
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false)
  })

  it('restoring the oldest kept backup does not delete it', async () => {
    const { dbPath, db, backupDbPath } = setup()
    const dir = path.dirname(backupDbPath)
    fs.utimesSync(backupDbPath, 1, 1)
    for (let i = 0; i < 9; i++) {
      const f = path.join(dir, `shoresh-2099-01-0${i + 1}.db`)
      fs.writeFileSync(f, 'x')
    }
    const installed = []
    const r = await restoreFromBackup({ sourcePath: backupDbPath, db, ...deps(dbPath, installed) })
    expect(r).toEqual({ restored: true })
    expect(fs.existsSync(backupDbPath)).toBe(true)
    expect(fs.existsSync(backupDbPath.replace(/\.db$/, '.automerge'))).toBe(true)
    installed[0].close()
  })

  it('a failure after the files are replaced puts the pre-restore db and document back and reinstalls', async () => {
    const { dbPath, db, backupDbPath } = setup()
    const docBefore = fs.readFileSync(docPath(tmp, campId))
    const installed = []
    let calls = 0
    const r = await restoreFromBackup({
      sourcePath: backupDbPath, db,
      ...deps(dbPath, installed, {
        installDb: async (d) => { calls++; if (calls === 1) { d.close(); throw new Error('swap failed') } installed.push(d) },
      }),
    })
    expect(r.error).toBe('restore_incomplete')
    expect(installed).toHaveLength(1)
    expect(names(installed[0])).toEqual(['Lake', 'Pool'])
    expect(fs.readFileSync(docPath(tmp, campId))).toEqual(docBefore)
    installed[0].close()
  })

  it('clears a stale .restore-prev and leaves none after success', async () => {
    const { dbPath, db, backupDbPath } = setup()
    const prev = `${docPath(tmp, campId)}.restore-prev`
    fs.writeFileSync(prev, 'stale')
    const installed = []
    await restoreFromBackup({ sourcePath: backupDbPath, db, ...deps(dbPath, installed) })
    expect(fs.existsSync(prev)).toBe(false)
    installed[0].close()
  })
})
