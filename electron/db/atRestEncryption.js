// At-rest encryption activation switch + key acquisition (ADR
// docs/adr/2026-09-15-at-rest-encryption-scoping.md; ticket T175).
//
// WHY A FLAG, AND WHY IT DEFAULTS OFF. Turning on at-rest encryption is a one-way, one-time
// migration of every device's on-disk bytes from plaintext to encrypted, and a botched migration
// must never risk a camp's data. The mechanism (key provider, document cipher, SQLite keying,
// migration) is built and unit-tested, but the LIVE flip must be verified against the real running
// Electron app on a real OS keychain — something the test suite cannot prove (safeStorage needs
// Electron; a native SQLite migration needs a real file). So the flip is staged behind this flag,
// exactly the way the sync-engine cutover was (syncEngineFlag.js): the code path is complete and
// reversible, and the default stays OFF until that real-app smoke passes, at which point the default
// here flips in a one-line change with the smoke evidence recorded.
//
// Read ONCE at import, mirroring the repo's other env toggles (SHORESH_SYNC_ENGINE, SHORESH_SMOKE_NONCE).
// The fail-safe direction is OFF: an unset or mistyped value leaves data in the current (plaintext)
// state, never half-migrates. Enabling must be exact.
import { getOrCreateDbKey } from './dbEncryptionKey.js'
import { makeDocCipher } from './docCipher.js'

const rawValue = process.env.SHORESH_AT_REST_ENCRYPTION

// Exactly 'on' enables it. Anything else — unset, empty, 'off', a typo — stays plaintext.
export const AT_REST_ENCRYPTION = rawValue === 'on' ? 'on' : 'off'

export function isAtRestEncryptionEnabled() {
  return AT_REST_ENCRYPTION === 'on'
}

// acquireDbKey(userDataDir, safeStorage) -> Buffer(32) | null
// The raw per-device key for SQLite (SQLCipher PRAGMA key), or null when encryption is off. This is
// the SAME key acquireDocCipher uses — one device key locks both the .automerge document and the
// SQLite db (ADR decision). Throws (fail-closed) if enabled but the keychain is unavailable.
export function acquireDbKey(userDataDir, safeStorage) {
  if (!isAtRestEncryptionEnabled()) return null
  return getOrCreateDbKey(userDataDir, safeStorage)
}

// acquireDocCipher(userDataDir, safeStorage) -> { encrypt, decrypt } | null
// Returns the per-device document cipher when encryption is enabled, else null (plaintext — the
// caller keeps its existing behavior). Injecting safeStorage keeps this unit-testable without
// Electron. Throws only if encryption is ENABLED but the key cannot be obtained (fail-closed: a
// device told to encrypt must not silently fall back to plaintext — see dbEncryptionKey.js).
export function acquireDocCipher(userDataDir, safeStorage) {
  if (!isAtRestEncryptionEnabled()) return null
  const key = getOrCreateDbKey(userDataDir, safeStorage)
  return makeDocCipher(key)
}
