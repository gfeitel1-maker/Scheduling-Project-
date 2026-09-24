// Core of the headless camper-preference-sheet importer (T226).
//
// docs/work/tickets/T226-camper-preference-import.md,
// docs/adr/2026-09-17-individual-elective-scheduling.md (D12, D14).
//
// WHY THIS IS A SEPARATE CORE FROM runIngestCli. A schedule grid and a camper
// ranked-preference sheet are different documents with different commit paths:
// the schedule path runs extractEntities -> commitIngest and is gated by
// partitionSchedulePages, and that gate (T224) exists SPECIFICALLY to refuse a
// preference sheet — a camper elective-selection form once committed its column
// headers ('#1', '#2', 'Division') as camp groups and again as tiers. Teaching
// runIngestCli to sometimes mean "preference sheet" would reopen exactly that
// hole. So this is a sibling, symmetric in shape and error discipline, sharing
// nothing but the file-reading helpers.
//
// No parsing or commit logic is forked here — this is pure harness over
// inferPreferenceMapping/parsePreferenceSheet (src/ingest/preferenceSheet.js)
// and commitElectiveRun (electron/ops/commitElectiveRun.js), the same pair the
// app's IPC handler drives.
//
// Trust model: same as runIngestCli — the CLI operates directly on a db FILE
// (the filesystem is the trust boundary), opens no socket, and never touches
// auth.

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import * as XLSX from 'xlsx'

import { openLocalDb } from '../electron/db/localDb.js'
import { commitElectiveRun, describeElectiveRunRefusal } from '../electron/ops/commitElectiveRun.js'
import { inferPreferenceMapping, parsePreferenceSheet } from '../src/ingest/preferenceSheet.js'
import { readWorkbookSafely, unescapeRow } from '../src/utils/exportSanitize.js'

function baseResult({ file, dbPath, action }) {
  return {
    ok: false,
    action,
    file,
    db: dbPath,
    error: null,
    mapping: null,
    counts: null,
    sameNameCampers: [],
    skippedRows: [],
    blocked: null,
    runId: null,
    exitCode: 1,
  }
}

const errorResult = (base, message) => ({ ...base, ok: false, error: message, exitCode: 1 })

// One reader for .xlsx/.xlsm/.xls and .csv/.tsv alike: SheetJS sniffs the
// delimited formats from the same buffer, so a camp that exports CSV and a camp
// that exports a workbook take the identical path — and both get the import
// size/complexity limits readWorkbookSafely enforces.
//
// FIRST SHEET ONLY. A preference sheet is one table; there is no
// workbookToPages equivalent here, and silently concatenating tabs would merge
// two different submissions into one run.
function readRows(buf) {
  const workbook = readWorkbookSafely(buf, { type: 'buffer', byteLength: buf.length })
  const name = workbook.SheetNames[0]
  if (!name) return []
  return XLSX.utils
    .sheet_to_json(workbook.Sheets[name], { header: 1, blankrows: false, defval: '', raw: false })
    .map(unescapeRow)
}

/**
 * PURE-ish orchestration core: read -> map -> parse -> (preview | commit).
 * No stdout/argv here, and never throws past this boundary.
 *
 * @returns {{ ok, action, file, db, error, mapping, counts, sameNameCampers, skippedRows, blocked, runId, exitCode }}
 */
export function runPreferenceSheetCli({
  file,
  dbPath,
  action = 'preview',
  runName = null,
  authorUserId = null,
  dbKey = null,
}) {
  const base = baseResult({ file, dbPath, action })

  // Read once: the same bytes are parsed below and hashed on commit, and
  // re-reading could hash a different file than the one that was parsed.
  let buf
  try {
    if (!fs.statSync(file).isFile()) return errorResult(base, `not a file: ${file}`)
    buf = fs.readFileSync(file)
  } catch (e) {
    return errorResult(base, `cannot read file: ${file} (${e.message})`)
  }

  let rows
  try {
    rows = readRows(buf)
  } catch (e) {
    return errorResult(base, `parse error: ${e.message}`)
  }
  if (rows.length < 2) {
    return errorResult(base, 'that file has no rows under its header — nothing to import')
  }

  // NEVER GUESS. D14's whole point is that the column arrangement of a
  // third-party export is unknown, so a field the header does not name is
  // reported back by name rather than assumed into a position.
  const mapping = inferPreferenceMapping(rows[0])
  if (mapping.unmapped.length > 0) {
    return errorResult(
      base,
      `that file does not look like a camper preference sheet — could not find: ${mapping.unmapped.join(', ')}. ` +
        'Expected a camper-name column and columns headed #1, #2, … for the ranked choices.'
    )
  }

  if (!fs.existsSync(dbPath)) return errorResult(base, `db not found: ${dbPath}`)

  let db
  try {
    db = openLocalDb(dbPath, { key: dbKey })
  } catch (e) {
    return errorResult(base, `cannot open db: ${dbPath} (${e.message})`)
  }

  try {
    // One camp per device db — the same lookup every other read in this repo
    // uses, and the reason camp isolation needs no filter.
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) return errorResult(base, 'db has no camp bootstrapped yet')

    const parsed = parsePreferenceSheet(rows, { campId: camp.id, mapping })
    const report = {
      ...base,
      mapping,
      counts: {
        campers: parsed.campers.length,
        choices: parsed.choices.length,
        preferences: parsed.preferences.length,
      },
      sameNameCampers: parsed.sameNameCampers,
      skippedRows: parsed.skippedRows,
    }

    if (action !== 'commit') {
      // A preview must be able to say "this would be refused, and why" without
      // touching the db — so it asks the commit path's own refusal check rather
      // than re-deciding, which is how the two stay in agreement.
      return { ...report, ok: true, blocked: describeElectiveRunRefusal(parsed), exitCode: 0 }
    }

    const device = db.prepare('SELECT id FROM devices LIMIT 1').get()
    if (!device) return { ...report, ok: false, error: 'db has no device registered yet', exitCode: 1 }

    // Identifies the exact bytes this run came from, so a director looking at a
    // run later can tell whether a resent sheet is the same document.
    const sourceSha256 = createHash('sha256').update(buf).digest('hex')

    let outcome
    try {
      outcome = commitElectiveRun(db, {
        campId: camp.id,
        deviceId: device.id,
        authorUserId,
        name: runName ?? path.basename(file),
        sourceFilename: path.basename(file),
        sourceSha256,
        parsed,
        assignments: [],
        occurrences: [],
      })
    } catch (e) {
      return { ...report, ok: false, error: `commit failed: ${e.message}`, exitCode: 1 }
    }

    if (!outcome.ok) return { ...report, ok: false, error: outcome.error, exitCode: 1 }
    return { ...report, ok: true, runId: outcome.runId, exitCode: 0 }
  } finally {
    db.close()
  }
}
