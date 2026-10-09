import fs from 'node:fs'
import path from 'node:path'
import { loadDoc as decodeDoc, sharesGenesis, listRecordIds } from '../automerge/campDocument.js'
import { readCampIdSafely, writeUserBackup } from './projectManager.js'
import { docPath } from '../sync/automerge/docStore.js'

export class RestoreRefusal extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const NO_DOCUMENT = 'This backup is from before backups included the camp document, so restoring it would be undone at the next sync.'
const WRONG_CAMP = 'This backup belongs to a different camp, so it cannot be restored here.'
const UNREADABLE = 'The camp document in this backup cannot be read on this computer, so it cannot be restored.'

// A backup is a pair: shoresh-<ts>.db + shoresh-<ts>.automerge/<campId>.automerge. Every refusal
// here happens before anything on disk changes.
export function validateBackupPair(backupDbPath, { db, cipher = null }) {
  const docDir = backupDbPath.replace(/\.db$/, '.automerge')
  let names = []
  try { names = fs.readdirSync(docDir).filter((n) => n.endsWith('.automerge')) } catch { /* no document copy */ }
  if (names.length === 0) throw new RestoreRefusal('backup_no_document', NO_DOCUMENT)

  const campId = readCampIdSafely(db)
  const docSrc = path.join(docDir, `${campId}.automerge`)
  if (!campId || !names.includes(`${campId}.automerge`)) throw new RestoreRefusal('backup_wrong_camp', WRONG_CAMP)

  let doc
  try {
    const raw = fs.readFileSync(docSrc)
    doc = decodeDoc(cipher ? cipher.decrypt(raw) : raw)
  } catch {
    throw new RestoreRefusal('backup_document_unreadable', UNREADABLE)
  }
  if (!sharesGenesis(doc) || listRecordIds(doc, 'camps')[0] !== campId) {
    throw new RestoreRefusal('backup_wrong_camp', WRONG_CAMP)
  }
  return { campId, docSrc }
}

function replaceFile(src, dest) {
  const tmp = `${dest}.tmp`
  try {
    fs.copyFileSync(src, tmp)
    fs.renameSync(tmp, dest)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* may not exist */ }
    throw err
  }
}

// Puts back both files. Document first: if it fails nothing has changed, and if the db step fails
// the document is put back, so a failure never leaves a document/db pair from different moments.
// Bytes are copied as-is (still encrypted at rest).
export function applyBackupFiles({ backupDbPath, dbPath, userDataPath, campId, docSrc, copyDb = replaceFile }) {
  const target = docPath(userDataPath, campId)
  const prev = `${target}.restore-prev`
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.rmSync(prev, { force: true })
  const hadDoc = fs.existsSync(target)
  if (hadDoc) fs.copyFileSync(target, prev)
  try {
    if (docSrc) replaceFile(docSrc, target)
  } catch (err) {
    try { fs.unlinkSync(prev) } catch { /* may not exist */ }
    throw new RestoreRefusal('restore_document_failed', err.message)
  }
  try {
    // The old connection's WAL would otherwise be replayed over the restored file.
    fs.rmSync(`${dbPath}-wal`, { force: true })
    fs.rmSync(`${dbPath}-shm`, { force: true })
    copyDb(backupDbPath, dbPath)
  } catch (err) {
    if (hadDoc) fs.renameSync(prev, target)
    else fs.unlinkSync(target)
    throw err
  }
  try { fs.unlinkSync(prev) } catch { /* may not exist */ }
}

const checkpoint = (db) => { try { db.pragma('wal_checkpoint(TRUNCATE)') } catch { /* closed or non-WAL */ } }

// Orchestrates a restore. The old connection is checkpointed and closed before the files are
// swapped so no stale WAL survives. Any failure after the files change puts the pre-restore pair
// (the safety backup) back and reinstalls it, so the director is never left half-restored.
export async function restoreFromBackup({
  sourcePath, dbPath, userDataPath, db, cipher,
  flushDoc, stopSync, startSync, discardDoc, openDb, installDb,
}) {
  let safetyDbPath
  try {
    try { flushDoc() } catch (err) { console.error('backup: automerge flush failed (non-fatal):', err?.message ?? err) }
    checkpoint(db)
    let docCopyError
    safetyDbPath = writeUserBackup(dbPath, userDataPath, readCampIdSafely(db), (err) => { docCopyError = err }, sourcePath)
    if (docCopyError) throw docCopyError
  } catch (err) {
    return { error: 'backup_failed', message: err.message }
  }

  const campId = readCampIdSafely(db)
  const reinstall = async () => {
    const reopened = openDb()
    try { await installDb(reopened) } catch (err) { try { reopened.close() } catch { /* unusable */ } throw err }
  }

  let pair
  try {
    pair = validateBackupPair(sourcePath, { db, cipher })
  } catch (err) {
    if (err instanceof RestoreRefusal) return { error: err.code, message: err.message }
    return { error: 'restore_failed', message: err.message }
  }

  let closed = false
  try {
    await stopSync()
    discardDoc(db)
    checkpoint(db)
    db.close()
    closed = true
    applyBackupFiles({ backupDbPath: sourcePath, dbPath, userDataPath, campId: pair.campId, docSrc: pair.docSrc })
  } catch (err) {
    // Nothing was replaced (applyBackupFiles undoes its own partial work); resume on the current files.
    try { if (closed) await reinstall(); else startSync() } catch { /* the typed error below still reports the original failure */ }
    if (err instanceof RestoreRefusal) return { error: err.code, message: err.message }
    return { error: 'restore_failed', message: err.message }
  }

  try {
    discardDoc(db)
    const newDb = openDb()
    try { await installDb(newDb) } catch (err) { try { newDb.close() } catch { /* unusable */ } throw err }
    return { restored: true }
  } catch (err) {
    try {
      discardDoc(db)
      const docDir = safetyDbPath.replace(/\.db$/, '.automerge')
      const safetyDoc = path.join(docDir, `${campId}.automerge`)
      applyBackupFiles({
        backupDbPath: safetyDbPath, dbPath, userDataPath, campId,
        docSrc: fs.existsSync(safetyDoc) ? safetyDoc : null,
      })
      await reinstall()
    } catch (rollbackErr) {
      return { error: 'restore_incomplete', message: `${err.message}; rollback failed: ${rollbackErr.message}`, rolledBack: false }
    }
    return { error: 'restore_incomplete', message: err.message, rolledBack: true }
  }
}
