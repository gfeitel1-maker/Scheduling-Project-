import fs from 'node:fs'
import path from 'node:path'
import { loadDoc as decodeDoc, sharesGenesis, listRecordIds } from '../automerge/campDocument.js'
import { readCampIdSafely } from './projectManager.js'
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
  const hadDoc = fs.existsSync(target)
  if (hadDoc) fs.copyFileSync(target, prev)
  try {
    replaceFile(docSrc, target)
  } catch (err) {
    try { fs.unlinkSync(prev) } catch { /* may not exist */ }
    throw new RestoreRefusal('restore_document_failed', err.message)
  }
  try {
    copyDb(backupDbPath, dbPath)
  } catch (err) {
    if (hadDoc) fs.renameSync(prev, target)
    else fs.unlinkSync(target)
    throw err
  }
  try { fs.unlinkSync(prev) } catch { /* may not exist */ }
}
