// T229 -- confirmed elective_set_activities x occurrences -> solver offerings.
//
// THE CAPACITY TRAP: buildElectiveAssignments does
// `Math.max(0, o.capacity ?? 0)`, so 0/null CLOSES the offering.
// capacity_mode:'unlimited' must pass a large number, never 0 or null.
import { electiveChoiceLabelKey } from '../../../../electron/ops/electiveDerivedIds.js'
import { resolveOfferingCapacity, resolveOfferingMinimum } from '../../../../electron/ops/electiveOfferingCapacity.js'

const UNLIMITED_CAPACITY = Number.MAX_SAFE_INTEGER

export function buildOfferings({ occurrences = [], setActivities = [], activities = [] } = {}) {
  const activityById = new Map(activities.map((a) => [a.id, a]))
  // H5 — defensive defaults matching schema.sql's own DEFAULTs ('confirmed' /
  // 'unlimited', schema.sql:1087-1099). The real electron path always
  // populates these (SQLite materialises the NOT NULL DEFAULT at INSERT —
  // see electron/ops/projections.js's elective_set_activities ensureExists),
  // so this is not compensating for a projection gap there. It tolerates a
  // shape the DEV MOCK can produce: src/localClient.mock.js's rows are plain
  // JS objects with no schema behind them, so a row created there via the
  // ordinary "Add Offering" UI (which writes only elective_set_id/
  // activity_id) reads back with status/capacity_mode literally undefined.
  // Treating that as "not confirmed" / "not unlimited" silently made every
  // new offering both invisible to the solver and closed at capacity 0 in
  // browser-dev. Missing means the schema default, not a rejection.
  const confirmed = setActivities.filter((sa) => (sa.status ?? 'confirmed') === 'confirmed')

  const offerings = []
  for (const occurrence of occurrences) {
    for (const sa of confirmed) {
      const activity = activityById.get(sa.activity_id)
      if (!activity) continue
      // T245: capacity resolution lives in ONE place
      // (electron/ops/electiveOfferingCapacity.js), shared with the move/lock
      // write path. Unchanged behaviour: 'unlimited' passes a large number,
      // and ('limited', NULL) still closes the offering at 0.
      const resolved = resolveOfferingCapacity(sa)
      const capacity = resolved.kind === 'unlimited'
        ? UNLIMITED_CAPACITY
        : resolved.kind === 'limited' ? resolved.capacity : 0
      // T265 — the MINIMUM to run, the mirror of the capacity above and the
      // opposite trap. Capacity's hazard is a null arriving as 0 and CLOSING an
      // offering; the minimum's is a null arriving as 0 and silently deleting the
      // constraint. `null` here means "no minimum", and only a real stated value
      // (integer >= 1, per the schema CHECK) ever becomes a number — a
      // declared-but-unstated minimum enforces nothing rather than guessing a
      // direction.
      const min = resolveOfferingMinimum(sa)
      offerings.push({
        occurrence_id: occurrence.id,
        labelKey: electiveChoiceLabelKey(activity.name),
        activity_id: activity.id,
        capacity,
        minimum: min.kind === 'required' ? min.minimum : null,
      })
    }
  }
  return offerings
}

// Informational findings for the preview: a ranked label that matches no
// offered activity, and a confirmed offering nobody ranked. Never blocking.
//
// ADDING A KIND HERE? QUOTE THE LABEL — these reach a director through
// ./findingDisplayMessage.js, whose substitution is anchored on the quotes, so an
// unquoted label key reaches the screen as `arts&crafts`. A new `kind:` literal in
// this file fails ./findingLabelCoverage.test.js until it has a fixture there; that
// guard's header says what it cannot see. T302, and see the longer note at
// `const findings = []` in src/engine/buildElectiveAssignments.js.
export function findMismatches({ offerings = [], preferences = [] } = {}) {
  const offeredLabelKeys = new Set(offerings.map((o) => o.labelKey))
  const rankedLabelKeys = new Set(preferences.map((p) => p.labelKey))

  const findings = []
  const unmatchedLabels = new Set([...rankedLabelKeys].filter((k) => !offeredLabelKeys.has(k)))
  for (const labelKey of unmatchedLabels) {
    const label = preferences.find((p) => p.labelKey === labelKey)?.label ?? labelKey
    findings.push({
      kind: 'UNMATCHED_PREFERENCE_LABEL',
      labelKey,
      message: `"${label}" was ranked by campers but does not match any offered activity.`,
    })
  }

  const unrankedOfferedKeys = new Set([...offeredLabelKeys].filter((k) => !rankedLabelKeys.has(k)))
  for (const labelKey of unrankedOfferedKeys) {
    findings.push({
      kind: 'UNRANKED_OFFERING',
      labelKey,
      message: `An offered activity ("${labelKey}") was not ranked by any camper.`,
    })
  }

  return findings
}
