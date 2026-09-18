// T229 -- confirmed elective_set_activities x occurrences -> solver offerings.
//
// THE CAPACITY TRAP: buildElectiveAssignments does
// `Math.max(0, o.capacity ?? 0)`, so 0/null CLOSES the offering.
// capacity_mode:'unlimited' must pass a large number, never 0 or null.
import { electiveChoiceLabelKey } from '../../../../electron/ops/electiveDerivedIds.js'

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
      const capacityMode = sa.capacity_mode ?? 'unlimited'
      const capacity = capacityMode === 'unlimited' ? UNLIMITED_CAPACITY : Math.max(0, sa.capacity_limit ?? 0)
      offerings.push({
        occurrence_id: occurrence.id,
        labelKey: electiveChoiceLabelKey(activity.name),
        activity_id: activity.id,
        capacity,
      })
    }
  }
  return offerings
}

// Informational findings for the preview: a ranked label that matches no
// offered activity, and a confirmed offering nobody ranked. Never blocking.
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
