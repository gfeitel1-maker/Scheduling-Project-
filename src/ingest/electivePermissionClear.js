// Symmetric counterpart to electivePermissionTier.js (owner priority #4,
// "reclassify — clear-on-removal"). That writer stamps 'permission' ONLY on
// a blank truth-status when an activity is added to an elective set; this
// one reverses it — but ONLY the value the elective path itself set.
//
// NON-DESTRUCTIVE by the same posture: we only ever clear a value that is
// currently exactly 'permission'. An 'asserted' or 'obligation' truth was
// never written by the elective path (electivePermissionTier.js never
// overwrites those), so this writer must never touch them either — if it
// no longer belongs to any elective set, that activity's Asserted/Obligation
// truth stands on its own and is none of this path's business.
//
// 'permission' means "this activity is a refusable elective offering."
// Removing the last elective_set_activities row for that activity means
// that truth no longer holds anywhere → revert to null (unknown/
// unclassified). If it still belongs to another set, the truth still holds
// → leave it.
//
// Re-import is explicitly OUT of scope here: populateElectiveSet is
// create-only and never removes memberships, so there is nothing to
// reclassify on re-import (see the classifier's create-only posture,
// #3/#163). This helper only fires on explicit UI removal.
export async function clearElectivePermissionOnRemoval({
  repo,
  allMemberships,
  removedMembershipIds,
  activityId,
  currentStatus,
}) {
  if (currentStatus !== 'permission') return

  const removed = new Set(removedMembershipIds)
  // Computed from the pre-delete membership list minus the removed ids —
  // never re-listed post-delete, to avoid a read-after-write race against
  // the op-log replay (this repo has been bitten by that staleness before).
  const remaining = allMemberships.filter((m) => m.activity_id === activityId && !removed.has(m.id))
  if (remaining.length > 0) return

  await repo.writeFields('activities', activityId, { recurrence_truth_status: null })
}
