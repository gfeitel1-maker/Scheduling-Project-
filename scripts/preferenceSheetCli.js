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
import { detectGridLayout, inferPreferenceLayout, parsePreferenceSheet } from '../src/ingest/preferenceSheet.js'
import { submissionKeyFromRows } from '../src/ingest/preferenceImport.js'
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
// EVERY SHEET, read separately and never concatenated (T285 slice D).
//
// This used to be FIRST SHEET ONLY, and the reason recorded here was real:
// "silently concatenating tabs would merge two different submissions into one
// run." That hazard is ANSWERED rather than removed. The rule is per-sheet
// CLASSIFICATION: each tab is mapped on its own, exactly ONE is chosen as the
// preference sheet, and every other is reported by name. Nothing is ever
// concatenated, so two submissions still cannot merge — while a workbook whose
// preferences are not on tab 1 stops being "not a camper preference sheet",
// which is what ADR §14.1 rules is not a reason to refuse.
function readSheets(buf) {
  const workbook = readWorkbookSafely(buf, { type: 'buffer', byteLength: buf.length })
  return workbook.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils
      .sheet_to_json(workbook.Sheets[name], { header: 1, blankrows: false, defval: '', raw: false })
      .map(unescapeRow),
  }))
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
  // T285 slice G. WHOSE sheet this is, when the caller knows — the portal, the
  // import screen's selection, or an agent driving the CLI. A planner grid has no
  // name column because the identity comes from the SUBMISSION, not the page, so
  // this is the first and best source in the identity order.
  camperName = null,
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

  let sheets
  try {
    sheets = readSheets(buf)
  } catch (e) {
    return errorResult(base, `parse error: ${e.message}`)
  }
  if (sheets.length === 0 || sheets.every((s) => s.rows.length < 2)) {
    return errorResult(base, 'that file has no rows under its header — nothing to import')
  }

  // NEVER GUESS. D14's whole point is that the column arrangement of a
  // third-party export is unknown, so a field the header does not name is
  // reported back by name rather than assumed into a position.
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

  // Identifies the exact bytes of this submission. Used for the run id (so a resent
  // sheet is an idempotent retry rather than a second run) AND as the identity of an
  // unattributed grid subject — see resolveSubject.
  const submissionSha256 = createHash('sha256').update(buf).digest('hex')

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

    // THE LAYOUT IS INFERRED AFTER THE CATALOG IS READ, and the order is
    // load-bearing (T285 slice C). An INVERTED MATRIX — one column per activity,
    // the cell holding its rank — is recognisable only by matching its headers
    // against the camp's own activities, so the mapping cannot be computed before
    // the db is open. That is RESOLVE doing the work rather than a shape
    // heuristic, and it is what keeps an unseeded camp from having a layout
    // guessed at.
    //
    // The header ROW is located here too (slice A): a title and a season line
    // above the table are ordinary, and assuming row 1 made such a sheet "not a
    // camper preference sheet".
    // EXACTLY ONE SHEET is chosen: the first that maps with nothing unmapped.
    // A menu tab and a planner tab have no camper-name column, so they cannot be
    // chosen — which is how constraint 1 (format-agnostic must not become
    // kind-agnostic) is satisfied structurally rather than by a name check on the
    // tab. If several tabs map cleanly, the first wins and the rest are reported;
    // that is accept-and-report, not a merge.
    const candidates = sheets.map((sheet) => ({
      sheet,
      mapping: inferPreferenceLayout(sheet.rows, { catalog }),
    }))
    const chosen = candidates.find((c) => c.sheet.rows.length >= 2 && c.mapping.unmapped.length === 0)

    // ONE COMPLETION PATH for every shape (T285 slice G). The grid branch and the
    // row-per-camper branch both end here, so preview/commit semantics, the
    // refusal check, the author check and the derived run id cannot drift between
    // them — a second completion path is how T224 happened.
    const finishRun = ({ parsed, mapping, extraResidue = [] }) => {
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
        // The workbook-level residue is the CLI's own: the parser is pure and
        // takes one table, so it cannot know a second tab existed.
        residue: [...extraResidue, ...parsed.residue],
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

      const sourceSha256 = submissionSha256

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
    }

    // THE SUBJECT OF A GRID, resolved in the owner's order, and NEVER blocking the
    // data from landing (T285 slice G):
    //   1. a camper the caller supplied     -> attributed
    //   2. a camper named on the page       -> attributed
    //   3. the filename                     -> provisional, flagged
    //   4. nothing                          -> provisional, flagged
    // An unattributed subject is a first-class outcome, not a failure: the
    // preferences are stored with their coordinates and a human or an agent names
    // the child later, without re-importing. Landing the data unattributed is
    // strictly better than dropping it.
    // TAKES ITS ROWS EXPLICITLY rather than closing over `rows`, which is declared
    // LATER in this function (`const rows = sheet.rows`, after the chosen-sheet
    // branch). Closing over it threw `ReferenceError: Cannot access 'rows' before
    // initialization` from the whole-sheet-grid branch, which runs BEFORE that
    // declaration — caught by the corpus (P19 and P22 moved to THREW), not by any
    // unit test, because only the grid branch reaches it early.
    const resolveSubject = (subjectRows) => {
      // 1. THE CALLER KNOWS. The portal, the import screen's selection, or an agent
      //    driving the CLI/MCP. Attributed outright.
      if (camperName) return { displayName: camperName, source: 'caller', attributed: true }

      // 2/3. Nothing named the child, so the subject is PROVISIONAL — and its
      //    IDENTITY IS THE SUBMISSION, not the filename.
      //
      //    KEYING ON THE FILENAME MERGED TWO REAL CHILDREN, reproduced by
      //    execution: two campers whose portal exported each planner as the ordinary
      //    basename `planner.csv` collapsed onto ONE camper row holding both
      //    children's answers, with two contradictory rank-1 cell choices at every
      //    coordinate — ok=true, no refusal, no residue. `hasContradictoryRanks` and
      //    the parse-level collision pass run PER IMPORT and structurally cannot see
      //    across two. That is the "merge two real children" case the ADR names as
      //    the ONLY legitimate refusal, happening silently on the default path.
      //
      //    The content hash keys it instead, through `deriveCamperId`'s `ext` arm:
      //    two different submissions can never collide, and the SAME bytes re-sent
      //    converge onto one subject rather than duplicating — the same idempotency
      //    the run id already gets from `deriveImportedElectiveRunId`. The filename
      //    stays as the human-readable LABEL so a director recognises which
      //    submission it is; it is no longer the key, so renaming a file no longer
      //    forks the child either.
      const stem = path.basename(file).replace(/\.[^.]+$/, '')
      return {
        displayName: stem || null,
        // `sub-` prefixed so a row read in a SQLite shell is obviously not a camp
        // roster id, and truncated because 32 hex characters already make collision
        // a non-issue while keeping the id legible for diagnosis.
        // ONE RULE, shared with the import screen (src/ingest/preferenceImport.js).
        // A SHA-256 of the file bytes here and a WebCrypto digest there would be TWO
        // rules, and two rules fork one child into two subjects depending on which
        // door their sheet came through.
        externalId: submissionKeyFromRows(subjectRows),
        source: stem ? 'filename' : 'none',
        attributed: false,
      }
    }

    if (!chosen) {
      // NO SHEET NAMES A CAMPER, so no sheet can carry a camper preference — and
      // that is a RESOLUTION fact, not a shape verdict. ADR §14.1: a readable file
      // is never refused, so this is ACCEPTED, writes nothing, and says what it
      // found.
      //
      // THIS IS WHERE CONSTRAINT 1 WOULD HAVE BROKEN, and the way it is avoided
      // matters more than the outcome. An offerings MENU (what is offered) and a
      // filled PLANNER (what was chosen) are the same day x period grid with
      // opposite meanings — ADR §3.3: "only the declared kind separates them, and
      // no amount of shape inference can." Any heuristic here that decided which
      // one it was looking at would be an adapter reading a document of one kind
      // as another, which is precisely the T224 incident.
      //
      // So this does not classify the kind at all. It states the one thing true of
      // BOTH: the page names no camper, therefore it holds no camper preferences.
      // That is checkable, kind-agnostic, and enough.
      // THE MESSAGE MUST NAME THE ACTUAL MISS, not the most likely one. A first
      // draft said "no camper name column" for every unreadable sheet, which is a
      // lie about a sheet that has a name column and only lacks readable ranks —
      // the same confident-wrong-characterization defect slice A had to fix for
      // the preamble. Two different misses, two different sentences.
      // A GRID IS NOT AN UNREADABLE SHEET. Before reporting that nothing could be
      // read, ask whether this is a day x period grid — a camper's own planner —
      // and read it as one subject if so.
      const gridSheet = candidates.find((c) => detectGridLayout(c.sheet.rows, 0) != null)
      if (gridSheet) {
        const layout = detectGridLayout(gridSheet.sheet.rows, 0)
        const parsedGrid = parsePreferenceSheet([], {
          campId: camp.id,
          mapping: { unmapped: [], unrecognisedColumns: [], rankColumns: [], headerIndex: 0 },
          catalog,
          grid: { layout, rows: gridSheet.sheet.rows.slice(1), headerIndex: 0 },
          subject: resolveSubject(gridSheet.sheet.rows),
        })
        const unreadOther = sheets
          .filter((sh) => sh.name !== gridSheet.sheet.name)
          .map((sh) => ({
            kind: 'UNREAD_SHEET',
            sheet: sh.name,
            rows: sh.rows.length,
            message:
              `The tab \u201c${sh.name}\u201d (${sh.rows.length} row(s)) was not read \u2014 the grid on ` +
              `\u201c${gridSheet.sheet.name}\u201d was. Tabs are never combined.`,
          }))
        return finishRun({
          parsed: parsedGrid,
          mapping: gridSheet.mapping,
          extraResidue: unreadOther,
          sourceSheet: gridSheet.sheet.name,
        })
      }

      const noNames = candidates.map((c) => {
        const where = candidates.length > 1 ? `The tab \u201c${c.sheet.name}\u201d` : 'This file'
        const lacksName = c.mapping.unmapped.includes('name')
        return {
          kind: lacksName ? 'NO_CAMPER_NAMES' : 'NO_READABLE_CHOICES',
          sheet: c.sheet.name,
          rows: c.sheet.rows.length,
          unmapped: c.mapping.unmapped,
          message: lacksName
            ? `${where} has no camper name column, so nothing on it could be recorded as a ` +
              'camper\u2019s preference \u2014 a preference is something a NAMED child asked for. Nothing ' +
              'was imported and nothing was changed. If this is a grid of what each group does, or a ' +
              'menu of what is on offer, it belongs to the schedule rather than to camper choices.'
            : `${where} names campers but holds no ranked choices this import could read, so nothing ` +
              'was imported and nothing was changed. Ranked choices are recognised from headers like ' +
              '\u201c#1\u201d or \u201cFirst Choice\u201d, from a rank column beside an activity column, or ' +
              'from one column per activity when those activities already exist in this camp.',
        }
      })
      return {
        ...base,
        mapping: candidates[0].mapping,
        counts: { campers: 0, choices: 0, preferences: 0 },
        residue: noNames,
        coverage: { measurable: false, unmeasuredCampers: 0, campers: 0 },
        ok: true,
        exitCode: 0,
      }
    }

    const { sheet, mapping } = chosen
    const rows = sheet.rows
    // Every tab we did NOT read, named. A workbook silently reduced to one tab is
    // the same silence §12.0 forbids everywhere else.
    const unreadSheets = sheets
      .filter((s) => s.name !== sheet.name)
      .map((s) => ({
        kind: 'UNREAD_SHEET',
        sheet: s.name,
        rows: s.rows.length,
        message:
          `The tab \u201c${s.name}\u201d (${s.rows.length} row(s)) was not read \u2014 the camper ` +
          `preferences were taken from \u201c${sheet.name}\u201d instead. Tabs are never combined, so ` +
          'if that tab holds a second set of submissions it has NOT been imported.',
      }))

    // A SECOND TABLE ABOVE THE HEADER IS READ TOO, not reported as unread
    // (T285 slice G). P23 carries a planner grid AND a ranked block on one page,
    // and reading only the block was this program's own defect: the grid is a
    // camper's own sheet and its cells are that child's answers. Both halves land.
    const preambleGrid = mapping.headerIndex > 0 ? detectGridLayout(rows, 0) : null

    const parsed = parsePreferenceSheet(rows, {
      campId: camp.id,
      mapping,
      catalog,
      grid: preambleGrid
        ? { layout: preambleGrid, rows: rows.slice(1, mapping.headerIndex), headerIndex: 0 }
        : undefined,
      // The grid's subject is resolved WITHOUT looking at the named campers in the
      // table below it: this page names four of them, so picking one would be a
      // guess about whose week the grid describes.
      //
      // The `pageName` branch this used to have was DEAD CODE — both call sites
      // passed null — so it is deleted rather than left looking like a feature.
      subject: preambleGrid ? resolveSubject(rows) : undefined,
    })

    return finishRun({ parsed, mapping, extraResidue: unreadSheets })
  } finally {
    db.close()
  }
}
