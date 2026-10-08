// @vitest-environment node
// At-rest encryption slice 1: the key lifecycle (docs/adr/2026-09-15-at-rest-encryption-scoping.md).
// safeStorage is stubbed — these pin the LOGIC (mint once, stable, sealed round-trip, fail-closed
// when the keychain is unavailable), not Electron's real crypto.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getOrCreateDbKey, getDbKey, hasDbKey, KEY_BYTES } from './dbEncryptionKey.js'

// A stub safeStorage that "seals" by tagging the string (NOT real encryption — the test only needs a
// reversible round-trip to exercise the module's mint/persist/read logic).
function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from('SEALED:' + s, 'utf8'),
    decryptString: (buf) => buf.toString('utf8').replace(/^SEALED:/, ''),
  }
}

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-dbkey-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('getOrCreateDbKey', () => {
  it('mints a 32-byte key on first call and returns the SAME key on later calls', () => {
    const ss = fakeSafeStorage()
    const k1 = getOrCreateDbKey(dir, ss)
    expect(Buffer.isBuffer(k1)).toBe(true)
    expect(k1.length).toBe(KEY_BYTES)
    const k2 = getOrCreateDbKey(dir, ss)
    expect(k2.equals(k1)).toBe(true) // stable — not regenerated each open
  })

  it('persists the key SEALED, never in plaintext', () => {
    const ss = fakeSafeStorage()
    const key = getOrCreateDbKey(dir, ss)
    const onDisk = fs.readFileSync(path.join(dir, 'db.key.enc'))
    expect(onDisk.toString('utf8').startsWith('SEALED:')).toBe(true) // went through safeStorage
    expect(onDisk.includes(key)).toBe(false) // raw key bytes are not on disk
    expect(hasDbKey(dir)).toBe(true)
  })

  it('a fresh device (new dir) mints a DIFFERENT key', () => {
    const ss = fakeSafeStorage()
    const a = getOrCreateDbKey(dir, ss)
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-dbkey2-'))
    try {
      const b = getOrCreateDbKey(dir2, ss)
      expect(b.equals(a)).toBe(false)
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true })
    }
  })

  it('FAILS CLOSED when the OS keychain is unavailable — never writes an unprotected key', () => {
    const ss = fakeSafeStorage({ available: false })
    expect(() => getOrCreateDbKey(dir, ss)).toThrow(/keychain encryption is unavailable|Refusing/)
    expect(hasDbKey(dir)).toBe(false) // nothing written
  })

  it('requires a safeStorage implementation', () => {
    expect(() => getOrCreateDbKey(dir, null)).toThrow(/safeStorage/)
  })

  it('rejects a malformed stored key rather than using it', () => {
    const ss = fakeSafeStorage()
    fs.writeFileSync(path.join(dir, 'db.key.enc'), ss.encryptString('deadbeef')) // 4 bytes, not 32
    expect(() => getOrCreateDbKey(dir, ss)).toThrow(/malformed/)
  })
})

describe('getOrCreateDbKey — never mint over an existing encrypted db', () => {
  const MAGIC = Buffer.from('SQLite format 3\0', 'latin1')

  it('refuses when an Automerge doc file is encrypted (docPaths), but not when it is plaintext Automerge', () => {
    const enc = path.join(dir, 'a.automerge'); fs.writeFileSync(enc, Buffer.concat([Buffer.from('SHEN', 'ascii'), Buffer.alloc(64)]))
    let err
    try { getOrCreateDbKey(dir, fakeSafeStorage(), { docPaths: [enc] }) } catch (e) { err = e }
    expect(err?.code).toBe('db_key_file_missing')
    const plain = path.join(dir, 'b.automerge'); fs.writeFileSync(plain, Buffer.from([0x85, 0x6f, 0x4a, 0x83, 1, 2, 3]))
    expect(getOrCreateDbKey(dir, fakeSafeStorage(), { docPaths: [plain] })).toHaveLength(32)
  })

  it('refuses with db_key_file_missing when a data path is encrypted and the key file is gone', () => {
    const data = path.join(dir, 'camp.sqlite')
    fs.writeFileSync(data, Buffer.alloc(4096, 0x9c))
    let err
    try { getOrCreateDbKey(dir, fakeSafeStorage(), { dataPaths: [data] }) } catch (e) { err = e }
    expect(err?.code).toBe('db_key_file_missing')
    expect(err.message).toMatch(/encryption key file is missing/)
    expect(err.message).toContain('db.key.enc')
    expect(hasDbKey(dir)).toBe(false) // no key written
  })

  it.each([
    ['plaintext', () => MAGIC],
    ['empty', () => Buffer.alloc(0)],
    ['absent', () => null],
  ])('still mints when the data path is %s', (_n, content) => {
    const data = path.join(dir, 'camp.sqlite')
    const c = content()
    if (c) fs.writeFileSync(data, c)
    expect(getOrCreateDbKey(dir, fakeSafeStorage(), { dataPaths: [data] }).length).toBe(KEY_BYTES)
    expect(hasDbKey(dir)).toBe(true)
  })

  it('an existing key file is read as before even when the db is encrypted', () => {
    const ss = fakeSafeStorage()
    const k = getOrCreateDbKey(dir, ss)
    const data = path.join(dir, 'camp.sqlite')
    fs.writeFileSync(data, Buffer.alloc(4096, 0x9c))
    expect(getOrCreateDbKey(dir, ss, { dataPaths: [data] }).equals(k)).toBe(true)
  })
})

