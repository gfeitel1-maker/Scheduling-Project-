// D2 — folds the decision queue's local answers into the SINGLE existing
// commit call. Pure, no IO: takes the commit's own `approved` plus Phase C's
// `decisions[]` and the queue's local answers, returns the `approved`/
// `resolutions` to actually send. Reuses the exact held-back semantics
// electron/ops/ingest.js:1015-1023 already enforces — see
// reconciliationResolutions.test.js for the load-bearing proof.
//
// docs/adr/2026-08-10-ingestion-phaseD-experience.md (D2), OQ1 resolved (c):
// unresolved decisions are held back, never auto-applied, never gate the rest.

// resolve_conflict stays on the existing HeldResolution/finishHeld path
// (genuine op:conflict, post-commit) — this queue never touches it.
export function filterQueueDecisions(decisions) {
  return (decisions ?? []).filter((d) => d.kind !== 'resolve_conflict')
}

export function isDecisionResolved(decision, answer) {
  if (decision.kind === 'confirm_value') {
    return answer?.action === 'looks_right' || answer?.action === 'edited'
  }
  if (decision.kind === 'confirm_change') {
    return answer?.choice === 'accept' || answer?.choice === 'keep'
  }
  if (decision.kind === 'review_legacy_priority') {
    return answer?.resolved === true
  }
  return false
}

export function applyResolutions({ approved, decisions, answers }) {
  const nextApproved = {}
  for (const [entity, names] of Object.entries(approved ?? {})) nextApproved[entity] = [...names]
  const resolutions = []

  for (const decision of filterQueueDecisions(decisions)) {
    const answer = answers?.[decision.id]

    // Pure acknowledgement gate — proposes nothing, never a write, resolved
    // or not (ADR C2b/OQ3: batch, all-or-nothing, never an auto-clear).
    if (decision.kind === 'review_legacy_priority') continue

    if (decision.kind === 'confirm_value') {
      // Resolved (looks-right or edited-in-place) -> name stays in approved,
      // no resolution needed (an edit ships through the entity's own edit
      // side-channel — activityRules/groupUnitOverrides — not a resolution).
      // Unresolved -> held back: remove from approved so it does not write
      // unconditionally (the silent-write risk this module exists to guard).
      if (!isDecisionResolved(decision, answer) && decision.entityName) {
        nextApproved[decision.entity] = (nextApproved[decision.entity] ?? []).filter((n) => n !== decision.entityName)
      }
      continue
    }

    if (decision.kind === 'confirm_change') {
      // Unresolved MUST still emit 'keep', never omit the resolution —
      // an absent resolution re-holds the WHOLE commit (makeStaleConflict).
      const choice = answer?.choice === 'accept' ? 'accept' : 'keep'
      const fields = Array.isArray(decision.field) ? decision.field : [decision.field]
      for (const field of fields) {
        resolutions.push({ entity: decision.entity, name: decision.entityName, reason: 'stale', field, choice })
      }
    }
  }

  return { approved: nextApproved, resolutions }
}
