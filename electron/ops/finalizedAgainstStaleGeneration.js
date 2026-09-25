// Shared by getElectiveRunHandler (T244) and getElectiveRunOuterScheduleHandler
// (T248, electron/main.js) so the two handlers cannot silently diverge on
// what "finalized against a stale generation" means. See
// docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md.
//
// A draft run is always false — there is no snapshot generation to compare
// against yet. A final run with no snapshot rows (e.g. a legacy pre-v74 final
// row) is also false — nothing to be stale against.
export function computeFinalizedAgainstStaleGeneration(db, run) {
  if (run?.status !== 'final') return false
  const snapshotGenerations = db
    .prepare('SELECT DISTINCT solver_generation FROM elective_run_outer_snapshots WHERE run_id = ?')
    .all(run.id)
  if (snapshotGenerations.length === 0) return false
  return snapshotGenerations.some((r) => r.solver_generation !== run.solver_generation)
}
