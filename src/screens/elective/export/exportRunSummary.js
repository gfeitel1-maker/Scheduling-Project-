// T197 (docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-choice-export.md §4) —
// summary export: pure aggregation over data the Draft/Final screens already load. No IPC.
export function buildRunSummaryExport({
  run,
  assignments = [],
  preferences = [],
  capacityRows = [],
} = {}) {
  const counts_by_rank = {}
  const assignedCamperIds = new Set()
  for (const a of assignments) {
    assignedCamperIds.add(a.camper_id)
    if (a.preference_rank != null) {
      counts_by_rank[a.preference_rank] = (counts_by_rank[a.preference_rank] ?? 0) + 1
    }
  }

  const preferenceCamperIds = new Set(preferences.map((p) => p.camper_id))
  let unassigned_count = 0
  for (const camperId of preferenceCamperIds) {
    if (!assignedCamperIds.has(camperId)) unassigned_count += 1
  }

  const fill_by_offering = capacityRows.map((c) => ({
    occurrence_id: c.occurrenceId, activity_id: c.activityId, filled: c.filled, capacity: c.capacity,
  }))

  return {
    run_id: run.id,
    run_name: run.name,
    run_status: run.status,
    solver_generation: run.solver_generation ?? null,
    source_hash: run.source_sha256 ?? null,
    counts_by_rank,
    unassigned_count,
    fill_by_offering,
  }
}
