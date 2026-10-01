// T320 (docs/adr/2026-09-30-elective-run-durability.md item 1) — unit tests for
// the shared snapshot-completeness fragment. Real in-memory sqlite: this module
// is a digest over already-held rows plus a comparison, and the stub-seed
// partial-row case is exactly what a fixture table can demonstrate directly.
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import {
  computeExpectedSnapshotDigest,
  computeExpectedSnapshotDigestByCamper,
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
    );
    CREATE TABLE tombstones (
      id TEXT PRIMARY KEY, entity TEXT NOT NULL, version INTEGER NOT NULL, sig TEXT NOT NULL,
      created_at TEXT
    );
  `)
  return db
}

function tombstone(db, { id, entity = 'campers', version = 1 }) {
  db.prepare('INSERT INTO tombstones (id, entity, version, sig) VALUES (?, ?, ?, ?)').run(id, entity, version, 'sig')
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
// FIXED (board item, same loop that added elective_run_outer_snapshots to projector.js's
// TOMBSTONE_DENYLISTED_ENTITIES and to purgeSupportCommand.js's local delete set). This describe
// block used to PIN the defect (erasure makes a finalized run permanently unexportable) and was
// "MEANT to go red the day someone actually fixes this" — today is that day. snapshot_digest is
// now a per-camper map (computeExpectedSnapshotDigestByCamper), so a tombstoned camper's expected
// rows/digest are excluded from the comparison rather than causing a permanent mismatch against
// the whole-set digest.
describe('erasure-aware completeness: a tombstoned camper is excluded from the comparison', () => {
  it('reports complete after a camper is erased, with expected/held both reduced to the surviving campers', () => {
    const db = fixtureDb()
    const expectedRows = [row({ id: 'snap-1', camper_id: 'c1' }), row({ id: 'snap-2', camper_id: 'c2' })]
    const expectedDigest = computeExpectedSnapshotDigestByCamper(expectedRows, 'run-1')
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

    // Sanity: complete before any erasure.
    expect(computeSnapshotCompleteness(db, run).snapshotIncomplete).toBe(false)

    // Simulate the erasure sweep (projector.js's TOMBSTONE_DENYLISTED_ENTITIES /
    // purgeSupportCommand.js's local delete): camper c1's snapshot row is gone, AND the fleet-wide
    // signed tombstone fact is recorded (same table the projector's denylist gate reads).
    db.prepare('DELETE FROM elective_run_outer_snapshots WHERE camper_id = ?').run('c1')
    tombstone(db, { id: 'c1' })

    const result = computeSnapshotCompleteness(db, run)

    expect(result.heldSnapshotRows).toBe(1)
    expect(result.expectedSnapshotRows).toBe(1)
    expect(result.snapshotIncomplete).toBe(false)
  })

  // Anti-vacuity (brief item (d)): a genuinely missing row for a NON-erased camper must still
  // fire SNAPSHOT_INCOMPLETE. If the fix merely relaxed the comparison (e.g. dropped the digest
  // check, or only compared counts), this would wrongly read complete.
  it('still reports incomplete when a NON-erased camper is missing a row, even with an unrelated camper tombstoned', () => {
    const db = fixtureDb()
    const expectedRows = [row({ id: 'snap-1', camper_id: 'c1' }), row({ id: 'snap-2', camper_id: 'c2' })]
    const expectedDigest = computeExpectedSnapshotDigestByCamper(expectedRows, 'run-1')
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

    // c1 is tombstoned (unrelated to the bug we're probing) but c2's row is independently lost —
    // a real data-loss scenario this guard must still catch.
    tombstone(db, { id: 'c1' })
    db.prepare('DELETE FROM elective_run_outer_snapshots WHERE camper_id = ?').run('c2')

    const result = computeSnapshotCompleteness(db, run)

    expect(result.snapshotIncomplete).toBe(true)
  })

  // Fallback 2 (brief): a CORRUPT/unparseable digest (not legacy 64-hex, not valid per-camper
  // JSON) must read as INCOMPLETE — never complete, never silently treated as legacy.
  it('reports incomplete for a corrupt/unparseable snapshot_digest', () => {
    const db = fixtureDb()
    db.prepare(
      `INSERT INTO elective_run_outer_snapshots
        (id, run_id, camper_id, day_id, time_block_id, activity_id, activity_name, location_id,
         location_name, span_blocks, solver_generation, cell_kind, choice_id, is_linked_choice, choice_label)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run('snap-1', 'run-1', 'c1', 'd1', 'tb1', 'a1', 'Pottery', 'l1', 'Art Room', 1, null, 'elective', null, 0, null)

    for (const corrupt of ['{not json', '[]', 'null', '42', '{"c1":{"rows":"one","digest":"x"}}']) {
      const run = { id: 'run-1', status: 'final', snapshot_expected_rows: 1, snapshot_digest: corrupt }
      expect(computeSnapshotCompleteness(db, run).snapshotIncomplete).toBe(true)
    }
  })

  // Fallback 1 (brief): a LEGACY 64-hex-char digest (what v83 wrote before erasure-awareness)
  // keeps TODAY's whole-set comparison exactly as-is — erasure-awareness is deliberately NOT
  // retroactive, so a legacy-digest run stays incomplete forever after an erasure.
  it('a legacy plain-hex digest keeps the old whole-set comparison, including staying incomplete after an erasure', () => {
    const db = fixtureDb()
    const expectedRows = [row({ id: 'snap-1', camper_id: 'c1' }), row({ id: 'snap-2', camper_id: 'c2' })]
    const legacyDigest = computeExpectedSnapshotDigest(expectedRows) // whole-set sha256 hex
    expect(legacyDigest).toMatch(/^[0-9a-f]{64}$/)
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
    const run = { id: 'run-1', status: 'final', snapshot_expected_rows: 2, snapshot_digest: legacyDigest }
    expect(computeSnapshotCompleteness(db, run).snapshotIncomplete).toBe(false)

    db.prepare('DELETE FROM elective_run_outer_snapshots WHERE camper_id = ?').run('c1')
    tombstone(db, { id: 'c1' })

    expect(computeSnapshotCompleteness(db, run).snapshotIncomplete).toBe(true)
  })
})

