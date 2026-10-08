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
import path from 'node:path'

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
// Present only while a rekey is in flight. Recovery restores a plaintext .bak ONLY when it exists, so a
// stale .bak can never be mistaken for the product of an interrupted rekey.
const MIGRATION_MARKER_SUFFIX = '.migration-in-progress'

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

  const markerPath = `${filePath}${MIGRATION_MARKER_SUFFIX}`
  const bakStat = fsImpl.statSync(backupPath)
  fsImpl.writeFileSync(markerPath, JSON.stringify({ backupPath, size: bakStat.size, mtimeMs: bakStat.mtimeMs }))
  const clearMarker = () => { try { fsImpl.unlinkSync(markerPath) } catch { /* best effort */ } }

  const restoreFromBackup = () => {
    // rekey may have partially rewritten the file; put the known-good plaintext copy back so the
    // caller's retry (or the next launch) starts from an intact db, not a half-encrypted one.
    try {
      for (const suffix of ['-wal', '-shm']) {
        const p = `${filePath}${suffix}`
        if (fsImpl.existsSync(p)) fsImpl.unlinkSync(p)
      }
      fsImpl.copyFileSync(backupPath, filePath)
      clearMarker()
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
  clearMarker()
  try { if (fsImpl.existsSync(backupPath)) fsImpl.unlinkSync(backupPath) } catch { /* non-fatal — best effort */ }

  return { migrated: true, backupPath }
}

// Crash recovery for migratePlaintextToEncrypted. If the process died between the in-place rekey and
// the verify/shred, the db file is half-encrypted and a plaintext `.pre-migration-*.bak` remains.
// A keyed open then fails opaquely. Detect that (file present, not plaintext, key does not open it)
// and put the newest PLAINTEXT .bak back so the normal migration can run again. Only a .bak with a
// plaintext header qualifies: schema-migration backups of an already-encrypted db share the name
// pattern and must never be restored as if they were plaintext. A .bak is never deleted here.
function readMarker(markerPath, fsImpl) {
  try {
    const m = JSON.parse(fsImpl.readFileSync(markerPath, 'utf8'))
    return typeof m?.backupPath === 'string' ? m : null
  } catch {
    return null
  }
}

export function recoverInterruptedMigration(filePath, key, { Database, fsImpl = fs } = {}) {
  if (!Database) throw new Error('recoverInterruptedMigration: a Database constructor is required')
  let size
  try { size = fsImpl.statSync(filePath).size } catch { return { recovered: false } }
  if (!size || isPlaintextSqliteFile(filePath, { fsImpl })) return { recovered: false }

  let opened = false
  try {
    const probe = new Database(filePath)
    try {
      probe.pragma(rawKeyPragma(key))
      probe.prepare('SELECT count(*) AS n FROM sqlite_master').get()
      opened = true
    } finally {
      probe.close()
    }
  } catch (err) {
    if (err?.code !== 'SQLITE_NOTADB') throw err
  }

  const markerPath = `${filePath}${MIGRATION_MARKER_SUFFIX}`
  const bound = readMarker(markerPath, fsImpl)
  if (opened) {
    // The key opens the db, so any marker is stale (the crash came after rekey+verify). Clear it and
    // the plaintext .bak it names, so neither can later authorize restoring old data over newer data.
    if (bound && isPlaintextSqliteFile(bound.backupPath, { fsImpl })) {
      try { fsImpl.unlinkSync(bound.backupPath) } catch { /* best effort */ }
    }
    try { fsImpl.unlinkSync(markerPath) } catch { /* absent or best effort */ }
    return { recovered: false }
  }

  if (!bound) {
    const e = new Error(
      `The camp database at ${filePath} could not be opened with this device's encryption key, and no ` +
        'encryption upgrade was in progress, so nothing was changed. The key may have been replaced or ' +
        'the file damaged. See docs/current/KEY_RECOVERY_STORY.md.'
    )
    e.code = 'db_unreadable'
    throw e
  }

  // Only the backup THIS marker was written for qualifies; any other plaintext .bak is not authorized.
  const candidates = []
  try {
    const st = fsImpl.statSync(bound.backupPath)
    if (st.size === bound.size && st.mtimeMs === bound.mtimeMs && isPlaintextSqliteFile(bound.backupPath, { fsImpl })) {
      candidates.push({ p: bound.backupPath })
    }
  } catch { /* backup gone */ }

  const fail = (detail) => {
    const e = new Error(
      `The camp database at ${filePath} could not be opened: an earlier encryption upgrade was ` +
        `interrupted part-way and the file is now unreadable. ${detail}`
    )
    e.code = 'db_migration_interrupted'
    return e
  }
  if (candidates.length === 0) {
    throw fail('No pre-migration backup was found beside it to restore from, so nothing was changed. ' +
      'Recover by re-syncing this device from a paired peer; see docs/current/KEY_RECOVERY_STORY.md.')
  }
  const bakPath = candidates[0].p
  const aside = `${filePath}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fsImpl.existsSync(`${filePath}${suffix}`)) fsImpl.renameSync(`${filePath}${suffix}`, `${aside}${suffix}`)
    }
    fsImpl.copyFileSync(bakPath, filePath)
  } catch (err) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { if (fsImpl.existsSync(`${aside}${suffix}`)) fsImpl.renameSync(`${aside}${suffix}`, `${filePath}${suffix}`) } catch { /* best effort */ }
    }
    throw fail(`Restoring the backup failed (${err?.message ?? err}). The backup is intact at ${bakPath}; the original file was left in place.`)
  }
  return { recovered: true, backupPath: bakPath, unreadableCopy: aside }
}

// Security cleanup, called only after a keyed open has SUCCEEDED. An interrupted or abandoned
// at-rest upgrade can leave a plaintext `<db>.pre-migration-*.bak` — the only cleartext copy of the
// camp — beside a db that now opens encrypted. Delete (overwrite, then unlink) those. Schema-migration
// backups share the name pattern; an ENCRYPTED-header one is a legitimate rollback copy and is kept,
// so the decision is by header, never by name alone.
export function shredOrphanedPlaintextBackups(filePath, { fsImpl = fs } = {}) {
  const dir = path.dirname(filePath)
  const prefix = `${path.basename(filePath)}.pre-migration-`
  const shredded = []
  let names
  try { names = fsImpl.readdirSync(dir) } catch { return { shredded } }
  for (const n of names) {
    if (!n.startsWith(prefix) || !n.endsWith('.bak')) continue
    const p = path.join(dir, n)
    if (!isPlaintextSqliteFile(p, { fsImpl })) continue
    try {
      fsImpl.writeFileSync(p, Buffer.alloc(fsImpl.statSync(p).size))
      fsImpl.unlinkSync(p)
      shredded.push(p)
    } catch { /* best effort — a locked file must not block opening the camp */ }
  }
  return { shredded }
}

// Facts about the db file, taken BEFORE the keyed open: a keyed open of an absent or zero-length
// file CREATES an empty encrypted db, which proves nothing about any backup beside it.
export function probeDbFile(filePath, { fsImpl = fs } = {}) {
  let size
  try { size = fsImpl.statSync(filePath).size } catch { return { existed: false, nonEmpty: false, encryptedHeader: false } }
  const nonEmpty = size > 0
  return { existed: true, nonEmpty, encryptedHeader: nonEmpty && !isPlaintextSqliteFile(filePath, { fsImpl }) }
}

// A plaintext backup is orphaned only if the db was a real, non-empty, already-encrypted file before
// this open, or this very call migrated a pre-existing plaintext db and verified it.
export function shouldShredOrphanedBackups({ existed, nonEmpty, encryptedHeader, migratedThisCall = false }) {
  return migratedThisCall || (existed && nonEmpty && encryptedHeader)
}
