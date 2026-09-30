// @vitest-environment node
//
// T199 spec §6, conditions (1) and (2)'s IMPORT HALF. T251.
//
//   (1) "ambiguous rows block until resolved"
//   (2) "two runs over identical input produce byte-equivalent normalized
//       output" — the import half only. §6's sentence covers the SOLVE too, and
//       a solve is not reachable from this file (no production module composes
//       solver inputs from a database — see
//       electron/electiveAcceptanceSolve.integration.test.jsx's header, which
//       carries the other half).
//
// WHAT IS REAL. The sheets are real .csv files on disk. They go through
// runPreferenceSheetCli — the headless core of the preference import, which is
// pure harness over the SAME inferPreferenceMapping/parsePreferenceSheet and
// commitElectiveRun pair the app's IPC handler drives (its own header says so)
// — against the real acceptance camp's real SQLite file, through the full
// migration chain. Nothing between the bytes on disk and the assertion is
// constructed here.
//
// WHY THE TWO SHEETS DIFFER IN EXACTLY ONE THING. Condition (1) is not "a bad
// sheet is refused"; it is "ambiguous rows block UNTIL RESOLVED". A refusal
// proves nothing on its own — a sheet refused for an unrelated reason refuses
// just as loudly. preferences.csv and preferences-resolved.csv are generated
// from one function with one flag (scripts/fixtures/make-preference-corpus.mjs)
// and differ only in the camper id on the two colliding rows, so the second
// committing is what makes the first's refusal attributable.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

import { runPreferenceSheetCli } from '../scripts/preferenceSheetCli.js'
import { describeElectiveRunRefusal } from './ops/commitElectiveRun.js'
import { openAcceptanceCamp } from './electiveAcceptanceHarness.js'
import {
  ACCEPTANCE_MANIFEST, SHEET_BLOCKING, SHEET_RESOLVED, SHEET_BUNDLE_BY_NAME, importResolvedSheet,
} from './fixtures/electiveAcceptanceCamp.js'

const M = ACCEPTANCE_MANIFEST

let camp

beforeAll(async () => { camp = await openAcceptanceCamp() }, 60_000)
afterAll(() => { camp?.close() })

const importSheet = (file, extra = {}) => runPreferenceSheetCli({
  file, dbPath: camp.file, action: 'commit', authorUserId: camp.userId, ...extra,
})

// The same one construction every other T251 file uses, called here AFTER this
// file's own condition-(1) pair has driven the refusal and the commit by hand.
let imported = null
// EVERY TABLE THE COMMIT PATH WRITES, not just `campers`. "A preview writes
// nothing" measured as a camper count is satisfied by a regression in which
// commitElectiveRun opens its transaction, writes the run row or appends ops,
// and only then reaches the ambiguity refusal — the rollback is what makes that
// safe today, and a rollback is exactly the thing that can break silently.
const COMMIT_PATH_TABLES = ['campers', 'elective_assignment_runs', 'elective_choices', 'elective_preferences', 'operations']
const commitPathSnapshot = () => Object.fromEntries(COMMIT_PATH_TABLES.map((t) => [
  t, camp.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c,
]))
const camperRows = () => camp.db
  .prepare('SELECT id, display_name, external_id, division_label, is_active FROM campers WHERE camp_id = ? ORDER BY id')
  .all(camp.fixture.campId)

