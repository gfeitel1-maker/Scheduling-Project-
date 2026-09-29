// How a preference's (day, period) COORDINATE — written as the child wrote it —
// is matched against a camp's own day and time-block names. ONE rule, two
// callers, deliberately.
//
// The callers are solve-time binding (src/screens/elective/assignment/
// resolvePreferenceCoordinates.js, which turns a coordinate into an
// occurrence_id) and the edit path (electron/ops/setElectivePreference.js, which
// has to find the stored rows a director's correction supersedes). A second copy
// of this rule would be worse than useless: the edit path would fail to
// recognise a row the solver DOES bind to that cell, so the superseded row would
// survive, both rows would resolve to the same occurrence, and the correction
// would tie with the value being corrected. Silently.
import { recognitionKey } from './preview.js'

// The same canonicalizer the rest of the ETL recognises entities by, deliberately
// not a second rule: a camper writing "monday" and a camp calling the day "Monday"
// are the same day, and a coordinate lost to capitalisation is a coordinate lost.
export const coordinateKey = (name) => recognitionKey('days_of_operation', name)

// A period written as a bare number against a camp that names it "Period 3".
// The sheet's own column is often headed "Period Number" and its cells hold "3",
// so refusing to bind those would lose a coordinate to a naming convention. Kept
// narrow: a bare integer only, never a partial word match.
const BARE_NUMBER = /^\d+$/
export const periodAliases = (label) => {
  const raw = String(label ?? '').trim()
  const out = [coordinateKey(raw)]
  if (BARE_NUMBER.test(raw)) {
    out.push(coordinateKey(`Period ${raw}`), coordinateKey(`Block ${raw}`))
  }
  const withoutWord = raw.replace(/^(period|block)\s*/i, '')
  if (withoutWord !== raw && BARE_NUMBER.test(withoutWord)) out.push(coordinateKey(withoutWord))
  return out
}

/**
 * Do two period labels name the same period?
 *
 * SYMMETRIC, via alias-set intersection, because the two sides arrive in
 * different vocabularies and neither is canonical: the stored label is the
 * child's ("1"), the cell's is the camp's ("Period 1"). Aliasing only one side
 * matches in one direction and not the other.
 */
export const samePeriodLabel = (a, b) => {
  const aliases = new Set(periodAliases(a))
  return periodAliases(b).some((k) => aliases.has(k))
}

export const sameDayLabel = (a, b) => coordinateKey(a) === coordinateKey(b)

/**
 * The two stored coordinate COLUMNS as the one object every consumer wants.
 *
 * `deriveElectivePreferenceId` takes `{dayName, periodLabel}` or null, and the
 * engine's coordinate resolver reads the same shape — while the table stores
 * `coordinate_day_label`/`coordinate_period_label`. Four sites were converting
 * between the two by hand and had already drifted on how they wrote the null
 * test, which matters: BOTH legs null means "this row names no cell" (the
 * whole-run fallback), and an object with two null legs is a coordinate that
 * names nothing — a different thing the id derivation would key differently.
 */
export const coordinateOf = (row) => (
  row?.coordinate_day_label == null && row?.coordinate_period_label == null
    ? null
    : { dayName: row.coordinate_day_label ?? null, periodLabel: row.coordinate_period_label ?? null }
)
