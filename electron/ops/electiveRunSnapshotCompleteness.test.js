// T320 (docs/adr/2026-09-30-elective-run-durability.md item 1) — unit tests for
// the shared snapshot-completeness fragment. Real in-memory sqlite: this module
// is a digest over already-held rows plus a comparison, and the stub-seed
// partial-row case is exactly what a fixture table can demonstrate directly.
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  computeExpectedSnapshotDigest,
  computeHeldSnapshotDigest,
  computeSnapshotCompleteness,
} from './electiveRunSnapshotCompleteness.js'

function fixtureDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE elective_run_outer_snapshots (
      id TEXT PRIMARY KEY, run_id TEXT, camper_id TEXT, day_id TEXT, time_block_id TEXT,
      activity_id TEXT, activity_name TEXT, location_id TEXT, location_name TEXT,
      span_blocks INTEGER, solver_generation TEXT, cell_kind TEXT, choice_id TEXT,
      is_linked_choice INTEGER, choice_label TEXT
    )
  `)
  return db
}

const row = (over = {}) => ({
  id: 'snap-1', run_id: 'run-1', camper_id: 'c1', day_id: 'd1', time_block_id: 'tb1',
  activity_id: 'a1', activity_name: 'Pottery', location_id: 'l1', location_name: 'Art Room',
  span_blocks: 1, cell_kind: 'elective', choice_id: null, is_linked_choice: 0, choice_label: null,
  ...over,
})

describe('computeSnapshotCompleteness', () => {
  it('reports incomplete when a held row is only stub-seeded (NULL fields), even though the COUNT matches', () => {
    const db = fixtureDb()
    const expectedRows = [row()]
    const expectedDigest = computeExpectedSnapshotDigest(expectedRows)
    // Stub-seeded: only the identity columns are present, exactly what
    // projections.js's ensureExists inserts before per-field ops arrive.
    db.prepare(
      'INSERT INTO elective_run_outer_snapshots (id, run_id, camper_id, day_id, time_block_id) VALUES (?,?,?,?,?)'
    ).run('snap-1', 'run-1', 'c1', 'd1', 'tb1')

    const run = { id: 'run-1', status: 'final', snapshot_expected_rows: 1, snapshot_digest: expectedDigest }
    const result = computeSnapshotCompleteness(db, run)

    expect(result.heldSnapshotRows).toBe(1)
    expect(result.snapshotIncomplete).toBe(true)
  })

  it('reports complete when every field of every expected row is held', () => {
    const db = fixtureDb()
    const expectedRows = [row()]
    const expectedDigest = computeExpectedSnapshotDigest(expectedRows)
    db.prepare(
      `INSERT INTO elective_run_outer_snapshots
        (id, run_id, camper_id, day_id, time_block_id, activity_id, activity_name, location_id,
         location_name, span_blocks, solver_generation, cell_kind, choice_id, is_linked_choice, choice_label)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run('snap-1', 'run-1', 'c1', 'd1', 'tb1', 'a1', 'Pottery', 'l1', 'Art Room', 1, null, 'elective', null, 0, null)

    const run = { id: 'run-1', status: 'final', snapshot_expected_rows: 1, snapshot_digest: expectedDigest }
    const result = computeSnapshotCompleteness(db, run)

    expect(result.heldSnapshotRows).toBe(1)
    expect(result.snapshotIncomplete).toBe(false)
    expect(result.expectedSnapshotRows).toBe(1)
  })

  it('is not incomplete for a draft run', () => {
    const db = fixtureDb()
    const run = { id: 'run-1', status: 'draft', snapshot_expected_rows: null, snapshot_digest: null }
    expect(computeSnapshotCompleteness(db, run)).toEqual({
      expectedSnapshotRows: null, heldSnapshotRows: null, snapshotIncomplete: false,
    })
  })

  it('is not incomplete for a legacy final run with no recorded expectation', () => {
    const db = fixtureDb()
    const run = { id: 'run-1', status: 'final', snapshot_expected_rows: null, snapshot_digest: null }
    expect(computeSnapshotCompleteness(db, run)).toEqual({
      expectedSnapshotRows: null, heldSnapshotRows: null, snapshotIncomplete: false,
    })
  })
})