// Board follow-up (digest-keys-privacy) — a per-camper map whose keys are NOT all 64-lowercase-hex
// is the raw-camper-id shape written in the dev-only window between PR #684 and this fix (no live
// users ever saw it). It is read EXACTLY like legacy plain-hex: whole-set comparison, never
// erasure-aware. There is no migration path for it and none is needed.
describe('branch 2: a raw-id-keyed per-camper map (pre-fix shape) reads like legacy, not erasure-aware', () => {
  function rawIdKeyedDigest(rows) {
    // The shape this module wrote before the fix: keys are the raw camper_id, not a hash.
    const byCamper = new Map()
    for (const r of rows) {
      if (!byCamper.has(r.camper_id)) byCamper.set(r.camper_id, [])
      byCamper.get(r.camper_id).push(r)
    }
    const map = {}
    for (const [camperId, camperRows] of byCamper) {
      map[camperId] = { rows: camperRows.length, digest: computeExpectedSnapshotDigest(camperRows) }
    }
    return JSON.stringify(map)
  }

  it('is treated as whole-set (legacy-like): reports complete when every row is held', () => {
    const db = fixtureDb()
    const expectedRows = [row({ id: 'snap-1', camper_id: 'c1' }), row({ id: 'snap-2', camper_id: 'c2' })]
    const digest = rawIdKeyedDigest(expectedRows)
    expect(Object.keys(JSON.parse(digest))).toEqual(['c1', 'c2']) // confirms this is NOT hash-keyed
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
    const run = { id: 'run-1', status: 'final', snapshot_expected_rows: 2, snapshot_digest: digest }
    expect(computeSnapshotCompleteness(db, run).snapshotIncomplete).toBe(false)
  })

  // Plant: a raw-id-keyed map must NOT get erasure-awareness for free — dropping a tombstoned
  // camper's row must still leave the run reporting incomplete, exactly like legacy plain-hex.
  it('plant: is NOT read as complete when a tombstoned camper is missing — proves branch 2 is not erasure-aware', () => {
    const db = fixtureDb()
    const expectedRows = [row({ id: 'snap-1', camper_id: 'c1' }), row({ id: 'snap-2', camper_id: 'c2' })]
    const digest = rawIdKeyedDigest(expectedRows)
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
    const run = { id: 'run-1', status: 'final', snapshot_expected_rows: 2, snapshot_digest: digest }

    db.prepare('DELETE FROM elective_run_outer_snapshots WHERE camper_id = ?').run('c1')
    tombstone(db, { id: 'c1' })

    expect(computeSnapshotCompleteness(db, run).snapshotIncomplete).toBe(true)
  })
})

