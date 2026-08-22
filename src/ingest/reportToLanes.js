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

    // Slice 3a (docs/adr/2026-08-22-nested-schedules-electives-and-events.md
    // §4 addendum): a detected elective period/column is ALWAYS hold,
    // regardless of confidence band — "never silent" is the whole point of
    // the nudge. A confirmed-band header finding still asks, it never
    // auto-creates.
    case 'elective_candidate':
      return 'hold'

    // fix, panel round 2 — the "N more not shown" cap note is informational,
    // not a director decision blocking anything; standard (not hold, not
    // express-silent) matches review_legacy_priority's own batch-note lane.
    case 'elective_candidates_truncated':
      return 'standard'

    default:
      throw new Error(`reportToLanes: unrecognized decision.kind "${decision.kind}"`)
  }
}

const BUCKET_KEYS = ['understood', 'needsAttention', 'notInSource', 'changed']

// F3, docs/adr/2026-08-17-onescreen-reconciliation-merge.md §5 — a required
// readiness gap ("the camp itself isn't set up yet, independent of this
// file") is a decision-shaped attention item too, not just the boolean
// readinessGreen consumed below. Prepended ahead of every other hold-lane
// card — a setup gap blocks everything else. Pure re-shape of
// report.readiness; no second source of truth.
function requiredGapDecisions(readinessRows) {
  return readinessRows
    .filter((row) => row.kind === 'required' && row.state !== 'ready')
    .map((row) => ({
      id: `readiness:${row.key}`,
      kind: 'required_gap',
      entity: null,
      entityId: null,
      entityName: null,
      field: null,
      confidence: 'required',
      proposedValue: null,
      label: row.label,
      message: row.message ?? null,
      screen: row.screen,
      evidence: null,
    }))
}

export function reportToLanes(report) {
  const express = []
  const standard = []
  const hold = [...requiredGapDecisions(report.readiness ?? [])]

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
