// @vitest-environment node
//
// End-to-end proof of SQLite at-rest encryption through the REAL openLocalDb + the REAL encrypting
// driver (better-sqlite3-multiple-ciphers). Gated on the driver being installed and built: on a
// runtime where it is absent (e.g. a Node version with no prebuilt and a failed source build), this
// whole file SKIPS rather than fails locally. On CI (CI=true) it NEVER skips: a missing driver there makes
// every test below FAIL with the driver's own load error, because a green run that skipped the real-crypto
// proof (including the T345 decrypt-back) is a green that did not run. The migration ORCHESTRATION and
// header detection are covered without the driver in sqliteCipher.test.js; this file proves the actual
// crypto + the openLocalDb wiring.
import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { openLocalDb } from './localDb.js'
import { isPlaintextSqliteFile, decryptEncryptedToPlaintext, readTableCounts } from './sqliteCipher.js'
import { disableAtRestEncryption } from './disableAtRestEncryption.js'
import { saveDoc as saveCampDoc, createEmptyDoc } from '../automerge/campDocument.js'
import { getOrCreateDbKey, KEY_FILE } from './dbEncryptionKey.js'
import { makeDocCipher, isEncrypted } from './docCipher.js'

const require = createRequire(import.meta.url)
// require() succeeding is NOT enough — the native binding is located lazily and only fails at
// construction. Actually build a throwaway in-memory db to prove the driver is usable here.
let driverAvailable = false
let driverLoadError = null
try { const D = require('better-sqlite3-multiple-ciphers'); D(':memory:').close(); driverAvailable = true } catch (err) { driverLoadError = err }
const onCI = Boolean(process.env.CI)

