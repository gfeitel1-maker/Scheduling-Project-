// T229 -- confirmed elective_set_activities x occurrences -> solver offerings.
//
// THE CAPACITY TRAP: buildElectiveAssignments does
// `Math.max(0, o.capacity ?? 0)`, so 0/null CLOSES the offering.
// capacity_mode:'unlimited' must pass a large number, never 0 or null.
import { electiveChoiceLabelKey } from '../../../../electron/ops/electiveDerivedIds.js'
import { resolveOfferingCapacity, resolveOfferingMinimum } from '../../../../electron/ops/electiveOfferingCapacity.js'

const UNLIMITED_CAPACITY = Number.MAX_SAFE_INTEGER

// H5's "missing means the schema default" rule, shared between buildOfferings
// and findBlankCapacities so the two can never disagree about which rows the
// solver considers — a divergence here would report a row the solver ignores,
// or stay silent on one it uses.
const isConfirmed = (sa) => (sa.status ?? 'confirmed') === 'confirmed'

export function buildOfferings({ occurrences = [], setActivities = [], activities = [] } = {}) {
  const activityById = new Map(activities.map((a) => [a.id, a]))
  // H5 — defensive defaults matching schema.sql's own DEFAULTs ('confirmed' /
  // 'unlimited', schema.sql:1037-1049). The real electron path always
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
  const confirmed = setActivities.filter(isConfirmed)

  const offerings = []
  for (const occurrence of occurrences) {
    for (const sa of confirmed) {
      const activity = activityById.get(sa.activity_id)
      if (!activity) continue
      // T245: capacity resolution lives in ONE place
      // (electron/ops/electiveOfferingCapacity.js), shared with the move/lock
      // write path. Unchanged behaviour for the two cases it always had:
      // 'unlimited' passes a large number, 'limited' with a stated limit
      // passes that number. T316 changes the third case — ('limited', NULL,
      // i.e. `unknownLimit`) no longer closes the offering at capacity 0; it
      // is excluded here entirely, because findBlankCapacities (below) has
      // already refused the run over it via AssignmentPanel.
      const resolved = resolveOfferingCapacity(sa)
      if (resolved.kind === 'unknownLimit') continue
      const capacity = resolved.kind === 'unlimited' ? UNLIMITED_CAPACITY : resolved.capacity
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

// T316 — a confirmed offering declared 'limited' with a blank capacity_limit
// (`resolveOfferingCapacity`'s `unknownLimit`) is BLOCKING, unlike the two
// informational finding kinds below: AssignmentPanel refuses to solve while
// one of these exists. Owner ruling 2026-09-29: "blank capacities need to be
// filled in." One finding per OFFERING (not per occurrence — a director does
// not need to be told the same blank number once per day), naming the
// activity directly since this module (unlike the pure engine) already has
// `activities` to hand.
export function findBlankCapacities({ setActivities = [], activities = [] } = {}) {
  const activityById = new Map(activities.map((a) => [a.id, a]))
  const findings = []
  for (const sa of setActivities.filter(isConfirmed)) {
    const activity = activityById.get(sa.activity_id)
    if (!activity) continue
    if (resolveOfferingCapacity(sa).kind !== 'unknownLimit') continue
    findings.push({
      kind: 'INVALID_CAPACITY',
      activity_id: activity.id,
      set_activity_id: sa.id,
      labelKey: electiveChoiceLabelKey(activity.name),
      message: `"${activity.name}": capacity blank.`,
    })
  }
  return findings
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
      message: `"${label}" ranked but not offered.`,
    })
  }

  const unrankedOfferedKeys = new Set([...offeredLabelKeys].filter((k) => !rankedLabelKeys.has(k)))
  for (const labelKey of unrankedOfferedKeys) {
    findings.push({
      kind: 'UNRANKED_OFFERING',
      labelKey,
      message: `"${labelKey}" offered but never ranked.`,
    })
  }

  return findings
}
