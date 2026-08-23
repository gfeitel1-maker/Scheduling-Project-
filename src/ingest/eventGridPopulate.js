// Events consumer for parseGridSchedule's output — Consumer 1 of
// docs/adr/2026-08-22-event-schedule-import.md. Maps a normalized grid parse
// onto event_time_blocks/event_groups/event_slots.
//
// Pure logic against a `repo` shim — no localClient/IPC import here, so it
// can be unit tested against a mock repo (spec Step 3). The real
// EventGridEditor.jsx wires a repo backed by writeField/localClient.

import { recognitionKey, normalizeName } from './preview.js'
import { createActivity } from '../screens/schedule/createActivityHelper.js'

// Mirrors EventGridEditor.jsx's deriveEventSeedId string-template shape
// (itself modeled on electron/ops/locationId.js's deriveLocationId, INV-1) —
// different literal prefix ("event-import:" vs "event-seed:") so the two id
// spaces can never collide for any plausible input.
export function deriveEventImportId(eventId, axis, sourceSignature) {
  return `event-import:${eventId}:${axis}:${sourceSignature}`
}

const NOT_CONFIDENT_MESSAGE =
  "Couldn't tell which side of this file is the schedule's times. Check that the file has a clear time column or time row, and try again."
const NONEMPTY_MESSAGE =
  "This event's schedule already has entries. Clear it first if you want to replace it with an import, or add to it by hand."

/**
 * Map a parseGridSchedule result onto this event's three tables.
 *
 * Returns `{ ok: true, unmapped }` on success (all mappable writes made
 * through `repo`), or `{ ok: false, reason }` on REFUSAL — not-confident
 * orientation or a nonempty container (ADR §5/§6) — writing nothing in
 * that case. A mid-write IO failure (e.g. `repo.writeField` rejects) is
 * NOT covered by that guarantee: it throws with some writes already made,
 * and the caller (EventGridEditor.jsx's `runImport`) is responsible for
 * reloading so the partial state is visible and the refuse-on-nonempty
 * gate above blocks a naive retry from re-minting duplicate activities.
 * Activities are resolved/created in one pass before any event_slots row
 * is written, narrowing (not eliminating) that partial-write window.
 */
export async function populateEventGrid(parsed, { eventId, campId, existingLocations, existingActivities, existingEventSlots }, repo) {
  if (!parsed || parsed.orientation?.confident !== true) {
    return { ok: false, reason: NOT_CONFIDENT_MESSAGE }
  }
  const hasPlacedActivity = (existingEventSlots ?? []).some((s) => s.activity_id)
  if (hasPlacedActivity) {
    return { ok: false, reason: NONEMPTY_MESSAGE }
  }

  const activities = [...(existingActivities ?? [])]

  for (const t of parsed.timeAxis) {
    const id = deriveEventImportId(eventId, 'block', t.sourceIndex)
    await repo.writeField('event_time_blocks', id, 'event_id', eventId)
    await repo.writeField('event_time_blocks', id, 'name', t.name)
    await repo.writeField('event_time_blocks', id, 'sort_order', t.sourceIndex)
    if (t.start_time) await repo.writeField('event_time_blocks', id, 'start_time', t.start_time)
    if (t.end_time) await repo.writeField('event_time_blocks', id, 'end_time', t.end_time)
  }

  for (const g of parsed.groupAxis) {
    const id = deriveEventImportId(eventId, 'group', g.sourceIndex)
    await repo.writeField('event_groups', id, 'event_id', eventId)
    await repo.writeField('event_groups', id, 'name', g.name)
    await repo.writeField('event_groups', id, 'sort_order', g.sourceIndex)
  }

  const locationsByKey = new Map((existingLocations ?? []).map((l) => [recognitionKey('locations', l.name), l]))
  const unmapped = [...parsed.unmapped]

  // Pass 1: resolve/create every DISTINCT cell activity first, before any
  // event_slots row is written — reduces the window in which a mid-import
  // IO failure could leave slots referencing an activity that never got
  // written, and keeps the mint count at "one per distinct name" rather
  // than depending on write order (Red Hat #1).
  const activityIdByName = new Map()
  for (const cell of parsed.cells) {
    const nameKey = normalizeName(cell.activityName)
    if (activityIdByName.has(nameKey)) continue
    const { activityId, activity, isNew } = await createActivity(
      { name: cell.activityName, campId, activities },
      { writeActivityFields: repo.writeActivityFields }
    )
    if (isNew) activities.push(activity)
    activityIdByName.set(nameKey, activityId)
  }

  // Pass 2: write the slots, referencing activities resolved above.
  for (const cell of parsed.cells) {
    const activityId = activityIdByName.get(normalizeName(cell.activityName))

    let locationId = null
    if (cell.locationName) {
      const match = locationsByKey.get(recognitionKey('locations', cell.locationName))
      if (match) locationId = match.id
      else unmapped.push({ sourceExcerpt: cell.locationName, reason: 'no matching location for this cell' })
    }

    const id = deriveEventImportId(eventId, 'slot', `${cell.timeIndex}:${cell.groupIndex}`)
    await repo.writeField('event_slots', id, 'event_id', eventId)
    await repo.writeField('event_slots', id, 'event_group_id', deriveEventImportId(eventId, 'group', cell.groupIndex))
    await repo.writeField('event_slots', id, 'time_block_id', deriveEventImportId(eventId, 'block', cell.timeIndex))
    await repo.writeField('event_slots', id, 'activity_id', activityId)
    if (locationId) await repo.writeField('event_slots', id, 'location_id', locationId)
  }

  return { ok: true, unmapped }
}
