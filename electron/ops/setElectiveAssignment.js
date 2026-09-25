// Moving/locking a camper inside a DRAFT elective run (T245, docs/adr/
// 2026-09-23-elective-run-lifecycle-and-remaining-slices.md decision (b)).
//
// Writes the SAME derived row the solver writes —
// deriveElectiveAssignmentId(run_id, camper_id, occurrence_id) — so a move is
// an ordinary per-field last-write-wins on one record, which the existing
// conflict machinery already serializes (D4). Same runAtomic/appendOp
// discipline and the same "refusals are returned, not thrown" convention as
// commitElectiveRun.js / finalizeElectiveRun.js.
import { randomUUID } from 'node:crypto'
import { appendOp, runAtomic } from './operations.js'
import { deriveElectiveAssignmentId } from './electiveDerivedIds.js'
import { electiveGenerationVisibleFragment } from './electiveGenerationPredicate.js'
import { resolveOfferingCapacity } from './electiveOfferingCapacity.js'

/**
 * @returns {{ok:true, assignmentId:string}
 *  | {ok:false, error:'RUN_NOT_DRAFT'}
 *  | {ok:false, error:'OCCURRENCE_FULL', capacity:number, filled:number}
 *  | {ok:false, error:'CAMPER_INELIGIBLE'}
 *  | {ok:false, error:string}}
 */
export function setElectiveAssignment(db, {
  runId, camperId, occurrenceId, activityId, locked = false, authorUserId = null, deviceId,
}) {
  const run = db.prepare('SELECT * FROM elective_assignment_runs WHERE id = ?').get(runId)
  if (!run) return { ok: false, error: 'run not found' }
  if (run.status === 'final') return { ok: false, error: 'RUN_NOT_DRAFT' }

  const occurrence = db.prepare('SELECT * FROM elective_occurrences WHERE id = ?').get(occurrenceId)
  // Plain string, not a machine code: an occurrence that does not exist at all
  // is an input-shape refusal with no director-facing action, per
  // finalizeElectiveRun.js's convention.
  if (!occurrence) return { ok: false, error: 'occurrence not found' }

  // ELIGIBILITY, AND WHAT IT DELIBERATELY DOES NOT COVER.
  //
  // buildElectiveAssignments' internal eligibility is `attends(camperId,
  // occurrenceId)` over an attendance map, and that map is built by
  // src/screens/elective/assignment/buildAttendance.js from the PARSED SHEET's
  // per-camper `division`, matched against tier names. That fact is never
  // persisted: `campers` has no division column, commitElectiveRun never
  // writes one, and campers.group_id is not populated on this path — so this
  // handler structurally CANNOT reconstruct the engine's attendance map, and
  // persisting it would be a schema change T245 does not own (T243 owned
  // schema). Accepting an attendance map over IPC from the renderer was
  // rejected for the same reason the rest of this module refuses
  // client-supplied authority.
  //
  // CAMPER_INELIGIBLE here therefore means the DB-DERIVABLE eligibility only:
  // the camper is a participant of this run (has an elective_preferences row
  // for it), and the occurrence belongs to this run. Division/tier attendance
  // is NOT checked. Do not read this as a complete eligibility check.
  if (occurrence.run_id !== runId) return { ok: false, error: 'CAMPER_INELIGIBLE' }
  const participant = db
    .prepare('SELECT 1 FROM elective_preferences WHERE run_id = ? AND camper_id = ? LIMIT 1')
    .get(runId, camperId)
  if (!participant) return { ok: false, error: 'CAMPER_INELIGIBLE' }

  // The (occurrence, activity) pair must be a confirmed offering of the
  // occurrence's set — the same `status ?? 'confirmed'` rule buildOfferings.js
  // applies. A plain string, not CAMPER_INELIGIBLE: nothing about the camper
  // is wrong, and there is no specific director action beyond surfacing it.
  const setActivity = db
    .prepare('SELECT * FROM elective_set_activities WHERE elective_set_id = ? AND activity_id = ?')
    .get(occurrence.elective_set_id, activityId)
  if (!setActivity || (setActivity.status ?? 'confirmed') !== 'confirmed') {
    return { ok: false, error: 'that activity is not a confirmed offering of this occurrence' }
  }

  const assignmentId = deriveElectiveAssignmentId(runId, camperId, occurrenceId)

  // Capacity, resolved by the ONE helper the engine's offering builder uses
  // (electiveOfferingCapacity.js). An 'unlimited' offering is never checked.
  // ('limited', NULL) resolves to a capacity of 0 here, which is exactly what
  // buildOfferings.js/buildElectiveAssignments already do with such a row
  // (`Math.max(0, capacity_limit ?? 0)` closes the offering) — this path
  // mirrors the engine rather than inventing a third reading.
  const capacityResult = resolveOfferingCapacity(setActivity)
  if (capacityResult.kind !== 'unlimited') {
    const capacity = capacityResult.kind === 'limited' ? capacityResult.capacity : 0
    // Generation-visible rows only, via the shared fragment, and EXCLUDING the
    // row being written: a move within the same occurrence must not count
    // itself as an occupant.
    const filled = db
      .prepare(
        `SELECT COUNT(*) c FROM elective_assignments a
          WHERE a.run_id = :runId AND a.occurrence_id = :occurrenceId
            AND a.activity_id = :activityId AND a.id != :assignmentId
            AND ${electiveGenerationVisibleFragment('a')}`
      )
      .get({ runId, occurrenceId, activityId, assignmentId, gen: run.solver_generation }).c
    if (filled >= capacity) return { ok: false, error: 'OCCURRENCE_FULL', capacity, filled }
  }

  try {
    runAtomic(db, () => {
      const fields = {
        run_id: runId,
        occurrence_id: occurrenceId,
        camper_id: camperId,
        activity_id: activityId,
        source: 'manual',
        is_locked: locked ? 1 : 0,
        // Set at THIS write, from the run's current marker, and never touched
        // again by any other path (ADR decision (b) / Red Hat H3). A manual
        // row survives regeneration by being exempt from the generation
        // predicate, not by having its marker carried forward.
        solver_generation: run.solver_generation,
      }
      for (const [field, value] of Object.entries(fields)) {
        appendOp(db, {
          entity: 'elective_assignments', entity_id: assignmentId, field, value,
          author_user_id: authorUserId, device_id: deviceId, client_write_id: randomUUID(),
        })
      }
    })
  } catch (e) {
    return { ok: false, error: e.message }
  }

  return { ok: true, assignmentId }
}
