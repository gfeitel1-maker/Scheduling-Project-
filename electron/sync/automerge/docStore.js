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
//
// `cipher` (optional): a { encrypt, decrypt } from electron/db/docCipher.js. When present the
// document bytes are encrypted at rest under the per-device key (at-rest encryption, ADR
// 2026-09-15). When ABSENT the file is written plaintext exactly as before — the default is
// unchanged, so this seam is inert until a caller injects the cipher (which main.js/liveDoc will,
// once the key is wired). The passthrough on the read side (docCipher.decrypt) also means a legacy
// plaintext file still loads and is re-written encrypted on the next save.
export function saveDoc(userDataDir, campId, doc, cipher = null) {
  const targetPath = docPath(userDataDir, campId)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })

  const bytes = Buffer.from(encodeDoc(doc))
  const out = cipher ? cipher.encrypt(bytes) : bytes
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmpPath, out)
  fs.renameSync(tmpPath, targetPath)
}

export function loadDoc(userDataDir, campId, cipher = null) {
  const targetPath = docPath(userDataDir, campId)
  if (!fs.existsSync(targetPath)) return null
  const raw = fs.readFileSync(targetPath)
  const bytes = cipher ? cipher.decrypt(raw) : raw
  return decodeDoc(bytes)
}
