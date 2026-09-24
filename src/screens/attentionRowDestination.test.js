import { describe, it, expect } from 'vitest'
import { screenForAttentionRow } from './attentionRowDestination.js'

describe('screenForAttentionRow (T237)', () => {
  it('sends every reconciliation row to the fileless reconciliation door, regardless of domainTag', () => {
    expect(screenForAttentionRow({ sourceKind: 'reconciliation', domainTag: 'Scheduling' })).toBe('reconciliation')
    expect(screenForAttentionRow({ sourceKind: 'reconciliation', domainTag: 'Nowhere' })).toBe('reconciliation')
  })

  it('resolves a structure row via rootMapNav\'s domain-level fallback (structure rows carry no childKey)', () => {
    expect(screenForAttentionRow({ sourceKind: 'structure', domainTag: 'Structure' })).toBe('groups')
    expect(screenForAttentionRow({ sourceKind: 'structure', domainTag: 'Scheduling' })).toBe('activities')
  })

  it('returns null for a structure row whose domainTag has no rootMapNav target — the caller must render it inert, not navigate to nothing', () => {
    expect(screenForAttentionRow({ sourceKind: 'structure', domainTag: 'Nowhere' })).toBeNull()
  })
})
