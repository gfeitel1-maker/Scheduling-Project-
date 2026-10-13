// Disk side of Save whole camp / Open a saved camp (docs/adr/2026-10-13-whole-camp-file-save-and-open.md sections 1, 5).
// The file path never leaves this module: callers get a basename. The dialogs are injected so main.js owns Electron.

import fs from 'node:fs'
import path from 'node:path'
import { CAMP_FILE_CAPS, CAMP_FILE_EXTENSION } from './campFileScope.js'
import { exportCampFile, serializeCampFile } from './exportCampFile.js'
import { validateCampFile } from './validateCampFile.js'

const UNSAFE_NAME_CHARS = /[\\/:*?"<>|]/g

export function defaultCampFileName(campName) {
  const cleaned = [...String(campName ?? '')].filter((c) => c.charCodeAt(0) >= 32).join('').replace(UNSAFE_NAME_CHARS, ' ').replace(/\.{2,}/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '')
  return `${cleaned || 'My camp'}${CAMP_FILE_EXTENSION}`
}

// Temp file in the same folder, then rename: a crash never leaves a truncated file that looks complete.
export async function saveCampFileToDisk({ db, camp, showSaveDialog, appVersion = null, caps }) {
  const chosen = await showSaveDialog(defaultCampFileName(camp.name))
  if (chosen?.canceled || !chosen?.filePath) return { ok: false, reason: 'canceled' }
  const target = chosen.filePath.endsWith(CAMP_FILE_EXTENSION) ? chosen.filePath : `${chosen.filePath}${CAMP_FILE_EXTENSION}`
  const temp = `${target}.tmp-${process.pid}`
  const report = {}
  try {
    const file = exportCampFile(db, camp.id, { appVersion, report })
    const text = serializeCampFile(file)
    const sized = validateCampFile(text, { caps })
    if (!sized.ok && sized.reason === 'too_large') return { ok: false, reason: 'too_large', detail: sized.detail ?? {} }
    fs.writeFileSync(temp, text, { mode: 0o600 })
    fs.renameSync(temp, target)
    const total = Object.values(file.counts).reduce((a, b) => a + b, 0)
    return { ok: true, fileName: path.basename(target), counts: file.counts, total, report, leftOut: report.droppedRows + report.nulledReferences }
  } catch (err) {
    try { fs.rmSync(temp, { force: true }) } catch { /* nothing to clean */ }
    return { ok: false, reason: 'write_failed', message: `The file could not be saved (${err?.code ?? 'unknown error'}). Pick a different folder and try again.` }
  }
}

// Size is checked from stat BEFORE the file is read into memory; validation is the phase-1 validator, unchanged.
export async function pickCampFileFromDisk({ showOpenDialog }) {
  const chosen = await showOpenDialog()
  if (chosen?.canceled || !chosen?.filePaths?.length) return { ok: false, reason: 'canceled' }
  const filePath = chosen.filePaths[0]
  const fileName = path.basename(filePath)
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    return { ok: false, reason: 'not_a_camp_file', fileName, detail: {} }
  }
  if (!stat.isFile()) return { ok: false, reason: 'not_a_camp_file', fileName, detail: {} }
  if (stat.size > CAMP_FILE_CAPS.MAX_FILE_BYTES) return { ok: false, reason: 'too_large', fileName, detail: { bytes: stat.size } }
  let bytes
  try {
    bytes = fs.readFileSync(filePath)
  } catch {
    return { ok: false, reason: 'not_a_camp_file', fileName, detail: {} }
  }
  const checked = validateCampFile(bytes)
  if (!checked.ok) return { ok: false, reason: checked.reason, fileName, detail: checked.detail ?? {} }
  return { ok: true, fileName, file: checked.file }
}
