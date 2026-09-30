// T198 — extracted verbatim from electron/main.js's getElectiveRunOuterScheduleHandler (below its
// auth/arg validation, which stays in the IPC handler). See electron/ops/electiveRunProjectionInput.js
// for the one place this and getElectiveRun are combined into a machine-access projection; do not
// re-derive any of this a second time there.
import { deriveElectiveRunOuterRows } from './electiveRunOuterSchedule.js'
import { computeFinalizedAgainstStaleGeneration } from './finalizedAgainstStaleGeneration.js'
// T320 item 1 — the ONE fragment every reader of snapshot completeness must
// use (getElectiveRun.js is this module's cross-handler-parity sibling).
import { computeSnapshotCompleteness } from './electiveRunSnapshotCompleteness.js'

// T248 (docs/work/tickets/T248-child-schedule-export.md) — read-only,
// per-camper outer schedule for a run, source for the child schedule
// export (T250 wires the UI trigger; this is the data path only). Same
// read action as getElectiveRunHandler — no new staff-reachable path.
//
// A `final` run reads the immutable elective_run_outer_snapshots rows
// finalizeElectiveRun.js wrote (D6: survives the activity being renamed
// afterward, since the snapshot copied activity_name/location_name at
// finalize time). Any other status (draft) derives live via the SAME
// function finalizeElectiveRun.js calls (electron/ops/
// electiveRunOuterSchedule.js) — see that module's header comment for why
// this is a deliberate deviation from the ADR's (d) prose.
//
// Response shape deviates from the ADR's bare-Array (d) sketch by returning
// an object: the ticket also requires surfacing finalizedAgainstStaleGeneration
// on this handler, which a bare array cannot carry.

export function getElectiveRunOuterSchedule(db, { runId }) {
  const run = db.prepare('SELECT * FROM elective_assignment_runs WHERE id = ?').get(runId)

  let rows
  // Any status other than 'final' (including an unknown runId, where
  // `run` is undefined) takes the live-derive branch below. A future
  // 'archived' status landing here and being read live rather than from
  // the snapshot table is therefore a deliberate consequence of this
  // check, not an oversight.
  if (run?.status === 'final') {
    rows = db
      .prepare(
        `SELECT camper_id, day_id, time_block_id, activity_id, activity_name,
                location_id, location_name, span_blocks, solver_generation,
                cell_kind, choice_id, is_linked_choice, choice_label
           FROM elective_run_outer_snapshots
          WHERE run_id = ?
          ORDER BY camper_id, day_id, time_block_id`
      )
      .all(runId)
  } else {
    rows = deriveElectiveRunOuterRows(db, run).rows
  }

  return {
    rows: rows.map((r) => ({
      camperId: r.camper_id,
      dayId: r.day_id,
      timeBlockId: r.time_block_id,
      activityId: r.activity_id,
      activityName: r.activity_name,
      locationId: r.location_id,
      locationName: r.location_name,
      spanBlocks: r.span_blocks,
      solverGeneration: r.solver_generation,
      cellKind: r.cell_kind,
      choiceId: r.choice_id ?? null,
      isLinkedChoice: !!r.is_linked_choice,
      choiceLabel: r.choice_label ?? null,
    })),
    runStatus: run?.status ?? null,
    finalizedAgainstStaleGeneration: computeFinalizedAgainstStaleGeneration(db, run),
    // T320 item 1 — cross-handler parity with getElectiveRun.js: the SAME
    // computeSnapshotCompleteness call, so the two can never disagree about
    // whether a final run's export would be incomplete.
    ...computeSnapshotCompleteness(db, run),
  }
}
