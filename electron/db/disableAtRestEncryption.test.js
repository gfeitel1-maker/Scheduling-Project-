// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { disableAtRestEncryption } from './disableAtRestEncryption.js'
import { getOrCreateDbKey, KEY_FILE } from './dbEncryptionKey.js'
import { makeDocCipher } from './docCipher.js'
import { isPlaintextSqliteFile } from './sqliteCipher.js'

const MAGIC = 'SQLite format 3\0'
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => b.toString().replace(/^sealed:/, ''),
}

// Stand-in for the encrypting driver (the native module cannot load under every Node here; the
// real-driver proof lives in sqliteCipher.integration.test.js). File = 'ENC'|MAGIC prefix + JSON table counts.
function fakeDriver({ failRekey = false, corruptAfterRekey = false } = {}) {
  const calls = []
  function Fake(p) { this.p = p; this.keyed = false }
  Fake.prototype.pragma = function (s) {
    calls.push(s)
    if (/^key\s*=/.test(s)) { this.keyed = true; return }
    if (/^rekey\s*=\s*''$/.test(s)) {
      if (failRekey) throw new Error('disk I/O error')
      const body = fs.readFileSync(this.p, 'latin1')
      if (!body.startsWith('ENC')) throw new Error('not keyed')
      let json = body.slice(3)
      if (corruptAfterRekey) json = JSON.stringify({ camps: 99 })
      fs.writeFileSync(this.p, MAGIC + json, 'latin1')
    }
  }
  const readable = (self) => {
    const body = fs.readFileSync(self.p, 'latin1')
    const enc = body.startsWith('ENC')
    if (enc !== self.keyed) throw Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' })
    return JSON.parse(enc ? body.slice(3) : body.slice(MAGIC.length))
  }
  Fake.prototype.prepare = function (sql) {
    const self = this
    if (/sqlite_master/.test(sql) && /name/.test(sql)) return { all: () => Object.keys(readable(self)).map((name) => ({ name })) }
    const m = /FROM "(\w+)"/.exec(sql)
    if (m) return { get: () => ({ n: readable(self)[m[1]] }) }
    return { get: () => ({ n: Object.keys(readable(self)).length }) }
  }
  Fake.prototype.close = function () {}
  Fake._calls = calls
  return Fake
}

let dir, dbPath, docPath, docKey, keyPath
const tables = { camps: 1, users: 3 }
const docBytes = Buffer.concat([Buffer.from([0x85, 0x6f, 0x4a, 0x83]), crypto.randomBytes(64)])

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-disable-'))
  fs.mkdirSync(path.join(dir, 'automerge'))
  const key = getOrCreateDbKey(dir, safeStorage)
  keyPath = path.join(dir, KEY_FILE)
  docKey = makeDocCipher(key)
  dbPath = path.join(dir, 'camp.sqlite')
  fs.writeFileSync(dbPath, `ENC${JSON.stringify(tables)}`, 'latin1')
  docPath = path.join(dir, 'automerge', 'camp-1.automerge')
  fs.writeFileSync(docPath, docKey.encrypt(docBytes))
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const run = (over = {}) => disableAtRestEncryption({
  userDataDir: dir, dbPaths: [dbPath], safeStorage, Database: fakeDriver(), ...over,
})
const snapshot = () => ({
  db: fs.readFileSync(dbPath), doc: fs.readFileSync(docPath), key: fs.existsSync(keyPath),
  files: fs.readdirSync(dir).sort(),
})
const expectUntouchedEncrypted = (before) => {
  expect(fs.readFileSync(dbPath).equals(before.db)).toBe(true)
  expect(fs.readFileSync(docPath).equals(before.doc)).toBe(true)
  expect(fs.existsSync(keyPath)).toBe(true)
  expect(fs.existsSync(path.join(dir, 'encryption.disabled'))).toBe(false)
  expect(isPlaintextSqliteFile(dbPath)).toBe(false)
  expect(docKey.decrypt(fs.readFileSync(docPath)).equals(docBytes)).toBe(true)
}

