// Shared by getElectiveRunHandler (T244) and getElectiveRunOuterScheduleHandler
// (T248, electron/main.js) so the two handlers cannot silently diverge on
// what "finalized against a stale generation" means. See
// docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md.
//
// A draft run is always false — there is no snapshot generation to compare
// against yet. A final run with no ELECTIVE snapshot rows (e.g. a legacy
// pre-v74 final row, or a run whose only cells are inherited) is also false
// — nothing to be stale against.
//
// cell_kind = 'elective' only: since v76 (T197) an INHERITED row
// (electron/ops/electiveRunOuterSchedule.js) is written with
// solver_generation: NULL by design — it carries no solver generation at
// all, so it is not evidence of staleness. Comparing it anyway made every
// finalized run with an inherited cell read as stale against itself.
// Deliberately NOT also excluding `solver_generation IS NULL`: an ELECTIVE
// row is never produced with a NULL generation, so one found here is a real
// mismatch signal that excluding NULLs blindly would discard. Genuinely
// incomplete/not-yet-arrived snapshot data is a separate concern, handled by
// electron/ops/electiveRunSnapshotCompleteness.js (which deliberately
// excludes solver_generation from its own digest for the same reason, in
// the other direction) — the two findings have two different remedies:
// revise the run vs. wait for sync.
export function computeFinalizedAgainstStaleGeneration(db, run) {
  if (run?.status !== 'final') return false
  const snapshotGenerations = db
    .prepare(
      "SELECT DISTINCT solver_generation FROM elective_run_outer_snapshots WHERE run_id = ? AND cell_kind = 'elective'"
    )
    .all(run.id)
  if (snapshotGenerations.length === 0) return false
  return snapshotGenerations.some((r) => r.solver_generation !== run.solver_generation)
}
