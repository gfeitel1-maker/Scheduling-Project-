// Deterministic id derivation for elective_run_outer_snapshots (T243,
// docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md).
//
// Key: (run_id, camper_id, day_id, time_block_id). A finalized run's export
// snapshot for one camper's one grid cell. Follows the exact pattern of
// deriveElectiveAssignmentId (electron/ops/electiveDerivedIds.js): two
// devices independently finalizing/exporting the same run must produce the
// SAME id for the same camper/day/block, so a re-export is an ordinary
// per-field write on one row rather than a duplicate.
//
// A SEPARATE module from electiveDerivedIds.js, per the ticket, rather than an
// addition to it — the two files share no code beyond the `opaque` helper,
// re-implemented here narrowly rather than imported, to avoid coupling this
// small, single-purpose module to electiveDerivedIds.js's larger surface
// (choice labels, linked choices, etc.) that has nothing to do with this id.
//
// THIS ID IS NOT A PARSING CONTRACT. The components are legible in a SQLite
// shell for diagnosis only — nothing may recover a run, camper, day or block
// by inspecting the string. The row's own columns are the only authority.

const V = 1

// uuid + slug alphabet, plus ':' and '.' — mirrors electiveDerivedIds.js's
// OPAQUE guard exactly (see that file's comment for the full rationale: it
// closes delimiter injection and Unicode-normalization skew at the source).
const OPAQUE = /^[A-Za-z0-9_.:-]+$/

function opaque(name, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`deriveElectiveRunOuterSnapshotId: component ${name} must be a non-empty string`)
  }
  if (!OPAQUE.test(value)) {
    throw new Error(
      `deriveElectiveRunOuterSnapshotId: component ${name} must be an opaque id matching [A-Za-z0-9_.:-]+`
    )
  }
  return value
}

// Length-prefixed concatenation — provably injective, same reasoning as
// electiveDerivedIds.js's `join`.
function join(components) {
  return components.map((c) => `${c.length}.${c}`).join('')
}

export function deriveElectiveRunOuterSnapshotId(runId, camperId, dayId, timeBlockId) {
  return `erosn${V}:${join([
    opaque('run_id', runId),
    opaque('camper_id', camperId),
    opaque('day_id', dayId),
    opaque('time_block_id', timeBlockId),
  ])}`
}
