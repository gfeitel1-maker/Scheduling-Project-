// Crash safety for the at-rest encryption disable (T345; docs/adr/2026-09-28-at-rest-encryption-disable-control.md,
// "Crash safety"). The disable never edits a live file in place. It writes a journal, builds verified
// PLAINTEXT copies beside the originals (`<file>.disable-staged`), flips the journal to `committing`, then
// swaps the copies in, writes the opt-out marker and only then removes the key. Whatever instant the process
// dies at, the next boot runs recoverInterruptedDisable BEFORE any db or key is touched and lands on one
// of two known states: fully encrypted (key present, no marker) or fully plain (key gone, marker present).
//
//   journal state "staging"    : originals untouched, key untouched  -> roll BACK (delete the copies)
//   journal state "committing" : copies verified, swap may be partial -> roll FORWARD to plain; if that
//                                cannot be verified, roll back to the encrypted backups instead
//
// The journal lists only {kind, path}; staged and backup paths are DERIVED here, never read from it, so a
// damaged journal can never aim a delete or a copy at a path of its choosing.
import fs from 'node:fs'
import path from 'node:path'
import { KEY_FILE } from './dbEncryptionKey.js'
import { isEncrypted } from './docCipher.js'
import { OPT_OUT_FILE } from './atRestEncryption.js'
import { isPlaintextSqliteFile, restoreDbFromBackup } from './sqliteCipher.js'

export const DISABLE_JOURNAL_FILE = 'encryption.disable-journal'
const JOURNAL_VERSION = 1
const STAMP_RE = /^[0-9A-Za-z-]+$/

export const stagedPathFor = (file) => `${file}.disable-staged`
export const backupPathFor = (file, stamp) => `${file}.pre-disable-${stamp}.bak`

const coded = (code, message) => Object.assign(new Error(message), { code })

export function disablePaths(userDataDir) {
  const key = path.join(userDataDir, KEY_FILE)
  return {
    journal: path.join(userDataDir, DISABLE_JOURNAL_FILE),
    marker: path.join(userDataDir, OPT_OUT_FILE),
    key,
    held: `${key}.disabling`,
  }
}

// Whole-file replace that a kill cannot leave torn: the reader sees the old file or the complete new one.
export function atomicWrite(file, data, fsImpl = fs) {
  const tmp = `${file}.tmp`
  fsImpl.writeFileSync(tmp, data)
  fsImpl.renameSync(tmp, file)
}

export function writeJournal(userDataDir, journal, fsImpl = fs) {
  atomicWrite(disablePaths(userDataDir).journal, JSON.stringify({ version: JOURNAL_VERSION, ...journal }), fsImpl)
}

function parseJournal(raw) {
  let j
  try { j = JSON.parse(raw.toString('utf8')) } catch { return null }
  if (!j || j.version !== JOURNAL_VERSION) return null
  if (j.state !== 'staging' && j.state !== 'committing') return null
  if (typeof j.stamp !== 'string' || !STAMP_RE.test(j.stamp)) return null
  if (!Array.isArray(j.files)) return null
  for (const f of j.files) {
    if (!f || (f.kind !== 'db' && f.kind !== 'doc') || typeof f.path !== 'string' || !path.isAbsolute(f.path)) return null
  }
  return { state: j.state, stamp: j.stamp, files: j.files.map((f) => ({ kind: f.kind, path: f.path })) }
}

const exists = (p, fsImpl) => fsImpl.existsSync(p)
const tryUnlink = (p, fsImpl) => { if (exists(p, fsImpl)) fsImpl.unlinkSync(p) }
const dropDbSidecars = (file, fsImpl) => { for (const s of ['-wal', '-shm']) tryUnlink(`${file}${s}`, fsImpl) }

function isPlainNow(f, fsImpl) {
  try {
    return f.kind === 'db' ? isPlaintextSqliteFile(f.path, { fsImpl }) : !isEncrypted(fsImpl.readFileSync(f.path))
  } catch { return false }
}
function isEncryptedNow(f, fsImpl) {
  try {
    if (f.kind === 'db') return fsImpl.statSync(f.path).size > 0 && !isPlaintextSqliteFile(f.path, { fsImpl })
    return isEncrypted(fsImpl.readFileSync(f.path))
  } catch { return false }
}

export function swapStaged(files, fsImpl = fs) {
  for (const f of files) {
    const staged = stagedPathFor(f.path)
    if (!exists(staged, fsImpl)) continue
    if (f.kind === 'db') dropDbSidecars(f.path, fsImpl)
    fsImpl.renameSync(staged, f.path)
  }
}

export const allPlain = (files, fsImpl = fs) => files.every((f) => isPlainNow(f, fsImpl))

