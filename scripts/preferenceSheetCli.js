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
import { deriveImportedElectiveRunId, opaque } from '../electron/ops/electiveDerivedIds.js'
import {
  detectGridLayout,
  inferPreferenceLayout,
  parsePreferenceSheet,
  residueParts,
} from '../src/ingest/preferenceSheet.js'
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
  // T298 — the director's settled label resolutions, already in the resolver's
  // shape (`{ [rawLabel]: { action, activityName } }`; see resolutionMap in
  // src/ingest/labelResolutions.js). MCP PARITY, and the reason it matters: an
  // agent driving this import can already SEE the residue in a preview, and
  // without this it could read the question and not answer it. Mapping and
  // splitting write nothing — they are statements about how to read the file —
  // so they are exactly the kind of answer a machine caller can supply safely.
  //
  // `add_activity` is deliberately NOT reachable this way: it MINTS a camp
  // activity, which is a mutation of the camp's own setup rather than a reading
  // of the file, and an agent that wants one should create it as an activity.
  resolutions = null,
  // T303 — WHICH ARRIVAL THIS IS, stated by the caller rather than inferred. Why the
  // caller is the only one who can state it, and what happens when they do not, is at
  // the `arrivalId:` line in resolveSubject below — the one place a reader needs it.
  arrivalId = null,
}) {
  const base = baseResult({ file, dbPath, action })

  // VALIDATED AT THE BOUNDARY, because this becomes a component of a derived camper
  // id and `opaque()` throws on anything outside [A-Za-z0-9_.:-]. Two other outcomes
  // were available and both are worse: letting the throw escape breaks this
  // function's contract that it never throws past this boundary, and IGNORING a
  // malformed declaration merges the two children the caller was declaring apart —
  // this ticket's own defect class, reappearing at our own API boundary.
  //
  // An EMPTY string is declaring nothing, not declaring badly, so it is not refused.
  // `opaque` only VALIDATES — it returns its input unchanged — so there is nothing to
  // assign and the token is the trimmed string either way. Same refuse-on-throw shape
  // commitElectiveRun uses for its caller-supplied run id.
  const declaredArrival = String(arrivalId ?? '').trim() || null
  if (declaredArrival != null) {
    try {
      opaque('arrival_id', declaredArrival)
    } catch {
      return errorResult(
        base,
        'arrival_id must be an opaque token matching [A-Za-z0-9_.:-] — a UUID is the usual choice. ' +
          'It is the name of THIS arrival, so two submissions get two of them and a retry reuses one.'
      )
    }
  }

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

    // THIS IMPORT, identified. Derived from the file's bytes rather than minted, so
    // re-sending the same sheet is an idempotent retry — which is what an agent
    // recovering from an ambiguous MCP timeout needs. Derived ONCE and used for both
    // the run id and a provisional subject's arrival (T299), because those two are
    // the same fact: the import this data arrived in. Two derivations would be two
    // chances for the subject to claim an arrival the run does not have.
    const importedRunId = deriveImportedElectiveRunId(camp.id, submissionSha256)

    // WHAT SUBJECT RESOLUTION FOUND OUT, carried to the ONE completion path rather
    // than returned. `resolveSubject` has to answer "whose sheet is this" before the
    // parse, but what it learns on the way — that this submission has already been
    // imported and NAMED — belongs in the residue beside everything else the caller
    // is told. Pushing it here keeps finishRun the single place residue is assembled
    // (a second assembly point is how the two branches drifted before), and both
    // grid call sites are mutually exclusive so this holds at most one item.
    const subjectResidue = []

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
      // T303 — TWO SUBMISSIONS THIS PATH COULD NOT TELL APART, said out loud.
      //
      // The merge is not the defect; the SILENCE is. A caller that declared nothing
      // gets the content-derived arrival, and under that declaration a retry and a
      // second child who chose the same activities are the same event. An agent that
      // can SEE that re-calls with explicit arrivals; an agent that cannot has lost a
      // child's answers and will never know.
      //
      // Read off the id `parsePreferenceSheet` ALREADY derived rather than derived a
      // second time here: a second derivation is a second rule, and two rules decide
      // differently the day one of them is edited. Asking whether that exact row
      // already exists is also the only honest form of the question — "another sheet
      // somewhere has these answers" would be true in cases where this import did not
      // converge onto it.
      //
      // Computed BEFORE the commit below, because after it the row always exists.
      // Suppressed when the caller declared: they have already answered it. Suppressed
      // for an attributed subject too — a name is a fact about the child, so two
      // identical sheets under one name are one child by declaration, not by guess.
      const alreadyThere = db.prepare('SELECT 1 FROM campers WHERE id = ?')
      const arrivalResidue = declaredArrival != null
        ? []
        : parsed.campers
            .filter((c) => c.is_unattributed === 1 && alreadyThere.get(c.id) != null)
            .map((c) => ({
              kind: 'INDISTINGUISHABLE_SUBMISSION',
              camper_id: c.id,
              submission_key: c.external_id,
              ...residueParts(
                `Stored as “${c.display_name || 'unnamed'}”`,
                // THE REMEDY IS IN THE TELLING. An agent that never read the tool
                // schema meets this parameter at the moment it needs it, which is the
                // only moment it could act on it.
                'These answers are identical to a sheet already imported, so they landed on the SAME ' +
                  'camper — a retry and a second child who chose the same activities cannot be ' +
                  'told apart from content. If this is a different child, import again declaring a ' +
                  'distinct arrival_id for each submission.'
              ),
            }))

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
        // takes one table, so it cannot know a second tab existed. The arrival
        // collision is the CLI's own for the same reason in reverse — it is a fact
        // about the DATABASE, which the pure parser cannot read.
        residue: [...subjectResidue, ...arrivalResidue, ...extraResidue, ...parsed.residue],
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
          runId: importedRunId,
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

      // 1a. THIS SUBMISSION HAS ALREADY BEEN IMPORTED AND NAMED.
      //
      // T303 left this open as a design decision and it forked a real child. Import
      // a planner, let the director name the subject, re-send the SAME bytes:
      // `attributeElectiveSubject` rekeys the provisional row onto a name-derived id
      // and drops the submission key, so the row T303's INDISTINGUISHABLE_SUBMISSION
      // probes for is gone, a fresh provisional subject is derived, and one child
      // ends up as two camper rows holding her week twice. Confirmed by execution
      // before this was written: 2 campers, 8 elective_preferences rows, and the
      // only residue was the ordinary UNATTRIBUTED_SUBJECT. Worse on the DECLARED
      // path, where the same fork voids T303's own promise that the same declared
      // arrival any number of times is one camper.
      //
      // THIS IS NOT A NEW RULE — IT IS THE EXISTING ONE, HELD. Absent a declaration,
      // identical bytes are already one submission arriving once; that is what
      // `deriveImportedElectiveRunId` is for and what T303 deliberately preserved.
      // Attribution silently stopped it applying. So the fix restores the rule past
      // the rekey rather than deciding anything new about what a submission means.
      //
      // WHY NO STORED KEY, and why the two shapes the ticket proposed were not
      // needed. The link is ALREADY stored and already replicated: the rekey carries
      // `run_id` onto the moved preference rows, and that run id is derived from the
      // file's bytes, so this is an EXACT content-addressed lookup rather than
      // similarity matching (explicitly a non-goal). `elective_preferences` is in
      // PROJECTIONS, so it reaches every device — a host-local decision table in the
      // `source_aliases` mould would not, and the fork would come back on the second
      // device. Writing the submission key to `campers.external_id` instead would
      // collide with the roster id that column holds and that `deriveCamperId`'s
      // `ext` arm keys on, is single-valued so a second sheet evicts the first, and
      // still could not separate the two cases below.
      //
      // ONLY AN ATTRIBUTED ROW, and only when there is exactly ONE. An unattributed
      // match is T303's own case and is left to its residue untouched. Several
      // matches means two arrivals were declared for these bytes and since named; no
      // probe keyed on content can say which child this is, so it reports instead of
      // guessing.
      //
      // ONLY WHEN THE CALLER DECLARED NOTHING. A declared arrival is a claim that
      // this is a distinct submission, and the run id is the same for arrival A and
      // arrival B — so converging here would merge a second real child onto the
      // first whenever a caller declares them apart. That is the one refusal the ADR
      // names, so the declared path is told and left alone. Owner's call, 2026-09-29.
      // Probed unconditionally, because a DECLARED caller is told about it even
      // though it does not change where the answers land.
      const alreadyNamed = db
        .prepare(
          `SELECT DISTINCT c.id, c.display_name, c.external_id
             FROM elective_preferences p
             JOIN campers c ON c.id = p.camper_id
            WHERE p.run_id = ? AND c.camp_id = ? AND c.is_unattributed IS NOT 1`
        )
        .all(importedRunId, camp.id)

      if (declaredArrival != null && alreadyNamed.length > 0) {
        // THE DECLARED PATH IS TOLD, NOT FIXED — a stated limit, not an oversight.
        // A retry of arrival A and a second child declared as B produce the same
        // bytes, the same run id and the same probe result, so nothing here can tell
        // them apart; separating them means storing which arrival produced which
        // camper, which is a schema version the owner chose not to spend. Silence
        // was the defect T303 named, so the caller hears about it either way.
        subjectResidue.push({
          kind: 'SUBMISSION_ALREADY_NAMED_UNRESOLVED',
          camper_ids: alreadyNamed.map((c) => c.id),
          arrival_id: declaredArrival,
          ...residueParts(
            `Already stored under ${alreadyNamed.map((c) => `“${c.display_name}”`).join(', ')}`,
            'These exact answers are already held by a named camper, and this import declared its ' +
              'own arrival, so it landed as a new unnamed subject. If this was a RETRY of the ' +
              'import that became that camper, nothing more is needed and this subject should be ' +
              'discarded — a declared arrival cannot converge onto a camper who has since been ' +
              'named. If it is a different child, name this subject.'
          ),
        })
      } else if (alreadyNamed.length === 1) {
        const named = alreadyNamed[0]
        subjectResidue.push({
          kind: 'SUBMISSION_ALREADY_NAMED',
          camper_id: named.id,
          camper_name: named.display_name,
          ...residueParts(
            `Stored as “${named.display_name}”`,
            'This sheet was imported before and its subject has since been named, so these answers ' +
              'went to that camper rather than to a new unnamed subject. If this is a DIFFERENT ' +
              'child who chose the same activities, import again declaring a distinct arrival_id.'
          ),
        })
        // Returned in the shape step 1 returns, so the parser's existing `attributed`
        // arm derives the id: `deriveCamperId(campId, { externalId, displayName })` is
        // the identical call attributeElectiveSubject made when it minted this row, so
        // it lands back on exactly this camper. The preference ids derive from that
        // camper id, so the commit is an idempotent overwrite of her own rows rather
        // than a second set — and a preference she has since hand-edited stays held by
        // commitElectiveRun's own provenance check (T297), not quietly overwritten.
        return {
          displayName: named.display_name,
          externalId: named.external_id || null,
          source: 'already-named',
          attributed: true,
        }
      }

      if (declaredArrival == null && alreadyNamed.length > 1) {
        subjectResidue.push({
          kind: 'SUBMISSION_ALREADY_NAMED_UNRESOLVED',
          camper_ids: alreadyNamed.map((c) => c.id),
          ...residueParts(
            `Already stored under ${alreadyNamed.length} named campers`,
            'These exact answers are already held by more than one named camper, so which child ' +
              'this sheet belongs to cannot be read from its content. It landed as a new unnamed ' +
              'subject. Name it, or import again declaring the arrival_id that identifies this ' +
              'submission.'
          ),
        })
      }

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
      //    The content hash keys it instead — as of T299 through `deriveCamperId`'s
      //    `sub` arm, PAIRED WITH AN ARRIVAL rather than alone (the `ext` arm this
      //    used to borrow keyed on content only, and two children who picked the same
      //    activities collapsed onto one camper). Two different submissions can never
      //    collide, and the SAME bytes re-sent converge onto one subject rather than
      //    duplicating — the same idempotency the run id already gets from
      //    `deriveImportedElectiveRunId`, and on this path the same value provides
      //    both. The filename stays as the human-readable LABEL so a director
      //    recognises which submission it is; it is no longer the key, so renaming a
      //    file no longer forks the child either.
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
        // T299 — WHICH IMPORT this submission arrived in, the other half of the
        // identity. The content key alone cannot be it: two children who picked the
        // same activities produce byte-identical sheets, and keying on content alone
        // merged them onto one camper row holding both children's answers.
        //
        // T303 — THE CALLER'S OWN DECLARATION FIRST, the file's bytes as the default.
        //
        // The default is not a guess dressed up as one: `deriveImportedElectiveRunId`
        // exists so that re-sending the same bytes is one import rather than two, and
        // an agent that cannot safely retry a failed call cannot be trusted to drive
        // this software at all. So absent any declaration, identical bytes stay one
        // submission arriving once — with the consequence, said out loud rather than
        // left silent, that two children's byte-identical files reach ONE subject.
        //
        // What the default CANNOT do is separate two children who chose the same
        // activities, because there is no second fact in the bytes to separate them
        // with. `arrivalId` is that second fact, and only the caller holds it: two
        // submissions get two tokens, a retry reuses one. Minting one per invocation
        // here instead would buy the two children by forking every retry, which is
        // the trade T299 identified and refused.
        arrivalId: declaredArrival ?? importedRunId,
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
          resolutions,
        })
        const unreadOther = sheets
          .filter((sh) => sh.name !== gridSheet.sheet.name)
          .map((sh) => ({
            kind: 'UNREAD_SHEET',
            sheet: sh.name,
            rows: sh.rows.length,
            ...residueParts(
              `Tab \u201c${sh.name}\u201d`,
              `Not read (${sh.rows.length} row(s)) \u2014 the grid on ` +
                `\u201c${gridSheet.sheet.name}\u201d was. Tabs are never combined.`
            ),
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
          // A preference is something a NAMED child asked for, which is why the
          // first case writes nothing. Ranked choices are recognised from headers
          // like "#1"/"First Choice", from a rank column beside an activity
          // column, or from one column per activity when those activities exist.
          ...residueParts(
            where,
            lacksName
              ? 'Has no camper name column, so nothing was imported and nothing was changed.'
              : 'Names campers but holds no ranked choices this import could read, so nothing was ' +
                'imported and nothing was changed.'
          ),
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
        // Tabs are never combined, so a second set of submissions on that tab has
        // NOT been imported.
        ...residueParts(
          `Tab \u201c${s.name}\u201d`,
          `Not read (${s.rows.length} row(s)) \u2014 the camper preferences were taken from ` +
            `\u201c${sheet.name}\u201d instead. Tabs are never combined.`
        ),
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
      resolutions,
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
