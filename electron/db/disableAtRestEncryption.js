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
import { isPlaintextSqliteFile, readTableCounts, decryptEncryptedToPlaintext, rawKeyPragma } from './sqliteCipher.js'
import {
  writeJournal, atomicWrite, rollbackDisable, swapStaged, allPlain, finishDisable, stagedPathFor, backupPathFor,
} from './disableRecovery.js'

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

  const markerPath = path.join(userDataDir, OPT_OUT_FILE)
  const stamp = now().toISOString().replace(/[:.]/g, '-')
  const journal = {
    state: 'staging',
    stamp,
    files: [
      ...targets.map((file) => ({ kind: 'db', path: file })),
      ...docs.filter((d) => d.encrypted).map((d) => ({ kind: 'doc', path: d.file })),
    ],
  }
  const rollback = () => { try { rollbackDisable({ userDataDir, journal, fsImpl }) } catch { /* the journal and backups stay for the next boot */ } }

  try {
    writeJournal(userDataDir, journal, fsImpl)

    try {
      for (const f of journal.files) fsImpl.copyFileSync(f.path, backupPathFor(f.path, stamp))
    } catch (err) {
      throw coded('backup_failed', `Encryption was not changed: a backup could not be written (${err?.message ?? err}).`)
    }

    for (const d of docs.filter((x) => x.encrypted)) {
      try { fsImpl.writeFileSync(stagedPathFor(d.file), d.plain) } catch (err) {
        throw coded('doc_decrypt_failed', `Encryption was not changed: the camp document could not be decrypted (${err?.message ?? err}).`)
      }
    }
    for (const file of targets) {
      decryptEncryptedToPlaintext(file, key, { Database, stagedPath: stagedPathFor(file), expectedCounts: counts.get(file), fsImpl })
    }
    for (const d of docs.filter((x) => x.encrypted)) {
      let ok = false
      try { const staged = fsImpl.readFileSync(stagedPathFor(d.file)); ok = !isEncrypted(staged) && staged.equals(d.plain) } catch { /* ok stays false */ }
      if (!ok) throw coded('verify_failed', 'Encryption was not changed: the decrypted camp document did not match.')
    }

    journal.state = 'committing'
    try {
      writeJournal(userDataDir, journal, fsImpl)
      swapStaged(journal.files, fsImpl)
      if (!allPlain(journal.files, fsImpl)) throw new Error('a decrypted file did not take its place')
      atomicWrite(markerPath, JSON.stringify({ disabledAt: now().toISOString() }), fsImpl)
      fsImpl.renameSync(keyPath, `${keyPath}.disabling`)
    } catch (err) {
      throw coded('shred_failed', `Encryption was not changed: the switch could not be completed (${err?.message ?? err}).`)
    }
  } catch (err) {
    rollback()
    throw err
  }

  const warnings = finishDisable({ userDataDir, journal, fsImpl, now })
  return { disabled: true, warnings }
}
