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
  it('defaults OFF when unset — acquireDocCipher returns null (plaintext)', async () => {
    const m = await load()
    expect(m.isAtRestEncryptionEnabled()).toBe(false)
    expect(m.acquireDocCipher(userDataDir, fakeSafeStorage())).toBeNull()
  })

  it('stays OFF for any value other than exactly "on" (typo/"off"/empty never half-enables)', async () => {
    for (const v of ['off', 'ON', 'true', '1', '']) {
      vi.resetModules()
      process.env.SHORESH_AT_REST_ENCRYPTION = v
      const m = await load()
      expect(m.isAtRestEncryptionEnabled(), `value ${JSON.stringify(v)}`).toBe(false)
    }
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
