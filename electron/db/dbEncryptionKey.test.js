// @vitest-environment node
// At-rest encryption slice 1: the key lifecycle (docs/adr/2026-09-15-at-rest-encryption-scoping.md).
// safeStorage is stubbed — these pin the LOGIC (mint once, stable, sealed round-trip, fail-closed
// when the keychain is unavailable), not Electron's real crypto.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getOrCreateDbKey, hasDbKey, KEY_BYTES } from './dbEncryptionKey.js'

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
