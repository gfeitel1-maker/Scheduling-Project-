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
//   - the db is encrypted in place, then verified by re-opening WITH the key and reading a row;
//   - the plaintext backup is shredded ONLY after a successful verify — any failure (rekey or verify)
//     restores the plaintext db from the backup and throws, never leaving a half-encrypted db.
//
// Encryption is done with `PRAGMA rekey` — the SQLite3MultipleCiphers way to encrypt a plaintext
// database IN PLACE. (NOT `sqlcipher_export`: that is a SQLCipher-proper function and is not
// available in this driver — the real-driver integration test proved it throws "no such function".)
// rekey rewrites the whole file encrypted; because that edits the original, the pre-migration backup
// is the safety net if it fails partway, and it is restored-from on any failure before we rethrow.
//
// `Database` is injected (the better-sqlite3-multiple-ciphers constructor) so this is testable.
export function migratePlaintextToEncrypted(filePath, key, {
  Database,
  writeBackup,
  fsImpl = fs,
} = {}) {
  if (!Database) throw new Error('migratePlaintextToEncrypted: a Database constructor is required')
  if (!writeBackup) throw new Error('migratePlaintextToEncrypted: a writeBackup fn is required')

  // 1. Backup first — FATAL on failure. This is the only copy of the pre-migration bytes, and rekey
  //    edits the original in place, so without it a failed rekey could strand the data.
  let backupPath
  try {
    backupPath = writeBackup(filePath)
  } catch (err) {
    const e = new Error(`at-rest migration refused: pre-migration backup failed (${err?.message ?? err}). ` +
      'Not proceeding — a migration without a recoverable backup is exactly what must not happen.')
    e.code = 'backup_failed'
    throw e
  }

  const restoreFromBackup = () => {
    // rekey may have partially rewritten the file; put the known-good plaintext copy back so the
    // caller's retry (or the next launch) starts from an intact db, not a half-encrypted one.
    try {
      for (const suffix of ['-wal', '-shm']) {
        const p = `${filePath}${suffix}`
        if (fsImpl.existsSync(p)) fsImpl.unlinkSync(p)
      }
      fsImpl.copyFileSync(backupPath, filePath)
    } catch { /* best effort — the backup itself still exists at backupPath regardless */ }
  }

  // 2. Open the plaintext db (no key) and encrypt it IN PLACE with rekey.
  try {
    const plain = new Database(filePath)
    try {
      plain.pragma(`rekey = "x'${key.toString('hex')}'"`)
    } finally {
      plain.close()
    }
  } catch (err) {
    restoreFromBackup()
    const e = new Error(`at-rest migration aborted: encrypting the database (PRAGMA rekey) failed ` +
      `(${err?.message ?? err}). Restored the plaintext db from backup; a copy is also at ${backupPath}.`)
    e.code = 'rekey_failed'
    throw e
  }

  // 3. VERIFY: reopen WITH the key and read, before we shred the only plaintext copy.
  try {
    const check = new Database(filePath)
    try {
      check.pragma(rawKeyPragma(key))
      check.prepare('SELECT count(*) AS n FROM sqlite_master').get() // fails on a wrong key / corrupt db
    } finally {
      check.close()
    }
  } catch (err) {
    restoreFromBackup()
    const e = new Error(`at-rest migration aborted: the encrypted db failed verification (${err?.message ?? err}). ` +
      `Restored the plaintext db from backup; a copy is also at ${backupPath}.`)
    e.code = 'verify_failed'
    throw e
  }

  // 4. Success — shred the plaintext backup (finding 4: the .bak is the only remaining cleartext copy).
  try { if (fsImpl.existsSync(backupPath)) fsImpl.unlinkSync(backupPath) } catch { /* non-fatal — best effort */ }

  return { migrated: true, backupPath }
}
