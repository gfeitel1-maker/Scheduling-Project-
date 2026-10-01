// T299 — two campers who answered identically are two campers.
//
// Fixtures are fabricated; no real camper data is in this repo and none may be
// added.
//
// ENTERS THROUGH THE GRID, DELIBERATELY. Every existing test of this path hands
// `commitElectiveRun` a hand-written `parsed` with literal camper ids ('cam-1'),
// which cannot observe an identity defect at all — the ids are the fixture's, not
// the importer's. T224 and the planner-grid defect both survived large suites for
// exactly that reason. So these cases start from ROWS, run the same
// `readPreferenceSheet` call shape the director's panel uses
// (src/screens/elective/assignment/AssignmentPanel.jsx `confirmMapping`), and
// assert on ROWS IN SQLITE.
//
// THE FACT UNDER TEST is arrival, not content. Two children who both picked
// archery and swim produce byte-identical grids, and no property of those bytes
// can say whether that is two children or one child's sheet sent twice. What CAN
// say so is how the sheet got here: two import actions are two arrivals, and one
// import action repeated is one arrival. So `arrivalId` separates them, and a
// content key would not — while an ORDINAL (a per-row or per-import counter)
// would separate the two children and ALSO fork a retry, which is the trade
// electron/ops/electiveDerivedIds.js warns about.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitElectiveRun } from './commitElectiveRun.js'
import { attributeElectiveSubject } from './attributeElectiveSubject.js'
import { deriveCamperId } from './electiveDerivedIds.js'
import {
  buildPreferenceCatalog,
  readPreferenceSheet,
  submissionKeyFromRows,
} from '../../src/ingest/preferenceImport.js'
import { buildStructureIssues } from '../../src/ingest/attentionList.js'

const dirs = []
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-t299-'))
  dirs.push(dir)
  const db = openLocalDb(path.join(dir, 'shoresh.sqlite'))
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('dev-1', 'Host')
  return { db, campId }
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

// A child's own planner: no name column, because the identity comes from the
// SUBMISSION rather than the page (ADR 2026-09-27 §14.1a).
//
// ADVERSARIAL ON PURPOSE. Archery and Swim in every cell is the ticket's own
// scenario — the two obvious picks at a camp offering eight things — so the two
// children's sheets are byte-identical rather than merely similar. The activity
// names are also the SAME in both, so nothing downstream can tell the sheets
// apart by label either.
const GRID = () => [
  ['', 'Monday', 'Tuesday', 'Wednesday'],
  ['Period 1', 'Archery', 'Swim', 'Archery'],
  ['Period 2', 'Swim', 'Archery', 'Swim'],
]
const CATALOG = buildPreferenceCatalog({ activities: ['Archery', 'Swim'], groups: [], tiers: [] })

// One import action, start to finish: read the rows the way the panel reads them,
// then commit. `arrivalId` is what the panel mints per file selection and what the
// CLI derives from the file's bytes (scripts/preferenceSheetCli.js passes its
// run id) — the caller's statement of WHICH import this is.
function importSheet(db, campId, { rows, sourceLabel, arrivalId, runId = randomUUID() }) {
  const parsed = readPreferenceSheet({
    rows,
    campId,
    catalog: CATALOG,
    sourceLabel,
    submissionKey: submissionKeyFromRows(rows),
    arrivalId,
  }).parsed
  expect(parsed, 'the grid must read as a preference sheet at all').not.toBeNull()
  const out = commitElectiveRun(db, {
    campId,
    deviceId: 'dev-1',
    name: `run ${sourceLabel}`,
    parsed,
    runId,
  })
  expect(out.ok, out.ok ? '' : String(out.error)).toBe(true)
  return { parsed, out }
}

const subjects = (db, campId) =>
  db
    .prepare('SELECT id, display_name, external_id FROM campers WHERE camp_id = ? AND is_unattributed = 1')
    .all(campId)

