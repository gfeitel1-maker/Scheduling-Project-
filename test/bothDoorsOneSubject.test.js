// @vitest-environment node
//
// T313 — ONE SUBMISSION IS ONE CAMPER, WHICHEVER DOOR IT CAME THROUGH.
//
// Provisional camper-subject identity used to be built twice: `resolveSubject` in
// scripts/preferenceSheetCli.js and `readPreferenceSheet` in
// src/ingest/preferenceImport.js. The CLI file's own comment named the cost — "two
// rules fork one child into two subjects depending on which door their sheet came
// through" — but nothing asserted it, and so the halves drifted: T303 taught the
// CLI's copy a caller-declared arrival and left the panel's forwarding a bare one.
//
// The gap was WIDER than the subject object, and the second half is what these tests
// are really for. The two doors did not read the same BYTES: the CLI sent CSV through
// `readWorkbookSafely`, the panel hand-split it on `/\t|,/`. A provisional subject is
// keyed on `submissionKeyFromRows`, so two readers of one file are two keys and two
// camper ids — the identical defect class, displaced one layer up from the digest,
// where sharing the digest could not reach it.
//
// WHY THESE ASSERT ON CAMPER ROWS AND NOT ON THE RETURNED OBJECT. Comparing two
// subject objects proves the two functions agree today; it does not prove the value
// SURVIVES to the identity `deriveCamperId` mints and the row `commitElectiveRun`
// writes. So both doors commit into the SAME database under one declared arrival, and
// convergence is asserted as a row COUNT: if the doors derived different ids there
// would be two rows, and no amount of agreement in between could hide it.
//
// Both doors are entered at FILE BYTES. The panel door is `readWorkbookRows` ->
// `readPreferenceSheet` -> `commitElectiveRun`, which is what AssignmentPanel does;
// the CLI door is `runPreferenceSheetCli`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { openLocalDb } from '../electron/db/localDb.js'
import { commitElectiveRun } from '../electron/ops/commitElectiveRun.js'
import { runPreferenceSheetCli } from '../scripts/preferenceSheetCli.js'
import { buildPreferenceCatalog, readPreferenceSheet } from '../src/ingest/preferenceImport.js'
import { readWorkbookRows } from '../src/utils/exportSanitize.js'

const ACTIVITIES = ['Swim', 'Archery', 'Ceramics', 'Nature']

// A child's own planner: no name column, so the identity comes from the SUBMISSION.
const PLANNER = 'Period,Monday,Tuesday\nPeriod 1,Swim,Archery\nPeriod 2,Ceramics,Nature\n'

// THE CASE THAT USED TO FORK. A comma INSIDE a cell, quoted per RFC4180 — ordinary in
// any spreadsheet export, and load-bearing in a preference sheet, where a cell listing
// several activities is the PACKED CELL the corpus probes P09 and P10 exist to
// exercise. SheetJS reads it as one cell; the panel's hand-split read `"Archery` and
// `Ceramics"` as two. Two row sets, two submission keys, two campers for one child.
const QUOTED = 'Period,Monday,Tuesday\nPeriod 1,"Archery, Nature",Swim\nPeriod 2,Ceramics,Nature\n'

// The same shape, with both packed activities in this camp's catalog, so the parser
// reaches the packed-cell DECISION rather than only failing to resolve a label.
const PACKED = 'Period,Monday,Tuesday\nPeriod 1,"Archery, Ceramics",Swim\nPeriod 2,Nature,Swim\n'

// One arrival, declared to BOTH doors. In production the panel mints one per file
// selection and the CLI defaults to the content-derived run id, so the two never share
// one by accident — declaring it is what isolates the DERIVATION from the policy that
// chooses it, which is the thing under test here.
const ARRIVAL = 'arrival-0001'

