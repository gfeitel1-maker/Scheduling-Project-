import { describe, it, expect } from 'vitest'
import { buildPlan } from './buildPlan.js'

// S1b §4 — the confirmed_alias matching tier: uuid -> confirmed_alias ->
// exact_name -> human_confirmed -> new. docs/adr/2026-08-09-s1b-host-local-aliases.md
//
// buildPlan stays pure: `existing.aliases` is the host-local read
// buildExistingSnapshot attaches (electron/ops/ingest.js's listAliasMap) —
// here it is handed in directly, as a plain Map, exactly as the real caller
// shapes it.

const camp = 'camp-1'

function aliasMap(entity, pairs) {
  return { [entity]: new Map(pairs) }
}

describe('buildPlan confirmed_alias tier', () => {
  it('resolves a label with a confirmed alias and no exact-name match, tier confirmed_alias', () => {
    const existing = {
      groups: [{ id: 'g-live', name: 'Bunk One' }],
      aliases: aliasMap('groups', [['group 1', 'g-live']]),
    }
    const plan = buildPlan({ approved: { groups: ['Group 1'] }, camp_id: camp }, existing)
    expect(plan.items).toHaveLength(1)
    const item = plan.items[0]
    expect(item.op).toBe('unchanged')
    expect(item.entity_id).toBe('g-live')
    expect(item.evidence.tier).toBe('confirmed_alias')
  })

  it('is ranked ABOVE exact_name: alias wins even when the label ALSO matches nothing by exact name', () => {
    const existing = {
      groups: [{ id: 'g-live', name: 'Something Else' }],
      aliases: aliasMap('groups', [['group 1', 'g-live']]),
    }
    const plan = buildPlan({ approved: { groups: ['Group 1'] }, camp_id: camp }, existing)
    expect(plan.items[0].entity_id).toBe('g-live')
    expect(plan.items[0].evidence.tier).toBe('confirmed_alias')
  })

  it('is ranked BELOW uuid: a shoresh_id match wins even when a DIFFERENT alias exists for the same label', () => {
    const existing = {
      groups: [{ id: 'g-uuid-target', name: 'Bunk One' }, { id: 'g-alias-target', name: 'Bunk Two' }],
      aliases: aliasMap('groups', [['group 1', 'g-alias-target']]),
    }
    const plan = buildPlan(
      { approved: { groups: [{ id: 'g-uuid-target', name: 'Group 1' }] }, camp_id: camp },
      existing,
    )
    expect(plan.items[0].entity_id).toBe('g-uuid-target')
    expect(plan.items[0].evidence.tier).toBe('uuid')
  })

  it('is consistent (no divergence) when the alias target IS the sole exact-name match', () => {
    const existing = {
      groups: [{ id: 'g-live', name: 'Group 1' }],
      aliases: aliasMap('groups', [['group 1', 'g-live']]),
    }
    const plan = buildPlan({ approved: { groups: ['Group 1'] }, camp_id: camp }, existing)
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0].op).toBe('unchanged')
    expect(plan.items[0].entity_id).toBe('g-live')
  })

  it('does nothing when existing.aliases is absent (replace mode / no alias support)', () => {
    const existing = { groups: [{ id: 'g-live', name: 'Group 1' }] }
    const plan = buildPlan({ approved: { groups: ['Group 1'] }, camp_id: camp }, existing)
    expect(plan.items[0].evidence.tier).toBe('exact_name')
  })
})

describe('buildPlan alias_divergence', () => {
  it('surfaces a conflict, never auto-picks, when the alias points to A but a DIFFERENT live entity B exact-name matches', () => {
    const existing = {
      groups: [{ id: 'g-alias-target', name: 'Something Else' }, { id: 'g-exact-match', name: 'Group 1' }],
      aliases: aliasMap('groups', [['group 1', 'g-alias-target']]),
    }
    const plan = buildPlan({ approved: { groups: ['Group 1'] }, camp_id: camp }, existing)
    expect(plan.items).toHaveLength(1)
    const item = plan.items[0]
    expect(item.op).toBe('conflict')
    expect(item.reason).toBe('alias_divergence')
    expect(item.evidence.tier).toBe('confirmed_alias')
    const ids = item.evidence.candidates.map((c) => c.id).sort()
    expect(ids).toEqual(['g-alias-target', 'g-exact-match'].sort())
  })

  it('falls through to the ordinary hierarchy if the aliased id is stale/foreign (defense in depth)', () => {
    const existing = {
      groups: [{ id: 'g-live', name: 'Group 1' }],
      aliases: aliasMap('groups', [['group 1', 'g-nonexistent']]),
    }
    const plan = buildPlan({ approved: { groups: ['Group 1'] }, camp_id: camp }, existing)
    expect(plan.items[0].op).toBe('unchanged')
    expect(plan.items[0].entity_id).toBe('g-live')
    expect(plan.items[0].evidence.tier).toBe('exact_name')
  })
})
