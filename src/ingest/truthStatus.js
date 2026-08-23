// Truth-status classifier for an ingested activity's occurrence-pattern
// (docs/adr/2026-08-23-activity-recurrence-tiers-ingestion.md §3.2/§4.1).
//
// Pure — no database, no I/O. Reads the three booleans the commit path has
// already derived (isFixedEvent from plan.fixedEvents, hasObligationRule from
// the activity's inferred _rule, isElective from confirmedElectiveSets) and
// returns the single enum value to write to activities.recurrence_truth_status,
// or null when the pattern is not (yet) classifiable that way.
//
// isElective takes precedence over the other two: an activity that came off
// an explicit elective sheet is Permission-tier by construction, regardless
// of whether it also happens to look fixed or frequent in the raw grid data.
//
// isFixedEvent && hasObligationRule together are NOT "Asserted wins" — they
// are the dual-use signal (ADR §3.2): a name that is both Asserted (a pinned
// fixed-event occurrence) and Obligation (still carries a frequency rule) is
// genuinely mixed. The two-rows-sharing-a-name split (ADR OQ1) that would
// resolve this cleanly is not built yet, so NULL is the honest value now,
// not a guess at which tier is "really" the load-bearing one.
export function activityTruthStatus({ isFixedEvent, hasObligationRule, isElective }) {
  if (isElective) return 'permission'
  if (isFixedEvent && hasObligationRule) return null
  if (isFixedEvent) return 'asserted'
  if (hasObligationRule) return 'obligation'
  return null
}
