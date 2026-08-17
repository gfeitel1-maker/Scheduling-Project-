// Pure triage-state helpers for ReconciliationScreen.jsx — split into their
// own module so react-refresh's "a file exports only components" rule holds
// and so these are independently unit-testable (test-first at the seam).
//
// docs/adr/2026-08-17-onescreen-reconciliation-projection.md — Seam 3
// (staged-tray-as-dry-run) and Seam 5 (what replaces HeldResolution).

import { applyResolutions } from './reconciliationResolutions.js'
import { describeWriteFailure } from '../utils/writeErrorMessage.js'
import { ALIAS_COHORT_SCOPED } from './importAliasScope.js'

// Held is NOT an error (a held return wrote nothing), so it never reaches
// here — this only maps a real thrown commit failure. The main-process
// host-only refusal (T61, "can only be run on the main computer") already
// says the one thing the director can act on; passed through rather than
// mapped, or describeWriteFailure's honest "not something the app
// recognised" fallback would bury it.
export function mapCommitError(err) {
  const message = err?.message ?? ''
  return /admin role required/i.test(message) ? 'Only an admin can import a schedule.'
    : /can only be run on the main computer/i.test(message) ? `${message} Nothing was imported.`
    : describeWriteFailure(err, 'Nothing was imported. Your camp is exactly as it was.')
}

// A genuine op-log/identity conflict (a HELD dry-run response) has no
// `decision` shape of its own — it is folded into the same 'resolve_conflict'
// vocabulary reportToLanes already routes to the hold lane unconditionally,
// so it renders through the SAME card path rather than a second one. This is
// the "wire it in, don't stop short" resolution the cutover requires: the
// old HeldResolution takeover modal is gone, but nothing it handled is
// silently dropped — it lands as ordinary hold-lane cards.
export function heldConflictsToDecisions(conflicts) {
  const out = []
  for (const c of conflicts ?? []) {
    if (c.reason === 'ambiguous_identity') {
      out.push({
        id: `held:${c.entity}:${c._name}:identity`,
        kind: 'resolve_conflict',
        entity: c.entity,
        entityId: null,
        entityName: c._name,
        field: null,
        confidence: 'conflict',
        proposedValue: null,
        evidence: null,
        _held: true,
        _heldKind: 'identity',
        _candidates: c.candidates ?? [],
      })
    } else if (c.reason === 'stale') {
      for (const field of Object.keys(c.fields ?? {})) {
        out.push({
          id: `held:${c.entity}:${c._name}:stale:${field}`,
          kind: 'resolve_conflict',
          entity: c.entity,
          entityId: null,
          entityName: c._name,
          field: [field],
          confidence: 'conflict',
          proposedValue: c.fields[field]?.to ?? null,
          evidence: null,
          _held: true,
          _heldKind: 'stale',
          _delta: c.fields[field],
        })
      }
    }
  }
  return out
}

// Folds the screen's triage answers into the SAME payload shape commitIngest
// already accepts (ADR Seam 3 / spec's "do not invent a parallel resolution
// schema"). Non-held decisions reuse reconciliationResolutions.js's
// applyResolutions verbatim; held/identity conflicts (which never reach
// applyResolutions — filterQueueDecisions excludes every resolve_conflict
// kind) are folded here, right beside it, using the exact resolution shape
// HeldResolution used to build.
export function foldTriageInputs(baseInputs, decisions, answers) {
  const nonConflict = decisions.filter((d) => d.kind !== 'resolve_conflict')
  const { approved, resolutions } = applyResolutions({
    approved: baseInputs.approved,
    decisions: nonConflict,
    answers,
  })

  for (const d of decisions) {
    if (d.kind !== 'resolve_conflict') continue
    const a = answers[d.id]
    if (!a) continue
    const isIdentity = d._held ? d._heldKind === 'identity' : true
    if (isIdentity) {
      if (a.choice === 'existing') {
        resolutions.push({ entity: d.entity, name: d.entityName, reason: 'ambiguous_identity', choice: 'existing', entity_id: a.entity_id })
      } else if (a.choice === 'create') {
        resolutions.push({ entity: d.entity, name: d.entityName, reason: 'ambiguous_identity', choice: 'create' })
      }
    } else {
      resolutions.push({ entity: d.entity, name: d.entityName, reason: 'stale', field: d.field[0], choice: a.choice === 'accept' ? 'accept' : 'keep' })
    }
  }

  return { ...baseInputs, approved, resolutions: [...(baseInputs.resolutions ?? []), ...resolutions] }
}

// S1b's "Remember this" alias-confirmation, restored from ImportScreen's old
// finishHeld/confirmRemembers path (see ImportScreen.remember.test.jsx,
// pre-cutover) onto the new one-screen surface. Pure: takes the same
// decisions/answers this module already threads through foldTriageInputs and
// returns the exact confirmAlias({ entity_type, cohort_id, source_label,
// entity_id }) argument shape the old flow sent — ReconciliationScreen calls
// localClient.confirmAlias with these, one at a time, best-effort, AFTER a
// successful (non-held) commit. Only identity resolutions the director
// pointed at an EXISTING record (choice: 'existing') and left the default-on
// "remember" checkbox checked (answer.remember !== false) qualify — "create"
// has no existing record to alias to, and "skip" never resolved at all.
export function identityRememberCalls(decisions, answers, cohortId) {
  const calls = []
  for (const d of decisions) {
    if (d.kind !== 'resolve_conflict') continue
    const isIdentity = d._held ? d._heldKind === 'identity' : true
    if (!isIdentity) continue
    const a = answers[d.id]
    if (!a || a.choice !== 'existing') continue
    if (a.remember === false) continue
    calls.push({
      entity_type: d.entity,
      cohort_id: ALIAS_COHORT_SCOPED.has(d.entity) ? (cohortId ?? null) : null,
      source_label: d.entityName,
      entity_id: a.entity_id,
    })
  }
  return calls
}

export function isDecisionResolvedFor(decision, answers) {
  const a = answers[decision.id]
  if (!a) return false
  if (decision.kind === 'resolve_conflict') {
    const isIdentity = decision._held ? decision._heldKind === 'identity' : true
    return isIdentity ? (a.choice === 'existing' || a.choice === 'create') : (a.choice === 'accept' || a.choice === 'keep')
  }
  if (decision.kind === 'confirm_value') return a.action === 'looks_right' || a.action === 'edited'
  if (decision.kind === 'confirm_change') return a.choice === 'accept' || a.choice === 'keep' || a.ack === true
  if (decision.kind === 'review_legacy_priority') return a.resolved === true
  return false
}