// Discriminator edge case (brief): an EMPTY per-camper map ({}) satisfies "all keys are 64-hex"
// vacuously and therefore falls into branch 3 (erasure-aware), not branch 2. Deliberate: at zero
// entries the two branches behave identically (nothing to compare), and an unexpectedly-held
// camper is still caught by the existing "held camper the expectation never named" check.
describe('discriminator edge case: an empty per-camper map ({}) is vacuously branch 3', () => {
  it('a held camper against an empty expectation is still a mismatch (caught, not silently green)', () => {
    const db = fixtureDb()
    db.prepare(
      `INSERT INTO elective_run_outer_snapshots
        (id, run_id, camper_id, day_id, time_block_id, activity_id, activity_name, location_id,
         location_name, span_blocks, solver_generation, cell_kind, choice_id, is_linked_choice, choice_label)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run('snap-1', 'run-1', 'c1', 'd1', 'tb1', 'a1', 'Pottery', 'l1', 'Art Room', 1, null, 'elective', null, 0, null)

    const run = { id: 'run-1', status: 'final', snapshot_expected_rows: 0, snapshot_digest: '{}' }
    const result = computeSnapshotCompleteness(db, run)

    expect(result.snapshotIncomplete).toBe(true)
    expect(result.expectedSnapshotRows).toBe(0)
  })

  it('an empty expectation with nothing held is complete', () => {
    const db = fixtureDb()
    const run = { id: 'run-1', status: 'final', snapshot_expected_rows: 0, snapshot_digest: '{}' }
    const result = computeSnapshotCompleteness(db, run)

    expect(result.snapshotIncomplete).toBe(false)
    expect(result.expectedSnapshotRows).toBe(0)
    expect(result.heldSnapshotRows).toBe(0)
  })
})

// Red Hat HIGH (board 2b follow-up) — elective_assignment_runs fields arrive ONE PER FIELD over
// Automerge in no guaranteed order, so a device can hold status='final' and a fully-synced
// snapshot_digest while snapshot_expected_rows has not landed yet. The pre-existing `expected ==
// null` guard treated that exactly like the legacy/pre-v83 "nothing stored" case and returned
// snapshotIncomplete: false — silently truncating an export of a barely-synced finalized run.
describe('partial field arrival: snapshot_expected_rows and snapshot_digest can land independently', () => {
  it('reports INCOMPLETE when snapshot_digest has arrived but snapshot_expected_rows has not yet (not the legacy "both absent" case)', () => {
    const db = fixtureDb()
    const expectedRows = [row({ id: 'snap-1', camper_id: 'c1' })]
    const digest = computeExpectedSnapshotDigestByCamper(expectedRows, 'run-1')
    // Only ONE row held, same as expectedRows — digest/held agree with each other, but
    // snapshot_expected_rows itself has not synced to this device yet.
    db.prepare(
      `INSERT INTO elective_run_outer_snapshots
        (id, run_id, camper_id, day_id, time_block_id, activity_id, activity_name, location_id,
         location_name, span_blocks, solver_generation, cell_kind, choice_id, is_linked_choice, choice_label)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run('snap-1', 'run-1', 'c1', 'd1', 'tb1', 'a1', 'Pottery', 'l1', 'Art Room', 1, null, 'elective', null, 0, null)

    const run = { id: 'run-1', status: 'final', snapshot_expected_rows: null, snapshot_digest: digest }
    const result = computeSnapshotCompleteness(db, run)

    expect(result.snapshotIncomplete).toBe(true)
    // Honest held numbers, not null — same posture as the corrupt-digest fallback.
    expect(result.heldSnapshotRows).toBe(1)
  })

  it('still reports NOT incomplete when BOTH snapshot_expected_rows and snapshot_digest are absent (legacy/pre-v83 final run, regression guard)', () => {
    const db = fixtureDb()
    const run = { id: 'run-1', status: 'final', snapshot_expected_rows: null, snapshot_digest: null }
    expect(computeSnapshotCompleteness(db, run)).toEqual({
      expectedSnapshotRows: null, heldSnapshotRows: null, snapshotIncomplete: false,
    })
  })

  it('mirror case: snapshot_expected_rows present but snapshot_digest absent already reports INCOMPLETE (falls through to the corrupt-digest fallback)', () => {
    const db = fixtureDb()
    db.prepare(
      `INSERT INTO elective_run_outer_snapshots
        (id, run_id, camper_id, day_id, time_block_id, activity_id, activity_name, location_id,
         location_name, span_blocks, solver_generation, cell_kind, choice_id, is_linked_choice, choice_label)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run('snap-1', 'run-1', 'c1', 'd1', 'tb1', 'a1', 'Pottery', 'l1', 'Art Room', 1, null, 'elective', null, 0, null)

    const run = { id: 'run-1', status: 'final', snapshot_expected_rows: 1, snapshot_digest: null }
    const result = computeSnapshotCompleteness(db, run)

    expect(result.snapshotIncomplete).toBe(true)
  })

  it('a non-final run is unaffected by partial field arrival', () => {
    const db = fixtureDb()
    const run = { id: 'run-1', status: 'draft', snapshot_expected_rows: null, snapshot_digest: computeExpectedSnapshotDigestByCamper([row()], 'run-1') }
    expect(computeSnapshotCompleteness(db, run)).toEqual({
      expectedSnapshotRows: null, heldSnapshotRows: null, snapshotIncomplete: false,
    })
  })
})

describe('computeExpectedSnapshotDigestByCamper (write side)', () => {
  it('groups rows by camper_id into a per-camper {rows, digest} map, keyed by sha256(run_id:camper_id), never the raw camper_id', () => {
    const rows = [row({ id: 'snap-1', camper_id: 'c1' }), row({ id: 'snap-2', camper_id: 'c2' })]
    const map = JSON.parse(computeExpectedSnapshotDigestByCamper(rows, 'run-1'))
    const keys = Object.keys(map)
    expect(keys).not.toEqual(expect.arrayContaining(['c1', 'c2']))
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{64}$/)
    const byCamper1 = map[createHash('sha256').update('run-1:c1').digest('hex')]
    const byCamper2 = map[createHash('sha256').update('run-1:c2').digest('hex')]
    expect(byCamper1).toEqual({ rows: 1, digest: computeExpectedSnapshotDigest([rows[0]]) })
    expect(byCamper2).toEqual({ rows: 1, digest: computeExpectedSnapshotDigest([rows[1]]) })
  })

  it('is run-scoped: the same camper_id under two different run ids produces two different keys', () => {
    const rows = [row({ id: 'snap-1', camper_id: 'c1' })]
    const mapA = JSON.parse(computeExpectedSnapshotDigestByCamper(rows, 'run-A'))
    const mapB = JSON.parse(computeExpectedSnapshotDigestByCamper(rows, 'run-B'))
    expect(Object.keys(mapA)).not.toEqual(Object.keys(mapB))
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
