// docs/adr/2026-08-18-roots-reconstruction-moment-gating.md — pure gate
// predicate for the "Roots reconstruction moment". No DOM, no Canvas, no IPC:
// every input is already known before ReconciliationScreen mounts (ADR
// "Render seam"). Deciding after mount would let a flash of the wrong branch
// through, so this must run before the first paint, not as an effect.

// Owner-tunable per the ADR's open questions. Below this many parsed facts,
// the moment has nothing to say (prototype state E: "thin air") — skip
// straight to the existing plain-text branch.
export const ROOTS_MIN_FACT_COUNT = 20

// The reveal is ONE motion (not a grow-then-settle sequence): a quiet,
// product-native fade/lift built from the app's own importCardIn primitive,
// staggered per domain row. This constant names its total duration — the
// point at which onSettled fires and the moment hands off. Reduced motion is
// handled upstream by shouldShowReconstructionMoment, which skips the moment
// entirely in that case (never a separate in-component code path).
export const SETTLE_CAP_MS = 400

// Gate 1 (real-latency-bound) is structural, not a rule enforced here — the
// caller drives Phase 1 off promise resolution, never a setTimeout floor.
// This predicate only decides whether to show the moment at all.
export function shouldShowReconstructionMoment({ factCount, isFirstImport, prefersReducedMotion }) {
  if (prefersReducedMotion) return false
  if (!isFirstImport) return false
  if (factCount < ROOTS_MIN_FACT_COUNT) return false
  return true
}
