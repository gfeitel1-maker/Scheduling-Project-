import { describe, it, expect } from 'vitest'
import { resolveAnchorGroupIds, resolveAnchorDayIds, resolveAnchorUnitIds } from './anchorScope.js'

// resolveAnchorDayIds was extracted during the Q5 review: the "null day_id
// means EVERY day" rule had just become duplicated (Pass 1's anchorLookup and
// the day-keyed exclusion Map), which is the same shape that produced the
// weekCatalog/engine scope divergence a day earlier. These pin the rule so the
// two callers cannot drift apart again.
//
// resolveAnchorGroupIds (T180) is covered directly by the T183 precedence
// suite below, and additionally through buildSchedule's own suite.
describe('resolveAnchorDayIds', () => {
  const days = [
    { id: 'd1', label: 'Monday' },
    { id: 'd2', label: 'Tuesday' },
    { id: 'd3', label: 'Wednesday' },
  ]

  it('returns just the pinned day when day_id is set', () => {
    expect(resolveAnchorDayIds({ day_id: 'd2' }, days)).toEqual(['d2'])
  })

  it('treats a null day_id as EVERY day, never as no days', () => {
    expect(resolveAnchorDayIds({ day_id: null }, days)).toEqual(['d1', 'd2', 'd3'])
  })

  it('treats an absent day_id as every day', () => {
    expect(resolveAnchorDayIds({}, days)).toEqual(['d1', 'd2', 'd3'])
  })

  it('treats an EMPTY STRING day_id as every day — the shape a cleared form field leaves', () => {
    expect(resolveAnchorDayIds({ day_id: '' }, days)).toEqual(['d1', 'd2', 'd3'])
  })

  it('returns the pinned day even if that day is no longer in the live list', () => {
    // Deliberate: this resolves the anchor's CLAIM. Filtering a deleted day is
    // the caller's business — the placement loop simply never visits it — and
    // silently dropping it here would make a stale anchor look like an
    // all-days anchor, which is the more dangerous failure.
    expect(resolveAnchorDayIds({ day_id: 'gone' }, days)).toEqual(['gone'])
  })

  it('returns an empty list when there are no days to resolve against', () => {
    expect(resolveAnchorDayIds({ day_id: null }, [])).toEqual([])
    expect(resolveAnchorDayIds({ day_id: null }, undefined)).toEqual([])
  })

  it('tolerates a null anchor rather than throwing inside a pure engine', () => {
    expect(resolveAnchorDayIds(null, days)).toEqual(['d1', 'd2', 'd3'])
  })
})

// Groups across two divisions (tiers). Juniors = t1 (g1, g2), Seniors = t2 (g3).
const GROUPS = [
  { id: 'g1', tier_id: 't1' },
  { id: 'g2', tier_id: 't1' },
  { id: 'g3', tier_id: 't2' },
]

describe('resolveAnchorUnitIds — the division projection, one precedence with resolveAnchorGroupIds', () => {
  it('returns stored unit_ids as divisions, not inferred', () => {
    const r = resolveAnchorUnitIds({ unit_ids: ['t1'] }, GROUPS)
    expect(r).toEqual({ mode: 'divisions', unitIds: ['t1'], inferred: false })
  })

  it('reads the legacy singular unit_id as a stored division, not inferred', () => {
    const r = resolveAnchorUnitIds({ unit_id: 't2' }, GROUPS)
    expect(r).toEqual({ mode: 'divisions', unitIds: ['t2'], inferred: false })
  })

  it('reports is_all_groups as mode "all", not an enumerated list', () => {
    const r = resolveAnchorUnitIds({ is_all_groups: 1 }, GROUPS)
    expect(r).toEqual({ mode: 'all', unitIds: [], inferred: false })
  })

  it('derives divisions backward from a legacy group_ids-only row and FLAGS the answer inferred', () => {
    // Only g1 (one bunk of Juniors) — the backward derivation cannot tell this
    // from "the whole Juniors division", so the answer is an inference.
    const r = resolveAnchorUnitIds({ group_ids: ['g1'] }, GROUPS)
    expect(r).toEqual({ mode: 'divisions', unitIds: ['t1'], inferred: true })
  })

  it('returns mode "none" when the anchor claims no scope at all', () => {
    const r = resolveAnchorUnitIds({}, GROUPS)
    expect(r).toEqual({ mode: 'none', unitIds: [], inferred: false })
  })

  it('an empty unit_ids array is not a claim — it falls through to the next rule', () => {
    const r = resolveAnchorUnitIds({ unit_ids: [], is_all_groups: 1 }, GROUPS)
    expect(r).toEqual({ mode: 'all', unitIds: [], inferred: false })
  })

  it('precedence: unit_ids wins over is_all_groups, same order resolveAnchorGroupIds uses', () => {
    const anchor = { unit_ids: ['t1'], is_all_groups: 1 }
    const unit = resolveAnchorUnitIds(anchor, GROUPS)
    expect(unit).toEqual({ mode: 'divisions', unitIds: ['t1'], inferred: false })
    // The group projection must fire the SAME rule (unit_ids), not is_all_groups.
    expect(resolveAnchorGroupIds(anchor, GROUPS)).toEqual(['g1', 'g2'])
  })

  it('the two projections agree on WHICH rule fired for a division-scoped anchor', () => {
    const anchor = { unit_ids: ['t1', 't2'] }
    const unit = resolveAnchorUnitIds(anchor, GROUPS)
    const groupIds = resolveAnchorGroupIds(anchor, GROUPS)
    // divisions t1,t2 → groups g1,g2 (t1) + g3 (t2)
    expect(unit.unitIds).toEqual(['t1', 't2'])
    expect(groupIds).toEqual(['g1', 'g2', 'g3'])
  })
})
