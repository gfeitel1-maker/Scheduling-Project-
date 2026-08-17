// D2 — pure logic for folding the decision queue's local answers into the
// SINGLE existing commit call (approved + resolutions), reusing the exact
// held-back semantics electron/ops/ingest.js:1015-1023 already enforces:
//
//   confirm_change (a protected/human field): 'accept' overwrites, 'keep'
//   drops the delta, and NO resolution re-holds the WHOLE commit
//   (makeStaleConflict) — so an unresolved confirm_change must always emit
//   'keep', never omit the resolution.
//
//   confirm_value (a non-protected field or a create): writes UNCONDITIONALLY
//   if its name is in `approved` — so an unresolved confirm_value must have
//   its entityName removed from approved[entity] (the existing "skips"
//   mechanism finishHeld already uses, ImportScreen.jsx:685-689).
//
//   review_legacy_priority: a pure acknowledgement gate. It proposes nothing
//   (proposedValue is always null) and must NEVER be turned into a clear or
//   a write, resolved or not.
//
// Test-first: written before reconciliationResolutions.js exists.

import { describe, it, expect } from 'vitest'
import {
  filterQueueDecisions, applyResolutions, isDecisionResolved,
  isEditableDecision, isBackedConfirmChange,
} from './reconciliationResolutions.js'

function confirmValueDecision(overrides = {}) {
  return {
    id: 'activities:act-1', kind: 'confirm_value', entity: 'activities', entityId: 'act-1',
    entityName: 'Archery', field: ['max_per_week'], confidence: 'medium', proposedValue: 5,
    unknowns: [], evidence: null, reason: 'Only appeared once', ...overrides,
  }
}

function confirmChangeDecision(overrides = {}) {
  return {
    id: 'activities:act-2', kind: 'confirm_change', entity: 'activities', entityId: 'act-2',
    entityName: 'Swim', field: ['max_per_week'], confidence: 'changed', proposedValue: 7,
    unknowns: [], evidence: null, reason: 'A director set this by hand', ...overrides,
  }
}

function legacyPriorityDecision(overrides = {}) {
  return {
    id: 'activities:legacy_priority', kind: 'review_legacy_priority', entity: 'activities', entityId: null,
    entityName: null, field: 'priority', confidence: 'low', proposedValue: null, count: 2,
    activities: [{ entityId: 'act-3', name: 'Canoe' }, { entityId: 'act-4', name: 'Kayak' }],
    unknowns: [], evidence: null, reason: 'These carry a legacy priority', ...overrides,
  }
}

function conflictDecision(overrides = {}) {
  return {
    id: 'activities:null:ambiguous_identity:Kayaking', kind: 'resolve_conflict', entity: 'activities',
    entityId: null, entityName: 'Kayaking', field: null, confidence: 'conflict', proposedValue: null,
    unknowns: [], evidence: null, reason: 'ambiguous_identity', ...overrides,
  }
}

describe('filterQueueDecisions', () => {
  it('excludes resolve_conflict — that stays on the existing HeldResolution path', () => {
    const decisions = [confirmValueDecision(), conflictDecision(), legacyPriorityDecision()]
    const filtered = filterQueueDecisions(decisions)
    expect(filtered.map((d) => d.kind)).toEqual(['confirm_value', 'review_legacy_priority'])
  })

  it('handles an empty/absent decisions array without throwing', () => {
    expect(filterQueueDecisions(undefined)).toEqual([])
    expect(filterQueueDecisions([])).toEqual([])
  })
})

describe('applyResolutions — (b) resolved decisions apply through the commit path', () => {
  it('a "looks right" confirm_value keeps its name in approved and emits no resolution', () => {
    const decision = confirmValueDecision()
    const { approved, resolutions } = applyResolutions({
      approved: { activities: ['Archery'] },
      decisions: [decision],
      answers: { [decision.id]: { action: 'looks_right' } },
    })
    expect(approved.activities).toContain('Archery')
    expect(resolutions).toEqual([])
  })

  it('an edited confirm_value keeps its name in approved (the edited value ships via the side-channel edit, not a resolution)', () => {
    const decision = confirmValueDecision()
    const { approved, resolutions } = applyResolutions({
      approved: { activities: ['Archery'] },
      decisions: [decision],
      answers: { [decision.id]: { action: 'edited', value: 6 } },
    })
    expect(approved.activities).toContain('Archery')
    expect(resolutions).toEqual([])
  })

  it('an "Overwrite" confirm_change emits {reason:"stale", field, choice:"accept"} for every field', () => {
    const decision = confirmChangeDecision({ field: ['max_per_week', 'min_per_week'] })
    const { resolutions } = applyResolutions({
      approved: { activities: ['Swim'] },
      decisions: [decision],
      answers: { [decision.id]: { choice: 'accept' } },
    })
    expect(resolutions).toEqual([
      { entity: 'activities', name: 'Swim', reason: 'stale', field: 'max_per_week', choice: 'accept' },
      { entity: 'activities', name: 'Swim', reason: 'stale', field: 'min_per_week', choice: 'accept' },
    ])
  })

  it('a "Keep my value" confirm_change emits choice:"keep"', () => {
    const decision = confirmChangeDecision()
    const { resolutions } = applyResolutions({
      approved: { activities: ['Swim'] },
      decisions: [decision],
      answers: { [decision.id]: { choice: 'keep' } },
    })
    expect(resolutions).toEqual([{ entity: 'activities', name: 'Swim', reason: 'stale', field: 'max_per_week', choice: 'keep' }])
  })
})

