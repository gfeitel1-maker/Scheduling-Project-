// salienceOf — Seam 2, docs/adr/2026-08-17-onescreen-reconciliation-projection.md.
//
// PURE. No IO, no DB, no clock/random. Same discipline as buildSchedule's
// seeded-PRNG determinism requirement: same inputs, same rank, always.
// Discrete ranks only (owner-locked: no continuous score). Returns a
// RENDERING HINT — invariant 2 of the ADR: this function must never be
// consulted by reportToLanes for lane membership or order, only by the lane
// renderer for spacing/accent/scale.
//
// `reason` is a short machine string for the "why" evidence disclosure —
// NOT director-facing copy (the UI owns copy). The ADR's Seam 2 text lists
// three reasons ('high-blast-radius' | 'confirmed-change' | 'routine') but
// is silent on what resolve_conflict returns when passed through this
// function at all (it says resolve_conflict is "exempt from this ranking"
// because it already renders in the hold lane via reportToLanes regardless
// of rank). Flagged deviation: this implementation still returns a real,
// deterministic value for resolve_conflict (rank 0, reason 'held-conflict')
// rather than throwing or returning undefined, so a caller that calls
// salienceOf uniformly over every decision (rather than skipping conflicts)
// gets a safe, non-misleading answer instead of crashing.

// Future lane-renderer authors: do NOT use salienceOf().rank as an in-lane
// sort key for resolve_conflict items. They return rank 0 with reason
// 'held-conflict' — the same rank confirm_change uses — so sorting within the
// hold lane by rank alone would conflate a held conflict with a confirmed
// change. rank is a rendering hint (spacing/accent/scale per this module's
// header comment), never an ordering key; report.decisions array order is.
function keyFor(decision) {
  return `${decision.entity}:${decision.entityId}`
}

export function salienceOf(decision, blastRadiusIndex = new Map()) {
  if (decision.kind === 'confirm_change') {
    return { rank: 0, reason: 'confirmed-change' }
  }

  if (decision.kind === 'resolve_conflict') {
    return { rank: 0, reason: 'held-conflict' }
  }

  const blastRadius = blastRadiusIndex.get(keyFor(decision)) ?? 0
  const isLowOrMedium = decision.confidence === 'low' || decision.confidence === 'medium'

  if (blastRadius >= 1 && isLowOrMedium) {
    return { rank: 1, reason: 'high-blast-radius' }
  }

  return { rank: 2, reason: 'routine' }
}