describe('getOrCreateDbKey — unreadable existing data fails closed', () => {
  const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
  const throwingFs = (method) => ({ ...fs, [method]: () => { throw eacces() } })

  it.each([
    ['docPaths', 'readFileSync', (p) => ({ docPaths: [p] })],
    ['dataPaths', 'openSync', (p) => ({ dataPaths: [p] })],
  ])('an EACCES reading an existing %s file refuses to mint', (_n, method, mk) => {
    const p = path.join(dir, 'x.file'); fs.writeFileSync(p, Buffer.alloc(64, 0x9c))
    let err
    try { getOrCreateDbKey(dir, fakeSafeStorage(), { fsImpl: throwingFs(method), ...mk(p) }) } catch (e) { err = e }
    expect(err?.code).toBe('db_key_guard_unreadable')
    expect(err.message).toContain(p)
    expect(err.message).toMatch(/key was not created/)
    expect(hasDbKey(dir)).toBe(false)
  })

  it('an ENOENT file is nothing to guard and still mints', () => {
    const p = path.join(dir, 'absent.automerge')
    expect(getOrCreateDbKey(dir, fakeSafeStorage(), { docPaths: [p], dataPaths: [p] })).toHaveLength(32)
  })
})

describe('getOrCreateDbKey — docPaths getter is lazy', () => {
  it('is not called when a key file already exists (a readdir error cannot block a keyed device)', () => {
    const ss = fakeSafeStorage()
    getOrCreateDbKey(dir, ss)
    const docPaths = () => { throw new Error('transient readdir failure') }
    expect(getOrCreateDbKey(dir, ss, { docPaths })).toHaveLength(32)
  })
  it('is called, and its result judged, when no key file exists', () => {
    const enc = path.join(dir, 'a.automerge'); fs.writeFileSync(enc, Buffer.concat([Buffer.from('SHEN', 'ascii'), Buffer.alloc(64)]))
    let err
    try { getOrCreateDbKey(dir, fakeSafeStorage(), { docPaths: () => [enc] }) } catch (e) { err = e }
    expect(err?.code).toBe('db_key_file_missing')
  })
})

describe('keychain unavailable', () => {
  it('throws keychain_unavailable naming the escape and its limit', () => {
    let err
    try { getOrCreateDbKey(dir, fakeSafeStorage({ available: false })) } catch (e) { err = e }
    expect(err?.code).toBe('keychain_unavailable')
    expect(err.message).toContain('SHORESH_AT_REST_ENCRYPTION=off')
    expect(err.message).toMatch(/not yet encrypted/)
  })
})

describe('getDbKey — read-only', () => {
  it('throws db_key_not_created and writes nothing when no key file exists', () => {
    let err
    try { getDbKey(dir, fakeSafeStorage()) } catch (e) { err = e }
    expect(err?.code).toBe('db_key_not_created')
    expect(err.message).toMatch(/open the app once first/)
    expect(hasDbKey(dir)).toBe(false)
  })
  it('returns the key minted by getOrCreateDbKey', () => {
    const ss = fakeSafeStorage()
    const k = getOrCreateDbKey(dir, ss)
    expect(getDbKey(dir, ss).equals(k)).toBe(true)
  })
})