describe('computeHeldSnapshotDigest / computeExpectedSnapshotDigest agree on identical content', () => {
  it('produce the same digest for the same logical row', () => {
    const db = fixtureDb()
    const expectedRows = [row()]
    db.prepare(
      `INSERT INTO elective_run_outer_snapshots
        (id, run_id, camper_id, day_id, time_block_id, activity_id, activity_name, location_id,
         location_name, span_blocks, solver_generation, cell_kind, choice_id, is_linked_choice, choice_label)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run('snap-1', 'run-1', 'c1', 'd1', 'tb1', 'a1', 'Pottery', 'l1', 'Art Room', 1, null, 'elective', null, 0, null)

    expect(computeHeldSnapshotDigest(db, 'run-1')).toBe(computeExpectedSnapshotDigest(expectedRows))
  })
})

// T320 round 2, Red Hat HIGH — digestOf (this module) formerly joined a row's
// fields with unescaped `|`/`=` and joined ROWS with a no-op (`hash.update('')`
// is not a separator, it writes nothing). A field value is free text
// (location_name, choice_label, and even `id` here are all unvalidated TEXT
// columns), so a value containing the literal substring `id=` can be
// indistinguishable from the start of the NEXT row's mandatory `id=` field —
// two structurally different row sets serialize to the identical byte string
// and therefore hash equal. Concretely: row1's `choice_label` absorbing the
// text `"id=X"` and row2's `id` shrinking from `"Xid=Y"` to `"Y"` produces the
// same concatenation both ways (`...choice_label=` + `` + `id=Xid=Y|...` ==
// `...choice_label=` + `id=X` + `id=Y|...`). Two genuinely different snapshot
// row sets (different ids, different choice_label) would report "complete"
// against each other's digest.
// KNOWN, REPORTED, UNFIXED second director-facing defect (board item, same loop that added
// elective_run_outer_snapshots to projector.js's TOMBSTONE_DENYLISTED_ENTITIES and to
// purgeSupportCommand.js's local delete set). Erasing a camper deletes their snapshot rows from a
// FINALIZED run — on the purging device since T243, and now on every peer via the denylist — which
// makes `held !== expected` and the digest mismatch `run.snapshot_digest`. That makes THIS run
// report snapshotIncomplete:true forever, and every export builder
// (exportChildSchedule.js/exportActivityRoster.js/exportRunSummary.js/
// exportElectiveRunProjection.js) refuses it with SNAPSHOT_INCOMPLETE — an erasure makes an
// otherwise-healthy finalized run permanently unexportable. Fixing this needs either a schema
// addition (per-run erased-row accounting) or a change to the digest's algebra plus a cross-device
// propagation story for it — explicitly OUT OF SCOPE here; reported to the owner instead. This
// test exists ONLY to make the defect visible and non-regressable: it PINS today's behavior and is
// MEANT to go red the day someone actually fixes this — do not "fix" it by softening
// computeSnapshotCompleteness, adding a schema column, or touching the digest fields.
describe('KNOWN DEFECT (unfixed, reported): camper erasure permanently breaks a finalized run\'s export', () => {
  it('pins that erasing one camper\'s snapshot rows from an otherwise-complete finalized run makes it report snapshotIncomplete forever', () => {
    const db = fixtureDb()
    const expectedRows = [row({ id: 'snap-1', camper_id: 'c1' }), row({ id: 'snap-2', camper_id: 'c2' })]
    const expectedDigest = computeExpectedSnapshotDigest(expectedRows)
    const insert = db.prepare(
      `INSERT INTO elective_run_outer_snapshots
        (id, run_id, camper_id, day_id, time_block_id, activity_id, activity_name, location_id,
         location_name, span_blocks, solver_generation, cell_kind, choice_id, is_linked_choice, choice_label)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    for (const r of expectedRows) {
      insert.run(r.id, r.run_id, r.camper_id, r.day_id, r.time_block_id, r.activity_id, r.activity_name,
        r.location_id, r.location_name, r.span_blocks, null, r.cell_kind, r.choice_id, r.is_linked_choice, r.choice_label)
    }
    const run = { id: 'run-1', status: 'final', snapshot_expected_rows: 2, snapshot_digest: expectedDigest }

    // Sanity: complete before any erasure — the defect is specifically about what erasure does.
    expect(computeSnapshotCompleteness(db, run).snapshotIncomplete).toBe(false)

    // Simulate the erasure sweep (projector.js's TOMBSTONE_DENYLISTED_ENTITIES /
    // purgeSupportCommand.js's local delete): camper c1's snapshot row is gone.
    db.prepare('DELETE FROM elective_run_outer_snapshots WHERE camper_id = ?').run('c1')

    const result = computeSnapshotCompleteness(db, run)

    expect(result.heldSnapshotRows).toBe(1)
    expect(result.expectedSnapshotRows).toBe(2)
    expect(result.heldSnapshotRows).toBeLessThan(result.expectedSnapshotRows)
    expect(result.snapshotIncomplete).toBe(true)
  })
})

describe('digestOf row/field separation (Red Hat HIGH)', () => {
  it('computes DIFFERENT digests for two row sets whose field VALUES differ, even though the old unescaped/no-op-separator serialization made them collide', () => {
    const common = {
      camper_id: 'c1', day_id: 'd1', time_block_id: 'tb1', activity_id: 'a1',
      activity_name: 'Pottery', location_id: 'l1', location_name: 'Art Room',
      span_blocks: 1, cell_kind: 'elective', choice_id: null, is_linked_choice: 0,
    }
    const rowsA = [
      { id: 'A0', ...common, choice_label: '' },
      { id: 'Xid=Y', ...common, choice_label: null },
    ]
    const rowsB = [
      { id: 'A0', ...common, choice_label: 'id=X' },
      { id: 'Y', ...common, choice_label: null },
    ]

    expect(rowsA).not.toEqual(rowsB)
    expect(computeExpectedSnapshotDigest(rowsA)).not.toBe(computeExpectedSnapshotDigest(rowsB))
  })
})
