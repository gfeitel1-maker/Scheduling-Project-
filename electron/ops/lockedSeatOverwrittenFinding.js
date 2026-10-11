// T264 (docs/adr/2026-10-11-locked-elective-seat-survives-unmerged-regeneration.md).
//
// A lock written on a device that had not yet merged here can lose to a
// regeneration key by key (Automerge decides each key on its own). Derived
// from the merged projection, so every device raises the same item.
//
// Overwritten = locked, and NOT (the director's row, visible). Read through
// the shared generation-visibility fragment rather than a second copy of the
// predicate. That covers the row the solver won outright and the row whose
// source is the solver's but whose generation is stale (hidden). A row whose
// source is still 'manual' but holds the solver's activity is the
// activity_id conflict card's to resolve.
import { electiveGenerationVisibleFragment } from './electiveGenerationPredicate.js'

// Which side of the pending activity_id conflict was the director's lock
// ('manual') and which the solver's. reconcile.js annotates the sides; a
// device that has already answered the card has no row, and an unannotated
// one cannot say, so both degrade to "the row's own activity".
function sidesOfActivityConflict(db, assignmentId) {
  const row = db
    .prepare(
      `SELECT incoming_op, existing_op FROM conflicts
        WHERE entity = 'elective_assignments' AND entity_id = ? AND field = 'activity_id'
          AND resolved_at IS NULL AND id LIKE 'crdt:%'`
    )
    .get(assignmentId)
  const sides = { locked: null, solver: null }
  if (!row) return sides
  for (const raw of [row.existing_op, row.incoming_op]) {
    let side
    try { side = JSON.parse(raw) } catch { continue }
    if (side?.source === 'manual') sides.locked = side.value
    if (side?.source === 'solver') sides.solver = side.value
  }
  return sides
}

export function deriveLockedSeatOverwrittenFindings(db, runId, gen) {
  const rows = db
    .prepare(
      `SELECT a.id, a.occurrence_id, a.camper_id, a.activity_id, c.display_name AS camper_name
         FROM elective_assignments a LEFT JOIN campers c ON c.id = a.camper_id
        WHERE a.run_id = :runId AND a.is_locked = 1
          AND NOT (a.source = 'manual' AND ${electiveGenerationVisibleFragment('a')})
        ORDER BY a.id`
    )
    .all({ runId, gen })
  const nameOf = db.prepare('SELECT name FROM activities WHERE id = ?')
  const name = (id) => (id == null ? null : nameOf.get(id)?.name ?? null)
  return rows.map((r) => {
    const sides = sidesOfActivityConflict(db, r.id)
    const lockedId = sides.locked ?? r.activity_id
    const solverId = sides.locked != null && sides.solver != null ? sides.solver : null
    return {
      kind: 'LOCKED_SEAT_OVERWRITTEN',
      assignment_id: r.id,
      camper_id: r.camper_id,
      camper_name: r.camper_name ?? null,
      occurrence_id: r.occurrence_id,
      locked_activity_id: lockedId,
      locked_activity_name: name(lockedId),
      solver_activity_id: solverId,
      solver_activity_name: name(solverId),
    }
  })
}
