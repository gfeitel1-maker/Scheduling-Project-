// "Start fresh on this computer" (docs/adr/2026-10-13-revoked-device-local-reset.md): the crash-safe wipe of THIS
// device's data, inside the userData directory only. Move aside, then finish forward: the targets are renamed into
// userData/.reset-<stamp>/ under a durable journal, and the next launch (before any db is opened) deletes the staging
// directory, the sealed key first, and the journal last. A kill at any point leaves either the untouched original (the
// journal never became durable) or a state the next launch completes. Never touches the OS keychain's app-wide item.
import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite, syncDir, DISABLE_JOURNAL_FILE } from './disableRecovery.js'
import { KEY_FILE } from './dbEncryptionKey.js'
import { OPT_OUT_FILE } from './atRestEncryption.js'
import { RECENT_PROJECTS_FILE, CURRENT_PROJECT_FILE, BACKUP_DIR_NAME } from './projectManager.js'
import { FILE as SESSIONS_FILE } from '../sessionsValidAfter.js'
import { TOOL_AUTH_FILE } from '../auth/toolAuthorizations.js'
import { TCP_PORT_FILE } from '../sync/automerge/pinnedListenPort.js'
import { GRANT_FILE } from '../sync/automerge/portMappingGrantStore.js'

export const LOCAL_RESET_JOURNAL = 'local-reset.journal'
const JOURNAL_VERSION = 1
const STAMP_RE = /^[0-9A-Za-z-]+$/
const DEFAULT_DB_FILE = 'shoresh.sqlite'

// Every device-specific thing Shoresh keeps in userData. The sealed key is first: it is the first thing moved and the
// first thing deleted, so the data is unreadable even if a kill lands between those steps.
export const LOCAL_RESET_FILES = [
  KEY_FILE,
  DEFAULT_DB_FILE, `${DEFAULT_DB_FILE}-wal`, `${DEFAULT_DB_FILE}-shm`,
  'automerge',
  BACKUP_DIR_NAME,
  TOOL_AUTH_FILE,
  RECENT_PROJECTS_FILE,
  CURRENT_PROJECT_FILE,
  OPT_OUT_FILE,
  DISABLE_JOURNAL_FILE,
  TCP_PORT_FILE,
  GRANT_FILE,
  SESSIONS_FILE,
  'punch-gossip-highwater.json',
  'punch-signal-replay.json',
]

const isPlainRelative = (rel) => typeof rel === 'string' && rel !== '' && !path.isAbsolute(rel) && !rel.split(path.sep).includes('..')
const stagingDir = (userDataDir, stamp) => path.join(userDataDir, `.reset-${stamp}`)
const journalPath = (userDataDir) => path.join(userDataDir, LOCAL_RESET_JOURNAL)

/**
 * Every OTHER camp database this computer remembers, for the confirm step to name. Read-only: the camp name is the one
 * recent-projects.json stored, else the file name. A database outside userData is named too (and flagged), never touched.
 */
export function describeOtherCamps({ userDataDir, currentDbPath, recentProjects }) {
  const here = path.resolve(currentDbPath ?? '')
  const out = []
  for (const e of recentProjects ?? []) {
    const abs = path.resolve(e.path)
    if (abs === here) continue
    const rel = path.relative(userDataDir, abs)
    const outsideShoresh = !isPlainRelative(rel)
    const file = outsideShoresh ? abs : rel
    out.push({ name: e.campName || path.basename(abs), file, outsideShoresh })
  }
  return out
}

/** Names relative to userData, key first. Project dbs outside userData are dropped here and again at move time. */
export function resetTargets(userDataDir, extraDbPaths = []) {
  const out = [...LOCAL_RESET_FILES]
  for (const p of extraDbPaths) {
    const rel = path.relative(userDataDir, path.resolve(p))
    if (!isPlainRelative(rel)) continue
    out.push(rel, `${rel}-wal`, `${rel}-shm`)
  }
  return [...new Set(out)]
}

// The parent folder must really resolve inside userData: a symlinked folder lexically under userData must not let a
// rename reach the file it points at. A symlink as the target itself is fine (rename moves the link, not its target).
function parentInside(userDataDir, src, fsImpl) {
  try {
    const root = fsImpl.realpathSync(userDataDir)
    const rel = path.relative(root, fsImpl.realpathSync(path.dirname(src)))
    return rel === '' || isPlainRelative(rel)
  } catch { return false }
}

function moveAside(userDataDir, stamp, targets, fsImpl) {
  const staging = stagingDir(userDataDir, stamp)
  fsImpl.mkdirSync(staging, { recursive: true })
  for (const rel of targets) {
    const src = path.join(userDataDir, rel)
    if (!parentInside(userDataDir, src, fsImpl)) continue
    const dest = path.join(staging, rel)
    try {
      fsImpl.mkdirSync(path.dirname(dest), { recursive: true })
      fsImpl.renameSync(src, dest)
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }
  }
}

const writeState = (userDataDir, state, stamp, targets, fsImpl) =>
  atomicWrite(journalPath(userDataDir), JSON.stringify({ version: JOURNAL_VERSION, state, stamp, targets }), fsImpl)

/** Steps 1-3: journal, move aside, journal 'moved'. The caller restarts the app afterwards. */
export function runLocalReset({ userDataDir, extraDbPaths = [], fsImpl = fs, stamp = String(Date.now()) }) {
  const targets = resetTargets(userDataDir, extraDbPaths)
  writeState(userDataDir, 'moving', stamp, targets, fsImpl)
  moveAside(userDataDir, stamp, targets, fsImpl)
  writeState(userDataDir, 'moved', stamp, targets, fsImpl)
}

function readJournal(userDataDir, fsImpl) {
  let j
  try { j = JSON.parse(fsImpl.readFileSync(journalPath(userDataDir), 'utf8')) } catch { return null }
  if (!j || j.version !== JOURNAL_VERSION || (j.state !== 'moving' && j.state !== 'moved')) return null
  if (typeof j.stamp !== 'string' || !STAMP_RE.test(j.stamp)) return null
  if (!Array.isArray(j.targets) || !j.targets.every(isPlainRelative)) return null
  return j
}

/** Step 4, before any db is opened: finish a reset that was started. No journal (or an unreadable one): nothing is touched. */
export function recoverInterruptedLocalReset({ userDataDir, fsImpl = fs }) {
  const j = readJournal(userDataDir, fsImpl)
  if (!j) return { finished: false }
  const staging = stagingDir(userDataDir, j.stamp)
  if (j.state === 'moving') moveAside(userDataDir, j.stamp, j.targets, fsImpl)
  fsImpl.rmSync(path.join(staging, KEY_FILE), { force: true })
  fsImpl.rmSync(staging, { recursive: true, force: true })
  fsImpl.rmSync(`${journalPath(userDataDir)}.tmp`, { force: true })
  fsImpl.rmSync(journalPath(userDataDir), { force: true })
  syncDir(userDataDir, fsImpl)
  return { finished: true }
}
