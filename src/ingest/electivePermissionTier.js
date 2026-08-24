// Electives are Permission-tier "by construction" (ADR
// 2026-08-23-activity-recurrence-tiers-ingestion.md §4.1, truthStatus.js's
// isElective precedence). The commitIngest create-only classifier
// deliberately does NOT write 'permission' — elective membership lives in
// elective_set_activities, populated by a separate path — so each of that
// path's two writers (import: electiveSetPopulate.js; manual add:
// ElectiveSetDetail.jsx) calls this right after creating the membership row.
//
// NON-DESTRUCTIVE by design: we only stamp 'permission' when the activity has
// NO prior truth-status (null/undefined). If it already carries 'asserted' or
// 'obligation' — e.g. "Swim" is a fixed daily block AND reused as an elective,
// a routine name-collision under createActivity's normalized-name dedup — we
// LEAVE it. The ADR (2026-08-23-activity-recurrence-tiers-ingestion.md §1.1)
// says these truths coexist PER OCCURRENCE-PATTERN, not per activity; the
// schema's single recurrence_truth_status column can't yet hold both, and the
// two-rows-sharing-a-name split (OQ1, owner priority #5) is what will model the
// coexistence properly. Until then, overwriting would be a one-way,
// information-destroying ratchet on a synced column with no clear-on-removal
// path — so this writer never destroys an existing Asserted/Obligation truth.
// A pure elective (no other pattern) correctly gets 'permission'.
//
// Idempotent: the null-guard also skips when the value is already 'permission',
// mirroring the classifier-writer's seed-guard posture so a re-import or re-add
// doesn't churn the op-log.
//
// Human-protection (a director hand-setting recurrence_truth_status) is
// deferred — no UI drives that column today (see electron/ops/ingest.js's
// classifier comment), so there is nothing to protect against yet. When one
// ships, this call site needs the same latestOp human-source check the
// classifier uses.
export async function markElectivePermissionTier(repo, activityId, currentStatus) {
  // Only a blank truth-status is claimable. An existing asserted/obligation
  // (or permission) is left untouched — see the block comment above.
  if (currentStatus !== null && currentStatus !== undefined) return
  await repo.writeFields('activities', activityId, { recurrence_truth_status: 'permission' })
}
