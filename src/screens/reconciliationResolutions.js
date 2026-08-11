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

// Round 2 MEDIUM-HIGH — a confirm_change is only "backed" by a real commit-
// side resolution consumer when it carries a real field array. Fixed-event
// moved/scopeChanged decisions (reconciliationReport.js's addFixedEventDecision)
// carry field: null and have no resolution consumer at all (electron/ops/
// ingest.js's fixed-event loop never reads a resolution) — the danger-tinted
// Overwrite/Keep gate, and its "a director set this by hand" claim, must only
// apply to the real case: an update/clear decision with a non-empty field array.
export function isBackedConfirmChange(decision) {
  return decision.kind === 'confirm_change' && Array.isArray(decision.field) && decision.field.length > 0
}

// Round 2 HIGH — the source field names the queue's Edit affordance can
// actually apply, mirroring RULE_FIELD_TO_SOURCE (ImportScreen.jsx) — the
// rule-state fields updateActivityRule/ActivityRuleRow already know how to
// write. Single source of truth so a decision never offers an Edit button
// whose value the commit payload cannot receive.
export const EDITABLE_ACTIVITY_FIELDS = new Set(['min_per_week', 'max_per_week', 'priority', 'eligible_groups'])

// An Edit affordance is only offered when the edited value has a real,
// single-field destination in the commit payload: one of the activity-rule
// fields (routes through updateActivityRule) or a group's unit (routes
// through setGroupUnitOverrides). A multi-field confirm_value flattens N
// fields into one display box that cannot be cleanly split back on save, so
// it is never editable — same discipline as isBackedConfirmChange above:
// no affordance may promise a write it cannot deliver (Governor round 2,
// invariant 4).
export function isEditableDecision(decision) {
  if (decision.kind !== 'confirm_value') return false
  if (!Array.isArray(decision.field) || decision.field.length !== 1) return false
  const [field] = decision.field
  if (decision.entity === 'activities') return EDITABLE_ACTIVITY_FIELDS.has(field)
  if (decision.entity === 'groups') return field === 'unit'
  return false
}

export function isDecisionResolved(decision, answer) {
  if (decision.kind === 'confirm_value') {
    return answer?.action === 'looks_right' || answer?.action === 'edited'
  }
  if (decision.kind === 'confirm_change') {
    // A backed decision resolves via the real Overwrite/Keep gate; a
    // non-backed one (fixed-event drift, no write possible either way)
    // resolves via a plain acknowledgement — never via a choice that isn't
    // rendered for it.
    return isBackedConfirmChange(decision)
      ? answer?.choice === 'accept' || answer?.choice === 'keep'
      : answer?.ack === true
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
      // NOTE: `approved` never gates the 'anchor_activities' entity (buildPlan/
      // commit only whitelist INGESTIBLE_ENTITIES) — a fixed-event confirm_value
      // (entity: 'anchor_activities') held back here writes a key nothing
      // downstream ever reads. Harmless (proposedValue is null there too), left
      // as-is rather than special-cased, but no future writable field on that
      // entity should assume this hold-back actually gates anything.
      if (!isDecisionResolved(decision, answer) && decision.entityName) {
        nextApproved[decision.entity] = (nextApproved[decision.entity] ?? []).filter((n) => n !== decision.entityName)
      }
      continue
    }

    if (decision.kind === 'confirm_change') {
      // Not backed by a real resolution consumer (a fixed-event drift fact,
      // field: null) — never emits a resolution, resolved or not. The queue
      // shows this as a plain acknowledgement, never the write-implying
      // Overwrite/Keep gate.
      if (!isBackedConfirmChange(decision)) continue

      // Unresolved MUST still emit 'keep', never omit the resolution —
      // an absent resolution re-holds the WHOLE commit (makeStaleConflict).
      const choice = answer?.choice === 'accept' ? 'accept' : 'keep'
      for (const field of decision.field) {
        resolutions.push({ entity: decision.entity, name: decision.entityName, reason: 'stale', field, choice })
      }
    }
  }

  return { approved: nextApproved, resolutions }
}
