// Sunday-first weekday names. Previously duplicated in DaysScreen, ActivitiesScreen,
// and FixedEventsScreen — day_of_week is an engine-facing 0..6 index (see buildSchedule.js).
export const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const DOW_ABBR = DOW.map((d) => d.slice(0, 3).toLowerCase())

// Board item q-export-columns-do-not-round-trip (item 7), slice B2b derive-or-name —
// a file with no day_of_week column (or a blank cell) still carries a recognizable
// weekday NAME in the label ("Monday"/"Mon", case-insensitive); this recovers the
// 0..6 index from it rather than making the director re-type a column. Returns
// null when the label is not a weekday name, which DaysScreen treats as
// needing a director's eye rather than a guess.
export function weekdayFromLabel(label) {
  const folded = String(label ?? '').trim().toLowerCase()
  if (folded === '') return null
  const full = DOW.findIndex((d) => d.toLowerCase() === folded)
  if (full !== -1) return full
  return DOW_ABBR.indexOf(folded) === -1 ? null : DOW_ABBR.indexOf(folded)
}

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

// Time Blocks derive sort_order from start_time so directors never type an
// order number and blocks always sort chronologically regardless of entry
// order — see docs/work/plans/2026-08-27-retire-sort-order-input.md.
export function minutesFromMidnight(hhmm) {
  if (typeof hhmm !== 'string') return 0
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!match) return 0
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return 0
  return hours * 60 + minutes
}
