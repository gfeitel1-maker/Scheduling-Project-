// At-rest encryption of the camp document bytes (ADR docs/adr/2026-09-15-at-rest-encryption-scoping.md).
// AES-256-GCM (authenticated: tampering with an on-disk file is detected on read, not silently
// applied) under the per-device key from dbEncryptionKey.js. Pure Node crypto; the key is injected,
// so this is unit-testable without Electron or the keychain.
//
// ON-DISK FORMAT:  MAGIC(4) | VERSION(1) | IV(12) | AUTH_TAG(16) | CIPHERTEXT
//
// LEGACY / MIGRATION. decrypt() is passthrough for any buffer that does NOT start with MAGIC — an
// Automerge document (which begins with its own magic 0x85 0x6f 0x4a 0x83) is returned unchanged.
// So a device upgraded from the plaintext era loads its existing `.automerge` file fine, and the
// NEXT save re-writes it encrypted. No separate migration step, and no way to confuse the two
// formats (the magics differ and GCM authenticates).
import crypto from 'node:crypto'
import { KEY_BYTES } from './dbEncryptionKey.js'

const MAGIC = Buffer.from('SHEN', 'ascii') // Shoresh ENcrypted — distinct from Automerge's 0x856f4a83
const VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16
const HEADER = MAGIC.length + 1 + IV_BYTES + TAG_BYTES

export function isEncrypted(buf) {
  return Buffer.isBuffer(buf) && buf.length >= MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC)
}

// makeDocCipher(key: Buffer(32)) -> { encrypt(plain: Buffer) -> Buffer, decrypt(buf: Buffer) -> Buffer }
export function makeDocCipher(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`makeDocCipher: key must be a ${KEY_BYTES}-byte Buffer`)
  }
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(IV_BYTES)
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      const enc = Buffer.concat([cipher.update(plain), cipher.final()])
      const tag = cipher.getAuthTag()
      return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, tag, enc])
    },
    decrypt(buf) {
      // Legacy/plaintext (or a raw Automerge doc): return unchanged so an un-migrated file still loads.
      if (!isEncrypted(buf)) return buf
      const version = buf[MAGIC.length]
      if (version !== VERSION) {
        throw new Error(`docCipher: unsupported encrypted-document version ${version}`)
      }
      const iv = buf.subarray(MAGIC.length + 1, MAGIC.length + 1 + IV_BYTES)
      const tag = buf.subarray(MAGIC.length + 1 + IV_BYTES, HEADER)
      const enc = buf.subarray(HEADER)
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(enc), decipher.final()]) // .final() throws if tampered
    },
  }
}
