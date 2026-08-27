// Sunday-first weekday names. Previously duplicated in DaysScreen, ActivitiesScreen,
// and AnchorsScreen — day_of_week is an engine-facing 0..6 index (see buildSchedule.js).
export const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// Defense-in-depth: malformed JSON in an id-list column (e.g. a corrupted/tampered
// op) must not crash a list render — default to [].
export function parseIdList(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// operations.value only accepts strings/null/number (better-sqlite3 throws on a raw
// boolean/array) — every write pre-serializes through this. Each screen supplies its
// own bool/array field sets, so the serializer is a factory, not a shared constant.
export function makeSerializeFieldValue(boolFields, arrayFields) {
  return function serializeFieldValue(field, value) {
    if (boolFields.has(field)) return value ? 1 : 0
    if (arrayFields.has(field)) return JSON.stringify(value ?? [])
    return value ?? null
  }
}
