import { describe, it, expect } from 'vitest'
import { heldConflictsToDecisions, foldTriageInputs, isDecisionResolvedFor, mapCommitError, identityRememberCalls } from './reconciliationTriage.js'

describe('heldConflictsToDecisions', () => {
  it('folds an ambiguous_identity conflict into a resolve_conflict decision, held-flagged', () => {
    const decisions = heldConflictsToDecisions([
      { entity: 'groups', _name: 'Chipmunks', reason: 'ambiguous_identity', candidates: [{ entity_id: 'g1', name: 'Chipmunks (existing)' }] },
    ])
    expect(decisions).toEqual([
      expect.objectContaining({
        kind: 'resolve_conflict', entity: 'groups', entityName: 'Chipmunks',
        _held: true, _heldKind: 'identity', _candidates: [{ entity_id: 'g1', name: 'Chipmunks (existing)' }],
      }),
    ])
  })

  it('folds a stale conflict into one decision PER field, held-flagged', () => {
    const decisions = heldConflictsToDecisions([
      { entity: 'days_of_operation', _name: 'Monday', reason: 'stale', fields: { sort_order: { to: 1 }, label: { to: 'Mon' } } },
    ])
    expect(decisions).toHaveLength(2)
    expect(decisions.map((d) => d.field[0]).sort()).toEqual(['label', 'sort_order'])
    for (const d of decisions) {
      expect(d.kind).toBe('resolve_conflict')
      expect(d._held).toBe(true)
      expect(d._heldKind).toBe('stale')
    }
  })

  it('is empty for no conflicts', () => {
    expect(heldConflictsToDecisions([])).toEqual([])
    expect(heldConflictsToDecisions(undefined)).toEqual([])
  })
})

describe('foldTriageInputs', () => {
  const baseInputs = { approved: { activities: ['Art', 'Swim'], groups: ['Chipmunks'] }, resolutions: [] }

  it('a confirm_value "looks_right" answer keeps the name approved (reconciliationResolutions.js behavior, reused verbatim)', () => {
    const decisions = [{ id: 'd1', kind: 'confirm_value', entity: 'activities', entityName: 'Art', confidence: 'low' }]
    const { approved, resolutions } = foldTriageInputs(baseInputs, decisions, { d1: { action: 'looks_right' } })
    expect(approved.activities).toContain('Art')
    expect(resolutions).toEqual([])
  })

  it('an UNANSWERED confirm_value holds the name back (never auto-applied)', () => {
    const decisions = [{ id: 'd1', kind: 'confirm_value', entity: 'activities', entityName: 'Art', confidence: 'low' }]
    const { approved } = foldTriageInputs(baseInputs, decisions, {})
    expect(approved.activities).not.toContain('Art')
  })

  it('a confirm_change "accept" emits a stale/accept resolution for every field', () => {
    const decisions = [{ id: 'd1', kind: 'confirm_change', entity: 'activities', entityName: 'Swim', field: ['min_per_week'] }]
    const { resolutions } = foldTriageInputs(baseInputs, decisions, { d1: { choice: 'accept' } })
    expect(resolutions).toEqual([{ entity: 'activities', name: 'Swim', reason: 'stale', field: 'min_per_week', choice: 'accept' }])
  })

  it('an unresolved confirm_change still emits "keep" (an absent resolution would re-hold the whole commit)', () => {
    const decisions = [{ id: 'd1', kind: 'confirm_change', entity: 'activities', entityName: 'Swim', field: ['min_per_week'] }]
    const { resolutions } = foldTriageInputs(baseInputs, decisions, {})
    expect(resolutions).toEqual([{ entity: 'activities', name: 'Swim', reason: 'stale', field: 'min_per_week', choice: 'keep' }])
  })

  it('a pre-write resolve_conflict (ambiguous identity) answer folds to an ambiguous_identity resolution', () => {
    const decisions = [{ id: 'd1', kind: 'resolve_conflict', entity: 'groups', entityName: 'Chipmunks' }]
    const { resolutions } = foldTriageInputs(baseInputs, decisions, { d1: { choice: 'existing', entity_id: 'g1' } })
    expect(resolutions).toEqual([{ entity: 'groups', name: 'Chipmunks', reason: 'ambiguous_identity', choice: 'existing', entity_id: 'g1' }])
  })

  it('a held/stale resolve_conflict answer folds to a stale resolution — the exact shape HeldResolution used to build', () => {
    const decisions = heldConflictsToDecisions([
      { entity: 'days_of_operation', _name: 'Monday', reason: 'stale', fields: { sort_order: { to: 1 } } },
    ])
    const { resolutions } = foldTriageInputs(baseInputs, decisions, { [decisions[0].id]: { choice: 'accept' } })
    expect(resolutions).toEqual([{ entity: 'days_of_operation', name: 'Monday', reason: 'stale', field: 'sort_order', choice: 'accept' }])
  })

  it('a held/identity resolve_conflict answer folds to an ambiguous_identity resolution', () => {
    const decisions = heldConflictsToDecisions([
      { entity: 'groups', _name: 'Chipmunks', reason: 'ambiguous_identity', candidates: [{ entity_id: 'g1' }] },
    ])
    const { resolutions } = foldTriageInputs(baseInputs, decisions, { [decisions[0].id]: { choice: 'create' } })
    expect(resolutions).toEqual([{ entity: 'groups', name: 'Chipmunks', reason: 'ambiguous_identity', choice: 'create' }])
  })

  it('a "skip" answer on an identity conflict emits no resolution — the row stays held, nothing is written', () => {
    const decisions = heldConflictsToDecisions([
      { entity: 'groups', _name: 'Chipmunks', reason: 'ambiguous_identity', candidates: [{ entity_id: 'g1' }] },
    ])
    const { resolutions } = foldTriageInputs(baseInputs, decisions, { [decisions[0].id]: { choice: 'skip' } })
    expect(resolutions).toEqual([])
  })
})

