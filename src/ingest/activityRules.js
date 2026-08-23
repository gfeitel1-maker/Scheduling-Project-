// Infer per-activity scheduling rules from signals extractEntities() already
// computed, so a director does not have to open 30-60 activities by hand
// after an import (T35, docs/work/specs/T35-post-import-activity-rules.md).
//
// Pure inference — no database, no I/O. Like extractEntities, this proposes;
// the director confirms (and can edit) in the preview before anything is
// written. Rules travel as group NAMES here, same as recurring events — group IDs
// do not exist yet at preview time, they are minted by commitIngest inside
// its transaction. Resolution to IDs happens there, not here.
//
// A low match count (fewer than 2 groups matched) is treated as ambiguous and
// falls back to "all groups" (null) rather than guessing at a restriction —
// guessing wrong and writing it silently is the failure this feature exists
// to avoid (ADR §1, same principle extractEntities/preview already follow).
const AMBIGUOUS_APPEARANCE_THRESHOLD = 2

// priority is a two-valued engine contract ('high'/'low' — buildSchedule.js's
// runRound only ever filters for one of those two strings), not the spec's
// original three-tier 1/2/3. See docs/adr/2026-08-06-inferred-activity-rules-at-ingest.md
// Fix 1 (round 2 review): a third value would silently make an activity
// unplaceable in either scheduling round. As of B2, this file never assigns
// EITHER value: prevalence (unitShare) alone is not a legitimate basis for
// priority, so an inferred activity's priority is UNKNOWN (the key is
// omitted). resolvePriorityForGeneration.js resolves UNKNOWN to the two-valued
// contract at generation time, before buildSchedule ever sees the activity.

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
 * @param {Iterable<string>} [excludeNames] names to skip entirely (no rule emitted), normalized the
 *        same way as the loop's own keying. Classifier-sequencing fix
 *        (docs/adr/2026-08-23-activity-recurrence-tiers-ingestion.md §4.1/§6 step 3): a name
 *        already classified as a pinned (non-dual-use) Asserted fixed event must not also get a
 *        spurious Obligation (min_per_week) rule from this pass — that was a double-classification
 *        with nothing marking which one was load-bearing. Callers pass the caller's own
 *        already-computed pin-only set (fixed-event names minus dual-use names); dual-use names are
 *        deliberately NOT excluded, since a dual-use activity legitimately carries both an Asserted
 *        and an Obligation pattern (ADR OQ1: two rows sharing a name).
 * @returns {Map<string, {
 *   eligible_group_names: string[]|null,
 *   eligibility_known: boolean,   // false = no per-group signal existed at all (T35 Fix 2b) —
 *                                 // eligible_group_names is null because nothing was seen,
 *                                 // not because the activity was confidently judged universal.
 *   min_per_week: number, max_per_week: number,
 *   priority: 'high'|'low'|undefined,   // key OMITTED entirely = UNKNOWN;
 *                                       // prevalence alone never justifies a value here
 *   _inferred: true,
 * }>}
 */
export function inferActivityRules(activityNames, activityPages, seenCounts, dayCount, allGroupNames, excludeNames) {
  const pages = activityPages ?? {}
  const counts = seenCounts?.activities ?? {}
  const allGroups = Array.isArray(allGroupNames) ? allGroupNames : []
  const days = Math.max(Number(dayCount) || 0, 1)
  const excluded = new Set([...(excludeNames ?? [])].map(normalizeName))

  const rules = new Map()

  for (const name of activityNames ?? []) {
    const key = normalizeName(name)
    if (excluded.has(key)) continue
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

    rules.set(name, {
      eligible_group_names: eligibleGroupNames,
      eligibility_known: eligibilityKnown,
      min_per_week: perWeek,
      max_per_week: perWeek + 1,
      _inferred: true,
      // B4 (docs/adr/2026-08-10-ingestion-evidence-persistence.md): the exact
      // observation the derived fields above came from, so a director asking
      // "why?" after the import session ends can still be told. Additive only
      // — every field above this comment is unchanged by this addition.
      support: { matched_groups: matchedGroups, appearances, eligible_group_count: matchedGroups.length },
    })
  }

  return rules
}
