// Partial-snapshot detection (T320, docs/adr/2026-09-30-elective-run-
// durability.md item 1).
//
// WHY A DIGEST, NOT JUST A ROW COUNT. This codebase's projection layer
// stub-seeds a row on first-field-arrival (`INSERT OR IGNORE ...`,
// electron/ops/projections.js's elective_run_outer_snapshots entry) — a row
// can exist with only its four identity columns populated while
// activity_name/location_name/etc. are still NULL, because appendOp writes
// ONE OP PER FIELD, not one op per row, and per-field ops can arrive out of
// order across a sync. A row-count comparison sees that stub-seeded row as
// "present" and reports the snapshot complete when it is not.
import { createHash } from 'node:crypto'

// Field order is the contract — the SAME array (order-independent, since rows
// are sorted by id first) must be used by both the "expected" computation
// (finalize time, in-memory rows) and the "held" computation (read time,
// SELECT from elective_run_outer_snapshots) or the digest is meaningless.
// solver_generation is DELIBERATELY EXCLUDED: a generation mismatch is
// FINALIZED_AGAINST_STALE_GENERATION's own, separate concern
// (finalizedAgainstStaleGeneration.js) — folding it into this digest would
// make an ordinary, already-detected staleness ALSO register as
// "incomplete," conflating two different findings with two different
// remedies (revise the run vs. wait for sync to finish).
const DIGEST_FIELDS = [
  'id', 'camper_id', 'day_id', 'time_block_id', 'activity_id', 'activity_name',
  'location_id', 'location_name', 'span_blocks', 'cell_kind', 'choice_id',
  'is_linked_choice', 'choice_label',
]

// T320 round 2, F1 — the BOOLEAN/INTEGER BOUNDARY. `is_linked_choice` is the
// one DIGEST_FIELDS entry whose two producers disagree on TYPE, not just
// value: electiveRunOuterSchedule.js's derive side writes a JS boolean
// (`!!row.is_linked_choice`, or a literal `false`), while the held side
// re-reads the column from SQLite, where better-sqlite3 returns the
// NOT-NULL-DEFAULT-0 INTEGER column as a JS number (0/1). Without this,
// `is_linked_choice=false` and `is_linked_choice=0` are different STRINGS to
// createHash, so the digest computed at finalize time (over in-memory rows)
// can never equal the digest computed by any later read (over a fresh
// SELECT) — every finalized run reports snapshotIncomplete forever. Every
// other DIGEST_FIELDS entry was audited against both producers
// (electiveRunOuterSchedule.js's `rows.push`/inherited branches vs this
// module's own held SELECT) and found to agree in both type and null-vs-
// undefined handling — id/camper_id/day_id/time_block_id/activity_id are
// always-set strings on both sides; activity_name/location_id/location_name/
// choice_id/choice_label are consistently JS `null` (never `undefined`) on
// both the derive side's `?? null` and a SQLite NULL column read back by
// better-sqlite3; span_blocks and cell_kind agree in type (INTEGER/TEXT) on
// both sides. `is_linked_choice` is the only divergence, so this is the only
// field-specific normalization needed — but it lives in ONE place (here) so
// neither call site (computeExpectedSnapshotDigest,
// computeHeldSnapshotDigest) has to remember to coerce it.
function normalizedFieldValue(field, value) {
  if (field === 'is_linked_choice') return value ? 1 : 0
  return value ?? '\0NULL'
}

function digestOf(rows) {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const hash = createHash('sha256')
  for (const row of sorted) {
    hash.update(DIGEST_FIELDS.map((f) => `${f}=${normalizedFieldValue(f, row[f])}`).join('|'))
    hash.update('')
  }
  return hash.digest('hex')
}

// Called by finalizeElectiveRun.js with the SAME `snapshots` array it already
// builds, BEFORE writing — this is the single source of truth for "what the
// export should contain."
export function computeExpectedSnapshotDigest(rows) {
  return digestOf(rows)
}

// Called by getElectiveRun.js / getElectiveRunOuterSchedule.js with the
// CURRENTLY-HELD rows for this run.
export function computeHeldSnapshotDigest(db, runId) {
  const rows = db.prepare(
    `SELECT id, camper_id, day_id, time_block_id, activity_id, activity_name,
            location_id, location_name, span_blocks, cell_kind, choice_id,
            is_linked_choice, choice_label
       FROM elective_run_outer_snapshots WHERE run_id = ? ORDER BY id`
  ).all(runId)
  return digestOf(rows)
}

// Shared by every reader (getElectiveRun.js, getElectiveRunOuterSchedule.js,
// electiveRunProjectionInput.js via those two) — one fragment, per
// electiveGenerationPredicate.js's own precedent, so no reader can drift.
export function computeSnapshotCompleteness(db, run) {
  if (run?.status !== 'final') {
    return { expectedSnapshotRows: null, heldSnapshotRows: null, snapshotIncomplete: false }
  }
  const expected = run.snapshot_expected_rows
  // A legacy/pre-v83 final run (or a final run whose snapshot predates this
  // column existing) has nothing to compare against — same "no snapshot
  // generation" posture computeFinalizedAgainstStaleGeneration already takes
  // for its own no-snapshot-rows case. Not incomplete; simply unknown.
  if (expected == null) {
    return { expectedSnapshotRows: null, heldSnapshotRows: null, snapshotIncomplete: false }
  }
  const held = db
    .prepare('SELECT COUNT(*) c FROM elective_run_outer_snapshots WHERE run_id = ?')
    .get(run.id).c
  const heldDigest = computeHeldSnapshotDigest(db, run.id)
  const incomplete = held !== expected || heldDigest !== run.snapshot_digest
  return { expectedSnapshotRows: expected, heldSnapshotRows: held, snapshotIncomplete: incomplete }
}
