// T229 -- confirmed elective_set_activities x occurrences -> solver offerings.
//
// THE CAPACITY TRAP: buildElectiveAssignments does
// `Math.max(0, o.capacity ?? 0)`, so 0/null CLOSES the offering.
// capacity_mode:'unlimited' must pass a large number, never 0 or null.
import { electiveChoiceLabelKey } from '../../../../electron/ops/electiveDerivedIds.js'

const UNLIMITED_CAPACITY = Number.MAX_SAFE_INTEGER

export function buildOfferings({ occurrences = [], setActivities = [], activities = [] } = {}) {
  const activityById = new Map(activities.map((a) => [a.id, a]))
  const confirmed = setActivities.filter((sa) => sa.status === 'confirmed')

  const offerings = []
  for (const occurrence of occurrences) {
    for (const sa of confirmed) {
      const activity = activityById.get(sa.activity_id)
      if (!activity) continue
      const capacity = sa.capacity_mode === 'unlimited' ? UNLIMITED_CAPACITY : Math.max(0, sa.capacity_limit ?? 0)
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
