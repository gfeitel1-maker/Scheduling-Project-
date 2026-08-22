import { describe, it, expect } from 'vitest'
import { RULE_FIELDS, tierForField, worstTier, deriveActivityProvenance } from './ruleProvenance.js'

describe('tierForField', () => {
  it('is confirmed when source is null (hand-created, never imported)', () => {
    expect(tierForField(null, null)).toBe('confirmed')
  })

  it('is confirmed when source is human, regardless of any evidence tag', () => {
    expect(tierForField('human', 'inferred')).toBe('confirmed')
  })

  it('is observed when source is import and evidence tag is observed', () => {
    expect(tierForField('import', 'observed')).toBe('observed')
  })

  it('is inferred when source is import and evidence tag is inferred', () => {
    expect(tierForField('import', 'inferred')).toBe('inferred')
  })

  it('is inferred when source is import and evidence tag is unknown', () => {
    expect(tierForField('import', 'unknown')).toBe('inferred')
  })

  it('is inferred (no detail) when source is import but there is no evidence row at all', () => {
    expect(tierForField('import', null)).toBe('inferred')
  })
})

describe('worstTier', () => {
  it('returns null for an empty list', () => {
    expect(worstTier([])).toBe(null)
  })

  it('picks inferred over observed and confirmed', () => {
    expect(worstTier(['confirmed', 'observed', 'inferred'])).toBe('inferred')
  })

  it('picks observed over confirmed when nothing is inferred', () => {
    expect(worstTier(['confirmed', 'observed'])).toBe('observed')
  })

  it('is confirmed only when everything is confirmed', () => {
    expect(worstTier(['confirmed', 'confirmed'])).toBe('confirmed')
  })
})

describe('deriveActivityProvenance', () => {
  it('covers exactly the 3 scoped rule fields (min/max-per-week, eligible groups, location)', () => {
    const rows = deriveActivityProvenance({}, {})
    expect(rows.map((r) => r.key)).toEqual(['min_per_week', 'eligible_group_ids', 'location_id'])
  })

  it('derives each row tier from its own field sources + evidence', () => {
    const fieldSources = { min_per_week: 'import', max_per_week: 'import', eligible_group_ids: 'human', location_id: 'import' }
    const evidenceByField = {
      min_per_week: { tag: 'inferred', confidence: 'low', support: {} },
      location: { tag: 'observed', confidence: 'high', support: { location: 'Pool Deck' } },
    }
    const rows = deriveActivityProvenance(fieldSources, evidenceByField)
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
    expect(byKey.min_per_week.tier).toBe('inferred')
    expect(byKey.eligible_group_ids.tier).toBe('confirmed')
    expect(byKey.location_id.tier).toBe('observed')
  })

  it('has no evidence row on a field with no import_evidence, so it renders as a plain confirmed/inferred row without a support sentence', () => {
    const fieldSources = { min_per_week: null, max_per_week: null, eligible_group_ids: null, location_id: null }
    const rows = deriveActivityProvenance(fieldSources, {})
    expect(rows.every((r) => r.evidence === null)).toBe(true)
    expect(rows.every((r) => r.tier === 'confirmed')).toBe(true)
  })
})