describe('applyResolutions — (c) LOAD-BEARING held-back proof', () => {
  it('an UNRESOLVED confirm_value is held back: its entityName is removed from approved, no resolution writes proposedValue', () => {
    const decision = confirmValueDecision()
    const { approved, resolutions } = applyResolutions({
      approved: { activities: ['Archery', 'Swim'] },
      decisions: [decision],
      answers: {}, // no answer at all — unresolved
    })
    expect(approved.activities).not.toContain('Archery')
    expect(approved.activities).toContain('Swim') // untouched sibling name stays
    expect(resolutions.some((r) => r.name === 'Archery')).toBe(false)
  })

  it('an UNRESOLVED confirm_change always commits choice:"keep" — never "accept", never absent (absent re-holds the WHOLE commit)', () => {
    const decision = confirmChangeDecision()
    const { resolutions } = applyResolutions({
      approved: { activities: ['Swim'] },
      decisions: [decision],
      answers: {}, // no answer — unresolved
    })
    expect(resolutions).toEqual([{ entity: 'activities', name: 'Swim', reason: 'stale', field: 'max_per_week', choice: 'keep' }])
  })

  it('the rest — already-reconciled entries plus resolved decisions — still commits alongside the held-back ones', () => {
    const unresolvedValue = confirmValueDecision({ id: 'activities:act-1', entityName: 'Archery' })
    const resolvedChange = confirmChangeDecision({ id: 'activities:act-2', entityName: 'Swim' })
    const { approved, resolutions } = applyResolutions({
      approved: { activities: ['Archery', 'Swim', 'Canoe'] }, // Canoe = already-reconciled, no decision at all
      decisions: [unresolvedValue, resolvedChange],
      answers: { [resolvedChange.id]: { choice: 'accept' } },
    })
    expect(approved.activities).toEqual(['Swim', 'Canoe']) // Archery held back, the rest commits
    expect(resolutions).toEqual([{ entity: 'activities', name: 'Swim', reason: 'stale', field: 'max_per_week', choice: 'accept' }])
  })

  it('an entity with no matching decision at all is left completely untouched', () => {
    const { approved } = applyResolutions({
      approved: { groups: ['Bunk 1', 'Bunk 2'] },
      decisions: [],
      answers: {},
    })
    expect(approved.groups).toEqual(['Bunk 1', 'Bunk 2'])
  })
})

describe('applyResolutions — (d) batched review_legacy_priority is all-or-nothing and NEVER a write', () => {
  it('resolved or not, it emits no resolution and leaves approved untouched', () => {
    const decision = legacyPriorityDecision()
    const resolved = applyResolutions({
      approved: { activities: ['Archery'] },
      decisions: [decision],
      answers: { [decision.id]: { resolved: true } },
    })
    const unresolved = applyResolutions({
      approved: { activities: ['Archery'] },
      decisions: [decision],
      answers: {},
    })
    expect(resolved.resolutions).toEqual([])
    expect(unresolved.resolutions).toEqual([])
    expect(resolved.approved).toEqual({ activities: ['Archery'] })
    expect(unresolved.approved).toEqual({ activities: ['Archery'] })
  })

  it('never appears as a clear (proposedValue stays null; nothing in the output ever carries field:"priority" as a write)', () => {
    const decision = legacyPriorityDecision()
    const { resolutions } = applyResolutions({
      approved: { activities: [] },
      decisions: [decision],
      answers: { [decision.id]: { resolved: true } },
    })
    expect(resolutions.some((r) => r.field === 'priority')).toBe(false)
  })
})

