// SQLite at-rest encryption: keying + the one-time plaintext→encrypted migration (ADR
// docs/adr/2026-09-15-at-rest-encryption-scoping.md; ticket T175).
//
// The SQLite file holds the crackable PIN hashes the ADR names as the reason document-only
// encryption is not enough. This module keys the db with SQLCipher (via better-sqlite3-multiple-
// ciphers) and migrates an existing plaintext file across, safely.
//
// DETECTION IS BY FILE HEADER, NOT TRIAL-AND-ERROR. A plaintext SQLite file begins with the 16-byte
// magic "SQLite format 3\0"; a SQLCipher-encrypted file's header is itself encrypted, so it does not.
// Reading 16 bytes decides "plaintext (needs migration)" vs "encrypted / new (open with key)"
// deterministically, with no dependence on how the driver reports a wrong-key open.
//
// The functions here are injectable (Database, fs, backup) so the migration ORCHESTRATION is
// testable without the native module; the real keying + sqlcipher_export are covered by an
// integration test that runs once the module is installed.
import fs from 'node:fs'

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1') // 16 bytes

// The SQLCipher raw-key form: a 64-hex-char key in x'...' bypasses SQLCipher's PBKDF2 (we already
// hold 32 random bytes from the OS keychain — there is no passphrase to stretch). MUST be applied as
// the very first statement after opening, before any other access.
export function rawKeyPragma(key) {
  return `key = "x'${key.toString('hex')}'"`
}

// True iff the file exists, is non-empty, and starts with the plaintext SQLite magic. A brand-new
// (absent/empty) file is NOT plaintext — it will simply be created encrypted. An encrypted file is
// NOT plaintext — its header is ciphertext.
export function isPlaintextSqliteFile(filePath, { fsImpl = fs } = {}) {
  let fd
  try {
    fd = fsImpl.openSync(filePath, 'r')
  } catch {
    return false // does not exist / unreadable → not a plaintext file to migrate
  }
  try {
    const buf = Buffer.alloc(SQLITE_MAGIC.length)
    const n = fsImpl.readSync(fd, buf, 0, SQLITE_MAGIC.length, 0)
    return n === SQLITE_MAGIC.length && buf.equals(SQLITE_MAGIC)
  } catch {
    return false
  } finally {
    try { fsImpl.closeSync(fd) } catch { /* ignore */ }
  }
}

// Migrate a PLAINTEXT SQLite file at `filePath` to an encrypted one in place, under `key`.
//
// SAFETY (assessment finding 4), now that there is no live camp data but the code must be right for
// when there is:
//   - a pre-migration backup is written FIRST and its failure is FATAL (no backup → do not proceed);
//   - the encrypted copy is produced beside the original via sqlcipher_export, then verified by
//     re-opening WITH the key and reading a row BEFORE the plaintext original is replaced;
//   - only after the swap AND a successful verify is the plaintext backup shredded — a failed verify
//     restores from backup and throws, never leaving a half-migrated or unreadable db.
//
// `Database` is injected (the better-sqlite3-multiple-ciphers constructor) so this is testable.
export function migratePlaintextToEncrypted(filePath, key, {
  Database,
  writeBackup,
  fsImpl = fs,
} = {}) {
  if (!Database) throw new Error('migratePlaintextToEncrypted: a Database constructor is required')
  if (!writeBackup) throw new Error('migratePlaintextToEncrypted: a writeBackup fn is required')

  // 1. Backup first — FATAL on failure. This is the only copy of the pre-migration bytes.
  let backupPath
  try {
    backupPath = writeBackup(filePath)
  } catch (err) {
    const e = new Error(`at-rest migration refused: pre-migration backup failed (${err?.message ?? err}). ` +
      'Not proceeding — a migration without a recoverable backup is exactly what must not happen.')
    e.code = 'backup_failed'
    throw e
  }

  const encPath = `${filePath}.enc-migrate`
  // Clean any leftover from a prior interrupted attempt (idempotent).
  for (const p of [encPath, `${encPath}-wal`, `${encPath}-shm`]) {
    try { if (fsImpl.existsSync(p)) fsImpl.unlinkSync(p) } catch { /* ignore */ }
  }

  // 2. Open plaintext, export into a new encrypted db beside it.
  const plain = new Database(filePath)
  try {
    const hex = key.toString('hex')
    plain.exec(`ATTACH DATABASE '${encPath.replace(/'/g, "''")}' AS enc KEY "x'${hex}'"`)
    plain.exec("SELECT sqlcipher_export('enc')")
    plain.exec('DETACH DATABASE enc')
  } finally {
    plain.close()
  }

  // 3. VERIFY the encrypted copy opens with the key and reads back before we destroy the original.
  try {
    const check = new Database(encPath)
    try {
      check.pragma(rawKeyPragma(key))
      // A read that would fail on a wrong key or a corrupt export.
      check.prepare("SELECT count(*) AS n FROM sqlite_master").get()
    } finally {
      check.close()
    }
  } catch (err) {
    // Verify failed — leave the plaintext original untouched, remove the bad encrypted copy, restore
    // nothing (original was never changed), and throw. The backup also still exists.
    for (const p of [encPath, `${encPath}-wal`, `${encPath}-shm`]) {
      try { if (fsImpl.existsSync(p)) fsImpl.unlinkSync(p) } catch { /* ignore */ }
    }
    const e = new Error(`at-rest migration aborted: the encrypted copy failed verification (${err?.message ?? err}). ` +
      `The original plaintext db is untouched and a backup is at ${backupPath}.`)
    e.code = 'verify_failed'
    throw e
  }

  // 4. Swap: remove the plaintext original (and its sidecars), move the encrypted copy into place.
  for (const suffix of ['-wal', '-shm', '']) {
    const p = `${filePath}${suffix}`
    try { if (fsImpl.existsSync(p)) fsImpl.unlinkSync(p) } catch { /* ignore */ }
  }
  fsImpl.renameSync(encPath, filePath)

  // 5. Success — shred the plaintext backup (finding 4: the .bak is the only remaining cleartext copy).
  try { if (fsImpl.existsSync(backupPath)) fsImpl.unlinkSync(backupPath) } catch { /* non-fatal — best effort */ }

  return { migrated: true, backupPath }
}
