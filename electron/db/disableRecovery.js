// Crash safety for the at-rest encryption disable (T345; docs/adr/2026-09-28-at-rest-encryption-disable-control.md,
// "Crash safety"). The disable never edits a live file in place. It writes a journal, builds verified
// PLAINTEXT copies beside the originals (`<file>.disable-staged`), flips the journal to `committing`, then
// swaps the copies in, writes the opt-out marker and only then removes the key. Whatever instant the process
// dies at, the next boot runs recoverInterruptedDisable BEFORE any db or key is touched and lands on one
// of two known states: fully encrypted (key present, no marker) or fully plain (key gone, marker present).
//
//   journal state "staging"    : originals untouched, key untouched  -> roll BACK (delete the copies)
//   journal state "committing" : copies verified, swap may be partial -> roll FORWARD to plain, but only after
//                                a FULL content check (verifyPlainContent). If the check fails while the key is
//                                still in place, roll back to the encrypted backups; if the key is already gone,
//                                keep every backup and fail closed (nothing is deleted)
//
// The journal lists only {kind, path}; staged and backup paths are DERIVED here, never read from it, so a
// damaged journal can never aim a delete or a copy at a path of its choosing.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { loadDoc as parseAutomergeDoc } from '../automerge/campDocument.js'
import { KEY_FILE } from './dbEncryptionKey.js'
import { isEncrypted } from './docCipher.js'
import { OPT_OUT_FILE } from './atRestEncryption.js'
import { isPlaintextSqliteFile, restoreDbFromBackup, readTableCounts } from './sqliteCipher.js'

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
// fsync before the rename and on the folder after it: a process kill needs neither, a power loss needs both
// (otherwise the renamed-in name can reach disk before the bytes do).
// 'r+', not 'r': on Windows FlushFileBuffers needs a handle with write access, and fsync on a read-only handle fails
// with EPERM. 'r+' neither creates nor truncates, so the bytes are untouched.
export function syncFile(file, fsImpl = fs) {
  const fd = fsImpl.openSync(file, 'r+')
  try { fsImpl.fsyncSync(fd) } finally { fsImpl.closeSync(fd) }
}
export function syncDir(dir, fsImpl = fs) {
  try {
    const fd = fsImpl.openSync(dir, 'r')
    try { fsImpl.fsyncSync(fd) } finally { fsImpl.closeSync(fd) }
  } catch { /* a folder cannot be opened for fsync on every platform */ }
}

export function atomicWrite(file, data, fsImpl = fs) {
  const tmp = `${file}.tmp`
  fsImpl.writeFileSync(tmp, data)
  syncFile(tmp, fsImpl)
  fsImpl.renameSync(tmp, file)
  syncDir(path.dirname(file), fsImpl)
}

export function writeJournal(userDataDir, journal, fsImpl = fs) {
  atomicWrite(disablePaths(userDataDir).journal, JSON.stringify({ version: JOURNAL_VERSION, ...journal }), fsImpl)
}

const within = (dir, file) => { const r = path.relative(dir, file); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r) }

function parseJournal(raw, userDataDir) {
  let j
  try { j = JSON.parse(raw.toString('utf8')) } catch { return null }
  if (!j || j.version !== JOURNAL_VERSION) return null
  if (j.state !== 'staging' && j.state !== 'committing') return null
  if (typeof j.stamp !== 'string' || !STAMP_RE.test(j.stamp)) return null
  if (!Array.isArray(j.files) || !j.files.some((f) => f?.kind === 'db')) return null
  for (const f of j.files) {
    if (!f || (f.kind !== 'db' && f.kind !== 'doc') || typeof f.path !== 'string' || !path.isAbsolute(f.path)) return null
    if (!within(userDataDir, f.path)) return null
  }
  return { state: j.state, stamp: j.stamp, files: j.files.map(expectationsOf) }
}

// Expectations recorded before the swap (row counts, document hash): content facts, never key material.
// A malformed one is dropped, which makes the content check fail rather than pass.
function expectationsOf(f) {
  const out = { kind: f.kind, path: f.path }
  if (f.kind === 'db' && f.counts && typeof f.counts === 'object' && !Array.isArray(f.counts) &&
      Object.values(f.counts).every((n) => Number.isInteger(n) && n >= 0)) out.counts = f.counts
  if (f.kind === 'doc' && typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256) && Number.isInteger(f.length)) {
    out.sha256 = f.sha256
    out.length = f.length
  }
  return out
}

