// Infer per-activity scheduling rules from signals extractEntities() already
// computed, so a director does not have to open 30-60 activities by hand
// after an import (T35, docs/work/specs/T35-post-import-activity-rules.md).
//
// Pure inference — no database, no I/O. Like extractEntities, this proposes;
// the director confirms (and can edit) in the preview before anything is
// written. Rules travel as group NAMES here, same as fixed events — group IDs
// do not exist yet at preview time, they are minted by commitIngest inside
// its transaction. Resolution to IDs happens there, not here.
//
// A low match count (fewer than 2 groups matched) is treated as ambiguous and
// falls back to "all groups" (null) rather than guessing at a restriction —
// guessing wrong and writing it silently is the failure this feature exists
// to avoid (ADR §1, same principle extractEntities/preview already follow).
import { classifyConfidence, CONFIDENCE } from './confidence.js'

const AMBIGUOUS_APPEARANCE_THRESHOLD = 2

// priority is a two-valued engine contract ('high'/'low' — buildSchedule.js's
// runRound only ever filters for one of those two strings), not the spec's
// original three-tier 1/2/3. See docs/adr/2026-08-06-inferred-activity-rules-at-ingest.md
// Fix 1 (round 2 review): a third value would silently make an activity
// unplaceable in either scheduling round.
const HIGH_PRIORITY_THRESHOLD = 0.8

function normalizeName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * @param {string[]} activityNames        proposed activity names, spelled as extractEntities spells them
 * @param {object} activityPages          normalized(name) -> array of group names that had this activity
 * @param {{ activities: object, activityUnitShare: object }} seenCounts
 *        .activities is keyed by RAW name (extractEntities.seenCounts.activities);
 *        .activityUnitShare is keyed by NORMALIZED name (extractEntities.seenCounts.activityUnitShare)
 * @param {number} dayCount                proposal.entities.days_of_operation.length
 * @param {string[]} allGroupNames         every proposed group name, for the "appears everywhere" check
 * @returns {Map<string, {
 *   eligible_group_names: string[]|null,
 *   eligibility_known: boolean,   // false = no per-group signal existed at all (T35 Fix 2b) —
 *                                 // eligible_group_names is null because nothing was seen,
 *                                 // not because the activity was confidently judged universal.
 *   min_per_week: number, max_per_week: number,
 *   priority: 'high'|'low',
 *   _inferred: true,
 * }>}
 */
export function inferActivityRules(activityNames, activityPages, seenCounts, dayCount, allGroupNames) {
  const pages = activityPages ?? {}
  const counts = seenCounts?.activities ?? {}
  const shares = seenCounts?.activityUnitShare ?? {}
  const allGroups = Array.isArray(allGroupNames) ? allGroupNames : []
  const days = Math.max(Number(dayCount) || 0, 1)

  const rules = new Map()

  for (const name of activityNames ?? []) {
    const key = normalizeName(name)
    const matchedGroups = Array.isArray(pages[key]) ? pages[key] : []
    const appearances = Number(counts[name]) || 0

    // No page-level signal at all — e.g. the file's layout couldn't be
    // attributed to groups per cell (T35 Fix 2b regression: this used to be
    // indistinguishable from "confidently judged universal"). Distinct from
    // the "ambiguous" branch below, where SOME signal existed but was thin.
    const eligibilityKnown = matchedGroups.length > 0

    let eligibleGroupNames
    if (matchedGroups.length === 0) {
      eligibleGroupNames = null
    } else if (allGroups.length > 0 && matchedGroups.length >= allGroups.length) {
      eligibleGroupNames = null
    } else if (matchedGroups.length < 2 && appearances < AMBIGUOUS_APPEARANCE_THRESHOLD) {
      eligibleGroupNames = null
    } else {
      eligibleGroupNames = matchedGroups
    }

    const eligibleGroupCount = Math.max(matchedGroups.length, 1)
    let perWeek = Math.round(appearances / eligibleGroupCount / days)
    if (perWeek < 1) perWeek = 1

    const share = Number(shares[key]) || 0
    const priorityTier = classifyConfidence(share, { highThreshold: HIGH_PRIORITY_THRESHOLD })
    const priority = priorityTier === CONFIDENCE.HIGH ? 'high' : 'low'

    rules.set(name, {
      eligible_group_names: eligibleGroupNames,
      eligibility_known: eligibilityKnown,
      min_per_week: perWeek,
      max_per_week: perWeek + 1,
      priority,
      _inferred: true,
    })
  }

  return rules
}