describe('isDecisionResolved', () => {
  it('confirm_value: resolved by looks_right or edited, not by an empty answer', () => {
    const d = confirmValueDecision()
    expect(isDecisionResolved(d, undefined)).toBe(false)
    expect(isDecisionResolved(d, { action: 'looks_right' })).toBe(true)
    expect(isDecisionResolved(d, { action: 'edited', value: 1 })).toBe(true)
  })

  it('confirm_change (backed, field non-null): resolved by an explicit accept or keep choice, not by an empty answer', () => {
    const d = confirmChangeDecision()
    expect(isDecisionResolved(d, undefined)).toBe(false)
    expect(isDecisionResolved(d, { choice: 'accept' })).toBe(true)
    expect(isDecisionResolved(d, { choice: 'keep' })).toBe(true)
  })

  it('confirm_change (NOT backed, field:null — a fixed-event drift fact): resolved only by an explicit ack', () => {
    const d = confirmChangeDecision({ field: null })
    expect(isDecisionResolved(d, undefined)).toBe(false)
    expect(isDecisionResolved(d, { choice: 'accept' })).toBe(false) // this button doesn't even render for it
    expect(isDecisionResolved(d, { ack: true })).toBe(true)
  })

  it('review_legacy_priority: resolved only by an explicit resolved:true (batch, all-or-nothing)', () => {
    const d = legacyPriorityDecision()
    expect(isDecisionResolved(d, undefined)).toBe(false)
    expect(isDecisionResolved(d, { resolved: true })).toBe(true)
  })
})

// Round 2 HIGH — an Edit must never be offered unless the edited value can
// actually reach the commit payload (activities' rule-editable fields via
// updateActivityRule, or a group's unit via setGroupUnitOverrides). A
// multi-field confirm_value flattens N fields into one box that can't be
// cleanly split back on save, so it is NOT editable — only "Looks right".
describe('isEditableDecision', () => {
  it('a single-field activities confirm_value on a known rule field is editable', () => {
    expect(isEditableDecision(confirmValueDecision({ entity: 'activities', field: ['max_per_week'] }))).toBe(true)
    expect(isEditableDecision(confirmValueDecision({ entity: 'activities', field: ['priority'] }))).toBe(true)
  })

  it('a multi-field activities confirm_value is NOT editable (cannot be split back cleanly)', () => {
    expect(isEditableDecision(confirmValueDecision({ entity: 'activities', field: ['max_per_week', 'min_per_week'] }))).toBe(false)
  })

  it('an activities field with no rule-editor target is NOT editable', () => {
    expect(isEditableDecision(confirmValueDecision({ entity: 'activities', field: ['some_unmapped_field'] }))).toBe(false)
  })

  it('a groups confirm_value on "unit" is editable; any other groups field is not', () => {
    expect(isEditableDecision(confirmValueDecision({ entity: 'groups', field: ['unit'] }))).toBe(true)
    expect(isEditableDecision(confirmValueDecision({ entity: 'groups', field: ['name'] }))).toBe(false)
  })

  it('a whole-row create (field: null) is NOT editable', () => {
    expect(isEditableDecision(confirmValueDecision({ field: null }))).toBe(false)
  })

  it('a confirm_change or review_legacy_priority is never "editable" in this sense', () => {
    expect(isEditableDecision(confirmChangeDecision())).toBe(false)
    expect(isEditableDecision(legacyPriorityDecision())).toBe(false)
  })
})

// Round 2 MEDIUM-HIGH — a confirm_change is only "backed" (the Overwrite/Keep
// choice actually reaches a resolution the backend consumes) when it carries
// a real field array. Fixed-event moved/scopeChanged decisions carry
// field: null (reconciliationReport.js addFixedEventDecision) and have no
// backend resolution consumer (electron/ops/ingest.js's fixed-event loop
// never reads a resolution) — the Overwrite/Keep gate must not pretend
// otherwise for those.
describe('isBackedConfirmChange', () => {
  it('true when field is a non-empty array (a real protected-field delta)', () => {
    expect(isBackedConfirmChange(confirmChangeDecision({ field: ['max_per_week'] }))).toBe(true)
  })
  it('false when field is null (a fixed-event drift fact, no resolution consumer)', () => {
    expect(isBackedConfirmChange(confirmChangeDecision({ field: null }))).toBe(false)
  })
  it('false for any non-confirm_change kind', () => {
    expect(isBackedConfirmChange(confirmValueDecision())).toBe(false)
    expect(isBackedConfirmChange(legacyPriorityDecision())).toBe(false)
  })
})

