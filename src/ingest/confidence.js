// One confidence vocabulary and one auto-accept policy for the whole importer.
//
// Three sources used to each roll their own high/low notion (activityRules,
// fixedEvents, preview) plus ImportScreen re-implemented the accept check
// inline. B1 (docs/work/specs/2026-08-10-ingestion-B0-baseline.md §5) unifies
// the representation without changing what any site classifies — each site
// keeps its own threshold, because forcing one formula across sites with
// different meanings of "strength" would change behavior, not just its shape.

export const CONFIDENCE = Object.freeze({ HIGH: 'high', MEDIUM: 'medium', LOW: 'low' })

// mediumThreshold defaults to highThreshold so no current call site can ever
// emit MEDIUM — MEDIUM is reserved for a later slice (B2+).
export function classifyConfidence(strength, { highThreshold, mediumThreshold = highThreshold } = {}) {
  if (strength >= highThreshold) return CONFIDENCE.HIGH
  if (strength >= mediumThreshold) return CONFIDENCE.MEDIUM
  return CONFIDENCE.LOW
}

// Convenience for sites that already have a boolean "is high confidence"
// (preview's lowConfidence predicate) rather than a numeric strength.
export function tierFromHighFlag(isHigh) {
  return isHigh ? CONFIDENCE.HIGH : CONFIDENCE.LOW
}

// Single auto-accept policy. Only HIGH auto-accepts today (ImportScreen).
export function autoAccepts(tier) {
  return tier === CONFIDENCE.HIGH
}
