// Stage 5 persistence (docs/work/plans/2026-09-06-stage5-live-wiring-design.md § 5): the Automerge
// camp document lives in a plain file, not a SQLite blob — SQLite is derived, this file is the
// authoritative artifact for the flagged path. Node fs only; `userDataDir` is a parameter, never
// electron `app`, so this stays Electron-free and testable (mirrors electron/db/userDataPath.js's
// injected-path pattern).
import fs from 'node:fs'
import path from 'node:path'
import { saveDoc as encodeDoc, loadDoc as decodeDoc } from '../../automerge/campDocument.js'

export function docPath(userDataDir, campId) {
  return path.join(userDataDir, 'automerge', `${campId}.automerge`)
}

// Atomic write: write to a temp file in the same directory, then rename over the target. A crash
// mid-write leaves either the old file or the temp file, never a truncated/corrupt target, since
// rename is atomic on the same filesystem.
export function saveDoc(userDataDir, campId, doc) {
  const targetPath = docPath(userDataDir, campId)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })

  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmpPath, encodeDoc(doc))
  fs.renameSync(tmpPath, targetPath)
}

export function loadDoc(userDataDir, campId) {
  const targetPath = docPath(userDataDir, campId)
  if (!fs.existsSync(targetPath)) return null
  return decodeDoc(fs.readFileSync(targetPath))
}
