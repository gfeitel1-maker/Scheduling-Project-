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
import { deriveImportedElectiveRunId } from '../electron/ops/electiveDerivedIds.js'
import { inferPreferenceLayout, parsePreferenceSheet } from '../src/ingest/preferenceSheet.js'
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
    // Non-empty by DEFAULT (ADR section 3.4) — the loud half. Present on every
    // result shape, preview and commit alike, so a caller never has to ask
    // whether this import had a residue ledger.
    residue: [],
    coverage: { measurable: false, unmeasuredCampers: 0, campers: 0 },
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
  // The header is LOCATED, not assumed to be row 1 (T285 slice A): a title and a
  // season line above the table are ordinary, and assuming row 1 made such a
  // sheet "not a camper preference sheet".
  const mapping = inferPreferenceLayout(rows)
  if (mapping.unmapped.length > 0) {
    return errorResult(
      base,
      `that file does not look like a camper preference sheet — could not find: ${mapping.unmapped.join(', ')}. ` +
        'Expected a camper-name column and columns headed #1, #2, … for the ranked choices.'
    )
  }

  // THE DUPLICATE-RANK REFUSAL IS GONE (T285 slice A, ADR §14.1). It used to
  // refuse a header listing '#1' twice. Two columns claiming one rank is not a
  // file this app cannot read — it is an UNORDERED SET (ADR §4.1), a tie among
  // equals — so `inferPreferenceMapping` now routes those columns to rank NULL
  // with a `DUPLICATED_RANK_HEADER` residue item, and the reader states what it
  // did instead of refusing. The original worry behind the refusal is answered
  // rather than ignored: two '#1' columns no longer reach the parser as one
  // camper holding rank 1 twice, because an unranked preference is exempt from
  // the contradictory-ranks check, so no director is sent hunting through rows
  // for a problem that is in row 1.

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

    // THE CAMP'S OWN ENTITIES, read here and passed in as plain arrays so the
    // transform stays pure. This is what RESOLVE resolves AGAINST (ADR section
    // 12.0): a choice label against the activity catalog, a division label
    // against groups and then tiers. Read-only — this path never creates a
    // group, a tier or an activity from an imported file, which is T224's
    // lesson stated as a rule.
    const catalog = {
      activities: db.prepare('SELECT name FROM activities WHERE camp_id = ?').all(camp.id).map((r) => r.name),
      groups: db.prepare('SELECT id, name FROM groups WHERE camp_id = ?').all(camp.id),
      tiers: db.prepare('SELECT id, name FROM tiers WHERE camp_id = ?').all(camp.id),
    }

    const parsed = parsePreferenceSheet(rows, { campId: camp.id, mapping, catalog })
    const report = {
      ...base,
      mapping,
      counts: {
        campers: parsed.campers.length,
        choices: parsed.choices.length,
        // POST-RESOLUTION, and that is the whole point (ADR section 12.2b).
        // `parsed.preferences` is already collision-resolved, so this number,
        // commitElectiveRun's `counts.preferences`, and the number of rows
        // written are the SAME number by construction. P02's 200-vs-160
        // disagreement cannot recur, because there is only one number.
        preferences: parsed.preferences.length,
      },
      sameNameCampers: parsed.sameNameCampers,
      skippedRows: parsed.skippedRows,
      residue: parsed.residue,
      coverage: parsed.coverage,
    }

    if (action !== 'commit') {
      // A preview must be able to say "this would be refused, and why" without
      // touching the db — so it asks the commit path's own refusal check rather
      // than re-deciding, which is how the two stay in agreement.
      return { ...report, ok: true, blocked: describeElectiveRunRefusal(parsed), exitCode: 0 }
    }

    // One device per db on this path for the same structural reason as the
    // camp lookup above: the CLI operates on a single device's database file,
    // so "the device" is unambiguous and needs no selector.
    const device = db.prepare('SELECT id FROM devices LIMIT 1').get()
    if (!device) return { ...report, ok: false, error: 'db has no device registered yet', exitCode: 1 }

    // Checked here rather than left to the FOREIGN KEY, which rolls back
    // correctly but reports 'FOREIGN KEY constraint failed' — true, and
    // useless to whoever passed the id.
    if (authorUserId != null) {
      const author = db.prepare('SELECT id FROM users WHERE id = ?').get(authorUserId)
      if (!author) {
        return {
          ...report,
          ok: false,
          error: `author_user_id ${authorUserId} is not a user in this camp's database`,
          exitCode: 1,
        }
      }
    }

    // Identifies the exact bytes this run came from, so a director looking at a
    // run later can tell whether a resent sheet is the same document.
    const sourceSha256 = createHash('sha256').update(buf).digest('hex')

    let outcome
    try {
      // T250: no `lockedAssignments` here, and that is correct rather than an
      // omission — this CLI runs no solve at all (it commits with
      // `assignments: []`), so there are no locked seats to carry through.
      // The caller that DOES solve, and that must pass them, is
      // src/screens/elective/assignment/AssignmentPanel.jsx.
      outcome = commitElectiveRun(db, {
        campId: camp.id,
        deviceId: device.id,
        authorUserId,
        // Derived, NOT minted — see deriveImportedElectiveRunId. Re-sending the
        // same bytes converges onto one run (an idempotent retry); a corrected
        // sheet is different bytes and so a new run. Only this caller can make
        // that choice: the renderer's solve path has no document to key on and
        // must keep minting its own.
        runId: deriveImportedElectiveRunId(camp.id, sourceSha256),
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
