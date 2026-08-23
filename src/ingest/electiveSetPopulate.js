// Electives consumer for parseGridSchedule's output — Consumer 2 of
// docs/adr/2026-08-22-event-schedule-import.md §8. An elective set is a FLAT
// membership list, not a 2D grid, so only cells[].activityName is read;
// timeIndex/groupIndex/locationName are ignored.
//
// Pure logic against a `repo` shim — no localClient/IPC import here, so it
// can be unit tested against a mock repo, mirroring eventGridPopulate.js.
// The real ElectivesScreen.jsx wires a repo backed by setupCrudRepository.

import { createActivity } from '../screens/schedule/createActivityHelper.js'

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
const NONEMPTY_MESSAGE =
  'This elective set already has offerings. Clear it first if you want to replace it with an import, or add to it by hand.'

/**
 * Map a parseGridSchedule result onto this elective set's flat offering list.
 *
 * Returns `{ ok: true }` on success (all writes made through `repo`), or
 * `{ ok: false, reason }` on REFUSAL — nonempty set, or nothing to import
 * (ADR §6/§8) — writing nothing in that case. A mid-write IO failure is NOT
 * covered by that guarantee: it throws with some writes already made, and
 * the caller is responsible for reloading so the nonempty-refuse gate above
 * blocks a naive retry from re-minting duplicate catalog activities.
 */
export async function populateElectiveSet(parsed, { electiveSetId, campId, repo, existingActivities, existingOfferings }) {
  if ((existingOfferings ?? []).length > 0) {
    return { ok: false, reason: NONEMPTY_MESSAGE }
  }

  const distinctNames = [...new Set((parsed?.cells ?? []).map((c) => c.activityName).filter((name) => String(name ?? '').trim()))]
  if (distinctNames.length === 0) {
    return { ok: false, reason: NOTHING_TO_IMPORT_MESSAGE }
  }

  const activities = [...(existingActivities ?? [])]

  for (const name of distinctNames) {
    const { activityId, activity, isNew } = await createActivity(
      { name, campId, activities },
      { writeActivityFields: repo.writeActivityFields }
    )
    if (isNew) activities.push(activity)

    const id = deriveElectiveImportId(electiveSetId, activityId)
    await repo.writeFields('elective_set_activities', id, {
      elective_set_id: electiveSetId,
      activity_id: activityId,
      camper_headcount: null,
    })
  }

  return { ok: true }
}
