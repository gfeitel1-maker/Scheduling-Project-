/**
 * Project-file lifecycle utilities: recent-projects list, backup rotation,
 * and current-project persistence. All I/O is synchronous (better-sqlite3
 * convention — no async in the main-process db layer).
 */

import fs from 'node:fs'
import path from 'node:path'

const RECENT_PROJECTS_FILE = 'recent-projects.json'
const CURRENT_PROJECT_FILE = 'current-project.json'
const BACKUP_DIR_NAME = 'backups'
const MAX_BACKUPS = 10
const MAX_RECENT = 5

// ---------------------------------------------------------------------------
// Current project path
// ---------------------------------------------------------------------------

export function getCurrentProjectPath(userDataPath, defaultPath) {
  const filePath = path.join(userDataPath, CURRENT_PROJECT_FILE)
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    // Only return the stored path if the file still exists on disk.
    if (data.path && fs.existsSync(data.path)) return data.path
  } catch {
    /* fall through to default */
  }
  return defaultPath
}

export function setCurrentProjectPath(userDataPath, dbPath) {
  fs.writeFileSync(
    path.join(userDataPath, CURRENT_PROJECT_FILE),
    JSON.stringify({ path: dbPath, updatedAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 }
  )
}

// ---------------------------------------------------------------------------
// Recent projects
// ---------------------------------------------------------------------------

export function readRecentProjects(userDataPath) {
  const filePath = path.join(userDataPath, RECENT_PROJECTS_FILE)
  try {
    const entries = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (!Array.isArray(entries)) return []
    // Normalize and filter out paths that no longer exist.
    return entries.filter((e) => e && typeof e.path === 'string' && fs.existsSync(e.path))
  } catch {
    return []
  }
}

export function addRecentProject(userDataPath, { path: dbPath, campName }) {
  // Remove any existing entry for this path, prepend the new one, cap at 5.
  const existing = readRecentProjects(userDataPath).filter((e) => e.path !== dbPath)
  const entries = [
    { path: dbPath, campName: campName ?? null, lastOpenedAt: new Date().toISOString() },
    ...existing,
  ].slice(0, MAX_RECENT)
  fs.writeFileSync(
    path.join(userDataPath, RECENT_PROJECTS_FILE),
    JSON.stringify(entries, null, 2),
    { mode: 0o600 }
  )
  return entries
}

// ---------------------------------------------------------------------------
// Backup helpers
// ---------------------------------------------------------------------------

/**
 * Rotate backups in backupDir: delete oldest shoresh-*.db files until fewer
 * than `max` exist (making room for the one we're about to write).
 */
function rotateBackups(backupDir, max) {
  let files
  try {
    files = fs.readdirSync(backupDir)
      .filter((f) => /^shoresh-.*\.db$/.test(f))
      .map((f) => {
        const fullPath = path.join(backupDir, f)
        return { name: f, mtime: fs.statSync(fullPath).mtimeMs, fullPath }
      })
      .sort((a, b) => a.mtime - b.mtime) // oldest first
  } catch {
    return
  }
  while (files.length >= max) {
    const oldest = files.shift()
    try { fs.unlinkSync(oldest.fullPath) } catch { /* ignore — disk race */ }
  }
}

/**
 * Write a dated backup of dbPath into {userData}/backups/.
 * Rotates to keep at most MAX_BACKUPS files.
 * Returns the backup file path.
 */
export function writeUserBackup(dbPath, userDataPath) {
  const backupDir = path.join(userDataPath, BACKUP_DIR_NAME)
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  }
  rotateBackups(backupDir, MAX_BACKUPS)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(backupDir, `shoresh-${ts}.db`)
  fs.copyFileSync(dbPath, backupPath)
  // Restrict backup file permissions so it's not world-readable.
  try { fs.chmodSync(backupPath, 0o600) } catch { /* non-fatal on Windows */ }
  return backupPath
}

/**
 * Rotate pre-resolution backup files that sit beside the db file.
 * Files match the pattern: `{dbBasename}.pre-resolve-*.sqlite` in the same
 * directory as dbPath. Keeps at most `max` files, deleting the oldest first.
 * Called before each new pre-resolve backup is written so the directory
 * never accumulates unbounded files.
 */
export function rotatePreResolveBackups(dbPath, max = MAX_BACKUPS) {
  const dir = path.dirname(dbPath)
  const base = path.basename(dbPath, '.sqlite')
  let files
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.pre-resolve-`) && f.endsWith('.sqlite'))
      .map((f) => {
        const fullPath = path.join(dir, f)
        return { name: f, mtime: fs.statSync(fullPath).mtimeMs, fullPath }
      })
      .sort((a, b) => a.mtime - b.mtime) // oldest first
  } catch {
    return
  }
  while (files.length >= max) {
    const oldest = files.shift()
    try { fs.unlinkSync(oldest.fullPath) } catch { /* ignore — disk race */ }
  }
}

/**
 * Write a pre-migration backup to the same directory as the db file.
 * Named {dbPath}.pre-migration-{timestamp}.bak.
 * Returns the backup path, or null if the source doesn't exist yet (fresh db).
 */
export function writePreMigrationBackup(dbPath) {
  if (!fs.existsSync(dbPath)) return null
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${dbPath}.pre-migration-${ts}.bak`
  fs.copyFileSync(dbPath, backupPath)
  try { fs.chmodSync(backupPath, 0o600) } catch { /* non-fatal */ }
  return backupPath
}
