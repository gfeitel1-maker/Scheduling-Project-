import { describe, it, expect } from 'vitest'
import { buildPlan } from './buildPlan.js'

// S1a — buildPlan RECOGNITION + AMBIGUITY (ADR 2026-08-08-s1a §1, §3).
//
// buildPlan is pure: given a source proposal and a read-only `existing`
// snapshot it decides, per approved name, whether the plan CREATEs, recognizes
// as UNCHANGED (exact normalized-name match), or surfaces an ambiguous_identity
// CONFLICT (one incoming label normalize-matching more than one live row).

const camp = 'camp-1'

describe('buildPlan recognition (exact_name tier)', () => {
  it('recognizes an exact normalized-name match as unchanged with tier exact_name', () => {
    const plan = buildPlan(
      { approved: { activities: ['Art'] }, camp_id: camp },
      { activities: [{ id: 'a-live', name: 'art ' }] }, // normalizes to 'art'
    )
    expect(plan.items).toHaveLength(1)
    const item = plan.items[0]
    expect(item.op).toBe('unchanged')
    expect(item.entity_id).toBe('a-live')
    expect(item.evidence.tier).toBe('exact_name')
  })

  it('emits a create with tier new for a genuinely new label', () => {
    const plan = buildPlan(
      { approved: { activities: ['Archery'] }, camp_id: camp },
      { activities: [{ id: 'a-live', name: 'Swim' }] },
    )
    expect(plan.items).toHaveLength(1)
    const item = plan.items[0]
    expect(item.op).toBe('create')
    expect(item.entity_id).toBeNull()
    expect(item.evidence.tier).toBe('new')
  })

  it('is a create when existing is null (blind-create path preserved)', () => {
    const plan = buildPlan({ approved: { activities: ['Swim'] }, camp_id: camp }, null)
    expect(plan.items[0].op).toBe('create')
  })
})

describe('buildPlan ambiguous_identity (normalize/UNIQUE mismatch, §3)', () => {
  it('surfaces a conflict with BOTH candidates and no auto-pick when one label matches >1 live row', () => {
    const plan = buildPlan(
      { approved: { activities: ['Art'] }, camp_id: camp },
      { activities: [{ id: 'art-1', name: 'Art' }, { id: 'art-2', name: 'art ' }] },
    )
    expect(plan.items).toHaveLength(1)
    const item = plan.items[0]
    expect(item.op).toBe('conflict')
    expect(item.reason).toBe('ambiguous_identity')
    expect(item.entity_id).toBeNull()
    const ids = item.evidence.candidates.map((c) => c.id).sort()
    expect(ids).toEqual(['art-1', 'art-2'])
  })

  it('does not let the second same-normalized row silently overwrite the first', () => {
    // Regression on the old `already` Map: a second same-normalized existing row
    // used to clobber the first, silently auto-picking the last. Now it is a
    // conflict carrying every colliding candidate.
    const plan = buildPlan(
      { approved: { tiers: ['Aleph'] }, camp_id: camp },
      { tiers: [{ id: 't1', name: 'Aleph' }, { id: 't2', name: 'aleph' }] },
    )
    expect(plan.items[0].op).toBe('conflict')
    expect(plan.items[0].evidence.candidates).toHaveLength(2)
  })
})

// ADR 2026-08-09 Decision 2 — item._humanFields, normalized to the STORED
// column name (unit -> tier_id), so commitCreate/commitUpdate know which
// field-writes to stamp source:'human' instead of 'import'.
describe('buildPlan._humanFields (ADR 2026-08-09 Decision 2)', () => {
  it('attaches _humanFields on a create item, normalized unit -> tier_id', () => {
    const plan = buildPlan({
      approved: { groups: [{ name: 'Chagalls', fields: { unit: 'Kfar A' } }] },
      camp_id: camp,
      humanEditedFields: { groups: { Chagalls: ['unit'] } },
    }, null)
    expect(plan.items[0].op).toBe('create')
    expect(plan.items[0]._humanFields).toEqual(['tier_id'])
  })

  it('a create item with no humanEditedFields entry gets an empty _humanFields', () => {
    const plan = buildPlan({
      approved: { groups: [{ name: 'Chagalls', fields: { unit: 'Kfar A' } }] },
      camp_id: camp,
    }, null)
    expect(plan.items[0]._humanFields).toEqual([])
  })

  it('attaches _humanFields on an update item', () => {
    const plan = buildPlan({
      approved: { groups: [{ name: 'Chagalls', fields: { unit: 'Kfar B' } }] },
      camp_id: camp,
      humanEditedFields: { groups: { Chagalls: ['unit'] } },
    }, { groups: [{ id: 'g1', name: 'Chagalls', unit_name: 'Kfar A' }] })
    expect(plan.items[0].op).toBe('update')
    expect(plan.items[0]._humanFields).toEqual(['tier_id'])
  })

  it('attaches _humanFields on a clear item', () => {
    const plan = buildPlan({
      approved: { groups: [{ name: 'Chagalls', clears: ['unit'] }] },
      camp_id: camp,
      humanEditedFields: { groups: { Chagalls: ['unit'] } },
    }, { groups: [{ id: 'g1', name: 'Chagalls', unit_name: 'Kfar A' }] })
    expect(plan.items[0].op).toBe('clear')
    expect(plan.items[0]._humanFields).toEqual(['tier_id'])
  })
})

// B2 — a director's hand-set priority ('human' field) must survive a
// re-import where the source's inferred rule now omits priority entirely
// (UNKNOWN, activityRules.js no longer manufactures it from prevalence).
// MATCH_AND_MERGE_SEMANTICS §3: blank/absent in the source -> preserve,
// never diff. Priority simply not appearing in `fields` reproduces this,
// with no special-casing needed in buildPlan itself.
describe('buildPlan preserves a human-set priority across re-import (B2)', () => {
  it('a source rule with no priority key produces no priority delta on an update item', () => {
    const plan = buildPlan({
      approved: { activities: [{ name: 'Swim', fields: { min_per_week: 2, max_per_week: 3 } }] },
      camp_id: camp,
      humanEditedFields: { activities: { Swim: ['priority'] } },
    }, {
      activities: [{ id: 'act-1', name: 'Swim', priority: 'high', min_per_week: 1, max_per_week: 1, eligible_group_names: [] }],
    })
    expect(plan.items).toHaveLength(1)
    const item = plan.items[0]
    expect(item.op).toBe('update')
    expect('priority' in item.fields).toBe(false)
  })

  it('an unchanged-priority activity with only other deltas absent stays unchanged (no priority field appears)', () => {
    const plan = buildPlan({
      approved: { activities: [{ name: 'Swim', fields: {} }] },
      camp_id: camp,
    }, {
      activities: [{ id: 'act-1', name: 'Swim', priority: 'high', eligible_group_names: [] }],
    })
    expect(plan.items[0].op).toBe('unchanged')
    expect(plan.items[0].fields).toEqual({})
  })
})
