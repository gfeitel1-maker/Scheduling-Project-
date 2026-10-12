// Electives consumer for parseGridSchedule's output — Consumer 2 of
// docs/adr/2026-08-22-event-schedule-import.md §8. An elective set is a FLAT
// membership list, not a 2D grid, so only cells[].activityName is read;
// timeIndex/groupIndex/locationName are ignored.
//
// Pure logic against a `repo` shim — no localClient/IPC import here, so it
// can be unit tested against a mock repo, mirroring eventGridPopulate.js.
// The real ElectivesScreen.jsx wires a repo backed by setupCrudRepository.

import { createActivity } from '../screens/schedule/createActivityHelper.js'
import { markElectivePermissionTier } from './electivePermissionTier.js'

// Content-keyed on the RESOLVED activity (not source position, unlike
// deriveEventImportId) — a flat set has no meaningful cell position, and
// keying on the activity id makes a re-import of the same file (or a
// different file naming the same activities) converge on the same row
// instead of minting a duplicate offering, per ADR §8.
export function deriveElectiveImportId(electiveSetId, activityId) {
  return `elective-import:${electiveSetId}:${activityId}`
}

const NOTHING_TO_IMPORT_MESSAGE =
  "No schedule could be read out of that. It may be a scan rather than a document with text in it."

/**
 * Map a parseGridSchedule result onto this elective set's flat offering list.
 *
 * Returns `{ ok: true }` on success (all writes made through `repo`), or
 * `{ ok: false, reason }` when there is nothing to import (ADR §8) — writing
 * nothing in that case. There is no longer a nonempty-set refusal (T195):
 * import is a per-activity POTENTIAL-ONLY upsert —
 *   - no existing row for this (set, activity) pair -> write status: 'potential'
 *   - existing row status 'potential' -> rewrite the same fields (idempotent)
 *   - existing row status 'confirmed' -> SKIP ENTIRELY, touch no field. This
 *     is the load-bearing safety property: import can never regress a
 *     director's confirmed decision, and there is no promotion logic to get
 *     wrong because import never promotes.
 * An activity that fell off a later sheet is left alone — no auto-delete, no
 * auto-demote (owner ruling pending; this is a named limitation, not an
 * oversight).
 *
 * A mid-write IO failure is NOT covered by the "nothing on failure"
 * guarantee above: it throws with some writes already made, and the caller
 * is responsible for reloading. Retrying is safe even so — every write is
 * content-keyed and a confirmed row is structurally unreachable.
 */
export async function populateElectiveSet(parsed, { electiveSetId, campId, repo, existingActivities, existingOfferings }) {
  const distinctNames = [...new Set((parsed?.cells ?? []).map((c) => c.activityName).filter((name) => String(name ?? '').trim()))]
  if (distinctNames.length === 0) {
    return { ok: false, reason: NOTHING_TO_IMPORT_MESSAGE }
  }

  const activities = [...(existingActivities ?? [])]
  const offeringByActivityId = new Map((existingOfferings ?? []).map((o) => [o.activity_id, o]))
  // The activity ids this sheet actually names, resolved below. Used after the
  // loop to find offerings that fell off the sheet (T195).
  const sheetActivityIds = new Set()

  for (const name of distinctNames) {
    const { activityId, activity, isNew } = await createActivity(
      { name, campId, activities },
      { writeActivityFields: repo.writeActivityFields }
    )
    if (isNew) activities.push(activity)
    sheetActivityIds.add(activityId)

    if (offeringByActivityId.get(activityId)?.status === 'confirmed') continue

    const id = deriveElectiveImportId(electiveSetId, activityId)
    await repo.writeFields('elective_set_activities', id, {
      elective_set_id: electiveSetId,
      activity_id: activityId,
      // v66 (T194, ADR D3): an imported offering has no declared cap. Written
      // explicitly rather than left to the column DEFAULT, because a projection
      // write is a field-by-field UPDATE and the default only applies to the
      // ensureExists INSERT. Same meaning as the v39 `camper_headcount: null`
      // this replaces — that column is now retired from the write path.
      capacity_mode: 'unlimited',
      capacity_limit: null,
      // v68 (T195): the importer is the only writer that ever says
      // 'potential' — never 'confirmed'. Confirmation is director-driven.
      status: 'potential',
    })
    await markElectivePermissionTier(repo, activityId, activity.recurrence_truth_status)
  }

  // T195 — the "no longer on the sheet" marker. An offering THIS importer
  // previously wrote (a 'potential', import-id-keyed row) whose activity is
  // absent from the sheet just imported is REPORTED to the caller, never
  // silently left in place. Deliberately narrow, by design and owner posture:
  //   - import-id-keyed only (`id === deriveElectiveImportId(...)`) — a
  //     director-created offering is not a leftover of any sheet, so it is not
  //     "missed"; reporting it would be noise.
  //   - status 'potential' only — a 'confirmed' offering is a director decision
  //     (and is already skipped above), not a silent leftover.
  // It is REPORT-ONLY: nothing here deletes or demotes the row. Auto-removal on
  // re-import is a separate owner ruling that has not been made.
  const nameByActivityId = new Map(activities.map((a) => [a.id, a.name]))
  const vanishedOfferings = (existingOfferings ?? [])
    .filter((o) =>
      o.status === 'potential' &&
      !sheetActivityIds.has(o.activity_id) &&
      o.id === deriveElectiveImportId(electiveSetId, o.activity_id)
    )
    .map((o) => ({ activity_id: o.activity_id, name: nameByActivityId.get(o.activity_id) ?? null, status: o.status }))

  // `activities` (the resolved+newly-created list) is returned so a caller
  // importing several sets can thread it through successive calls.
  return { ok: true, activities, vanishedOfferings }
}