describe('applyResolutions — a NOT-backed confirm_change (fixed-event drift) never emits a resolution', () => {
  it('regardless of which local answer is given, or none at all', () => {
    const decision = confirmChangeDecision({ entity: 'anchor_activities', field: null, entityName: 'Movie Night' })
    for (const answer of [undefined, { choice: 'accept' }, { choice: 'keep' }, { ack: true }]) {
      const { resolutions } = applyResolutions({
        approved: {},
        decisions: [decision],
        answers: answer ? { [decision.id]: answer } : {},
      })
      expect(resolutions).toEqual([])
    }
  })
})

// Sub-slice 4 (docs/adr/2026-08-17-onescreen-reconciliation-merge.md §3, A1)
// — the fixed-event hold-back, symmetric to the `approved` hold-back above:
// an unresolved fixed-event confirm_value must not ship in the outgoing
// fixedEvents[] commitIngest sees. Matched by (name, time_block, days) — the
// A1 discriminator — never by name alone.
function fixedEventValueDecision(overrides = {}) {
  return {
    id: 'anchor_activities:null:confirm_value:1 of 2 groups not imported:Free Swim:Afternoon:Monday',
    kind: 'confirm_value', entity: 'anchor_activities', entityId: null,
    entityName: 'Free Swim', field: null, confidence: 'low', proposedValue: null,
    timeBlock: 'Afternoon', days: ['Monday'],
    unknowns: [], evidence: null, reason: '1 of 2 groups not imported', ...overrides,
  }
}

describe('applyResolutions — fixed-event hold-back (sub-slice 4)', () => {
  it('an UNRESOLVED fixed-event confirm_value is held back: its event is removed from the outgoing fixedEvents[]', () => {
    const decision = fixedEventValueDecision()
    const fe = { name: 'Free Swim', time_block: 'Afternoon', days: ['Monday'], scope: { is_all_groups: true } }
    const { fixedEvents } = applyResolutions({
      approved: {},
      decisions: [decision],
      answers: {}, // unresolved
      fixedEvents: [fe],
    })
    expect(fixedEvents).toEqual([])
  })

  it('a RESOLVED (looks_right) fixed-event confirm_value ships its event unchanged', () => {
    const decision = fixedEventValueDecision()
    const fe = { name: 'Free Swim', time_block: 'Afternoon', days: ['Monday'], scope: { is_all_groups: true } }
    const { fixedEvents } = applyResolutions({
      approved: {},
      decisions: [decision],
      answers: { [decision.id]: { action: 'looks_right' } },
      fixedEvents: [fe],
    })
    expect(fixedEvents).toEqual([fe])
  })

  it('two same-named fixed events on different days: resolving one holds only the unresolved one — proves name-alone matching would be wrong', () => {
    const decisionMonday = fixedEventValueDecision({
      id: 'anchor_activities:null:confirm_value:r:Free Swim:Afternoon:Monday',
      timeBlock: 'Afternoon', days: ['Monday'],
    })
    const decisionTuesday = fixedEventValueDecision({
      id: 'anchor_activities:null:confirm_value:r:Free Swim:Afternoon:Tuesday',
      timeBlock: 'Afternoon', days: ['Tuesday'],
    })
    const feMonday = { name: 'Free Swim', time_block: 'Afternoon', days: ['Monday'], scope: { is_all_groups: true } }
    const feTuesday = { name: 'Free Swim', time_block: 'Afternoon', days: ['Tuesday'], scope: { is_all_groups: true } }
    const { fixedEvents } = applyResolutions({
      approved: {},
      decisions: [decisionMonday, decisionTuesday],
      answers: { [decisionMonday.id]: { action: 'looks_right' } }, // only Monday resolved
      fixedEvents: [feMonday, feTuesday],
    })
    expect(fixedEvents).toEqual([feMonday])
  })

  it('an understood/HIGH fixed event with no decision at all always ships, unaffected', () => {
    const fe = { name: 'Mifkad', time_block: 'Morning', days: ['Monday', 'Tuesday'], scope: { is_all_groups: true } }
    const { fixedEvents } = applyResolutions({
      approved: {},
      decisions: [],
      answers: {},
      fixedEvents: [fe],
    })
    expect(fixedEvents).toEqual([fe])
  })

  it('an absent fixedEvents input degrades to an empty array, not a throw', () => {
    const { fixedEvents } = applyResolutions({ approved: {}, decisions: [], answers: {} })
    expect(fixedEvents).toEqual([])
  })
})
