// @vitest-environment node
//
// T199 spec §6, conditions (1) and (2)'s IMPORT HALF. T251.
//
//   (1) "ambiguous rows block until resolved"
//   (2) "two runs over identical input produce byte-equivalent normalized
//       output" — the import half only. §6's sentence covers the SOLVE too, and
//       a solve is not reachable from this file (no production module composes
//       solver inputs from a database — see
//       electron/electiveAcceptanceSolve.integration.test.js's header, which
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
import os from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

import { runPreferenceSheetCli } from '../scripts/preferenceSheetCli.js'
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
const importResolvedSheetHere = () => imported
const camperRows = () => camp.db
  .prepare('SELECT id, display_name, external_id, division_label, is_active FROM campers WHERE camp_id = ? ORDER BY id')
  .all(camp.fixture.campId)

describe('§6 (1) — ambiguous rows block until resolved', () => {
  it('refuses the sheet whose two same-named rows carry no camper id, and writes nothing', () => {
    const before = camperRows().length
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

    // A PREVIEW WRITES NOTHING and so does a blocked commit. Asserted as a row
    // count against the database, not as the absence of a return value.
    expect(camperRows().length).toBe(before)
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
    })
    const { inactiveCamperId } = importResolvedSheetHere()
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

describe('GAP — a bundle cannot be preferred by its own name', () => {
  // docs/adr/2026-09-29-linked-elective-bundles.md D4 says a bundle's name is
  // "the string a camper's sheet must match". It is not: buildPreferenceCatalog
  // (src/ingest/preferenceImport.js:91-97) is built from activities, groups and
  // tiers and never from bundles, so the label resolves to nothing, the
  // preference becomes UNRESOLVED_CHOICE_LABEL residue, and it never reaches
  // the solver at all.
  //
  // THE FIXTURE WORKS AROUND IT by naming the bundle after its own activity
  // ('Ropes'), which is why condition (8) is live at all. This assertion holds
  // the gap open: it goes RED the day bundle names enter the catalogue, which
  // is the day the workaround should be removed.
  it('a sheet that names the bundle by its director-given name loses those preferences', () => {
    const out = runPreferenceSheetCli({
      file: SHEET_BUNDLE_BY_NAME, dbPath: camp.file, action: 'preview', authorUserId: camp.userId,
    })
    expect(out.ok).toBe(true)
    const unresolved = out.residue.filter((r) => r.kind === 'UNRESOLVED_CHOICE_LABEL')
    expect(unresolved.length).toBeGreaterThan(0)
    // And the loss is total, not partial: no choice carries the bundle's label.
    expect(JSON.stringify(out)).not.toContain('ropesintensive')
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
  // acceptance sheet, every parsed preference either carries no occurrence_id
  // or carries a non-empty string. If a parser change ever makes the branch
  // reachable, this goes red and the refusal gets a real test.
  it('no preference the real parser produces has a malformed occurrence_id', () => {
    const out = runPreferenceSheetCli({
      file: SHEET_RESOLVED, dbPath: camp.file, action: 'preview', authorUserId: camp.userId,
    })
    expect(out.ok).toBe(true)
    expect(out.counts).toBeTruthy()
    const stored = camp.db.prepare('SELECT occurrence_id FROM elective_preferences').all()
    expect(stored.length).toBeGreaterThan(0)
    for (const row of stored) {
      expect(row.occurrence_id == null || (typeof row.occurrence_id === 'string' && row.occurrence_id.length > 0)).toBe(true)
    }
  })
})