export const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// The check that gates every backup deletion. db: reopen KEYLESS through the driver, integrity_check, and the
// per-table row counts must equal those captured from the encrypted original. doc: LOAD it as Automerge
// and match the recorded length and hash. -> null when everything checks out, else a short reason.
export function verifyPlainContent({ files, Database, fsImpl = fs }) {
  for (const f of files) {
    const name = path.basename(f.path)
    try {
      if (f.kind === 'db') {
        if (!f.counts) return `${name}: no recorded row counts to compare`
        if (!Database) return `${name}: no database driver to check it with`
        const db = new Database(f.path)
        try {
          if (db.pragma('integrity_check', { simple: true }) !== 'ok') return `${name}: integrity check failed`
        } finally { db.close() }
        const after = readTableCounts(Database, f.path, null)
        if (JSON.stringify(Object.entries(after).sort()) !== JSON.stringify(Object.entries(f.counts).sort())) return `${name}: row counts differ`
      } else {
        if (!f.sha256) return `${name}: no recorded hash to compare`
        const buf = fsImpl.readFileSync(f.path)
        parseAutomergeDoc(buf)
        if (buf.length !== f.length || sha256Hex(buf) !== f.sha256) return `${name}: not the document that was decrypted`
      }
    } catch (err) {
      return `${name}: ${err?.message ?? err}`
    }
  }
  return null
}

const exists = (p, fsImpl) => fsImpl.existsSync(p)
const tryUnlink = (p, fsImpl) => { if (exists(p, fsImpl)) fsImpl.unlinkSync(p) }
const dropDbSidecars = (file, fsImpl) => { for (const s of ['-wal', '-shm']) tryUnlink(`${file}${s}`, fsImpl) }

const AUTOMERGE_MAGIC = Buffer.from([0x85, 0x6f, 0x4a, 0x83])

function isPlainNow(f, fsImpl) {
  try {
    if (f.kind === 'db') return isPlaintextSqliteFile(f.path, { fsImpl })
    const buf = fsImpl.readFileSync(f.path)
    return buf.length > AUTOMERGE_MAGIC.length && buf.subarray(0, AUTOMERGE_MAGIC.length).equals(AUTOMERGE_MAGIC)
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
    syncDir(path.dirname(f.path), fsImpl)
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
  if (exists(p.key, fsImpl)) { fsImpl.renameSync(p.key, p.held); syncDir(userDataDir, fsImpl) }
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
export function recoverInterruptedDisable({ userDataDir, Database, fsImpl = fs }) {
  const p = disablePaths(userDataDir)
  tryUnlink(`${p.journal}.tmp`, fsImpl)
  let raw
  try {
    raw = fsImpl.readFileSync(p.journal)
  } catch (err) {
    if (err?.code === 'ENOENT') return { outcome: 'none' }
    return { outcome: 'unreadable_journal', message: exists(p.key, fsImpl) ? UNREADABLE_ON : UNREADABLE_OTHER }
  }
  let journal = parseJournal(raw, userDataDir)
  // A genuine commit always left an encrypted backup of every file. While the key is still at its own path,
  // a "committing" journal without them is not ours, and rolling it forward would shred a key the data needs.
  if (journal?.state === 'committing' && exists(p.key, fsImpl) &&
      !journal.files.every((f) => exists(backupPathFor(f.path, journal.stamp), fsImpl))) journal = null
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
  const bad = verifyPlainContent({ files: journal.files, Database, fsImpl })
  if (bad) {
    if (exists(p.key, fsImpl)) {
      rollbackDisable({ userDataDir, journal, fsImpl })
      return { outcome: 'rolled_back', message: ROLLED_BACK }
    }
    if (!exists(p.marker, fsImpl)) atomicWrite(p.marker, JSON.stringify({ disabledAt: new Date().toISOString() }), fsImpl)
    return { outcome: 'unverified_plain', message: UNVERIFIED }
  }
  finishDisable({ userDataDir, journal, fsImpl })
  return { outcome: 'completed', message: 'An earlier attempt to turn off encryption was interrupted and has now finished. Encryption is off on this device.' }
}

const UNVERIFIED =
  'An earlier attempt to turn off encryption was interrupted and the decrypted camp data could not be confirmed complete. ' +
  'Nothing was deleted: the protected backups beside your data are kept. Do not delete them; see docs/current/KEY_RECOVERY_STORY.md.'
const ROLLED_BACK = 'An earlier attempt to turn off encryption was interrupted. Encryption is still on and your camp data is intact. You can try again from the Devices screen.'