// Put the device back to fully encrypted. Only legal while the key is still at its own path.
export function rollbackDisable({ userDataDir, journal, fsImpl = fs }) {
  const p = disablePaths(userDataDir)
  if (!exists(p.key, fsImpl)) throw coded('disable_recovery_failed', 'Encryption could not be put back: the device key is missing.')
  for (const f of journal.files) {
    for (const s of ['', '-wal', '-shm']) tryUnlink(`${stagedPathFor(f.path)}${s}`, fsImpl)
    const bak = backupPathFor(f.path, journal.stamp)
    if (journal.state === 'committing' && exists(bak, fsImpl) && !isEncryptedNow(f, fsImpl)) {
      if (f.kind === 'db') restoreDbFromBackup(f.path, bak, { fsImpl })
      else fsImpl.copyFileSync(bak, f.path)
    }
  }
  if (!journal.files.every((f) => isEncryptedNow(f, fsImpl))) {
    throw coded('disable_recovery_failed',
      'Encryption is still on, but a file could not be put back to its protected form. Nothing was deleted; the backups beside it are intact. Restart the app to try again.')
  }
  tryUnlink(`${p.marker}.tmp`, fsImpl)
  tryUnlink(p.marker, fsImpl)
  for (const f of journal.files) tryUnlink(backupPathFor(f.path, journal.stamp), fsImpl)
  tryUnlink(`${p.journal}.tmp`, fsImpl)
  tryUnlink(p.journal, fsImpl)
}

// The irreversible tail: opt-out marker, key out of its path, key overwritten, backups and journal gone.
// Idempotent, so a boot that finds it half done simply runs it again.
export function finishDisable({ userDataDir, journal, fsImpl = fs, now = () => new Date() }) {
  const p = disablePaths(userDataDir)
  if (!exists(p.marker, fsImpl)) atomicWrite(p.marker, JSON.stringify({ disabledAt: now().toISOString() }), fsImpl)
  if (exists(p.key, fsImpl)) fsImpl.renameSync(p.key, p.held)
  const warnings = []
  try {
    if (exists(p.held, fsImpl)) {
      fsImpl.writeFileSync(p.held, Buffer.alloc(fsImpl.statSync(p.held).size))
      fsImpl.unlinkSync(p.held)
    }
  } catch (err) { warnings.push(`sealed key leftover at ${p.held}: ${err?.message ?? err}`); return warnings }
  for (const f of journal.files) {
    const bak = backupPathFor(f.path, journal.stamp)
    try { tryUnlink(bak, fsImpl) } catch (err) { warnings.push(`backup leftover at ${bak}: ${err?.message ?? err}`); return warnings }
  }
  try { tryUnlink(p.journal, fsImpl) } catch (err) { warnings.push(`journal leftover at ${p.journal}: ${err?.message ?? err}`) }
  return warnings
}

const UNREADABLE_ON =
  'An earlier attempt to turn off encryption was interrupted and its progress record could not be read. ' +
  'Encryption is still on and nothing was changed; no camp data was lost. You can try again from the Devices screen.'
const UNREADABLE_OTHER =
  'An earlier attempt to turn off encryption was interrupted and its progress record could not be read. ' +
  'Nothing was deleted. See docs/current/KEY_RECOVERY_STORY.md.'

// Run once per boot, before the key is read or any database is opened.
// -> { outcome: 'none' | 'rolled_back' | 'completed' | 'unreadable_journal', message? }
export function recoverInterruptedDisable({ userDataDir, fsImpl = fs }) {
  const p = disablePaths(userDataDir)
  tryUnlink(`${p.journal}.tmp`, fsImpl)
  let raw
  try {
    raw = fsImpl.readFileSync(p.journal)
  } catch (err) {
    if (err?.code === 'ENOENT') return { outcome: 'none' }
    return { outcome: 'unreadable_journal', message: exists(p.key, fsImpl) ? UNREADABLE_ON : UNREADABLE_OTHER }
  }
  const journal = parseJournal(raw)
  if (!journal) {
    const keyThere = exists(p.key, fsImpl)
    if (keyThere) {
      for (const dir of [userDataDir, path.join(userDataDir, 'automerge')]) {
        let names = []
        try { names = fsImpl.readdirSync(dir) } catch { /* no such folder */ }
        for (const n of names) if (n.endsWith('.disable-staged')) { try { fsImpl.unlinkSync(path.join(dir, n)) } catch { /* best effort */ } }
      }
    }
    try { fsImpl.renameSync(p.journal, `${p.journal}.unreadable`) } catch { /* the message repeats next boot */ }
    return { outcome: 'unreadable_journal', message: keyThere ? UNREADABLE_ON : UNREADABLE_OTHER }
  }

  if (journal.state === 'staging') {
    rollbackDisable({ userDataDir, journal, fsImpl })
    return { outcome: 'rolled_back', message: ROLLED_BACK }
  }

  try {
    swapStaged(journal.files, fsImpl)
    if (!allPlain(journal.files, fsImpl)) throw new Error('not all plain')
  } catch {
    rollbackDisable({ userDataDir, journal, fsImpl })
    return { outcome: 'rolled_back', message: ROLLED_BACK }
  }
  finishDisable({ userDataDir, journal, fsImpl })
  return { outcome: 'completed', message: 'An earlier attempt to turn off encryption was interrupted and has now finished. Encryption is off on this device.' }
}

const ROLLED_BACK = 'An earlier attempt to turn off encryption was interrupted. Encryption is still on and your camp data is intact. You can try again from the Devices screen.'
