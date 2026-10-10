// What this import will create counts toward "is the camp set up", beside what
// the db already holds. Without this the Review step lists Age Divisions,
// Groups, Days, Time Blocks and Activities as "Still to set up" for a file
// that contains every one of them.
//
// Maps readiness.js's collection keys to the import's `approved` entities.
// Placeholder rows only make the collection non-empty; nothing reads them.
const APPROVED_FOR = {
  tiers: 'tiers',
  groups: 'groups',
  days: 'days_of_operation',
  timeBlocks: 'time_blocks',
  activities: 'activities',
}

export function withImportOwnRecords(collections, baseInputs) {
  const approved = baseInputs?.approved ?? {}
  const merged = { ...collections }
  for (const [key, entity] of Object.entries(APPROVED_FOR)) {
    const own = Array.isArray(approved[entity]) ? approved[entity] : []
    if (own.length > 0) merged[key] = [...(merged[key] ?? []), ...own.map((name) => ({ imported: name }))]
  }
  const ownEvents = Array.isArray(baseInputs?.fixedEvents) ? baseInputs.fixedEvents : []
  if (ownEvents.length > 0) {
    merged.recurringevents = [...(merged.recurringevents ?? []), ...ownEvents.map((e) => ({ imported: e.name }))]
  }
  return merged
}
