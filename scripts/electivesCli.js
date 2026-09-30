// T198 — core of the headless `electives` CLI. scripts/electives.js is the thin argv-parsing +
// printing wrapper around runElectivesCli, mirroring scripts/ingestCli.js/scripts/ingest.js.
//
// `preview` and `commit` are a LITERAL PASSTHROUGH to runPreferenceSheetCli
// (scripts/preferenceSheetCli.js) — that module already owns the read -> map -> parse ->
// (preview | commit) logic and its own full test coverage; nothing is re-implemented here.
//
// `export` is the one action genuinely new to this file: it builds the run's projection input via
// buildElectiveRunProjectionInput (electron/ops/electiveRunProjectionInput.js) — the SAME assembly
// the MCP `export_elective_assignments` tool calls (scripts/mcp/tools.js) — and either returns the
// combined JSON document or writes an XLSX workbook to `file`.
//
// `generate` (solving a run) is NOT implemented and is not an action this function accepts.
//
// Trust model: same as runIngestCli/runPreferenceSheetCli — this operates directly on a db FILE (the
// filesystem is the trust boundary), opens no socket, and never touches auth.
import fs from 'node:fs'
import * as XLSX from 'xlsx'

import { openLocalDb } from '../electron/db/localDb.js'
import { runPreferenceSheetCli } from './preferenceSheetCli.js'
import { buildElectiveRunProjectionInput } from '../electron/ops/electiveRunProjectionInput.js'
import { buildElectiveRunProjectionExport } from '../src/screens/elective/export/exportElectiveRunProjection.js'
import { buildElectiveRunWorkbook } from '../src/screens/elective/export/exportElectiveRunWorkbook.js'

function runExport({ runId, dbPath, dbKey, format, file }) {
  if (!runId) return { ok: false, action: 'export', error: 'runId is required', exitCode: 1 }
  if (!fs.existsSync(dbPath)) return { ok: false, action: 'export', error: `db not found: ${dbPath}`, exitCode: 1 }

  const db = openLocalDb(dbPath, { key: dbKey ?? null })
  try {
    const result = buildElectiveRunProjectionInput(db, { runId })
    if (!result.ok) return { ok: false, action: 'export', error: result.error, exitCode: 1 }

    if (format === 'json') {
      return { ok: true, action: 'export', export: buildElectiveRunProjectionExport(result.input), exitCode: 0 }
    }
    if (format === 'xlsx') {
      if (!file) return { ok: false, action: 'export', error: 'file is required for format xlsx', exitCode: 1 }
      const workbook = buildElectiveRunWorkbook(result.input)
      fs.writeFileSync(file, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
      return { ok: true, action: 'export', file, exitCode: 0 }
    }
    return { ok: false, action: 'export', error: `unknown format: ${format} (must be json or xlsx)`, exitCode: 1 }
  } finally {
    db.close()
  }
}

export function runElectivesCli({ action, runId = null, dbPath, dbKey = null, format = 'json', file = null, ...rest }) {
  if (action === 'preview' || action === 'commit') {
    return runPreferenceSheetCli({ ...rest, file, dbPath, action, dbKey })
  }
  if (action === 'export') {
    return runExport({ runId, dbPath, dbKey, format, file })
  }
  return { ok: false, action, error: `unknown action: ${action} (must be preview, commit, or export)`, exitCode: 1 }
}
