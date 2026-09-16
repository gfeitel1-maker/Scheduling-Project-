// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { isPlaintextSqliteFile, rawKeyPragma, migratePlaintextToEncrypted } from './sqliteCipher.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const tmp = []
afterEach(() => { for (const f of tmp.splice(0)) { try { fs.rmSync(f, { force: true }) } catch { /* */ } } })
function tmpFile(tag) {
  const f = path.join(os.tmpdir(), `shoresh-sqlcipher-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  tmp.push(f, `${f}-wal`, `${f}-shm`, `${f}.enc-migrate`)
  return f
}

// Finding 5 gate: the `{ plaintext: true }` opt-out of encryption must be TEST-ONLY. If a production
// (non-test) file passed it, a keyed db could be silently opened plaintext — the bypass the opt-in
// must never become. This scans production source and fails if any NON-COMMENT line uses it.
describe('plaintext:true opt-in is test-only (finding 5 gate)', () => {
  it('no production (non-test) source passes plaintext: true in code', () => {
    const roots = [path.resolve(__dirname, '..'), path.resolve(__dirname, '../../scripts')] // electron/, scripts/
    const offenders = []
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name)
        if (ent.isDirectory()) { if (ent.name !== 'node_modules') walk(p); continue }
        if (!ent.name.endsWith('.js') || ent.name.endsWith('.test.js')) continue
        fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, '') // strip line comments
          if (/plaintext\s*:\s*true/.test(code)) offenders.push(`${p}:${i + 1}`)
        })
      }
    }
    for (const r of roots) walk(r)
    expect(offenders).toEqual([])
  })
})

describe('rawKeyPragma', () => {
  it('formats a 32-byte key as a SQLCipher raw-key pragma (no PBKDF2 stretching)', () => {
    const key = Buffer.alloc(32, 0xab)
    expect(rawKeyPragma(key)).toBe(`key = "x'${'ab'.repeat(32)}'"`)
  })
})

describe('isPlaintextSqliteFile — header detection, no driver guesswork', () => {
  it('returns true for a real plaintext SQLite file', () => {
    const f = tmpFile('plain')
    const db = new Database(f)
    db.exec('CREATE TABLE t (x)'); db.prepare('INSERT INTO t VALUES (1)').run(); db.close()
    expect(isPlaintextSqliteFile(f)).toBe(true)
  })
  it('returns false for a non-existent file (a fresh db is not a migration candidate)', () => {
    expect(isPlaintextSqliteFile(path.join(os.tmpdir(), `nope-${Math.random()}.sqlite`))).toBe(false)
  })
  it('returns false for an empty file', () => {
    const f = tmpFile('empty'); fs.writeFileSync(f, '')
    expect(isPlaintextSqliteFile(f)).toBe(false)
  })
  it('returns false for a file whose header is NOT the SQLite magic (stands in for encrypted bytes)', () => {
    const f = tmpFile('enc-like'); fs.writeFileSync(f, crypto.randomBytes(4096))
    expect(isPlaintextSqliteFile(f)).toBe(false)
  })
})

describe('migratePlaintextToEncrypted — orchestration safety (fakes; real crypto in the integration test)', () => {
  // A fake Database for the rekey-in-place flow: `pragma('rekey…')` "encrypts" by rewriting the file
  // content (so a later plaintext read would differ), and the verify reopen's read succeeds by
  // default. failRekey / failVerify exercise the abort+restore paths.
  function fakeDbFactory({ failRekey = false, failVerify = false } = {}) {
    const calls = []
    let verifyPhase = false
    function Fake(p) { this.p = p; calls.push(['open', p]) }
    Fake.prototype.pragma = function (s) {
      calls.push(['pragma', s])
      if (/^rekey/.test(s)) {
        if (failRekey) throw new Error('rekey failed')
        fs.writeFileSync(this.p, 'FAKE-ENCRYPTED') // in-place encryption rewrote the file
        verifyPhase = true
      } else if (/^key/.test(s)) {
        if (failVerify) throw new Error('wrong key')
      }
    }
    Fake.prototype.prepare = function () { return { get: () => ({ n: 1 }) } }
    Fake.prototype.close = function () { calls.push(['close', this.p]) }
    Fake._calls = calls
    void verifyPhase
    return Fake
  }

  it('backs up FIRST, rekeys in place, verifies, and shreds the backup on success', () => {
    const f = tmpFile('happy'); fs.writeFileSync(f, 'PLAINTEXT-ORIGINAL')
    const backups = []
    const writeBackup = (p) => { const b = `${p}.bak`; fs.copyFileSync(p, b); backups.push(b); tmp.push(b); return b }
    const Fake = fakeDbFactory()

    const res = migratePlaintextToEncrypted(f, Buffer.alloc(32, 1), { Database: Fake, writeBackup })

    expect(res.migrated).toBe(true)
    expect(fs.readFileSync(f, 'utf8')).toBe('FAKE-ENCRYPTED') // encrypted in place
    expect(fs.existsSync(backups[0])).toBe(false) // backup shredded on success
    expect(Fake._calls.some((c) => c[0] === 'pragma' && /^rekey/.test(c[1]))).toBe(true)
  })

  it('is FATAL if the backup fails — never proceeds to touch the db', () => {
    const f = tmpFile('nobackup'); fs.writeFileSync(f, 'PLAINTEXT')
    const Fake = fakeDbFactory()
    expect(() => migratePlaintextToEncrypted(f, Buffer.alloc(32, 1), {
      Database: Fake,
      writeBackup: () => { throw new Error('disk full') },
    })).toThrow(/backup failed/)
    expect(Fake._calls).toEqual([]) // never opened the db
    expect(fs.readFileSync(f, 'utf8')).toBe('PLAINTEXT') // original untouched
  })

  it('RESTORES the plaintext db from backup if rekey fails', () => {
    const f = tmpFile('rekeyfail'); fs.writeFileSync(f, 'PLAINTEXT-ORIGINAL')
    const writeBackup = (p) => { const b = `${p}.bak`; fs.copyFileSync(p, b); tmp.push(b); return b }
    const Fake = fakeDbFactory({ failRekey: true })

    expect(() => migratePlaintextToEncrypted(f, Buffer.alloc(32, 1), { Database: Fake, writeBackup }))
      .toThrow(/rekey/)
    expect(fs.readFileSync(f, 'utf8')).toBe('PLAINTEXT-ORIGINAL') // restored from backup
  })

  it('RESTORES from backup if the encrypted db fails verification', () => {
    const f = tmpFile('badverify'); fs.writeFileSync(f, 'PLAINTEXT-ORIGINAL')
    const writeBackup = (p) => { const b = `${p}.bak`; fs.copyFileSync(p, b); tmp.push(b); return b }
    const Fake = fakeDbFactory({ failVerify: true })

    expect(() => migratePlaintextToEncrypted(f, Buffer.alloc(32, 1), { Database: Fake, writeBackup }))
      .toThrow(/verification/)
    expect(fs.readFileSync(f, 'utf8')).toBe('PLAINTEXT-ORIGINAL') // rekey rewrote it, verify failed, restored
  })
})