describe('identityRememberCalls', () => {
  it('builds one confirmAlias call per resolved identity decision left checked (default), skipping non-cohort-scoped entities\' cohort_id', () => {
    const decisions = heldConflictsToDecisions([
      { entity: 'groups', _name: 'Chipmunks', reason: 'ambiguous_identity', candidates: [{ entity_id: 'g1' }] },
    ])
    const calls = identityRememberCalls(decisions, { [decisions[0].id]: { choice: 'existing', entity_id: 'g1' } }, 'cohort-1')
    expect(calls).toEqual([{ entity_type: 'groups', cohort_id: null, source_label: 'Chipmunks', entity_id: 'g1' }])
  })

  it('sends cohort_id for a cohort-scoped entity type (tiers/time_blocks)', () => {
    const decisions = heldConflictsToDecisions([
      { entity: 'tiers', _name: 'Senior', reason: 'ambiguous_identity', candidates: [{ entity_id: 't1' }] },
    ])
    const calls = identityRememberCalls(decisions, { [decisions[0].id]: { choice: 'existing', entity_id: 't1' } }, 'cohort-1')
    expect(calls).toEqual([{ entity_type: 'tiers', cohort_id: 'cohort-1', source_label: 'Senior', entity_id: 't1' }])
  })

  it('excludes an unchecked ("remember: false") answer', () => {
    const decisions = heldConflictsToDecisions([
      { entity: 'groups', _name: 'Chipmunks', reason: 'ambiguous_identity', candidates: [{ entity_id: 'g1' }] },
    ])
    const calls = identityRememberCalls(decisions, { [decisions[0].id]: { choice: 'existing', entity_id: 'g1', remember: false } }, null)
    expect(calls).toEqual([])
  })

  it('excludes a "create" choice — there is no existing record to alias to', () => {
    const decisions = heldConflictsToDecisions([
      { entity: 'groups', _name: 'Chipmunks', reason: 'ambiguous_identity', candidates: [{ entity_id: 'g1' }] },
    ])
    const calls = identityRememberCalls(decisions, { [decisions[0].id]: { choice: 'create' } }, null)
    expect(calls).toEqual([])
  })

  it('excludes a "skip" choice and any non-identity decision', () => {
    const decisions = [
      ...heldConflictsToDecisions([{ entity: 'groups', _name: 'Chipmunks', reason: 'ambiguous_identity', candidates: [{ entity_id: 'g1' }] }]),
      { id: 'd2', kind: 'confirm_value', entity: 'activities', entityName: 'Art' },
    ]
    const answers = { [decisions[0].id]: { choice: 'skip' }, d2: { action: 'looks_right' } }
    expect(identityRememberCalls(decisions, answers, null)).toEqual([])
  })
})

