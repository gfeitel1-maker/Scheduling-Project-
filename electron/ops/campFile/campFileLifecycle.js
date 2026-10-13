// What the renderer and the Start over action need to know about a camp that was being filled from a camp file
// (docs/adr/2026-10-13-whole-camp-file-save-and-open.md section 3, "Atomicity").

import path from 'node:path'
import { readLoadIncomplete } from './loadCampFile.js'

export function readCampStatus(db) {
  const camp = db.prepare('SELECT id, name FROM camps LIMIT 1').get()
  if (!camp) return null
  return { ...camp, loadIncomplete: readLoadIncomplete(db) !== null }
}

// Start over only ever walks away from a profile whose open-from-file did not finish: the marker is set before the
// camp is made, so even a crash before the director could sign in leaves it. It takes no sign-in on purpose (that
// director may be unable to log in in this state); the marker is the whole gate, and every other camp is refused.
// Nothing is deleted: the abandoned profile stays on disk.
export function canStartOver(db) {
  return readLoadIncomplete(db) !== null
}

export function freshProjectPath(currentDbPath, now = Date.now) {
  const ext = path.extname(currentDbPath) || '.sqlite'
  return path.join(path.dirname(currentDbPath), `${path.basename(currentDbPath, ext)}-fresh-${now()}${ext}`)
}
