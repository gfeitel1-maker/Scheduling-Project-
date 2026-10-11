// ADR 2026-08-20 (per-field UNKNOWN): which fields a CREATE commits as unknown. ONE rule, used by the
// commit (electron/ops/ingest.js, where the tag:'unknown' evidence is written) and by the review flag
// (src/ingest/reconciliationReport.js), so the flag can never claim a field the commit does not mark.
// `eligibleGroupCount` is how many of the rule's eligible groups resolve (the commit floors
// min_per_week only for an activity some group can take).
export function unknownFieldsOnCreate(rule, eligibleGroupCount) {
  if (!rule) return []
  const out = []
  if (rule.priority !== 'high' && rule.priority !== 'low') out.push('priority')
  const fileShowsZero = rule.min_per_week === 0 && rule.min_from_file === true
  const positive = Number.isInteger(rule.min_per_week) && rule.min_per_week >= 1
  const floored = !fileShowsZero && !positive && eligibleGroupCount > 0
  const unobserved = !fileShowsZero && (positive || floored) && rule.support?.appearances === 0
  if (floored || unobserved) out.push('min_per_week')
  return out
}