describe('isDecisionResolvedFor', () => {
  it('confirm_value resolves on looks_right or edited, not on any other answer shape', () => {
    const d = { id: 'd1', kind: 'confirm_value' }
    expect(isDecisionResolvedFor(d, {})).toBe(false)
    expect(isDecisionResolvedFor(d, { d1: { action: 'looks_right' } })).toBe(true)
    expect(isDecisionResolvedFor(d, { d1: { action: 'edited' } })).toBe(true)
  })

  it('resolve_conflict (pre-write identity) resolves on existing or create', () => {
    const d = { id: 'd1', kind: 'resolve_conflict' }
    expect(isDecisionResolvedFor(d, {})).toBe(false)
    expect(isDecisionResolvedFor(d, { d1: { choice: 'existing', entity_id: 'g1' } })).toBe(true)
    expect(isDecisionResolvedFor(d, { d1: { choice: 'create' } })).toBe(true)
  })

  it('resolve_conflict (identity) never resolves on "skip" — it stays pending/held', () => {
    const d = { id: 'd1', kind: 'resolve_conflict' }
    expect(isDecisionResolvedFor(d, { d1: { choice: 'skip' } })).toBe(false)
    const held = { id: 'd2', kind: 'resolve_conflict', _held: true, _heldKind: 'identity' }
    expect(isDecisionResolvedFor(held, { d2: { choice: 'skip' } })).toBe(false)
  })

  it('resolve_conflict (held/stale) resolves on accept or keep, not existing/create', () => {
    const d = { id: 'd1', kind: 'resolve_conflict', _held: true, _heldKind: 'stale' }
    expect(isDecisionResolvedFor(d, { d1: { choice: 'existing' } })).toBe(false)
    expect(isDecisionResolvedFor(d, { d1: { choice: 'accept' } })).toBe(true)
    expect(isDecisionResolvedFor(d, { d1: { choice: 'keep' } })).toBe(true)
  })

  it('review_legacy_priority resolves only on an explicit ack, never an auto-clear', () => {
    const d = { id: 'd1', kind: 'review_legacy_priority' }
    expect(isDecisionResolvedFor(d, {})).toBe(false)
    expect(isDecisionResolvedFor(d, { d1: {} })).toBe(false)
    expect(isDecisionResolvedFor(d, { d1: { resolved: true } })).toBe(true)
  })
})

describe('mapCommitError', () => {
  it('passes the host-only refusal through with the safety reassurance appended', () => {
    expect(mapCommitError(new Error('Import can only be run on the main computer.')))
      .toBe('Import can only be run on the main computer. Nothing was imported.')
  })

  it('maps an admin-role refusal to plain language', () => {
    expect(mapCommitError(new Error('admin role required'))).toBe('Only an admin can import a schedule.')
  })

  it('falls back to describeWriteFailure for anything else', () => {
    expect(mapCommitError(new Error('boom'))).toMatch(/Nothing was imported/)
  })
})
