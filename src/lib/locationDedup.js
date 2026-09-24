import { lowestIdOf } from './nameIdTiebreak.js'

// Shared body of the LocationPicker "create new" flow, used by both
// ActivitiesScreen, AnchorsScreen and SpecialEventsScreen. See
// ActivitiesScreen.jsx's createLocation comment for the full
// case-insensitive-dedupe rationale
// (docs/adr/2026-08-15-locations-concurrent-create-collision.md option (d)).
//
// Deliberately does NOT touch React state — callers own their own
// `locations` state and do their own `setLocations`/`setSupportData` after
// this resolves.
//
// Case-insensitive dedupe against `existing` is a known accepted race
// (two devices/screens creating the same name concurrently can still both
// win) — not fixed here, unchanged from the pre-extraction behavior. What IS
// fixed (T255 finding 8): `existing` is the caller's own React state array,
// so its order can shift on a reload or a peer's insert. When more than one
// row matches, resolve to the lowest-id row deterministically, via the same
// tie-break every other name lookup in this codebase uses post-v73 — rather
// than "whichever happened to be first in this array right now".
export async function createLocationRecord({ repository, campId, name, existing }) {
  const trimmedName = String(name ?? '').trim()
  if (!trimmedName) return null
  const matches = existing.filter(l => String(l.name ?? '').trim().toLowerCase() === trimmedName.toLowerCase())
  const match = lowestIdOf(matches)
  if (match) return { location: match, created: false }
  const newId = crypto.randomUUID()
  const fields = { name: trimmedName, camp_id: campId, capacity: 1, notes: null }
  await repository.createRecord('locations', newId, fields)
  return { location: { id: newId, ...fields }, created: true }
}

export async function updateLocationCapacityRecord({ repository, locationId, capacity }) {
  await repository.writeFields('locations', locationId, { capacity })
}