describe('§6 (1) — ambiguous rows block until resolved', () => {
  it('refuses the sheet whose two same-named rows carry no camper id, and writes nothing', () => {
    const before = commitPathSnapshot()
    // BOTH SURFACES, because they report the refusal in different fields and a
    // director meets both: a PREVIEW says "this would be refused, and why" in
    // `blocked` without opening a transaction, and a COMMIT refuses through
    // commitElectiveRun and reports in `error`. They must never disagree — the
    // CLI calls describeElectiveRunRefusal for the preview precisely so they
    // cannot (scripts/preferenceSheetCli.js:326-330).
    const preview = runPreferenceSheetCli({
      file: SHEET_BLOCKING, dbPath: camp.file, action: 'preview', authorUserId: camp.userId,
    })
    const out = importSheet(SHEET_BLOCKING)

    expect(preview.blocked).toBeTruthy()
    expect(out.ok).toBe(false)
    expect(out.error).toBe(preview.blocked)
    expect(out.runId).toBeNull()
    // The MESSAGE, not merely the refusal. A director who is told two rows
    // collide and not which ones, or not what distinguishes them, cannot act:
    // §12.2a of docs/adr/2026-09-27-elective-preference-etl-canonical-record-
    // and-learned-axis-binding.md makes naming the division the whole point,
    // because the division is the evidence that says "those are two children".
    expect(out.error).toContain(M.duplicateNameSameGroup)
    expect(out.error).toMatch(/rows [\d, ]+: Older/)
    expect(out.error).toContain('no camper id to tell them apart')

    // A PREVIEW WRITES NOTHING and so does a blocked commit. Asserted as row
    // counts against the database — across every table the commit path touches,
    // including `operations` — not as the absence of a return value.
    expect(commitPathSnapshot()).toEqual(before)
  })

  it('commits the same sheet once the two rows are told apart, and only then', () => {
    const out = importSheet(SHEET_RESOLVED)
    expect(out.error).toBeNull()
    expect(out.ok).toBe(true)
    expect(out.blocked).toBeNull()
    expect(out.runId).toBeTruthy()
    expect(camperRows()).toHaveLength(M.camperCount)
  })

  // §6's other named identity cases, asserted on the rows the commit produced
  // rather than on the parser's report of them.
  it('keeps the legal duplicate as two campers, and the missing external id as one camper', () => {
    const rows = camperRows()
    const dupes = rows.filter((r) => r.display_name === M.duplicateNameDifferentGroups)
    expect(dupes).toHaveLength(2)
    expect(new Set(dupes.map((r) => r.division_label))).toEqual(new Set(M.tiers))
    expect(new Set(dupes.map((r) => r.id)).size).toBe(2)

    // §6: "one missing external id" — exactly one, and the one the sheet names.
    const noId = rows.filter((r) => r.external_id == null)
    expect(noId).toHaveLength(1)
    expect(noId[0].display_name).toBe(M.missingExternalIdCamper)
  })

  it('deactivating a camper is an ordinary field write, and reaches exactly one row', async () => {
    imported = await importResolvedSheet(camp.db, {
      dbPath: camp.file, handlers: camp.handlers, token: camp.token, authorUserId: camp.userId,
      campId: camp.fixture.campId, groupIdByName: camp.fixture.groupIdByName,
    })
    const { inactiveCamperId } = imported
    const inactive = camperRows().filter((r) => r.is_active === 0)
    expect(inactive).toHaveLength(1)
    expect(inactive[0].id).toBe(inactiveCamperId)
    expect(inactive[0].display_name).toBe(M.inactiveCamper)
  })
})

describe('§6 (2) import half — re-importing identical bytes converges', () => {
  // THE NORMALIZER, and its stripped-key list asserted as data. Three fields
  // cannot be byte-equal across two calls and none of them is a fact about the
  // camp: `generated_at` is `new Date()` (exportChildSchedule.js:31),
  // `solver_generation` is a fresh randomUUID per commit
  // (commitElectiveRun.js:245), and `finalized_at` is wall clock. Anything else
  // that differs is a real divergence, so the list is pinned here rather than
  // grown quietly when a test goes red.
  const VOLATILE_KEYS = ['generated_at', 'solver_generation', 'finalized_at']

  const normalize = (value) => JSON.stringify(value, (key, v) => (VOLATILE_KEYS.includes(key) ? undefined : v))

  it('strips exactly three keys and no others', () => {
    expect(VOLATILE_KEYS).toEqual(['generated_at', 'solver_generation', 'finalized_at'])
    const probe = normalize({ generated_at: 1, solver_generation: 2, finalized_at: 3, kept: 4, run_id: 5 })
    expect(JSON.parse(probe)).toEqual({ kept: 4, run_id: 5 })
  })

  it('a second commit of the same bytes lands on the same run and adds no rows', () => {
    const first = importSheet(SHEET_RESOLVED)
    const snapshotOf = () => ({
      campers: camp.db.prepare('SELECT * FROM campers WHERE camp_id = ? ORDER BY id').all(camp.fixture.campId),
      preferences: camp.db.prepare('SELECT * FROM elective_preferences ORDER BY id').all(),
      choices: camp.db.prepare('SELECT * FROM elective_choices ORDER BY id').all(),
      runs: camp.db.prepare('SELECT * FROM elective_assignment_runs ORDER BY id').all(),
    })
    const before = normalize(snapshotOf())

    const second = importSheet(SHEET_RESOLVED)
    expect(second.ok).toBe(true)
    // deriveImportedElectiveRunId keys the run on the file's bytes, so the same
    // bytes are one run, not two (scripts/preferenceSheetCli.js:366-372).
    expect(second.runId).toBe(first.runId)
    expect(normalize(snapshotOf())).toBe(before)
  })
})

// ── ASSERTED GAPS ──────────────────────────────────────────────────────────

