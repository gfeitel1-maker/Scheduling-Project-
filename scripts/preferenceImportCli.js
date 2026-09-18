// T195 — headless preview-only CLI for the preference import service.
// Follows scripts/ingestCli.js's shape: pure(-ish) orchestration core, no
// stdout/argv here. Commit is deliberately NOT exposed — T198 owns wiring a
// commit path to any CLI/MCP surface; this file only ever previews.
//
// Trust model matches ingestCli.js: operates directly on a db FILE, never a
// network socket, never a session token.
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { openLocalDb } from '../electron/db/localDb.js'
import { parsePreferenceSheet } from '../src/ingest/preferenceImport/parseSheet.js'
import { previewPreferenceImport } from '../electron/ops/preferenceImportPreview.js'
import { sanitizeCell } from '../src/utils/exportSanitize.js'

function baseResult({ file, dbPath, camp_id, run_id }) {
  return { ok: false, action: 'preview', file, db: dbPath, camp_id, run_id, error: null, result: null, exitCode: 1 }
}

function errorResult(base, message) {
  return { ...base, ok: false, error: sanitizeCell(message), exitCode: 1 }
}

/**
 * @returns {{ ok, action, file, db, camp_id, run_id, error, result, exitCode }}
 */
export function runPreferenceImportCli({ file, dbPath, camp_id, run_id, mapping, action = 'preview' }) {
  const base = baseResult({ file, dbPath, camp_id, run_id })

  if (action !== 'preview') {
    return errorResult(base, `preferenceImportCli only supports action 'preview' (got '${action}') — commit is not exposed here (T198)`)
  }

  let buf
  try {
    buf = fs.readFileSync(file)
  } catch (err) {
    return errorResult(base, `could not read file: ${err.message}`)
  }

  let db
  try {
    db = openLocalDb(dbPath)
  } catch (err) {
    return errorResult(base, `could not open db: ${err.message}`)
  }

  try {
    const { headers, rows } = parsePreferenceSheet(buf)
    const source_sha256 = createHash('sha256').update(buf).digest('hex')
    const result = previewPreferenceImport(db, { camp_id, run_id, headers, rows, mapping, source_sha256 })
    return { ...base, ok: true, error: null, result, exitCode: 0 }
  } catch (err) {
    return errorResult(base, err.message)
  } finally {
    db.close()
  }
}
