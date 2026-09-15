// At-rest encryption: the per-device key that locks the camp's data on disk.
// ADR docs/adr/2026-09-15-at-rest-encryption-scoping.md (accepted: app-level encryption keyed to
// the OS keychain). This module is ONLY the key lifecycle — isolated and testable; nothing encrypts
// with it yet (the SQLite/`.automerge` wiring is a later, migration-guarded slice).
//
// THE KEY. A random 32 bytes, generated once per device, used to encrypt the SQLite db and the
// `.automerge` document. It is NOT stored in plaintext next to the data (that would be theatre) —
// it is sealed with Electron's `safeStorage`, which wraps it with a key the OS keychain
// (macOS Keychain / Windows DPAPI) releases only to THIS app under the logged-in user. The sealed
// blob sits at `<userDataDir>/db.key.enc`; an offline thief with the disk cannot unseal it without
// the user's OS login. There is no director passphrase to forget (ADR decision).
//
// FAIL CLOSED. If the OS keychain is unavailable (e.g. a headless Linux box with no keyring),
// `safeStorage` cannot protect a key, so we REFUSE rather than silently write an unprotected key —
// an unprotected key is worse than an honest error. The shipped targets (macOS, Windows) always
// have it. `safeStorage` is injected so this is unit-testable without a running Electron app.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const KEY_BYTES = 32 // 256-bit
const KEY_FILE = 'db.key.enc'

// getOrCreateDbKey(userDataDir, safeStorage) -> Buffer(32).
// safeStorage is Electron's `safeStorage` (or a compatible stub in tests): it must expose
// isEncryptionAvailable(), encryptString(str)->Buffer, decryptString(Buffer)->str.
export function getOrCreateDbKey(userDataDir, safeStorage, { fsImpl = fs } = {}) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
    throw new Error('getOrCreateDbKey: a safeStorage implementation is required')
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'getOrCreateDbKey: OS keychain encryption is unavailable on this machine, so the database key ' +
        'cannot be protected. Refusing to store an unprotected key. (macOS/Windows always support this; ' +
        'a Linux host needs an available keyring.)'
    )
  }
  const keyPath = path.join(userDataDir, KEY_FILE)
  if (fsImpl.existsSync(keyPath)) {
    const sealed = fsImpl.readFileSync(keyPath)
    const hex = safeStorage.decryptString(sealed)
    const key = Buffer.from(hex, 'hex')
    if (key.length !== KEY_BYTES) {
      throw new Error(`getOrCreateDbKey: stored key at ${keyPath} is malformed (expected ${KEY_BYTES} bytes)`)
    }
    return key
  }
  // First run on this device: mint, seal, persist. Write the sealed blob to a temp file and rename,
  // so a crash mid-write never leaves a half-written key file that would strand the data.
  const key = crypto.randomBytes(KEY_BYTES)
  const sealed = safeStorage.encryptString(key.toString('hex'))
  const tmp = `${keyPath}.tmp`
  fsImpl.writeFileSync(tmp, sealed)
  fsImpl.renameSync(tmp, keyPath)
  return key
}

// True if a device key has already been minted (used by the migration slice to decide encrypt-now
// vs already-encrypted).
export function hasDbKey(userDataDir, { fsImpl = fs } = {}) {
  return fsImpl.existsSync(path.join(userDataDir, KEY_FILE))
}
