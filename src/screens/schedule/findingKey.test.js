import { describe, it, expect } from 'vitest'
import { findingDismissKey } from './findingKey'

describe('findingDismissKey', () => {
  it('same coordinates AND same magnitude produce the same key (dismissal survives incidental edits)', () => {
    const a = { kind: 'UNDERSERVED', groupId: 'g1', activityId: 'swim', got: 2, needed: 3 }
    const b = { kind: 'UNDERSERVED', groupId: 'g1', activityId: 'swim', got: 2, needed: 3 }
    expect(findingDismissKey(a)).toBe(findingDismissKey(b))
  })

  it('same coordinates but a WORSE magnitude produces a different key (finding resurfaces)', () => {
    const dismissed = { kind: 'UNDERSERVED', groupId: 'g1', activityId: 'swim', got: 2, needed: 3 }
    const worse = { kind: 'UNDERSERVED', groupId: 'g1', activityId: 'swim', got: 1, needed: 3 }
    expect(findingDismissKey(worse)).not.toBe(findingDismissKey(dismissed))
  })

  it('a changed target (needed) also produces a different key', () => {
    const a = { kind: 'UNDERSERVED', groupId: 'g1', activityId: 'swim', got: 2, needed: 3 }
    const b = { kind: 'UNDERSERVED', groupId: 'g1', activityId: 'swim', got: 2, needed: 4 }
    expect(findingDismissKey(a)).not.toBe(findingDismissKey(b))
  })

  it('DISTRIBUTION keys on beforeCount and requiredBefore', () => {
    const a = { kind: 'DISTRIBUTION', groupId: 'g1', activityId: 'swim', beforeCount: 1, requiredBefore: 2 }
    const b = { kind: 'DISTRIBUTION', groupId: 'g1', activityId: 'swim', beforeCount: 1, requiredBefore: 2 }
    const changed = { kind: 'DISTRIBUTION', groupId: 'g1', activityId: 'swim', beforeCount: 0, requiredBefore: 2 }
    expect(findingDismissKey(a)).toBe(findingDismissKey(b))
    expect(findingDismissKey(changed)).not.toBe(findingDismissKey(a))
  })

  it('different coordinates never collide', () => {
    const a = { kind: 'UNDERSERVED', groupId: 'g1', activityId: 'swim', got: 2, needed: 3 }
    const b = { kind: 'UNDERSERVED', groupId: 'g2', activityId: 'swim', got: 2, needed: 3 }
    const c = { kind: 'UNDERSERVED', groupId: 'g1', activityId: 'art', got: 2, needed: 3 }
    expect(new Set([findingDismissKey(a), findingDismissKey(b), findingDismissKey(c)]).size).toBe(3)
  })

  // The masking scenario, expressed as the exact composition ScheduleScreen
  // runs: dismissFinding writes findingDismissKey(f) into the Set, and the
  // activeFindings filter drops any finding whose findingDismissKey(f) is in it.
  // Both sides route through the same helper, so this reproduces the real
  // predicate without rendering the screen.
  describe('dismiss → recompute masking behavior', () => {
    const dismiss = (set, f) => new Set(set).add(findingDismissKey(f))
    const activeFindings = (findings, dismissed) =>
      findings.filter(f => !dismissed.has(findingDismissKey(f)))

    it('an unchanged finding at the same coordinates STAYS dismissed after recompute', () => {
      const dismissed = dismiss(new Set(), { kind: 'UNDERSERVED', groupId: 'g1', activityId: 'swim', got: 2, needed: 3 })
      const recomputed = [{ kind: 'UNDERSERVED', groupId: 'g1', activityId: 'swim', got: 2, needed: 3 }]
      expect(activeFindings(recomputed, dismissed)).toHaveLength(0)
    })

    it('a materially WORSE finding at the same coordinates is NOT masked (resurfaces)', () => {
      const dismissed = dismiss(new Set(), { kind: 'UNDERSERVED', groupId: 'g1', activityId: 'swim', got: 2, needed: 3 })
      const recomputed = [{ kind: 'UNDERSERVED', groupId: 'g1', activityId: 'swim', got: 1, needed: 3 }]
      const active = activeFindings(recomputed, dismissed)
      expect(active).toHaveLength(1)
      expect(active[0].got).toBe(1)
    })
  })

  it('binary kinds use coordinate-only keys, ignoring absent magnitude fields', () => {
    // ANCHOR_DUPLICATE (T182) and DANGLING_LOCATION carry no got/needed — their
    // lifecycle is presence-only, cleared by the regenerate reset, so a stable
    // coordinate key is correct.
    const anchorDup = { kind: 'ANCHOR_DUPLICATE', groupId: 'g1', activityId: 'lunch' }
    expect(findingDismissKey(anchorDup)).toBe('g1|lunch|ANCHOR_DUPLICATE')

    const dangling = { kind: 'DANGLING_LOCATION', groupId: null, activityId: 'swim' }
    expect(findingDismissKey(dangling)).toBe('null|swim|DANGLING_LOCATION')

    // A kind we don't special-case falls through to the base key deterministically.
    const unknown = { kind: 'SOMETHING_NEW', groupId: 'g1', activityId: 'swim', got: 9 }
    expect(findingDismissKey(unknown)).toBe('g1|swim|SOMETHING_NEW')
  })
})
