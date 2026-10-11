// Director-gated at-rest encryption disable (T345; docs/adr/2026-09-28-at-rest-encryption-disable-control.md).
// Decrypts the camp document(s) and every SQLite db this device keyed, VERIFIES the result, then removes
// the device key and writes the opt-out marker. Any failure before the key is gone restores everything
// from the backups taken first and leaves the device encrypted and readable. An unknown state is refused,
// never read as safe. Pure over injected fs / driver / safeStorage so it runs under Vitest.
//
// Crash safety: if the process dies after the db is decrypted but before the key is removed, the key file
// is still there, so the next launch latches ON and the plaintext db is simply re-encrypted by the normal
// keyed-open migration.
import fs from 'node:fs'
import path from 'node:path'
import { getDbKey, KEY_FILE } from './dbEncryptionKey.js'
import { makeDocCipher, isEncrypted } from './docCipher.js'
import { OPT_OUT_FILE } from './atRestEncryption.js'
import {
  isPlaintextSqliteFile, readTableCounts, decryptEncryptedToPlaintext, restoreDbFromBackup, rawKeyPragma,
} from './sqliteCipher.js'

export const DISABLE_PHRASE = 'DISABLE ENCRYPTION'

function coded(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}
const unknown = (what, err) => coded('unknown_state', `Encryption was not changed: ${what}${err ? ` (${err.code ?? err.message})` : ''}. Nothing was touched.`)

export function disableAtRestEncryption({ userDataDir, dbPaths, safeStorage, Database, fsImpl = fs, now = () => new Date() }) {
  const keyPath = path.join(userDataDir, KEY_FILE)

  try {
    fsImpl.statSync(keyPath)
  } catch (err) {
    if (err?.code === 'ENOENT') throw coded('not_encrypted', 'This device is not encrypted: there is no key file.')
    throw unknown('the key file state could not be read', err)
  }
  let key
  try { key = getDbKey(userDataDir, safeStorage, { fsImpl }) } catch (err) { throw unknown('the device key could not be unsealed', err) }
  const cipher = makeDocCipher(key)

  const docDir = path.join(userDataDir, 'automerge')
  let docNames
  try {
    docNames = fsImpl.readdirSync(docDir).filter((n) => n.endsWith('.automerge'))
  } catch (err) {
    if (err?.code !== 'ENOENT') throw unknown('the document folder could not be listed', err)
    docNames = []
  }
  const docs = []
  for (const n of docNames) {
    const file = path.join(docDir, n)
    try {
      const raw = fsImpl.readFileSync(file)
      docs.push({ file, encrypted: isEncrypted(raw), plain: cipher.decrypt(raw) })
    } catch (err) {
      throw unknown(`the document ${n} could not be read with this key`, err)
    }
  }

  const counts = new Map()
  // dbPaths[0] is the open camp db and must be keyed. A recent project that was never opened under
  // the key is already plaintext; there is nothing to decrypt, so it is left alone.
  const targets = []
  for (const file of dbPaths) {
    if (isPlaintextSqliteFile(file, { fsImpl })) {
      if (file === dbPaths[0]) throw unknown(`${path.basename(file)} is already plaintext while this device holds a key`)
      continue
    }
    targets.push(file)
    try {
      const db = new Database(file)
      try { db.pragma(rawKeyPragma(key)); db.pragma('wal_checkpoint(TRUNCATE)') } finally { db.close() }
      counts.set(file, readTableCounts(Database, file, key))
    } catch (err) {
      throw unknown(`${path.basename(file)} could not be opened with this key`, err)
    }
  }

  const stamp = now().toISOString().replace(/[:.]/g, '-')
  const backups = new Map() // original path -> backup path
  const tmps = []
  const markerPath = path.join(userDataDir, OPT_OUT_FILE)
  const heldKeyPath = `${keyPath}.disabling`
  let keyMoved = false

  const rollback = () => {
    if (keyMoved) { try { fsImpl.renameSync(heldKeyPath, keyPath) } catch { /* the sealed key is still at heldKeyPath */ } }
    try { fsImpl.unlinkSync(markerPath) } catch { /* may not exist */ }
    for (const t of tmps) { try { fsImpl.unlinkSync(t) } catch { /* may not exist */ } }
    for (const [file, bak] of backups) {
      try {
        if (targets.includes(file)) restoreDbFromBackup(file, bak, { fsImpl })
        else fsImpl.copyFileSync(bak, file)
      } catch { /* the backup still exists */ }
    }
  }
  const withRollback = (fn) => {
    try { return fn() } catch (err) { rollback(); throw err }
  }

  withRollback(() => {
    try {
      for (const file of [...targets, ...docs.filter((d) => d.encrypted).map((d) => d.file)]) {
        const bak = `${file}.pre-disable-${stamp}.bak`
        fsImpl.copyFileSync(file, bak)
        backups.set(file, bak)
      }
    } catch (err) {
      throw coded('backup_failed', `Encryption was not changed: a backup could not be written (${err?.message ?? err}).`)
    }

    for (const d of docs.filter((x) => x.encrypted)) {
      const tmp = `${d.file}.disable.tmp`
      try {
        tmps.push(tmp)
        fsImpl.writeFileSync(tmp, d.plain)
        fsImpl.renameSync(tmp, d.file)
      } catch (err) {
        throw coded('doc_decrypt_failed', `Encryption was not changed: the camp document could not be decrypted (${err?.message ?? err}).`)
      }
    }

    for (const file of targets) {
      decryptEncryptedToPlaintext(file, key, { Database, writeBackup: () => backups.get(file), expectedCounts: counts.get(file), fsImpl })
    }

    for (const d of docs.filter((x) => x.encrypted)) {
      let ok = false
      try { const now_ = fsImpl.readFileSync(d.file); ok = !isEncrypted(now_) && now_.equals(d.plain) } catch { /* ok stays false */ }
      if (!ok) throw coded('verify_failed', 'Encryption was not changed: the decrypted camp document did not match.')
    }

    try {
      fsImpl.writeFileSync(markerPath, JSON.stringify({ disabledAt: now().toISOString() }))
      fsImpl.renameSync(keyPath, heldKeyPath)
      keyMoved = true
    } catch (err) {
      throw coded('shred_failed', `Encryption was not changed: the device key could not be removed (${err?.message ?? err}).`)
    }
  })

  const warnings = []
  try {
    fsImpl.writeFileSync(heldKeyPath, Buffer.alloc(fsImpl.statSync(heldKeyPath).size))
    fsImpl.unlinkSync(heldKeyPath)
  } catch (err) { warnings.push(`sealed key leftover at ${heldKeyPath}: ${err?.message ?? err}`) }
  for (const bak of backups.values()) {
    try { fsImpl.unlinkSync(bak) } catch (err) { warnings.push(`backup leftover at ${bak}: ${err?.message ?? err}`) }
  }
  return { disabled: true, warnings }
}
