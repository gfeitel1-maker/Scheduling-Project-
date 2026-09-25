// T248 (docs/work/tickets/T248-child-schedule-export.md) — the single
// derivation of a run's per-camper outer schedule rows, shared by BOTH the
// draft-derive read path (getElectiveRunOuterScheduleHandler, electron/
// main.js) and finalizeElectiveRun.js's snapshot-write path.
//
// GOVERNOR DEVIATION FROM THE ADR: docs/adr/2026-09-23-elective-run-lifecycle-
// and-remaining-slices.md decision (d)'s prose describes the draft path as
// reading the camper's GROUP's non-elective template_slots. That is not what
// T244 actually built: finalizeElectiveRun.js snapshots the run's
// generation-visible elective_assignments joined to their occurrences —
// per-camper RESOLVED elective placements, not a group's template. Building
// the draft path to the ADR's literal group-template reading would make it
// disagree with what finalize snapshots for the exact same run, which is
// unverifiable and wrong. Resolution (Governor): extract T244's derivation
// into this one function and have BOTH the draft-read handler and
// finalizeElectiveRun.js call it, so draft-derive and finalize are PROVABLY
// symmetric — finalizing a draft and re-deriving it must produce identical
// rows, which is exactly what the integration test asserts. Do not implement
// the ADR's group/template_slots reading here.
//
// Span-awareness note: this module returns one row per span HEAD (span_blocks
// carries the length), never one row per covered block — the renderer grid
// helpers named in the ticket (collectSpanTails/getActivityRowSpan,
// src/screens/schedule/useSlotMutations.js and gridGeometry.js) are NOT used
// here. Those operate on a group schedule's rendered `slots` array in the
// renderer and cannot run in the main process against this shape; they are
// also out of bounds for electron/ per this repo's renderer/main boundary.
// The activity's own `span_blocks` column, copied through unchanged, is what
// carries span length for this derivation, exactly as finalizeElectiveRun.js
// already did before this extraction.
import { electiveGenerationVisibleFragment } from './electiveGenerationPredicate.js'

/**
 * @returns {{rows: Array, skipped: Array}}
 */
export function deriveElectiveRunOuterRows(db, run) {
  // An unknown runId (round 2, Code Reviewer + Red Hat) leaves `run`
  // undefined — degrade the same way getElectiveRunHandler does for the
  // same input, rather than dereferencing run.id below.
  if (!run) return { rows: [], skipped: [] }

  const assignmentRows = db
    .prepare(
      `SELECT a.camper_id, a.activity_id, o.day_id, o.time_block_id
         FROM elective_assignments a
         JOIN elective_occurrences o ON o.id = a.occurrence_id
        WHERE a.run_id = :runId AND ${electiveGenerationVisibleFragment('a')}
        ORDER BY a.camper_id, o.day_id, o.time_block_id`
    )
    .all({ runId: run.id, gen: run.solver_generation })

  const activityById = new Map(db.prepare('SELECT * FROM activities').all().map((a) => [a.id, a]))
  const locationById = new Map(db.prepare('SELECT * FROM locations').all().map((l) => [l.id, l]))

  const rows = []
  const skipped = []
  for (const row of assignmentRows) {
    if (row.day_id == null || row.time_block_id == null) {
      skipped.push({ camperId: row.camper_id, reason: 'missing day_id or time_block_id' })
      continue
    }
    const activity = activityById.get(row.activity_id) ?? null
    const location = activity?.location_id != null ? locationById.get(activity.location_id) ?? null : null
    rows.push({
      camper_id: row.camper_id,
      day_id: row.day_id,
      time_block_id: row.time_block_id,
      activity_id: row.activity_id,
      activity_name: activity?.name ?? null,
      location_id: activity?.location_id ?? null,
      location_name: location?.name ?? null,
      span_blocks: activity?.span_blocks ?? null,
      solver_generation: run.solver_generation,
    })
  }
  return { rows, skipped }
}