describe('disableAtRestEncryption: happy path', () => {
  it('decrypts the SQLite db and the document, verifies, shreds the key and writes the opt-out marker', () => {
    const res = run()
    expect(res.disabled).toBe(true)
    expect(isPlaintextSqliteFile(dbPath)).toBe(true)
    expect(JSON.parse(fs.readFileSync(dbPath, 'latin1').slice(MAGIC.length))).toEqual(tables)
    expect(fs.readFileSync(docPath).equals(docBytes)).toBe(true)
    expect(fs.existsSync(keyPath)).toBe(false)
    expect(fs.existsSync(path.join(dir, 'encryption.disabled'))).toBe(true)
    expect(fs.readdirSync(dir).filter((n) => /\.bak$|disabling|\.tmp$/.test(n))).toEqual([])
    expect(fs.readdirSync(path.join(dir, 'automerge'))).toEqual(['camp-1.automerge'])
  })

  it('decrypts every listed database, not just the current one', () => {
    const other = path.join(dir, 'other.sqlite')
    fs.writeFileSync(other, `ENC${JSON.stringify({ camps: 5 })}`, 'latin1')
    run({ dbPaths: [dbPath, other] })
    expect(isPlaintextSqliteFile(other)).toBe(true)
  })
})

describe('disableAtRestEncryption: refuses on unknown or inconsistent state, touching nothing', () => {
  it('no key file: not encrypted', () => {
    fs.rmSync(keyPath)
    const before = { ...snapshot(), key: false }
    expect(() => run()).toThrow(expect.objectContaining({ code: 'not_encrypted' }))
    expect(fs.readFileSync(dbPath).equals(before.db)).toBe(true)
  })

  it('key file stat fails with something other than ENOENT: unknown_state', () => {
    const before = snapshot()
    const fsImpl = { ...fs, statSync: (p, ...a) => { if (String(p).endsWith(KEY_FILE)) throw Object.assign(new Error('x'), { code: 'EIO' }); return fs.statSync(p, ...a) } }
    expect(() => run({ fsImpl })).toThrow(expect.objectContaining({ code: 'unknown_state' }))
    expectUntouchedEncrypted(before)
  })

  it('key present but the keychain cannot unseal it: unknown_state', () => {
    const before = snapshot()
    const broken = { ...safeStorage, decryptString: () => { throw new Error('keychain locked') } }
    expect(() => run({ safeStorage: broken })).toThrow(expect.objectContaining({ code: 'unknown_state' }))
    expectUntouchedEncrypted(before)
  })

  it('db already plaintext while a key exists: unknown_state, not "safe"', () => {
    fs.writeFileSync(dbPath, MAGIC + JSON.stringify(tables), 'latin1')
    expect(() => run()).toThrow(expect.objectContaining({ code: 'unknown_state' }))
    expect(fs.existsSync(keyPath)).toBe(true)
  })

  it('db file unreadable/missing: unknown_state', () => {
    fs.rmSync(dbPath)
    expect(() => run()).toThrow(expect.objectContaining({ code: 'unknown_state' }))
    expect(fs.existsSync(keyPath)).toBe(true)
  })

  it('the db does not open with the key (wrong key): unknown_state', () => {
    fs.writeFileSync(dbPath, crypto.randomBytes(100))
    const before = snapshot()
    expect(() => run()).toThrow(expect.objectContaining({ code: 'unknown_state' }))
    expect(fs.readFileSync(dbPath).equals(before.db)).toBe(true)
    expect(fs.existsSync(keyPath)).toBe(true)
  })

  it('a document that does not decrypt (tampered): refused before anything changes', () => {
    const tampered = Buffer.from(fs.readFileSync(docPath)); tampered[tampered.length - 1] ^= 1
    fs.writeFileSync(docPath, tampered)
    const before = snapshot()
    expect(() => run()).toThrow(expect.objectContaining({ code: 'unknown_state' }))
    expect(fs.readFileSync(docPath).equals(tampered)).toBe(true)
    expect(fs.readFileSync(dbPath).equals(before.db)).toBe(true)
    expect(fs.existsSync(keyPath)).toBe(true)
    expect(fs.readdirSync(dir).filter((n) => /bak|tmp|disabl/.test(n))).toEqual([])
  })
})

