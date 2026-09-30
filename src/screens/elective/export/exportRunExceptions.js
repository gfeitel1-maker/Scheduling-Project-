// T197 (docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-choice-export.md §4) —
// exceptions export. Pure renderer utility, no IPC: every category here is computed from data the
// Draft/Final screens already load.
//
// unassigned/unranked/unresolved/stale/capacity are fully discharged from existing data.
//
// T320 (docs/adr/2026-09-30-elective-run-durability.md item 4) — eligibility and resource are no
// longer deliberately-empty placeholders. eligibilityFindings is read from the persisted
// elective_run_findings table (electron/ops/getElectiveRun.js); resourceConflicts is computed
// LIVE for a draft run and is provably [] for a final run (the finalize gate already refused any
// run that would have had one) — both are threaded in by the caller, never re-derived here.
export function buildRunExceptionsExport({
  campers = [],
  preferences = [],
  assignments = [],
  occurrences = [],
  staleCount = 0,
  capacityRows = [],
  eligibilityFindings = [],
  resourceConflicts = [],
} = {}) {
  const preferenceCamperIds = new Set(preferences.map((p) => p.camper_id))
  const assignedCamperIds = new Set(assignments.map((a) => a.camper_id))
  const assignedOccurrenceIds = new Set(assignments.map((a) => a.occurrence_id))

  const unassigned = campers
    .filter((c) => preferenceCamperIds.has(c.id) && !assignedCamperIds.has(c.id))
    .map((c) => ({ camper_id: c.id, camper_name: c.display_name }))

  const unranked = campers
    .filter((c) => !preferenceCamperIds.has(c.id))
    .map((c) => ({ camper_id: c.id, camper_name: c.display_name }))

  const unresolved = occurrences
    .filter((o) => !assignedOccurrenceIds.has(o.id))
    .map((o) => ({ occurrence_id: o.id }))

  const capacity = capacityRows
    .filter((c) => c.capacity != null && c.filled > c.capacity)
    .map((c) => ({ occurrence_id: c.occurrenceId, activity_id: c.activityId, filled: c.filled, capacity: c.capacity }))

  return {
    unassigned,
    unranked,
    unresolved,
    stale: staleCount,
    capacity,
    eligibility: eligibilityFindings.map((f) => ({
      kind: f.kind, camper_id: f.camper_id ?? null, choice_id: f.choice_id ?? null,
      occurrence_id: f.occurrence_id ?? null, message: f.message,
    })),
    resource: resourceConflicts,
    // T320 — both categories are now discharged (computed, not merely
    // "checked and found none" — an eligibility bucket genuinely empty
    // because the persisted table has no rows for this generation reads
    // identically to one where the caller forgot to pass eligibilityFindings,
    // and that ambiguity is accepted the same way every OTHER category's
    // empty array already is).
    not_computed: [],
  }
}
