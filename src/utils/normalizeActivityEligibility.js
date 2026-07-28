// The shared read boundary for `activities` rows coming back from
// localClient.list(), which returns raw `SELECT *` output with no coercion
// (electron/main.js). eligible_tier_ids / eligible_group_ids are stored as
// JSON-stringified arrays (NULL means "no restriction"), never real arrays —
// same class of bug as the is_anchor/is_span_head INTEGER columns fixed in
// normalizeSlots.js. Every consumer that reads eligibility off an activity
// row must go through this first, or `'[]'` (a 2-char truthy string) reads
// as "restricted to nothing" instead of "no restrictions".
//
// Extracted from ActivitiesScreen.jsx's original parseIdList/normalizeActivity
// (T6) so ScheduleScreen's manual-placement eligibility check — which read
// activities raw and inherited the bug — can share the same parse instead of
// duplicating it. Deliberately narrower than ActivitiesScreen's version: this
// only touches the two ID-list fields. ScheduleScreen reads
// `activity.max_per_week`/`max_groups_per_slot` with `!= null` checks where
// null intentionally means "no cap" (placeActivityManual's atMax/
// locationFull) — defaulting those here the way the modal-facing version
// does would silently change that behavior for any row with a null cap.

export function parseIdList(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function normalizeActivityEligibility(row) {
  return {
    ...row,
    eligible_tier_ids: parseIdList(row.eligible_tier_ids),
    eligible_group_ids: parseIdList(row.eligible_group_ids),
  }
}
