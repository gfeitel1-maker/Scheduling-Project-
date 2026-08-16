import { describe, it, expect } from 'vitest'
import { isActivityEligibleForGroup } from './eligibility.js'

// T83 — the tier/group eligibility formula was hand-copied a third and fourth
// time inside buildSchedule.js (the placement-pass Set precompute and
// computeFindings). This test pins that the engine's own eligibility decision
// (reimplemented here from the pre-T83 shape as `engineEligible`, matching
// buildSchedule.js's Pass 0 / computeFindings loops) agrees with the shared
// src/engine/eligibility.js predicate across a matrix of list shapes, so the
// refactor that routes both engine copies through the shared predicate can be
// verified behavior-preserving.
function engineEligible(activity, group, groups) {
  const tierIds = activity.eligible_tier_ids || []
  const groupIds = activity.eligible_group_ids || []
  const eligible = new Set()
  if (tierIds.length === 0 && groupIds.length === 0) {
    for (const g of groups) eligible.add(g.id)
  } else {
    if (tierIds.length > 0) {
      const tierSet = new Set(tierIds)
      for (const g of groups) {
        if (tierSet.has(g.tier_id)) eligible.add(g.id)
      }
    }
    for (const gid of groupIds) eligible.add(gid)
  }
  return eligible.has(group?.id)
}

describe('engine/eligibility agreement matrix', () => {
  const groups = [
    { id: 'g1', tier_id: 't1' },
    { id: 'g2', tier_id: 't2' },
    { id: 'g3', tier_id: 't1' },
  ]

  // Cases with NO explicit group are crossed against every real group below.
  const cases = [
    { name: 'empty lists (both undefined)', activity: {} },
    { name: 'empty lists (both [])', activity: { eligible_tier_ids: [], eligible_group_ids: [] } },
    { name: 'tier-only, matching tier', activity: { eligible_tier_ids: ['t1'], eligible_group_ids: [] } },
    { name: 'tier-only, non-matching tier', activity: { eligible_tier_ids: ['t9'], eligible_group_ids: [] } },
    { name: 'group-only, matching group', activity: { eligible_tier_ids: [], eligible_group_ids: ['g2'] } },
    { name: 'group-only, non-matching group', activity: { eligible_tier_ids: [], eligible_group_ids: ['g9'] } },
    { name: 'both tier and group set, tier matches', activity: { eligible_tier_ids: ['t2'], eligible_group_ids: ['g9'] } },
    { name: 'both tier and group set, group matches', activity: { eligible_tier_ids: ['t9'], eligible_group_ids: ['g1'] } },
    { name: 'both tier and group set, neither matches', activity: { eligible_tier_ids: ['t9'], eligible_group_ids: ['g9'] } },
  ]

  for (const g of groups) {
    for (const c of cases) {
      it(`${c.name} vs group ${g.id}`, () => {
        expect(isActivityEligibleForGroup(c.activity, g)).toBe(engineEligible(c.activity, g, groups))
      })
    }
  }

  // A group whose tier_id matches nothing / is absent — still a real group object.
  it('missing tier_id on group, tier-only activity', () => {
    const activity = { eligible_tier_ids: ['t1'], eligible_group_ids: [] }
    const group = { id: 'g4' }
    expect(isActivityEligibleForGroup(activity, group)).toBe(engineEligible(activity, group, groups))
  })
})

// The predicate accepts a null group (guards with `group?.`); the engine copies never pass one —
// both buildSchedule.js call sites iterate the real `groups` array. This block documents that
// boundary explicitly rather than letting the agreement matrix imply null is a tested engine input.
describe('engine/eligibility — null group boundary (not a production input)', () => {
  const groups = [{ id: 'g1', tier_id: 't1' }]

  it('agrees on null group when the activity is RESTRICTED (both reject)', () => {
    const activity = { eligible_tier_ids: ['t1'], eligible_group_ids: [] }
    expect(isActivityEligibleForGroup(activity, null)).toBe(false)
    expect(engineEligible(activity, null, groups)).toBe(false)
  })

  it('DIVERGES on null group when the activity is UNRESTRICTED — documented, unreachable from buildSchedule', () => {
    const activity = {} // empty lists ⇒ "eligible for everyone"
    // Predicate short-circuits on empty lists → true, before it ever looks at the group.
    expect(isActivityEligibleForGroup(activity, null)).toBe(true)
    // Engine builds a Set of real group ids, then asks `.has(null?.id === undefined)` → false.
    expect(engineEligible(activity, null, groups)).toBe(false)
    // This cell is the ONLY disagreement; it cannot occur in buildSchedule.js, which never
    // passes a null group. If a future caller does, it must not rely on this cell.
  })
})
