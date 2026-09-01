import { describe, it, expect } from 'vitest'
import { inferActivityRules } from './activityRules.js'

// Minimal helpers to build the same shapes extractEntities/preview produce.
function seenCounts(activities, unitShare) {
  return { activities, activityUnitShare: unitShare ?? {} }
}

describe('inferActivityRules', () => {
  it('computes weekly min/max from appearances / groups (NOT / days)', () => {
    // 12 appearances across 3 groups -> 12/3 = 4 per group per week. dayCount (4)
    // is passed but must NOT divide — the old /days made this read as 1.
    const activityPages = { swim: ['Yeladim', 'Bogrim', 'Amichai'] }
    const counts = seenCounts({ Swim: 12 }, { swim: 1 })
    const rules = inferActivityRules(['Swim'], activityPages, counts, 4, ['Yeladim', 'Bogrim', 'Amichai'])
    const rule = rules.get('Swim')
    expect(rule.min_per_week).toBe(4)
    expect(rule.max_per_week).toBe(6) // observed floor + 2 headroom
  })

  // B4 (docs/adr/2026-08-10-ingestion-evidence-persistence.md): support is
  // additive — every other field on the rule is unchanged by its presence.
  it('attaches the observation support the derived fields came from', () => {
    const activityPages = { swim: ['Yeladim', 'Bogrim', 'Amichai'] }
    const counts = seenCounts({ Swim: 12 }, { swim: 1 })
    const rules = inferActivityRules(['Swim'], activityPages, counts, 4, ['Yeladim', 'Bogrim', 'Amichai'])
    const rule = rules.get('Swim')
    expect(rule.support).toEqual({
      matched_groups: ['Yeladim', 'Bogrim', 'Amichai'],
      appearances: 12,
      eligible_group_count: 3,
    })
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

  // B2: prevalence (unitShare) is not a legitimate basis for priority — an
  // inferred activity's priority is UNKNOWN (the key is omitted entirely),
  // regardless of how frequently it appeared. Resolution to a safe default
  // happens at generation time (resolvePriorityForGeneration.js), not here.
  it('inferred activities never carry a priority key, regardless of prevalence', () => {
    const allGroups = ['A', 'B']
    const activityPages = { high: ['A'], nearhigh: ['A'], low: ['A'] }
    const counts = seenCounts({ High: 4, Nearhigh: 4, Low: 4 }, { high: 0.8, nearhigh: 0.79, low: 0.2 })
    const rules = inferActivityRules(['High', 'Nearhigh', 'Low'], activityPages, counts, 2, allGroups)
    expect('priority' in rules.get('High')).toBe(false)
    expect('priority' in rules.get('Nearhigh')).toBe(false)
    expect('priority' in rules.get('Low')).toBe(false)
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
  // Classifier-sequencing fix (docs/adr/2026-08-23-activity-recurrence-tiers-ingestion.md
  // §4.1/§6 step 3): a name already classified as a pinned (non-dual-use)
  // Asserted fixed event must not also receive a spurious Obligation rule.
  describe('excludeNames', () => {
    it('emits no rule for a name in excludeNames', () => {
      const allGroups = ['A', 'B', 'C']
      const activityPages = { lunch: allGroups }
      const counts = seenCounts({ Lunch: 5 }, { lunch: 1 })
      const rules = inferActivityRules(['Lunch'], activityPages, counts, 5, allGroups, ['Lunch'])
      expect(rules.has('Lunch')).toBe(false)
    })

    it('a name NOT in excludeNames still receives its normal rule', () => {
      const allGroups = ['A', 'B', 'C']
      const activityPages = { swim: ['A', 'B', 'C'] }
      const counts = seenCounts({ Swim: 12 }, { swim: 1 })
      const rules = inferActivityRules(['Swim', 'Lunch'], activityPages, counts, 4, allGroups, ['Lunch'])
      expect(rules.has('Swim')).toBe(true)
      expect(rules.get('Swim').min_per_week).toBe(4) // 12 appearances / 3 groups
    })

    it('excludeNames matching is normalized the same as internal keying', () => {
      const allGroups = ['A', 'B', 'C']
      const activityPages = { lunch: allGroups }
      const counts = seenCounts({ Lunch: 5 }, { lunch: 1 })
      const rules = inferActivityRules(['Lunch'], activityPages, counts, 5, allGroups, ['  LUNCH  '])
      expect(rules.has('Lunch')).toBe(false)
    })

    it('empty/omitted excludeNames leaves behavior unchanged (backward compat)', () => {
      const allGroups = ['A', 'B', 'C']
      const activityPages = { swim: allGroups }
      const counts = seenCounts({ Swim: 12 }, { swim: 1 })
      const withDefault = inferActivityRules(['Swim'], activityPages, counts, 4, allGroups)
      const withEmpty = inferActivityRules(['Swim'], activityPages, counts, 4, allGroups, [])
      expect(withDefault.get('Swim')).toEqual(withEmpty.get('Swim'))
    })
  })

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
