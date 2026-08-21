// Core of the headless ingestion CLI (T51). scripts/ingest.js is the thin
// argv-parsing + printing wrapper around runIngestCli, so tests can exercise
// real logic directly against a temp db instead of spawning a subprocess.
//
// docs/work/specs/2026-08-20-ingestion-cli-design.md
//
// No ingestion logic is forked here — this is pure harness. It reuses the
// SAME headless path test/integration/scenarios/21-ingest-prior-year.js
// drives: openLocalDb -> parseTextGrid/workbookToPages -> extractEntities ->
// commitIngest (electron/ops/ingest.js, the host-only commit path the app's
// IPC handler also calls).
//
// Trust model: the CLI operates directly on a db FILE (filesystem is the
// trust boundary). It never opens a network socket, never mints/accepts a
// session token, and never touches auth — it is a local operator acting as
// the single writer, same as the integration tests and any SQLite tool.

import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'

import { openLocalDb } from '../electron/db/localDb.js'
import { commitIngest } from '../electron/ops/ingest.js'
import { parseTextGrid } from '../src/ingest/textGrid.js'
import { workbookToPages } from '../src/ingest/sheetGrid.js'
import { extractEntities, INGESTIBLE_ENTITIES } from '../src/ingest/extractEntities.js'
import { inferFixedEvents } from '../src/ingest/fixedEvents.js'
import { assertImportFileSize, assertWorkbookComplexity, unescapeRow } from '../src/utils/exportSanitize.js'

const WORKBOOK_EXT = /\.(xlsx|xlsm|xls)$/i

function baseResult({ file, dbPath, mode, action }) {
  return {
    ok: false,
    action,
    mode,
    file,
    db: dbPath,
    error: null,
    summary: null,
    conflicts: [],
    residual: null,
    exitCode: 1,
  }
}

function errorResult(base, message) {
  return { ...base, ok: false, error: message, exitCode: 1 }
}

function readPages(file) {
  const buf = fs.readFileSync(file)
  if (WORKBOOK_EXT.test(file)) {
    assertImportFileSize(buf.length)
    const workbook = XLSX.read(buf, { type: 'buffer' })
    assertWorkbookComplexity(workbook)
    const sheets = workbook.SheetNames.map((name) => ({
      name,
      rows: XLSX.utils
        .sheet_to_json(workbook.Sheets[name], { header: 1, blankrows: false, defval: '', raw: false })
        .map(unescapeRow),
    }))
    const pages = workbookToPages(sheets, path.basename(file))
    return { pages, residualSheets: pages.residual ?? [] }
  }
  const pages = parseTextGrid(buf.toString('utf8')).pages
  return { pages, residualSheets: [] }
}

/**
 * PURE-ish orchestration core: parse -> plan -> report -> (preview | commit).
 * No stdout/argv here — scripts/ingest.js owns printing and process.exit.
 *
 * @returns {{ ok, action, mode, file, db, error, summary, conflicts, residual, exitCode }}
 */
export function runIngestCli({ file, dbPath, mode = 'add', action = 'preview', authorUserId = null }) {
  const base = baseResult({ file, dbPath, mode, action })

  let buf
  try {
    buf = fs.statSync(file)
  } catch (e) {
    return errorResult(base, `cannot read file: ${file} (${e.message})`)
  }
  if (!buf.isFile()) return errorResult(base, `not a file: ${file}`)

  let pages, residualSheets
  try {
    ;({ pages, residualSheets } = readPages(file))
  } catch (e) {
    return errorResult(base, `parse error: ${e.message}`)
  }
  if (!pages || pages.length === 0) {
    return errorResult(base, 'No schedule could be read out of that file.')
  }

  const proposal = extractEntities({ pages })
  const { fixedEvents } = inferFixedEvents({ pages }, proposal)

  if (!fs.existsSync(dbPath)) return errorResult(base, `db not found: ${dbPath}`)

  let db
  try {
    db = openLocalDb(dbPath)
  } catch (e) {
    return errorResult(base, `cannot open db: ${dbPath} (${e.message})`)
  }

  try {
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return errorResult(base, 'db has no camp bootstrapped yet')
    const device = db.prepare('SELECT id FROM devices LIMIT 1').get()
    if (!device) return errorResult(base, 'db has no device registered yet')

    const approved = {}
    for (const entity of INGESTIBLE_ENTITIES) approved[entity] = [...(proposal.entities[entity] ?? [])]

    const dryRun = action !== 'commit'
    let outcome
    try {
      outcome = commitIngest(db, {
        approved,
        links: { groups: proposal.groupUnits },
        camp_id: camp.id,
        author_user_id: authorUserId,
        device_id: device.id,
        fixedEvents,
        mode,
        seenCounts: proposal.seenCounts,
        dryRun,
      })
    } catch (e) {
      return errorResult(base, `commit failed: ${e.message}`)
    }

    const unchanged = Array.isArray(outcome.planItems)
      ? outcome.planItems.filter((item) => item.op === 'unchanged').length
      : null

    return {
      ...base,
      ok: !outcome.held,
      error: outcome.held ? 'import held for review — conflicting or ambiguous entries' : null,
      summary: {
        created: outcome.created,
        updated: outcome.updated,
        unchanged,
        conflicts: outcome.conflicts?.length ?? 0,
        held: outcome.held,
        total: outcome.total,
        fixedEventsCreated: outcome.fixedEvents?.created ?? 0,
      },
      conflicts: outcome.conflicts ?? [],
      residual: {
        sheets: residualSheets,
        cells: proposal.residual?.cells ?? [],
      },
      exitCode: outcome.held ? 2 : 0,
    }
  } finally {
    db.close()
  }
}
