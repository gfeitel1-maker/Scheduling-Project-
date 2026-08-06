import { describe, it, expect } from 'vitest'
import { inferActivityRules } from './activityRules.js'

// Minimal helpers to build the same shapes extractEntities/preview produce.
function seenCounts(activities, unitShare) {
  return { activities, activityUnitShare: unitShare ?? {} }
}

describe('inferActivityRules', () => {
  it('computes min/max per week from appearances / groups / days', () => {
    // 12 appearances across 3 groups over 4 days -> 12/3/4 = 1 per group per week.
    const activityPages = { swim: ['Yeladim', 'Bogrim', 'Amichai'] }
    const counts = seenCounts({ Swim: 12 }, { swim: 1 })
    const rules = inferActivityRules(['Swim'], activityPages, counts, 4, ['Yeladim', 'Bogrim', 'Amichai'])
    const rule = rules.get('Swim')
    expect(rule.min_per_week).toBe(1)
    expect(rule.max_per_week).toBe(2)
  })

  it('universal activity (appears in every group) gets eligible_group_names = null', () => {
    const allGroups = ['Yeladim', 'Bogrim', 'Amichai']
    const activityPages = { swim: allGroups }
    const counts = seenCounts({ Swim: 12 }, { swim: 1 })
    const rules = inferActivityRules(['Swim'], activityPages, counts, 4, allGroups)
    expect(rules.get('Swim').eligible_group_names).toBeNull()
  })

  it('strict subset gets exactly those group names', () => {
    const allGroups = ['Yeladim', 'Bogrim', 'Amichai', 'Gesher']
    const activityPages = { ceramics: ['Yeladim', 'Bogrim'] }
    const counts = seenCounts({ Ceramics: 8 }, { ceramics: 0.9 })
    const rules = inferActivityRules(['Ceramics'], activityPages, counts, 4, allGroups)
    expect(rules.get('Ceramics').eligible_group_names).toEqual(['Yeladim', 'Bogrim'])
  })

  it('low-appearance ambiguous activity (1 group, count 1) falls back to null', () => {
    const allGroups = ['Yeladim', 'Bogrim', 'Amichai', 'Gesher']
    const activityPages = { archery: ['Yeladim'] }
    const counts = seenCounts({ Archery: 1 }, { archery: 0.25 })
    const rules = inferActivityRules(['Archery'], activityPages, counts, 4, allGroups)
    expect(rules.get('Archery').eligible_group_names).toBeNull()
  })

  // priority is the engine's two-valued contract ('high'/'low' —
  // buildSchedule.js's runRound only ever filters for one of those two
  // strings), not the original three-tier 1/2/3 (round 2 review, Fix 1).
  it('priority thresholds: unitShare 0.8 -> high, 0.79 -> low, 0.2 -> low (boundary values)', () => {
    const allGroups = ['A', 'B']
    const activityPages = { high: ['A'], nearhigh: ['A'], low: ['A'] }
    const counts = seenCounts({ High: 4, Nearhigh: 4, Low: 4 }, { high: 0.8, nearhigh: 0.79, low: 0.2 })
    const rules = inferActivityRules(['High', 'Nearhigh', 'Low'], activityPages, counts, 2, allGroups)
    expect(rules.get('High').priority).toBe('high')
    expect(rules.get('Nearhigh').priority).toBe('low')
    expect(rules.get('Low').priority).toBe('low')
  })

  it('dayCount === 0 and empty activityPages produce safe defaults, no NaN, no crash', () => {
    const rules = inferActivityRules(['Mystery'], {}, seenCounts({ Mystery: 5 }, {}), 0, ['A', 'B'])
    const rule = rules.get('Mystery')
    expect(rule.eligible_group_names).toBeNull()
    expect(Number.isFinite(rule.min_per_week)).toBe(true)
    expect(Number.isFinite(rule.max_per_week)).toBe(true)
    expect(rule.min_per_week).toBeGreaterThanOrEqual(1)
    expect(rule.max_per_week).toBeGreaterThanOrEqual(1)
  })

  it('every returned min/max is a finite integer >= 1 across all cases', () => {
    const allGroups = ['A', 'B', 'C']
    const activityPages = { rare: ['A'], common: ['A', 'B', 'C'] }
    const counts = seenCounts({ Rare: 1, Common: 30 }, { rare: 0.33, common: 1 })
    const rules = inferActivityRules(['Rare', 'Common'], activityPages, counts, 5, allGroups)
    for (const rule of rules.values()) {
      expect(Number.isInteger(rule.min_per_week)).toBe(true)
      expect(Number.isInteger(rule.max_per_week)).toBe(true)
      expect(rule.min_per_week).toBeGreaterThanOrEqual(1)
      expect(rule.max_per_week).toBeGreaterThanOrEqual(1)
    }
  })

  it('marks every returned rule as _inferred', () => {
    const rules = inferActivityRules(['Swim'], { swim: ['A'] }, seenCounts({ Swim: 4 }, { swim: 1 }), 2, ['A'])
    expect(rules.get('Swim')._inferred).toBe(true)
  })

  // T35 round 2, Fix 2b: no page-level signal (empty activityPages, or this
  // activity just never matched) must be distinguishable from a confident
  // "this is universal" judgement — both produce eligible_group_names: null,
  // but only one is actually an inference the director should trust.
  describe('eligibility_known (T35 Fix 2b)', () => {
    it('is false when activityPages is empty entirely', () => {
      const rules = inferActivityRules(['Mystery'], {}, seenCounts({ Mystery: 5 }, {}), 2, ['A', 'B'])
      expect(rules.get('Mystery').eligibility_known).toBe(false)
      expect(rules.get('Mystery').eligible_group_names).toBeNull()
    })

    it('is true when the activity appears in every group (confident universal)', () => {
      const allGroups = ['A', 'B']
      const rules = inferActivityRules(['Swim'], { swim: allGroups }, seenCounts({ Swim: 8 }, { swim: 1 }), 2, allGroups)
      expect(rules.get('Swim').eligibility_known).toBe(true)
      expect(rules.get('Swim').eligible_group_names).toBeNull()
    })

    it('is true for a strict subset match, even though ambiguous fallback also lands on null', () => {
      // matchedGroups.length > 0 in both cases below — some signal existed —
      // so eligibility_known is true even where the ambiguity guard still
      // falls back to null for the value itself.
      const allGroups = ['A', 'B', 'C', 'D']
      const rules = inferActivityRules(['Archery'], { archery: ['A'] }, seenCounts({ Archery: 1 }, { archery: 0.25 }), 4, allGroups)
      expect(rules.get('Archery').eligibility_known).toBe(true)
      expect(rules.get('Archery').eligible_group_names).toBeNull()
    })
  })
})