let dir
let dbPath
let campId
let deviceId

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-doors-'))
  dbPath = path.join(dir, 'shoresh.sqlite')
  const db = openLocalDb(dbPath)
  campId = randomUUID()
  deviceId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Host')
  const insert = db.prepare('INSERT INTO activities (id, camp_id, name) VALUES (?, ?, ?)')
  for (const name of ACTIVITIES) insert.run(randomUUID(), campId, name)
  db.close()
})

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const withDb = (fn) => {
  const db = openLocalDb(dbPath)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

const campers = () =>
  withDb((db) =>
    db.prepare('SELECT id, display_name, external_id, is_unattributed FROM campers ORDER BY id').all()
  )

/** Write `content` to its own directory, so one basename can be reused. */
function fixture(basename, content) {
  const sub = fs.mkdtempSync(path.join(dir, 'sub-'))
  const file = path.join(sub, basename)
  fs.writeFileSync(file, content)
  return file
}

/** The MACHINE door: scripts/preferenceSheetCli.js. */
const throughCli = (file, options = {}) =>
  runPreferenceSheetCli({ file, dbPath, action: 'commit', arrivalId: ARRIVAL, ...options })

/**
 * The DIRECTOR'S door: what AssignmentPanel.onFileSelected -> confirmMapping does,
 * with the same three inputs it derives from the file it was handed.
 */
function throughPanel(file, { arrivalId = ARRIVAL, camperName = null } = {}) {
  const buf = fs.readFileSync(file)
  const rows = readWorkbookRows(buf, { type: 'buffer', byteLength: buf.length })[0]?.rows ?? []
  const catalog = buildPreferenceCatalog(
    withDb((db) => ({
      activities: db.prepare('SELECT id, name FROM activities WHERE camp_id = ?').all(campId),
      groups: [],
      tiers: [],
    }))
  )
  const { parsed } = readPreferenceSheet({
    rows,
    campId,
    catalog,
    camperName,
    // The panel's own label rule: the file name with its extension removed. The CLI
    // spells the same thing with `path.basename`.
    sourceLabel: path.basename(file).replace(/\.[^.]+$/, ''),
    arrivalId,
    // NOT passed: `readPreferenceSheet` derives the submission key from the rows it
    // was handed, which is the whole point — a caller that computes its own is a
    // caller that can compute a different one.
  })
  if (!parsed) return { parsed: null, committed: null }
  const committed = withDb((db) =>
    commitElectiveRun(db, { campId, deviceId, name: 'Panel import', parsed, assignments: [], occurrences: [] })
  )
  return { parsed, committed }
}

describe('one submission is ONE camper through either door', () => {
  it('a plain planner: both doors land on the SAME camper row', () => {
    const file = fixture('planner.csv', PLANNER)

    expect(throughCli(file).ok).toBe(true)
    expect(campers()).toHaveLength(1)
    const afterCli = campers()[0]

    // The SAME file through the other door, under the same arrival. One row, not two.
    expect(throughPanel(file).committed.ok).toBe(true)
    const rows = campers()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(afterCli.id)
    // And the two doors agree about what they stored ON that row, not merely about its
    // key — a label divergence would leave one door's name silently overwritten.
    expect(rows[0].display_name).toBe('planner')
    expect(rows[0].external_id).toBe(afterCli.external_id)
    expect(rows[0].is_unattributed).toBe(1)
  })

  it('NON-VACUITY: two arrivals of that same file are still TWO camper rows', () => {
    // Without this, the test above would pass just as well if BOTH doors converged on
    // one hardcoded id, or if the second import were silently writing nothing.
    const file = fixture('planner.csv', PLANNER)

    expect(throughCli(file).ok).toBe(true)
    expect(throughPanel(file, { arrivalId: 'arrival-0002' }).committed.ok).toBe(true)

    const rows = campers()
    expect(rows).toHaveLength(2)
    expect(rows[0].id).not.toBe(rows[1].id)
    // Same submission, different arrival: the CONTENT key is shared and the arrival is
    // what separated them, which is T299's model rather than an accident of labelling.
    expect(rows[0].external_id).toBe(rows[1].external_id)
  })

  it('a QUOTED cell: both doors still land on one camper — the reader used to fork here', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. Before the readers were shared this was two
    // rows: `sub-910a00c4…` through the CLI and `sub-9407a1e0…` through the panel, for
    // one child's one file. Nothing refused, nothing warned — the child was simply in
    // the database twice.
    const file = fixture('planner.csv', QUOTED)

    expect(throughCli(file).ok).toBe(true)
    expect(throughPanel(file).committed.ok).toBe(true)

    expect(campers()).toHaveLength(1)
  })

  it('the quoted cell stays ONE cell, and the row after it does not shift', () => {
    // The convergence above would hold just as well if BOTH doors mangled the cell the
    // same way, so assert what the parser actually SAW.
    //
    // What the hand-split did, measured: `"Archery, Ceramics"` became the two cells
    // `"Archery` and `Ceramics"`, which put them at TWO coordinates — Monday Period 1
    // and TUESDAY Period 1 — and shifted the rest of the row one column right, so the
    // Swim that belonged to Tuesday fell off the end. Not merely two mangled labels: a
    // whole row of a child's week silently re-coordinated.
    const { parsed } = throughPanel(fixture('planner.csv', PACKED))

    // ONE finding about ONE cell, quoting it whole — the comma inside the quotes.
    const packed = parsed.residue.filter((r) => r.kind === 'AMBIGUOUS_PACKED_CELL')
    expect(packed).toHaveLength(1)
    expect(packed[0].why).toContain('Archery, Ceramics')
    // The director is asked about it rather than losing it, which is the `split_packed`
    // surface the panel's own reader used to destroy before the parser could offer it.
    expect(packed[0].why).toMatch(/split up it names 2 that are/)

    // The fragment signature, in either direction: no finding and no stored label may
    // carry a stray quote character, because no cell was ever cut at the comma.
    const texts = parsed.residue.map((r) => `${r.head} ${r.why}`)
    expect(texts.filter((t) => t.includes('"Archery'))).toEqual([])
    expect(texts.filter((t) => t.includes('Ceramics"'))).toEqual([])

    // And Tuesday still holds the activity that was written in the Tuesday column.
    const tuesday = withDb((db) =>
      db
        .prepare(
          `SELECT ch.label FROM elective_preferences p
             JOIN elective_choices ch ON ch.id = p.choice_id
            WHERE p.coordinate_day_label = 'Tuesday' AND p.coordinate_period_label = 'Period 1'`
        )
        .all()
        .map((r) => r.label)
    )
    expect(tuesday).toEqual(['Swim'])
  })

  it('a caller-supplied name attributes the subject identically through both doors', () => {
    // Step 1 of the identity order. An attributed subject is keyed on the NAME rather
    // than on (submission, arrival), so this exercises the other branch of the one
    // expression that decides which child a sheet lands on.
    const file = fixture('planner.csv', PLANNER)

    expect(throughCli(file, { camperName: 'Aviva Sandler' }).ok).toBe(true)
    expect(throughPanel(file, { camperName: 'Aviva Sandler' }).committed.ok).toBe(true)

    const rows = campers()
    expect(rows).toHaveLength(1)
    expect(rows[0].display_name).toBe('Aviva Sandler')
    // Named, so not provisional — and no submission key, because a name is a fact
    // about the child rather than about the import.
    expect(rows[0].is_unattributed).toBeNull()
    expect(rows[0].external_id).toBeNull()
  })
})

describe('a whole-sheet planner reports nothing as skipped', () => {
  it('neither door claims rows were skipped when every row landed', () => {
    // The panel door used to report EVERY grid row as `skippedRows: 'no camper name'`,
    // because `readPreferenceSheet` passed the grid's rows positionally alongside an
    // empty mapping, so `parsePreferenceSheet` walked them looking for a name column a
    // planner has no reason to have. ParseSummary renders that count to the director as
    // "N row(s) skipped" — on an import where all N rows landed. A residue item that is
    // false is worse than one that is missing.
    const file = fixture('planner.csv', PLANNER)

    const cli = throughCli(file)
    expect(cli.ok).toBe(true)
    expect(cli.skippedRows).toEqual([])

    const { parsed } = throughPanel(fixture('planner.csv', PLANNER), { arrivalId: 'arrival-0003' })
    expect(parsed.skippedRows).toEqual([])
    // NON-VACUITY: the rows were not skipped because they were empty. Four cells, four
    // preferences, through the door that used to call them all skipped.
    expect(parsed.preferences).toHaveLength(4)
  })
})