const tmp = []
afterEach(() => {
  for (const f of tmp.splice(0)) {
    for (const s of ['', '-wal', '-shm', '.enc-migrate', '.bak']) { try { fs.rmSync(`${f}${s}`, { force: true }) } catch { /* */ } }
  }
})
function tmpFile(tag) {
  const f = path.join(os.tmpdir(), `shoresh-sqlcipher-int-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  tmp.push(f)
  return f
}
const key = () => crypto.randomBytes(32)

describe.skipIf(!driverAvailable && !onCI)('SQLite at-rest encryption — real driver, through openLocalDb', () => {
  it('decryptEncryptedToPlaintext decrypts a COPY of a keyed WAL-mode db to plaintext with identical rows and leaves the original encrypted (T345)', () => {
    const f = tmpFile('decrypt')
    const k = key()
    const enc = openLocalDb(f, { key: k })
    enc.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT)')
    const ins = enc.prepare('INSERT INTO probe (v) VALUES (?)')
    for (let i = 0; i < 1500; i++) ins.run(`row-${i}-${'x'.repeat(80)}`)
    enc.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('c1', 'Camp One')
    const rowsBefore = enc.prepare('SELECT id, v FROM probe ORDER BY id').all()
    enc.pragma('wal_checkpoint(TRUNCATE)')
    enc.close()
    const D = require('better-sqlite3-multiple-ciphers')
    const expectedCounts = readTableCounts(D, f, k)
    const staged = `${f}.disable-staged`
    tmp.push(staged)
    const originalBytes = fs.readFileSync(f)
    decryptEncryptedToPlaintext(f, k, { Database: D, stagedPath: staged, expectedCounts })

    expect(isPlaintextSqliteFile(staged)).toBe(true)
    expect(fs.readFileSync(f).equals(originalBytes)).toBe(true)
    expect(isPlaintextSqliteFile(f)).toBe(false)
    const plain = new D(staged)
    expect(plain.prepare('SELECT name FROM camps WHERE id = ?').get('c1').name).toBe('Camp One')
    expect(plain.prepare('SELECT id, v FROM probe ORDER BY id').all()).toEqual(rowsBefore)
    expect(plain.pragma('integrity_check', { simple: true })).toBe('ok')
    plain.close()
    const stillEncrypted = new D(f)
    stillEncrypted.pragma(`key = "x'${k.toString('hex')}'"`)
    expect(stillEncrypted.prepare('SELECT count(*) AS n FROM probe').get().n).toBe(1500)
    stillEncrypted.close()
  })

  it('the full disable runs through the REAL driver: keyless reopen reads identical rows, the document round-trips, the key is gone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-disable-int-'))
    try {
      const safeStorage = {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(`sealed:${s}`),
        decryptString: (b) => b.toString().replace(/^sealed:/, ''),
      }
      const k = getOrCreateDbKey(dir, safeStorage)
      const f = path.join(dir, 'camp.sqlite')
      const db = openLocalDb(f, { key: k })
      db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT)')
      const ins = db.prepare('INSERT INTO probe (v) VALUES (?)')
      for (let i = 0; i < 800; i++) ins.run(`row-${i}-${'y'.repeat(60)}`)
      db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('c1', 'Camp One')
      const rowsBefore = db.prepare('SELECT id, v FROM probe ORDER BY id').all()
      db.close()

      const docBytes = Buffer.from(saveCampDoc(createEmptyDoc()))
      const cipher = makeDocCipher(k)
      fs.mkdirSync(path.join(dir, 'automerge'))
      const docPath = path.join(dir, 'automerge', 'camp-1.automerge')
      fs.writeFileSync(docPath, cipher.encrypt(docBytes))
      expect(isEncrypted(fs.readFileSync(docPath))).toBe(true)

      const D = require('better-sqlite3-multiple-ciphers')
      const res = disableAtRestEncryption({ userDataDir: dir, dbPaths: [f], safeStorage, Database: D })
      expect(res.warnings).toEqual([])

      expect(isPlaintextSqliteFile(f)).toBe(true)
      const plain = new D(f)
      expect(plain.prepare('SELECT name FROM camps WHERE id = ?').get('c1').name).toBe('Camp One')
      expect(plain.prepare('SELECT id, v FROM probe ORDER BY id').all()).toEqual(rowsBefore)
      expect(plain.pragma('integrity_check', { simple: true })).toBe('ok')
      plain.close()
      const reopened = openLocalDb(f, { plaintext: true })
      expect(reopened.prepare('SELECT count(*) AS n FROM probe').get().n).toBe(800)
      reopened.close()
      expect(fs.readFileSync(docPath).equals(docBytes)).toBe(true)
      expect(fs.existsSync(path.join(dir, KEY_FILE))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'encryption.disabled'))).toBe(true)
      expect(fs.readdirSync(dir).filter((n) => /\.bak$|\.tmp$|staged|disabling|journal/.test(n))).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the document cipher round-trips: encrypt then decrypt returns the exact bytes, and a flipped bit is refused', () => {
    const k = key()
    const cipher = makeDocCipher(k)
    const doc = Buffer.concat([Buffer.from([0x85, 0x6f, 0x4a, 0x83]), crypto.randomBytes(512)])
    const enc = cipher.encrypt(doc)
    expect(isEncrypted(enc)).toBe(true)
    expect(enc.includes(doc.subarray(8, 40))).toBe(false)
    expect(cipher.decrypt(enc).equals(doc)).toBe(true)
    const bad = Buffer.from(enc); bad[bad.length - 1] ^= 1
    expect(() => cipher.decrypt(bad)).toThrow()
  })

  it('recovers a half-encrypted db from its plaintext .bak and re-migrates (crash during rekey)', () => {
    const f = tmpFile('crash')
    const k = key()
    const plain = openLocalDb(f, { plaintext: true })
    plain.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('c1', 'Camp One')
    plain.pragma('wal_checkpoint(TRUNCATE)')
    plain.close()
    const bak = `${f}.pre-migration-2026-01-01T00-00-00-000Z.bak`
    tmp.push(bak)
    fs.copyFileSync(f, bak)
    fs.writeFileSync(f, crypto.randomBytes(8192)) // the interrupted rekey left garbage
    const st = fs.statSync(bak)
    fs.writeFileSync(`${f}.migration-in-progress`, JSON.stringify({ backupPath: bak, size: st.size, mtimeMs: st.mtimeMs })); tmp.push(`${f}.migration-in-progress`)

    const db = openLocalDb(f, { key: k })
    expect(db.prepare('SELECT name FROM camps WHERE id = ?').get('c1').name).toBe('Camp One')
    db.close()
    expect(isPlaintextSqliteFile(f)).toBe(false)
    expect(fs.existsSync(bak)).toBe(false) // no plaintext copy left behind
  })

  describe('orphaned plaintext pre-migration backups', () => {
    const MAGIC = Buffer.from('SQLite format 3\0', 'latin1')
    function encryptedDb(tag, k) {
      const f = tmpFile(tag)
      const db = openLocalDb(f, { key: k }); db.close()
      return f
    }
    const bakNamed = (f, n, content) => { const b = `${f}.pre-migration-${n}.bak`; tmp.push(b); fs.writeFileSync(b, content); return b }

    it('a successful keyed open shreds a plaintext .bak but keeps an encrypted-header one', () => {
      const k = key(); const f = encryptedDb('orphan', k)
      const plain = bakNamed(f, 'p', Buffer.concat([MAGIC, Buffer.alloc(200, 5)]))
      const enc = bakNamed(f, 'e', fs.readFileSync(f))
      openLocalDb(f, { key: k }).close()
      expect(fs.existsSync(plain)).toBe(false)
      expect(fs.existsSync(enc)).toBe(true)
    })

    it('db absent + plaintext .bak -> .bak kept (a fresh empty db must never trigger a shred)', () => {
      const f = tmpFile('absent')
      const plain = bakNamed(f, 'p', Buffer.concat([MAGIC, Buffer.alloc(200, 5)]))
      openLocalDb(f, { key: key() }).close()
      expect(fs.existsSync(plain)).toBe(true)
    })

    it('db zero-length + plaintext .bak -> .bak kept', () => {
      const f = tmpFile('zero')
      fs.writeFileSync(f, '')
      const plain = bakNamed(f, 'p', Buffer.concat([MAGIC, Buffer.alloc(200, 5)]))
      openLocalDb(f, { key: key() }).close()
      expect(fs.existsSync(plain)).toBe(true)
    })

    it('a failed key deletes nothing', () => {
      const f = encryptedDb('orphan-badkey', key())
      const plain = bakNamed(f, 'p', Buffer.concat([MAGIC, Buffer.alloc(200, 5)]))
      expect(() => openLocalDb(f, { key: key() })).toThrow()
      expect(fs.existsSync(plain)).toBe(true)
    })
  })

  it('an unreadable db with no plaintext .bak fails with db_migration_interrupted, not an opaque error', () => {
    const f = tmpFile('crash-nobak')
    fs.writeFileSync(f, crypto.randomBytes(8192))
    fs.writeFileSync(`${f}.migration-in-progress`, JSON.stringify({ backupPath: `${f}.gone.bak`, size: 0, mtimeMs: 0 })); tmp.push(`${f}.migration-in-progress`)
    let err
    try { openLocalDb(f, { key: key() }) } catch (e) { err = e }
    expect(err?.code).toBe('db_migration_interrupted')
  })

  it('an encrypted db the key cannot open and no upgrade in flight fails with db_unreadable (code survives openLocalDb)', () => {
    const f = tmpFile('unreadable')
    fs.writeFileSync(f, crypto.randomBytes(8192))
    let err
    try { openLocalDb(f, { key: key() }) } catch (e) { err = e }
    expect(err?.code).toBe('db_unreadable')
  })

  it('opens a fresh db KEYED, writes, and the on-disk file is NOT plaintext', () => {
    const f = tmpFile('fresh')
    const k = key()
    let db = openLocalDb(f, { key: k })
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('c1', 'Camp One')
    db.close()
    expect(isPlaintextSqliteFile(f)).toBe(false) // header is encrypted, not "SQLite format 3\0"

    // Reopen with the SAME key → reads back.
    db = openLocalDb(f, { key: k })
    expect(db.prepare('SELECT name FROM camps WHERE id = ?').get('c1').name).toBe('Camp One')
    db.close()
  })

  it('MIGRATES an existing plaintext db to encrypted on the first keyed open, preserving data', () => {
    const f = tmpFile('migrate')
    // 1. Create it plaintext (no key), write a row.
    let db = openLocalDb(f)
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('c9', 'Legacy Camp')
    db.close()
    expect(isPlaintextSqliteFile(f)).toBe(true)

    // 2. Open KEYED → migrates plaintext→encrypted, data preserved.
    const k = key()
    db = openLocalDb(f, { key: k })
    expect(db.prepare('SELECT name FROM camps WHERE id = ?').get('c9').name).toBe('Legacy Camp')
    db.close()
    expect(isPlaintextSqliteFile(f)).toBe(false) // now encrypted
    // The plaintext backup was shredded on success.
    expect(fs.readdirSync(path.dirname(f)).some((n) => n.startsWith(path.basename(f)) && n.includes('pre-migration'))).toBe(false)
  })

  it('a WRONG key cannot read an encrypted db', () => {
    const f = tmpFile('wrongkey')
    let db = openLocalDb(f, { key: key() })
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('c1', 'Secret')
    db.close()
    // A different key: the keyed open (no plaintext migration, header is not plaintext) then a read must fail.
    expect(() => {
      const bad = openLocalDb(f, { key: key() })
      bad.prepare('SELECT name FROM camps').get()
      bad.close()
    }).toThrow()
  })

  it('{ plaintext: true } opens a plaintext file WITHOUT migrating, even if a key is passed (era-fixture guard)', () => {
    const f = tmpFile('fixture')
    let db = openLocalDb(f) // plaintext
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('c1', 'Fixture Camp')
    db.close()
    expect(isPlaintextSqliteFile(f)).toBe(true)

    db = openLocalDb(f, { key: key(), plaintext: true }) // opt-out of encryption for this open
    expect(db.prepare('SELECT name FROM camps WHERE id = ?').get('c1').name).toBe('Fixture Camp')
    db.close()
    expect(isPlaintextSqliteFile(f)).toBe(true) // NOT migrated — the committed fixture is untouched
  })
})

// A visible marker when the driver is absent, so a skipped run is not mistaken for a passing one.
describe('SQLite at-rest driver availability', () => {
  it(driverAvailable ? 'driver present — encryption integration ran' : 'driver ABSENT — integration skipped (not a pass for encryption)', () => {
    expect(typeof driverAvailable).toBe('boolean')
  })
  // In CI a skipped encryption suite is a green that did not run: require the driver there, and say why not.
  it.runIf(onCI)('CI: the encrypting driver loads, so the real-crypto suite above actually ran', () => {
    expect(driverLoadError?.message ?? null).toBeNull()
    expect(driverAvailable).toBe(true)
  })
})
