// reportToLanes — Seam 1, docs/adr/2026-08-17-onescreen-reconciliation-projection.md.
//
// PURE. No IO, no DB, no clock/random. Deterministic given the same report.
// Total, exhaustive switch over decision.kind — throws on an unrecognized
// kind (protects against a future Phase-C decision kind landing silently,
// same "never silently drop" discipline classifyItem's fallback branch uses).
//
// Ordering within a lane is report.decisions array order — the report's own
// walk order over planItems/readiness. This adapter never re-sorts; salience
// (seam 2) is a rendering hint layered on top by the lane renderer, never
// consulted here (ADR invariant 2).

function laneFor(decision) {
  switch (decision.kind) {
    case 'resolve_conflict':
      return 'hold'

    case 'confirm_value':
      if (decision.confidence === 'conflict') return 'hold'
      if (decision.confidence === 'high') return 'express'
      return 'standard' // low | medium

    case 'confirm_change':
      // A director-confirmed field being overwritten is never "express"
      // regardless of tier (Phase C rule 4) — standard unless the merge
      // itself is conflict-confidence, which holds the whole commit.
      return decision.confidence === 'conflict' ? 'hold' : 'standard'

    case 'review_legacy_priority':
      return 'standard'

    default:
      throw new Error(`reportToLanes: unrecognized decision.kind "${decision.kind}"`)
  }
}

const BUCKET_KEYS = ['understood', 'needsAttention', 'notInSource', 'changed']

export function reportToLanes(report) {
  const express = []
  const standard = []
  const hold = []

  for (const decision of report.decisions) {
    const lane = laneFor(decision)
    if (lane === 'express') express.push(decision)
    else if (lane === 'standard') standard.push(decision)
    else hold.push(decision)
  }

  const spine = BUCKET_KEYS.map((bucket) => ({ bucket, count: report.buckets[bucket] ?? 0 }))

  // "done = list empty AND readiness green" (R1) is two independent things:
  // the list being empty (no pending hold/standard decisions) does NOT by
  // itself mean the camp is buildable — a required setup area (readiness.js's
  // `kind: 'required'`) can be unsatisfied (`state: 'missing'` or
  // `'needs-attention'`) while contributing zero decisions here (readiness
  // only ever folds into buckets.notInSource, and only for 'optional' rows —
  // see reconciliationReport.js). readinessGreen is therefore computed from
  // the raw readiness rows buildReconciliationReport exposes additively
  // (report.readiness, R2'a fix): true only when every required area's state
  // is 'ready'. Absent readiness (older/degraded caller) defaults to the
  // empty array, which vacuously satisfies "every required area is ready" —
  // matching the additive-degradation contract every other R2'a input uses.
  const readinessRows = report.readiness ?? []
  const requiredAreasReady = readinessRows
    .filter((row) => row.kind === 'required')
    .every((row) => row.state === 'ready')
  const readinessGreen = hold.length === 0 && standard.length === 0 && requiredAreasReady

  return { express, standard, hold, spine, readinessGreen }
}
