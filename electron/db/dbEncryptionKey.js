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
import { isPlaintextSqliteFile } from './sqliteCipher.js'
import { isEncrypted as isEncryptedDoc } from './docCipher.js'

export const KEY_BYTES = 32 // 256-bit
export const KEY_FILE = 'db.key.enc'

function coded(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

function requireSafeStorage(safeStorage, who) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
    throw new Error(`${who}: a safeStorage implementation is required`)
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw coded(
      'keychain_unavailable',
      `${who}: OS keychain encryption is unavailable on this machine, so the database key ` +
        'cannot be protected. Refusing to store an unprotected key. (macOS/Windows always support this; ' +
        'a Linux host needs an available keyring.) To run without at-rest encryption, set ' +
        'SHORESH_AT_REST_ENCRYPTION=off — this works only on a device that is not yet encrypted; ' +
        'it is ignored once db.key.enc exists.'
    )
  }
}

function isEncryptedDataFile(p, fsImpl) {
  try {
    return fsImpl.statSync(p).size > 0 && !isPlaintextSqliteFile(p, { fsImpl })
  } catch {
    return false
  }
}

function isEncryptedDocFile(p, fsImpl) {
  try {
    return isEncryptedDoc(fsImpl.readFileSync(p).subarray(0, 4))
  } catch {
    return false
  }
}

function readKey(keyPath, safeStorage, fsImpl) {
  const sealed = fsImpl.readFileSync(keyPath)
  const hex = safeStorage.decryptString(sealed)
  const key = Buffer.from(hex, 'hex')
  if (key.length !== KEY_BYTES) {
    throw new Error(`getOrCreateDbKey: stored key at ${keyPath} is malformed (expected ${KEY_BYTES} bytes)`)
  }
  return key
}

// getDbKey(userDataDir, safeStorage) -> Buffer(32). Read-only: never mints. For the headless/tool
// path, which must not create a device key just because it was asked for one.
export function getDbKey(userDataDir, safeStorage, { fsImpl = fs } = {}) {
  requireSafeStorage(safeStorage, 'getDbKey')
  const keyPath = path.join(userDataDir, KEY_FILE)
  if (!fsImpl.existsSync(keyPath)) {
    throw coded('db_key_not_created', 'this device has no database key yet — open the app once first')
  }
  return readKey(keyPath, safeStorage, fsImpl)
}

// getOrCreateDbKey(userDataDir, safeStorage, { dataPaths }) -> Buffer(32).
// safeStorage is Electron's `safeStorage` (or a compatible stub in tests): it must expose
// isEncryptionAvailable(), encryptString(str)->Buffer, decryptString(Buffer)->str.
// dataPaths: existing data files this key would have to open. If the key file is gone but one of
// them is already encrypted (docPaths: Automerge docs, judged by the SHEN header), minting a fresh key would orphan it, so refuse instead.
export function getOrCreateDbKey(userDataDir, safeStorage, { fsImpl = fs, dataPaths = [], docPaths = [] } = {}) {
  requireSafeStorage(safeStorage, 'getOrCreateDbKey')
  const keyPath = path.join(userDataDir, KEY_FILE)
  if (fsImpl.existsSync(keyPath)) return getDbKey(userDataDir, safeStorage, { fsImpl })
  const orphaned = dataPaths.find((p) => isEncryptedDataFile(p, fsImpl)) ?? docPaths.find((p) => isEncryptedDocFile(p, fsImpl))
  if (orphaned) {
    throw coded(
      'db_key_file_missing',
      `The encryption key file is missing (${keyPath}) but ${orphaned} is already encrypted. ` +
        'Refusing to create a new key, which would make that data permanently unreadable. ' +
        'Restore db.key.enc, or recover by re-syncing this device from a paired peer; see ' +
        'docs/current/KEY_RECOVERY_STORY.md.'
    )
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
