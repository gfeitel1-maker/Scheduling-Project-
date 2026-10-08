// At-rest encryption activation switch + key acquisition (ADR
// docs/adr/2026-09-15-at-rest-encryption-scoping.md; ticket T175).
//
// DEFAULT ON, AND STICKY. Encryption is on unless SHORESH_AT_REST_ENCRYPTION is exactly 'off'. 'off' is
// a pre-activation / test escape only: once a device holds its key file (db.key.enc) the variable is
// ignored (latchEncryptionIfKeyPresent), because flipping an already-encrypted device to plaintext
// mode makes its own data unreadable. No in-app disable is offered; see
// docs/adr/2026-10-08-at-rest-encryption-sticky-no-ambient-disable.md.
import fs from 'node:fs'
import path from 'node:path'
import { getOrCreateDbKey, KEY_FILE } from './dbEncryptionKey.js'
import { makeDocCipher } from './docCipher.js'

const rawValue = process.env.SHORESH_AT_REST_ENCRYPTION

export const AT_REST_ENCRYPTION = rawValue === 'off' ? 'off' : 'on'

let stickyOn = false

// An unknown state (any error but ENOENT) latches ON: it must never read as safe to disable.
export function latchEncryptionIfKeyPresent(userDataDir, { fsImpl = fs } = {}) {
  try {
    fsImpl.statSync(path.join(userDataDir, KEY_FILE))
    stickyOn = true
  } catch (err) {
    if (err?.code !== 'ENOENT') stickyOn = true
  }
  return stickyOn
}

export function isAtRestEncryptionEnabled() {
  return AT_REST_ENCRYPTION === 'on' || stickyOn
}

// acquireDbKey(userDataDir, safeStorage) -> Buffer(32) | null
// The raw per-device key for SQLite (SQLCipher PRAGMA key), or null when encryption is off. This is
// the SAME key acquireDocCipher uses — one device key locks both the .automerge document and the
// SQLite db (ADR decision). Throws (fail-closed) if enabled but the keychain is unavailable.
export function acquireDbKey(userDataDir, safeStorage, { dataPaths, docPaths } = {}) {
  if (!isAtRestEncryptionEnabled()) return null
  return getOrCreateDbKey(userDataDir, safeStorage, { dataPaths, docPaths })
}

// acquireDocCipher(userDataDir, safeStorage) -> { encrypt, decrypt } | null
// Returns the per-device document cipher when encryption is enabled, else null (plaintext — the
// caller keeps its existing behavior). Injecting safeStorage keeps this unit-testable without
// Electron. Throws only if encryption is ENABLED but the key cannot be obtained (fail-closed: a
// device told to encrypt must not silently fall back to plaintext — see dbEncryptionKey.js).
export function acquireDocCipher(userDataDir, safeStorage, { dataPaths, docPaths } = {}) {
  if (!isAtRestEncryptionEnabled()) return null
  const key = getOrCreateDbKey(userDataDir, safeStorage, { dataPaths, docPaths })
  return makeDocCipher(key)
}
