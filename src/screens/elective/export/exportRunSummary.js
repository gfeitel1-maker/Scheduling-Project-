// T197 (docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-choice-export.md §4) —
// summary export: pure aggregation over data the Draft/Final screens already load. No IPC.
//
// T318 (c4) — this export reaches PAPER (the Summary sheet's "Rank N: count"
// rows), so the same fabrication-proof rule as the screens applies: an
// assignment's rank is only counted into counts_by_rank on positive evidence of
// ordering (rank_kind 'cell-choice' or 'ordered-fallback', joined via the same
// buildPreferenceLookup camperElectiveWeek.js and runStateCopy.js use).
// Everything else — 'unordered-set' (a tie among equals; the ETL writes a real
// integer rank regardless), a null kind, or an unjoinable row — moves into
// unordered_count instead.
//
// THIS SIGNATURE NOW DIVERGES FROM ITS SIBLING, exportRunExceptions.js's
// buildRunExceptionsExport, which takes `occurrences` but not `days`/`timeBlocks`.
// That is deliberate, not drift to "fix" into uniformity: only THIS builder has
// to bind a coordinate-only preference row (occurrence_id null, a day/period
// pair instead) onto an occurrence, and that binding needs the camp's day and
// time-block catalogs. The exceptions builder does no such binding.
import { buildPreferenceLookup } from '../run/camperElectiveWeek.js'

export function buildRunSummaryExport({
  run,
  assignments = [],
  preferences = [],
  capacityRows = [],
  occurrences = [],
  days = [],
  timeBlocks = [],
} = {}) {
  const counts_by_rank = {}
  let unordered_count = 0
  const preferenceFor = buildPreferenceLookup({ preferences, occurrences, days, timeBlocks })
  const assignedCamperIds = new Set()
  for (const a of assignments) {
    assignedCamperIds.add(a.camper_id)
    if (a.preference_rank != null) {
      const rankKind = preferenceFor(a)?.rankKind ?? null
      if (rankKind === 'cell-choice' || rankKind === 'ordered-fallback') {
        counts_by_rank[a.preference_rank] = (counts_by_rank[a.preference_rank] ?? 0) + 1
      } else {
        unordered_count += 1
      }
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
    unordered_count,
    unassigned_count,
    fill_by_offering,
  }
}
