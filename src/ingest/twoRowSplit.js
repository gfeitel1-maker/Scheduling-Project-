// Slice 1 of docs/adr/2026-08-23-two-rows-multipattern-split.md (owner priority
// #5, OQ1 implementation). Pure split-emit logic: given a director-ACCEPTED
// decision to split one dual-use activity into a pinned row + a flexible row,
// write both `activities` rows with correct truth-status. No UI here — the
// off-by-default suggestion surface and decline-memory are Slice 2; accept/
// ignore instrumentation is Slice 3. This function is callable but not yet
// wired into the ImportScreen review flow.
//
// Load-bearing constraint (see the ADR): `activities` has UNIQUE(camp_id,
// name) both on fresh installs (schema.sql) and migrated dbs
// (idx_activities_camp_name) — two rows cannot share a stored name. So the
// EXISTING row keeps its bare name; a NEW row is minted with a distinct
// suffixed name (OD-2: auto "(rec)", director-editable). No schema/migration
// change — the split lives entirely in the existing activities table.
import { createActivity } from '../screens/schedule/createActivityHelper.js'
// Same normalizer createActivity's dedup uses (createActivityHelper.js:38) — the
// degenerate/collision guards below must reason about names identically to the
// dedup they are guarding, or they would disagree at the margins.
import { normalizeName } from './preview.js'

export const DEFAULT_SPLIT_SUFFIX = ' (rec)'

// Provenance: this function writes through `repo.writeFields`/
// `writeActivityFields` — the same generic renderer write path every setup
// screen uses. That path never stamps `source: 'import'` (only the ingest.js
// commit pipeline does, for items it is actively importing); an op with no
// source reads as `source == null`, which `tierForField`
// (src/utils/ruleProvenance.js) treats as director-confirmed. So a split
// applied through this function is durably human-confirmed with no separate
// `_humanFields`/`import_evidence` stamp required — there is no ingest.js
// item-processing pass in this call path to protect against. This mirrors
// electivePermissionTier.js and electiveSetPopulate.js, which use the same
// repo.writeFields path for the same reason.
//
// Non-destruction is asymmetric by design, unlike markElectivePermissionTier/
// markElectivePermissionClear (which only ever touch a blank or exactly
// 'permission' value): a split is a director-CONFIRMED action, not a passive
// importer inference, so setting the existing row to 'asserted' is
// intentional even if it already carries a different status. It is still
// idempotent — re-running with an already-'asserted' row writes nothing, so a
// re-run (e.g. a re-import re-suggesting a previously-accepted split) doesn't
// churn the op-log.
//
// existingActivity: the row this split acts on ({ id, name, camp_id,
// recurrence_truth_status }).
// existingActivities: the caller's current activities list, used for
// createActivity's normalized-name dedup — passing the up-to-date list
// (including a previously-created suffixed row) is what makes a re-run
// idempotent; see guard 2 below.
// suffix: OD-2's director-editable suffix, defaults to " (rec)".
// newRowStatus: the truth-status the NEW row should carry — 'obligation' for
// a frequency-rule flexible pattern, null/undefined to leave it blank for the
// classifier (an elective flexible pattern: markElectivePermissionTier stamps
// 'permission' later, when the elective membership is created — this
// function must not race that write by pre-stamping a status here).
// The recurrence ratchet, owned by the ingest seam. Pins an activity row as
// director-asserted. Idempotent: already-'asserted' writes nothing, so a
// re-run (a re-import re-suggesting a previously-accepted split, or a
// re-confirmed collision reuse) doesn't churn the op-log. Deliberately
// non-destructive-asymmetric — it overwrites a DIFFERENT existing status
// because a split/reuse is a director-CONFIRMED action, not a passive
// importer inference (see the module note above).
//
// Both split paths go through here: emitTwoRowSplit's step 1, and
// ImportScreen's collision-"reuse" branch, which pins the existing row without
// minting a counterpart. The screen layer must not decide truth-status itself.
export async function pinActivityAsserted({ repo, existingActivity }) {
  if (existingActivity.recurrence_truth_status === 'asserted') return
  await repo.writeFields('activities', existingActivity.id, { recurrence_truth_status: 'asserted' })
}

export async function emitTwoRowSplit({ repo, existingActivity, existingActivities, suffix = DEFAULT_SPLIT_SUFFIX, newRowStatus }) {
  const activities = existingActivities ?? []
  const newName = `${existingActivity.name}${suffix}`

  // Guard 1 (degenerate split) — validated BEFORE any write, so a rejected
  // split mutates nothing. OD-2 makes the suffix director-editable; an empty or
  // whitespace-only suffix makes `newName` normalize to the existing row's own
  // name. createActivity's dedup would then short-circuit to the existing row
  // itself (NOT an INSERT — no error is raised), returning a fake "split" of a
  // row with itself while the 'asserted' write below still lands. That is
  // silent corruption, so we reject it here and write nothing. Slice 2 blocks
  // the confirm on this outcome. (Red Hat HIGH, 2026-08-23.)
  if (normalizeName(newName) === normalizeName(existingActivity.name)) {
    return { outcome: 'degenerate', existingActivityId: existingActivity.id, newActivityId: null, newActivityName: newName, created: false }
  }

  // Guard 2 (unrelated-name collision vs. idempotent re-run) — also decided
  // BEFORE any write. If an activity already normalizes to `newName`, name
  // alone cannot tell "my own previously-minted split counterpart" (safe reuse)
  // from "an unrelated activity the director independently named 'Swim (rec)'"
  // (attaching flexible-pattern data to it in Slice 2/3 would corrupt it). We
  // surface this as an explicit 'collision' outcome and write NOTHING — Slice 2
  // asks the director to reuse, rename, or cancel. There is no back-link column
  // to disambiguate by (would need schema); a human decides. (Red Hat MED-HIGH.)
  const collidingRow = activities.find((a) => normalizeName(a.name) === normalizeName(newName))
  if (collidingRow) {
    return { outcome: 'collision', existingActivityId: existingActivity.id, newActivityId: collidingRow.id, newActivityName: newName, created: false }
  }

  // Only now, with a clean distinct name confirmed, do we mutate.
  await pinActivityAsserted({ repo, existingActivity })

  const { activityId } = await createActivity(
    { name: newName, campId: existingActivity.camp_id, activities },
    { writeActivityFields: repo.writeActivityFields }
  )
  if (newRowStatus) {
    await repo.writeFields('activities', activityId, { recurrence_truth_status: newRowStatus })
  }

  return {
    outcome: 'split',
    existingActivityId: existingActivity.id,
    newActivityId: activityId,
    newActivityName: newName,
    created: true,
  }
}
