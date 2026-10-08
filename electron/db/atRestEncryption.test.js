// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A fake safeStorage that "seals" with a fixed XOR — enough to prove the round-trip without a real
// keychain. Mirrors the shape getOrCreateDbKey requires (isEncryptionAvailable/encryptString/decryptString).
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`sealed:${s}`, 'utf8'),
    decryptString: (buf) => buf.toString('utf8').replace(/^sealed:/, ''),
  }
}

let userDataDir
beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-atrest-'))
  vi.resetModules()
  delete process.env.SHORESH_AT_REST_ENCRYPTION
})
afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true })
  delete process.env.SHORESH_AT_REST_ENCRYPTION
})

async function load() {
  return await import('./atRestEncryption.js')
}

describe('at-rest encryption activation flag', () => {
  it('defaults ON when unset — acquireDocCipher returns a cipher', async () => {
    const m = await load()
    expect(m.isAtRestEncryptionEnabled()).toBe(true)
    expect(m.acquireDocCipher(userDataDir, fakeSafeStorage())).not.toBeNull()
  })

  it('is OFF only for exactly "off"; any other value (typo, empty) stays ON', async () => {
    process.env.SHORESH_AT_REST_ENCRYPTION = 'off'
    expect((await load()).isAtRestEncryptionEnabled()).toBe(false)
    for (const v of ['of', 'OFF', 'false', '0', '']) {
      vi.resetModules()
      process.env.SHORESH_AT_REST_ENCRYPTION = v
      const m = await load()
      expect(m.isAtRestEncryptionEnabled(), `value ${JSON.stringify(v)}`).toBe(true)
    }
  })

  describe('sticky latch (no ambient disable once a device holds its key)', () => {
    it('env "off" + db.key.enc present -> latched ON, acquireDbKey returns a key', async () => {
      process.env.SHORESH_AT_REST_ENCRYPTION = 'on'
      const seed = await load()
      seed.acquireDbKey(userDataDir, fakeSafeStorage())
      vi.resetModules()
      process.env.SHORESH_AT_REST_ENCRYPTION = 'off'
      const m = await load()
      expect(m.isAtRestEncryptionEnabled()).toBe(false)
      expect(m.latchEncryptionIfKeyPresent(userDataDir)).toBe(true)
      expect(m.isAtRestEncryptionEnabled()).toBe(true)
      expect(m.acquireDbKey(userDataDir, fakeSafeStorage())).toBeInstanceOf(Buffer)
    })

    it('env "off" + no key file -> stays OFF', async () => {
      process.env.SHORESH_AT_REST_ENCRYPTION = 'off'
      const m = await load()
      expect(m.latchEncryptionIfKeyPresent(userDataDir)).toBe(false)
      expect(m.isAtRestEncryptionEnabled()).toBe(false)
    })

    it('unknown stat error (EACCES) fails closed -> latched ON', async () => {
      process.env.SHORESH_AT_REST_ENCRYPTION = 'off'
      const m = await load()
      const fsImpl = { statSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } }
      expect(m.latchEncryptionIfKeyPresent(userDataDir, { fsImpl })).toBe(true)
      expect(m.isAtRestEncryptionEnabled()).toBe(true)
    })
  })

  it('when "on", acquireDocCipher returns a working cipher keyed from the sealed device key', async () => {
    process.env.SHORESH_AT_REST_ENCRYPTION = 'on'
    const m = await load()
    expect(m.isAtRestEncryptionEnabled()).toBe(true)
    const cipher = m.acquireDocCipher(userDataDir, fakeSafeStorage())
    expect(cipher).not.toBeNull()
    const plain = Buffer.from('camp roster')
    expect(cipher.decrypt(cipher.encrypt(plain)).equals(plain)).toBe(true)
    // Key was persisted (sealed) so a second acquire yields the SAME key → decrypts the first's output.
    const again = m.acquireDocCipher(userDataDir, fakeSafeStorage())
    expect(again.decrypt(cipher.encrypt(plain)).equals(plain)).toBe(true)
  })

  it('when "on" but the keychain is unavailable, it FAILS CLOSED (throws, never plaintext)', async () => {
    process.env.SHORESH_AT_REST_ENCRYPTION = 'on'
    const m = await load()
    expect(() => m.acquireDocCipher(userDataDir, fakeSafeStorage(false))).toThrow(/keychain|unavailable/i)
  })
})