describe('disableAtRestEncryption: a failure at each step leaves the device encrypted, readable, nothing lost', () => {
  it('backup of the database fails', () => {
    const before = snapshot()
    const fsImpl = { ...fs, copyFileSync: (a, b, ...r) => { if (/pre-disable/.test(String(b))) throw new Error('disk full'); return fs.copyFileSync(a, b, ...r) } }
    expect(() => run({ fsImpl })).toThrow(expect.objectContaining({ code: 'backup_failed' }))
    expectUntouchedEncrypted(before)
    expect(fs.readdirSync(dir).sort()).toEqual(before.files)
  })

  it('document decrypt fails (write error)', () => {
    const before = snapshot()
    const fsImpl = { ...fs, renameSync: (a, b, ...r) => { if (String(b).endsWith('.automerge')) throw new Error('EIO'); return fs.renameSync(a, b, ...r) } }
    expect(() => run({ fsImpl })).toThrow(expect.objectContaining({ code: 'doc_decrypt_failed' }))
    expectUntouchedEncrypted(before)
  })

  it('rekey fails', () => {
    const before = snapshot()
    expect(() => run({ Database: fakeDriver({ failRekey: true }) })).toThrow(expect.objectContaining({ code: 'rekey_failed' }))
    expectUntouchedEncrypted(before)
  })

  it('rekey on the SECOND database fails: the first is put back too', () => {
    const other = path.join(dir, 'other.sqlite')
    fs.writeFileSync(other, `ENC${JSON.stringify({ camps: 5 })}`, 'latin1')
    const before = snapshot()
    const otherBefore = fs.readFileSync(other)
    const Fake = fakeDriver()
    const origPragma = Fake.prototype.pragma
    Fake.prototype.pragma = function (s) { if (/^rekey/.test(s) && this.p === other) throw new Error('boom'); return origPragma.call(this, s) }
    expect(() => run({ dbPaths: [dbPath, other], Database: Fake })).toThrow(expect.objectContaining({ code: 'rekey_failed' }))
    expectUntouchedEncrypted(before)
    expect(fs.readFileSync(other).equals(otherBefore)).toBe(true)
  })

  it('verification fails (row counts differ after decrypt)', () => {
    const before = snapshot()
    expect(() => run({ Database: fakeDriver({ corruptAfterRekey: true }) })).toThrow(expect.objectContaining({ code: 'verify_failed' }))
    expectUntouchedEncrypted(before)
  })

  it('key shred fails: everything is put back and the key is still there', () => {
    const before = snapshot()
    const fsImpl = { ...fs, renameSync: (a, b, ...r) => { if (String(a).endsWith(KEY_FILE)) throw new Error('EPERM'); return fs.renameSync(a, b, ...r) } }
    expect(() => run({ fsImpl })).toThrow(expect.objectContaining({ code: 'shred_failed' }))
    expectUntouchedEncrypted(before)
  })

  it('writing the opt-out marker fails', () => {
    const before = snapshot()
    const fsImpl = { ...fs, writeFileSync: (p, ...r) => { if (String(p).endsWith('encryption.disabled')) throw new Error('EROFS'); return fs.writeFileSync(p, ...r) } }
    expect(() => run({ fsImpl })).toThrow(expect.objectContaining({ code: 'shred_failed' }))
    expectUntouchedEncrypted(before)
  })
})

describe('latch after disable', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

  async function freshAtRest(env) {
    vi.resetModules()
    vi.stubEnv('SHORESH_AT_REST_ENCRYPTION', env)
    return import('./atRestEncryption.js')
  }

  it('before: a keyed device is latched on even with the env off', async () => {
    const m = await freshAtRest('off')
    expect(m.latchEncryptionIfKeyPresent(dir)).toBe(true)
    expect(m.isAtRestEncryptionEnabled()).toBe(true)
  })

  it('after: the next launch opens plaintext, even though the default is ON', async () => {
    run()
    const m = await freshAtRest('on')
    m.latchEncryptionIfKeyPresent(dir)
    expect(m.isAtRestEncryptionEnabled()).toBe(false)
    expect(m.acquireDbKey(dir, safeStorage)).toBeNull()
    expect(m.acquireDocCipher(dir, safeStorage)).toBeNull()
  })

  it('a key file present beats the opt-out marker (inconsistent state stays encrypted)', async () => {
    fs.writeFileSync(path.join(dir, 'encryption.disabled'), '{}')
    const m = await freshAtRest('on')
    m.latchEncryptionIfKeyPresent(dir)
    expect(m.isAtRestEncryptionEnabled()).toBe(true)
  })

  it('an unreadable marker/key state never reads as disabled', async () => {
    const m = await freshAtRest('on')
    const fsImpl = { ...fs, statSync: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }) } }
    m.latchEncryptionIfKeyPresent(dir, { fsImpl })
    expect(m.isAtRestEncryptionEnabled()).toBe(true)
  })
})
