// What the renderer and the Start over action need to know about a camp that was being filled from a camp file
// (docs/adr/2026-10-13-whole-camp-file-save-and-open.md section 3, "Atomicity").

import path from 'node:path'
import { readLoadIncomplete } from './loadCampFile.js'

export function readCampStatus(db) {
  const camp = db.prepare('SELECT id, name FROM camps LIMIT 1').get()
  if (!camp) return null
  return { ...camp, loadIncomplete: readLoadIncomplete(db) !== null }
}

// Start over only ever walks away from a camp that was never usable: one left half-loaded, or one that was just
// bootstrapped and is still empty. A real camp with setup data and no marker is refused, so a stray call cannot
// abandon it.
const SETUP_TABLES = ['tiers', 'groups', 'time_blocks', 'activities']
export function canStartOver(db) {
  if (readLoadIncomplete(db) !== null) return true
  return !SETUP_TABLES.some((t) => db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get())
}

export function freshProjectPath(currentDbPath, now = Date.now) {
  const ext = path.extname(currentDbPath) || '.sqlite'
  return path.join(path.dirname(currentDbPath), `${path.basename(currentDbPath, ext)}-fresh-${now()}${ext}`)
}