describe('MET — a bundle can be preferred by its own name', () => {
  // WAS A GAP, closed by board item 9b. docs/adr/2026-09-29-linked-elective-
  // bundles.md D4 says a bundle's name is "the string a camper's sheet must
  // match". It was not: the catalogue a label resolves against was built from
  // activities, groups and tiers and never from bundles, so the label resolved
  // to nothing, the preference became UNRESOLVED_CHOICE_LABEL residue, and it
  // never reached the solver at all.
  //
  // TWO CATALOGUES, not one, and the round-2 mutation found that out: the
  // renderer path goes through `buildPreferenceCatalog`
  // (src/ingest/preferenceImport.js), while THIS path — the CLI core —
  // hand-rolled the same three reads inline and never called that function.
  // Adding bundles to `buildPreferenceCatalog` alone therefore left this green;
  // the mutation that redded it was adding them to the CLI's own
  // `catalog.activities`. BOTH changed: the CLI now CALLS the shared helper, and
  // the helper merges bundle names. The inverted assertion below is verified
  // against each half separately — reverting either one alone reds it, which is
  // the property the old note said did not hold.
  //
  // THE FIXTURE WORKS AROUND THE OLD GAP for the LIVE bundle by naming it after
  // its own activity ('Ropes'), which is why condition (8) is live at all.
  //
  // THAT WORKAROUND IS ALSO WHY THIS ASSERTION NEEDS ITS OWN BUNDLE. A sheet
  // naming the live bundle says 'Ropes', which resolved even before this through
  // the ACTIVITY — so it could never have exhibited the gap. So the camp carries
  // a bundle whose director-given name is `bundleNamedOffCatalogue` and is no
  // activity's name, and the sheet names exactly that. Both halves are asserted
  // below, because the property is one of the pair and not of either one.
  it('the camp really has a bundle whose name no activity carries', () => {
    const name = M.bundleNamedOffCatalogue
    const bundles = camp.db
      .prepare('SELECT name FROM elective_bundles WHERE elective_set_id = ?').all(camp.fixture.electiveSetId)
      .map((b) => b.name)
    expect(bundles).toContain(name)
    expect(camp.db.prepare('SELECT COUNT(*) c FROM activities WHERE camp_id = ? AND name = ?')
      .get(camp.fixture.campId, name).c).toBe(0)
    // And the sheet under test names it — otherwise the assertion below is
    // about a string this camp has never heard of.
    expect(fs.readFileSync(SHEET_BUNDLE_BY_NAME, 'utf8')).toContain(name)
  })

  it('a sheet that names the bundle by its director-given name KEEPS those preferences', () => {
    const out = runPreferenceSheetCli({
      file: SHEET_BUNDLE_BY_NAME, dbPath: camp.file, action: 'preview', authorUserId: camp.userId,
    })
    // NOT `out.ok`: a preview is ALWAYS ok:true, so asserting it cannot detect
    // anything. `blocked` is the field that carries the answer.
    expect(out.blocked).toBeNull()
    // SCOPED TO THIS BUNDLE'S OWN LABEL, not to "nothing went unresolved". A bare
    // `unresolved.length === 0` would be a claim about the whole sheet and would
    // red on any unrelated residue — and, in the other direction, a bare
    // `length > 0` was what let the old assertion stay green once the catalogue
    // learned bundle names. The label is named on purpose.
    const unresolved = out.residue.filter(
      (r) => r.kind === 'UNRESOLVED_CHOICE_LABEL' && r.label === M.bundleNamedOffCatalogue
    )
    expect(unresolved).toHaveLength(0)
    // AND IT REACHED THE RECORD, which is the half "no residue" does not prove:
    // a label can go unreported and still be dropped. The preview's own counts
    // are what the director is shown.
    expect(out.counts.preferences).toBeGreaterThan(0)
  })
})

describe('GAP — the malformed-occurrence refusal is unreachable from the real parser', () => {
  // commitElectiveRun.js:96-101 refuses a preference whose `occurrence_id` is
  // present but not a non-empty string. Its own comment says today's parser
  // never emits one — so that branch cannot be exercised through any real
  // sheet, and a test that hand-built a `parsed` object to reach it would be
  // asserting about a shape the app cannot produce.
  //
  // What CAN be asserted about the real path is the premise: over the whole
  // acceptance sheet, `describeElectiveRunRefusal` — the one function both the
  // preview and the commit ask — does not reach its malformed branch. If a
  // parser change ever makes the branch reachable, this goes red and the
  // refusal gets a real test.
  //
  // NOT ASSERTED ON `elective_preferences` ROWS, which is what round 1 did and
  // what cannot fail: a malformed occurrence_id never reaches that table,
  // because commitElectiveRun refuses the whole commit first (:90-99). Reading
  // the stored rows back measures the refusal that already happened.
  //
  // NOT ASSERTED ON `out.ok` EITHER: a preview is always ok:true
  // (preferenceSheetCli.js:330). `blocked` is the field carrying the answer.
  it('the live refusal branch does not fire on the real sheet — and it IS live', () => {
    // The branch, shown to be reachable at all, on a hand-built shape. This is
    // the control: without it, `blocked === null` below is equally consistent
    // with the check having been deleted.
    expect(describeElectiveRunRefusal({ preferences: [{ camper_id: 'SYN-9999', occurrence_id: '' }] }))
      .toMatch(/cannot read/)
    expect(describeElectiveRunRefusal({ preferences: [{ camper_id: 'SYN-9999', occurrence_id: null }] }))
      .toBeNull()

    const out = runPreferenceSheetCli({
      file: SHEET_RESOLVED, dbPath: camp.file, action: 'preview', authorUserId: camp.userId,
    })
    expect(out.blocked).toBeNull()
    expect(out.counts.preferences).toBeGreaterThan(0)
  })
})
