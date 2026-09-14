// T147 — locations from a schedule: bind on IDENTITY, never infer MEANING.
//
// PURE. No database, no I/O — this proposes, the director confirms.
//
// WHY THE LINE IS DRAWN HERE (owner decision, 2026-09-13)
//
// A location is not a caption on a cell. `buildSchedule.js`'s `placeUsage` caps
// who can be in a place in a given block, so a location is an input to what the
// engine will and will not schedule. A wrongly-guessed one silently refuses a
// pairing that would have been fine, or admits two groups into a room that holds
// one — and the director sees an ordinary-looking schedule that an assignment
// they never made has quietly reshaped.
//
// So the question is not "how often would a guess be right?" but "what does a
// wrong guess cost, and would anyone catch it?" Here, wrong is invisible.
//
// The owner's camp is the evidence in both directions:
//
//   "virtual sports is in the room with that name, same for art, same for clay"
//       -> the name IS the place. Bind it, on identity, with confirmation.
//
//   "slingshots is at the archery range, not the slingshot range"
//       -> the name LIES. And the wrong answer is PLAUSIBLE — "Slingshots ->
//          Slingshot Range" reads fine in a review list and gets skimmed past.
//
//   "sports is usually outside on the field but could be in the gym"
//       -> genuinely variable. There is no answer to ask anyone to confirm.
//
// Hence: exact-name identity only. No stemming, no prefix, no "Art" -> "Art
// Room". Two similar strings are not one fact.

import { whitespaceInsensitiveName } from './preview.js'

const key = (s) => whitespaceInsensitiveName(String(s ?? ''))

/**
 * @param {string[]} activityNames        as the import proposes them
 * @param {Array<{id, name}>} locations   the camp's LIVE places
 * @param {{alreadyPlaced?: string[]}} [opts]  activities the FILE itself placed
 * @returns {{bindings: Array<{activityName, locationId, locationName}>, ambiguous: string[]}}
 */
export function matchActivitiesToLocations(activityNames, locations, opts) {
  const names = (Array.isArray(activityNames) ? activityNames : [])
    .map((n) => String(n ?? '').trim()).filter(Boolean)
  const places = Array.isArray(locations) ? locations : []
  // A place the FILE named for this activity is a stated fact and always wins;
  // a binding is only ever proposed for an activity the file left unplaced.
  const placed = new Set((opts?.alreadyPlaced ?? []).map(key))

  // Duplicate names collected rather than resolved by array order — "you have
  // two places called this" and "you have none" need different fixes, and a
  // last-write-wins Map would silently pick one (the collision T40 hit).
  const byName = new Map()
  const duplicated = new Set()
  for (const p of places) {
    const k = key(p.name)
    if (!k) continue
    if (byName.has(k)) duplicated.add(k)
    else byName.set(k, p)
  }

  const bindings = []
  const ambiguous = []
  for (const activityName of names) {
    const k = key(activityName)
    if (placed.has(k)) continue
    if (duplicated.has(k)) { ambiguous.push(activityName); continue }
    const place = byName.get(k)
    if (!place) continue
    bindings.push({ activityName, locationId: place.id, locationName: place.name })
  }
  return { bindings, ambiguous }
}

/**
 * Activity names the camp has no place for yet, offered as POSSIBLE places.
 *
 * This binds nothing. It is typing saved for a camp with forty rooms to enter,
 * and the asymmetry is the whole justification: a place ticked and never used
 * costs nothing, while a binding asserted wrongly costs a distorted schedule.
 * That is why "Slingshots" may appear here — as a name someone might have a
 * place for — while never being bound to "Slingshot Range".
 *
 * @returns {string[]} in the camp's own order, de-duplicated
 */
export function candidatePlaceNames(activityNames, locations) {
  const existing = new Set((Array.isArray(locations) ? locations : []).map((p) => key(p?.name)))
  const seen = new Set()
  const out = []
  for (const raw of Array.isArray(activityNames) ? activityNames : []) {
    const name = String(raw ?? '').trim()
    if (!name) continue
    const k = key(name)
    if (!k || existing.has(k) || seen.has(k)) continue
    seen.add(k)
    out.push(name)
  }
  return out
}