describe('T299 — identical submissions are not one camper', () => {
  it('two arrivals of byte-identical answers are TWO camper subjects', () => {
    const { db, campId } = freshDb()

    // The bytes are identical. Confirmed here rather than assumed, because if the
    // two fixtures ever drifted this case would pass for the wrong reason.
    const ari = GRID()
    const noa = GRID()
    expect(submissionKeyFromRows(noa)).toBe(submissionKeyFromRows(ari))

    // Both children exported from the same planner template, so even the file name
    // is the same — the collision that made the filename unusable as a key (T285).
    importSheet(db, campId, { rows: ari, sourceLabel: 'planner', arrivalId: randomUUID() })
    importSheet(db, campId, { rows: noa, sourceLabel: 'planner', arrivalId: randomUUID() })

    const rows = subjects(db, campId)
    expect(rows).toHaveLength(2)
    // Distinguishable, which is what lets a director merge them if it IS one child.
    expect(new Set(rows.map((r) => r.id)).size).toBe(2)

    // Both children's answers survive as their own. Six cells each, and the
    // preference rows must not have collapsed onto one camper either.
    const byCamper = db
      .prepare('SELECT camper_id, COUNT(*) AS n FROM elective_preferences GROUP BY camper_id')
      .all()
    expect(byCamper).toHaveLength(2)
    expect(byCamper.map((r) => r.n)).toEqual([6, 6])
  })

  it('the SAME arrival re-imported converges to ONE subject', () => {
    const { db, campId } = freshDb()

    // What a retry is: the same import action, sent again — an ambiguous MCP
    // timeout, or the CLI re-run on a file whose bytes have not changed, which
    // derives the same run id (deriveImportedElectiveRunId). Same arrival, same
    // run: it must land on the row it already wrote, not accumulate duplicates.
    const arrivalId = randomUUID()
    const runId = randomUUID()
    const first = importSheet(db, campId, { rows: GRID(), sourceLabel: 'planner', arrivalId, runId })
    const again = importSheet(db, campId, { rows: GRID(), sourceLabel: 'planner', arrivalId, runId })

    expect(again.parsed.campers[0].id).toBe(first.parsed.campers[0].id)
    expect(subjects(db, campId)).toHaveLength(1)
    // And no duplicated answers underneath the one subject.
    expect(db.prepare('SELECT COUNT(*) AS n FROM elective_preferences').get().n).toBe(6)
  })

  it('naming both subjects the same child MERGES them; naming them differently does not', () => {
    const { db, campId } = freshDb()
    importSheet(db, campId, { rows: GRID(), sourceLabel: 'planner', arrivalId: randomUUID() })
    importSheet(db, campId, { rows: GRID(), sourceLabel: 'planner', arrivalId: randomUUID() })
    const [a, b] = subjects(db, campId)

    // ONE CHILD: the director names both sheets the same camper. T285's rekey
    // sends both onto the canonical name-keyed id, so the merge needs no second
    // mechanism — which is why this ticket adds none.
    const first = attributeElectiveSubject(db, { campId, deviceId: 'dev-1', subjectId: a.id, displayName: 'Ari Green' })
    const second = attributeElectiveSubject(db, { campId, deviceId: 'dev-1', subjectId: b.id, displayName: 'Ari Green' })
    expect(first.ok && second.ok, String(first.error ?? second.error ?? '')).toBe(true)
    expect(second.camperId).toBe(first.camperId)
    expect(subjects(db, campId)).toHaveLength(0)
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM campers WHERE camp_id = ? AND is_active = 1').get(campId).n
    ).toBe(1)
  })

  // THE TELLING HALF, driven off the rows the import actually wrote rather than a
  // hand-made fixture. attentionList.test.js pins the message; what this case pins
  // is that the real import leaves the db in a state the attention surface can read
  // it out of — a fixture agreeing with the surface proves nothing about the
  // importer, which is how a planner-grid defect once survived 78 tests.
  it('the director is told, on the existing attention surface, that the two sheets are indistinguishable', () => {
    const { db, campId } = freshDb()
    importSheet(db, campId, { rows: GRID(), sourceLabel: 'planner', arrivalId: randomUUID() })
    importSheet(db, campId, { rows: GRID(), sourceLabel: 'planner', arrivalId: randomUUID() })

    // Exactly what localClient.list('campers') hands the Roots home.
    const campers = db.prepare('SELECT * FROM campers WHERE camp_id = ?').all(campId)
    const rows = buildStructureIssues({ campers }).filter((i) => i.sourceKind === 'unattributed-camper')

    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.why).toMatch(/same answers/i)

    // A third sheet with DIFFERENT answers, imported alongside, is NOT swept into the
    // claim. Without this the surface could be flagging every unnamed sheet and the
    // case above would pass for the wrong reason.
    const different = [
      ['', 'Monday', 'Tuesday', 'Wednesday'],
      ['Period 1', 'Swim', 'Swim', 'Swim'],
      ['Period 2', 'Archery', 'Archery', 'Archery'],
    ]
    importSheet(db, campId, { rows: different, sourceLabel: 'planner', arrivalId: randomUUID() })
    const after = buildStructureIssues({
      campers: db.prepare('SELECT * FROM campers WHERE camp_id = ?').all(campId),
    }).filter((i) => i.sourceKind === 'unattributed-camper')
    expect(after).toHaveLength(3)
    expect(after.filter((r) => /same answers/i.test(r.why))).toHaveLength(2)
  })

  // NO MIGRATION IS TAKEN for this change — no column moves and no schema version is
  // bumped — so the rows a pre-T299 database already holds have to keep working on
  // their own terms. A provisional subject written then is keyed in the OLD `ext`
  // mode, carrying the submission hash where a roster id belongs. It keeps its id
  // (nothing re-derives a subject id), stays on the attention surface, and must
  // still be nameable. If that were false, this change would silently strand every
  // unnamed sheet a developer's shoresh-dev database already holds.
  it('a subject written the pre-T299 way can still be named', () => {
    const { db, campId } = freshDb()
    const legacyId = deriveCamperId(campId, { externalId: 'sub-0ae5a692da689e80005faf6c4958e796' })
    db.prepare(
      'INSERT INTO campers (id, camp_id, display_name, external_id, is_active, is_unattributed) VALUES (?,?,?,?,1,1)'
    ).run(legacyId, campId, 'planner', 'sub-0ae5a692da689e80005faf6c4958e796')

    // Visible as a sheet awaiting a name, exactly as before.
    expect(subjects(db, campId).map((r) => r.id)).toEqual([legacyId])

    const out = attributeElectiveSubject(db, {
      campId,
      deviceId: 'dev-1',
      subjectId: legacyId,
      displayName: 'Ari Green',
    })
    expect(out.ok, String(out.error ?? '')).toBe(true)
    // T321 (docs/adr/2026-10-01-camper-id-high-entropy-format.md): the named
    // camper's id is now a random, opaque token (resolveOrMintCamperId), not
    // deriveCamperId's output directly — deriveCamperId now only computes the
    // camper_identity_keys LOOKUP row's id. Re-attributing the SAME subject to
    // the SAME name must still converge on the SAME camper id, so the
    // discriminator is idempotence, not a literal match against deriveCamperId.
    expect(out.camperId).toMatch(/^camper2:/)
    const lookupId = deriveCamperId(campId, { displayName: 'Ari Green' })
    expect(db.prepare('SELECT camper_id FROM camper_identity_keys WHERE id = ?').get(lookupId)?.camper_id).toBe(
      out.camperId
    )
    expect(subjects(db, campId)).toHaveLength(0)
  })

  it('two children named separately stay two children, each keeping their own answers', () => {
    const { db, campId } = freshDb()
    importSheet(db, campId, { rows: GRID(), sourceLabel: 'planner', arrivalId: randomUUID() })
    importSheet(db, campId, { rows: GRID(), sourceLabel: 'planner', arrivalId: randomUUID() })
    const [a, b] = subjects(db, campId)

    const ari = attributeElectiveSubject(db, { campId, deviceId: 'dev-1', subjectId: a.id, displayName: 'Ari Green' })
    const noa = attributeElectiveSubject(db, { campId, deviceId: 'dev-1', subjectId: b.id, displayName: 'Noa Katz' })
    expect(ari.ok && noa.ok, String(ari.error ?? noa.error ?? '')).toBe(true)
    expect(noa.camperId).not.toBe(ari.camperId)

    // Asserted as a SET keyed on the camper id, never on row order: two children
    // whose answers are identical produce rows that sort by whatever the ids
    // happen to be, and an order-sensitive assertion here would pass by accident.
    const counts = new Map(
      db
        .prepare('SELECT camper_id, COUNT(*) AS n FROM elective_preferences GROUP BY camper_id')
        .all()
        .map((r) => [r.camper_id, r.n])
    )
    expect(counts.get(ari.camperId)).toBe(6)
    expect(counts.get(noa.camperId)).toBe(6)
  })
})
