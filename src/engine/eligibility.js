// T82 (F2) — the tier/group eligibility predicate, previously hand-duplicated
// at ScheduleScreen.jsx's eligibleActivitiesFor and useSlotMutations.js's
// placeActivityManual UNFILLABLE check. One copy so the typeahead and the
// UNFILLABLE flag can never diverge.
//
// Contract: no eligibility lists (both empty/falsy) means unrestricted —
// eligible for every group. Otherwise eligible iff the group's tier_id is in
// eligible_tier_ids OR the group's id is in eligible_group_ids.
export function isActivityEligibleForGroup(activity, group) {
  const tierIds = activity.eligible_tier_ids || []
  const groupIds = activity.eligible_group_ids || []
  if (tierIds.length === 0 && groupIds.length === 0) return true
  if (tierIds.includes(group?.tier_id)) return true
  if (groupIds.includes(group?.id)) return true
  return false
}
