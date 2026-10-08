// @vitest-environment node
//
// End-to-end proof of SQLite at-rest encryption through the REAL openLocalDb + the REAL encrypting
// driver (better-sqlite3-multiple-ciphers). Gated on the driver being installed and built: on a
// runtime where it is absent (e.g. a Node version with no prebuilt and a failed source build), this
// whole file SKIPS rather than fails — the driver is an optional dependency only reached when
// encryption is enabled. The migration ORCHESTRATION and header detection are covered without the
// driver in sqliteCipher.test.js; this file proves the actual crypto + the openLocalDb wiring.
import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { openLocalDb } from './localDb.js'
import { isPlaintextSqliteFile } from './sqliteCipher.js'

const require = createRequire(import.meta.url)
// require() succeeding is NOT enough — the native binding is located lazily and only fails at
// construction. Actually build a throwaway in-memory db to prove the driver is usable here.
let driverAvailable = false
try { const D = require('better-sqlite3-multiple-ciphers'); D(':memory:').close(); driverAvailable = true } catch { driverAvailable = false }

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

describe.skipIf(!driverAvailable)('SQLite at-rest encryption — real driver, through openLocalDb', () => {
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
    fs.writeFileSync(`${f}.migration-in-progress`, bak); tmp.push(`${f}.migration-in-progress`)

    const db = openLocalDb(f, { key: k })
    expect(db.prepare('SELECT name FROM camps WHERE id = ?').get('c1').name).toBe('Camp One')
    db.close()
    expect(isPlaintextSqliteFile(f)).toBe(false)
    expect(fs.existsSync(bak)).toBe(false) // no plaintext copy left behind
  })

  it('an unreadable db with no plaintext .bak fails with db_migration_interrupted, not an opaque error', () => {
    const f = tmpFile('crash-nobak')
    fs.writeFileSync(f, crypto.randomBytes(8192))
    fs.writeFileSync(`${f}.migration-in-progress`, ''); tmp.push(`${f}.migration-in-progress`)
    let err
    try { openLocalDb(f, { key: key() }) } catch (e) { err = e }
    expect(err?.code).toBe('db_migration_interrupted')
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
})
