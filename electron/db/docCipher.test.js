// @vitest-environment node
import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { makeDocCipher, isEncrypted } from './docCipher.js'

const key = () => crypto.randomBytes(32)

describe('makeDocCipher', () => {
  it('round-trips: decrypt(encrypt(x)) === x for arbitrary bytes', () => {
    const c = makeDocCipher(key())
    for (const plain of [Buffer.from(''), Buffer.from('hello'), crypto.randomBytes(1), crypto.randomBytes(4096)]) {
      expect(c.decrypt(c.encrypt(plain)).equals(plain)).toBe(true)
    }
  })

  it('ciphertext is not the plaintext and is marked encrypted', () => {
    const c = makeDocCipher(key())
    const plain = Buffer.from('camp secrets')
    const enc = c.encrypt(plain)
    expect(isEncrypted(enc)).toBe(true)
    expect(enc.includes(plain)).toBe(false)
    // two encryptions of the same plaintext differ (fresh IV each time)
    expect(c.encrypt(plain).equals(c.encrypt(plain))).toBe(false)
  })

  it('LEGACY passthrough: a plaintext / raw-Automerge buffer decrypts to itself unchanged', () => {
    const c = makeDocCipher(key())
    // A real Automerge file starts with 0x85 0x6f 0x4a 0x83 — not our MAGIC.
    const automergeLike = Buffer.from([0x85, 0x6f, 0x4a, 0x83, 1, 2, 3])
    expect(isEncrypted(automergeLike)).toBe(false)
    expect(c.decrypt(automergeLike).equals(automergeLike)).toBe(true)
  })

  it('detects tampering: a flipped byte in the ciphertext throws, never returns bad plaintext', () => {
    const c = makeDocCipher(key())
    const enc = Buffer.from(c.encrypt(Buffer.from('important')))
    enc[enc.length - 1] ^= 0xff // flip a ciphertext byte
    expect(() => c.decrypt(enc)).toThrow()
  })

  it('a different key cannot decrypt', () => {
    const enc = makeDocCipher(key()).encrypt(Buffer.from('x'))
    expect(() => makeDocCipher(key()).decrypt(enc)).toThrow()
  })

  it('rejects a wrong-sized key', () => {
    expect(() => makeDocCipher(crypto.randomBytes(16))).toThrow(/32-byte/)
  })
})
