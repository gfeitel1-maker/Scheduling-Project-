import { normalizeName } from './preview.js'

// OQ3 answer memory, read from the camp's own current state
// (docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md,
// amendment 2026-10-11). A name an earlier import already classified is not
// asked about again, and must not be re-classified by a default:
//   - pinned_event marker row AND fixed events on file  -> already "fixed":
//     its events ship again and the marker is kept (the caller adds the name to
//     the pin-only set so buildPlan never clears it);
//   - a plain catalogue activity and NO events on file  -> already "activity":
//     it stays an activity, no question;
//   - anything else (a first import, or an inconsistent camp) stays ambiguous.
// Replace mode deletes those records, so the caller passes an empty camp then.
export function settleAmbiguousFromCamp(ambiguousEvents, { activities = [], fixedEvents = [] } = {}) {
  const roleByName = new Map(activities.map((a) => [normalizeName(a.name ?? ''), a.catalog_role ?? null]))
  const eventNames = new Set(fixedEvents.map((f) => normalizeName(f.name ?? '')))

  const stillAmbiguous = []
  const settledFixed = []
  const settledFixedNames = new Set()
  for (const fe of ambiguousEvents ?? []) {
    const key = normalizeName(fe.name)
    if (!roleByName.has(key)) { stillAmbiguous.push(fe); continue }
    const hasEvents = eventNames.has(key)
    if (roleByName.get(key) === 'pinned_event' && hasEvents) {
      settledFixed.push(fe)
      settledFixedNames.add(fe.name)
    } else if (roleByName.get(key) !== 'pinned_event' && !hasEvents) {
      // settled as an activity: dropped, not asked
    } else {
      stillAmbiguous.push(fe)
    }
  }
  return { stillAmbiguous, settledFixed, settledFixedNames: [...settledFixedNames] }
}
