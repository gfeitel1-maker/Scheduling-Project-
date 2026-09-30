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
