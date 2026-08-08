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
