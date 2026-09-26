// T197 (docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-choice-export.md §4) —
// exceptions export. Pure renderer utility, no IPC: every category here is computed from data the
// Draft/Final screens already load.
//
// unassigned/unranked/unresolved/stale/capacity are fully discharged from existing data.
//
// eligibility and resource are DELIBERATELY EMPTY buckets. No existing computed, persisted source
// was found for either during design: buildElectiveAssignments.js's UNSUPPORTED_LINKED_CHOICE
// findings and findRouteConflicts' OUTER_RESOURCE_CONFLICT findings are both produced only at
// generation/finalize TIME and are never persisted for a later export read to recover. Per the
// Governor's ruling (T197 dispatch), do not invent a detector for either — surface the named,
// empty bucket and let a product/data-model decision (a persisted findings table, or re-running
// the detector against current data) supply real rows later.
export function buildRunExceptionsExport({
  campers = [],
  preferences = [],
  assignments = [],
  occurrences = [],
  staleCount = 0,
  capacityRows = [],
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
    eligibility: [],
    resource: [],
    // F7 (round 2): eligibility/resource are empty for a DIFFERENT reason than the other buckets —
    // no detector exists, not "checked and found none." An empty array is shape-identical to a
    // real computed-zero result, so a consumer reading this document has no way to tell the two
    // apart without opening this file's source. Naming the gap here, in the contract itself,
    // closes it.
    not_computed: ['eligibility', 'resource'],
  }
}
