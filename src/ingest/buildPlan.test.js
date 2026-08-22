import { describe, it, expect } from 'vitest'
import { buildPlan, looksLikeAMerge, createConfidenceTier, buildElectiveCandidates } from './buildPlan.js'

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

// ADR 2026-08-17-onescreen-reconciliation-merge.md §1 — moved from
// preview.test.js along with looksLikeAMerge itself (A2: relocate coverage,
// don't leave a gap).
describe('looksLikeAMerge — telling a compound name from two welded cells', () => {
  // Camp A's densest pages read two adjacent cells as one. Frequency alone
  // does not catch it: the same two cells are adjacent on many pages, so the
  // artifact recurs. What distinguishes it is that it is far rarer than each
  // of its own parts.
  it('flags a pair that is far rarer than both its parts', () => {
    const counts = { 'Opening Drama': 2, Opening: 21, Drama: 36 }
    expect(looksLikeAMerge('Opening Drama', counts)).toBe(true)
  })

  it('keeps a genuine compound name whose parts are no more common', () => {
    // "Instructional Swim" is the real activity. Without the frequency guard
    // this rule would reject it alongside the artifacts, because
    // "Instructional" and "Swim" are both proposed too.
    const counts = { 'Instructional Swim': 77, Instructional: 34, Swim: 75 }
    expect(looksLikeAMerge('Instructional Swim', counts)).toBe(false)
  })

  it('leaves a name alone when its parts were never proposed', () => {
    // "Snack and PJ Library" only splits into things nobody proposed, so there
    // is no evidence it is a merge.
    expect(looksLikeAMerge('Snack and PJ Library', { 'Snack and PJ Library': 3 })).toBe(false)
  })

  it('never flags a single word', () => {
    expect(looksLikeAMerge('Drama', { Drama: 36 })).toBe(false)
  })

  it('is safe on values it has no count for', () => {
    expect(looksLikeAMerge('Anything At All', {})).toBe(false)
  })
})

// §1 — buildPlan's real create confidence. Table-driven over the exact
// fixtures preview.test.js's "what starts ticked" describe used to cover.
describe('buildPlan create confidence (§1)', () => {
  const seenCounts = (activities, activityUnitShare = {}) => ({ activities, activityUnitShare })

  it('stamps tier new for a confident candidate (seen enough, not a merge)', () => {
    expect(createConfidenceTier('activities', 'Drama', seenCounts({ Drama: 36 }))).toBe('new')
  })

  it('stamps tier low for a seen-once candidate', () => {
    expect(createConfidenceTier('activities', 'One Off', seenCounts({ 'One Off': 1 }))).toBe('low')
  })

  it('stamps tier low for a name that looks like a welded merge', () => {
    const counts = { 'Opening Drama': 2, Opening: 21, Drama: 36 }
    expect(createConfidenceTier('activities', 'Opening Drama', seenCounts(counts))).toBe('low')
  })

  it('trusts a rare-camp-wide activity that is universal within its own unit (activityUnitShare)', () => {
    expect(createConfidenceTier(
      'activities', 'Service Project',
      seenCounts({ 'Service Project': 1 }, { 'service project': 1 }),
    )).toBe('new')
  })

  it('stamps tier low unconditionally for locations, regardless of frequency', () => {
    expect(createConfidenceTier('locations', 'Pool', seenCounts({}))).toBe('low')
    // Even a high-frequency name (as if it were an activity) stays low.
    expect(createConfidenceTier('locations', 'Pool', { locations: { Pool: 50 }, activityUnitShare: {} })).toBe('low')
  })

  it('additive-degradation: seenCounts omitted -> every create stays tier new (today\'s behavior)', () => {
    expect(createConfidenceTier('activities', 'One Off', null)).toBe('new')
    expect(createConfidenceTier('activities', 'One Off', undefined)).toBe('new')
  })

  it('a low-confidence create candidate reaches buildPlan as evidence.tier low', () => {
    const plan = buildPlan(
      { approved: { activities: ['One Off'] }, camp_id: camp, seenCounts: seenCounts({ 'One Off': 1 }) },
      null,
    )
    expect(plan.items[0].op).toBe('create')
    expect(plan.items[0].evidence.tier).toBe('low')
  })

  it('a confident create candidate reaches buildPlan as evidence.tier new', () => {
    const plan = buildPlan(
      { approved: { activities: ['Drama'] }, camp_id: camp, seenCounts: seenCounts({ Drama: 36 }) },
      null,
    )
    expect(plan.items[0].evidence.tier).toBe('new')
  })

  // A5 (Red Hat, LOW) — Risk 5 holds AS LONG AS the frequency check is added
  // ONLY inside emitCreate. A name that is BOTH a create-candidate elsewhere
  // in the batch AND resolves to an existing row (unchanged) must keep its
  // exact_name/HIGH identity tier regardless of what seenCounts says about
  // frequency — the create-confidence check must never leak into the
  // recognized (update/unchanged) arm.
  it('a name that resolves unchanged stays tier exact_name/HIGH even when seenCounts marks it low-confidence', () => {
    const plan = buildPlan(
      { approved: { activities: ['One Off'] }, camp_id: camp, seenCounts: seenCounts({ 'One Off': 1 }) },
      { activities: [{ id: 'a-live', name: 'One Off' }] },
    )
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0].op).toBe('unchanged')
    expect(plan.items[0].evidence.tier).toBe('exact_name')
  })

  // A3 (Red Hat, HARD BLOCKER) — the pin-only fixed-event-name guard survives
  // as a buildPlan-side rule: a name ticked as a fixed event that is NOT
  // dual-use must never reach tier:'new', even if it would otherwise pass the
  // frequency test.
  it('forces tier low on a pin-only activity name, even when frequency alone would pass it', () => {
    const plan = buildPlan(
      {
        approved: { activities: ['Mifkad'] },
        camp_id: camp,
        seenCounts: seenCounts({ Mifkad: 40 }),
        pinOnlyActivityNames: ['Mifkad'],
      },
      null,
    )
    expect(plan.items[0].evidence.tier).toBe('low')
  })
})

// Slice 3a content-shape detector.
describe('buildElectiveCandidates (Slice 3a content-shape detector)', () => {
  it('fires on an unresolved blob that survived isActivityLike but matches no live activity, outside a header-flagged period', () => {
    const source = {
      electiveHeaderFindings: [],
      activityPeriods: { 'arts/crafts, sports, music': [false, false] },
      approved: { activities: ['Arts/Crafts, Sports, Music'] },
    }
    const candidates = buildElectiveCandidates(source, { activities: [] })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      detector: 'shape', band: 'inferred', sourceExcerpt: 'Arts/Crafts, Sports, Music',
    })
  })

  it('does NOT fire on a token that resolves 1:1 to an existing activity (false-positive guard)', () => {
    const source = {
      electiveHeaderFindings: [],
      activityPeriods: { swim: [false] },
      approved: { activities: ['Swim'] },
    }
    const candidates = buildElectiveCandidates(source, { activities: [{ id: 'a1', name: 'Swim' }] })
    expect(candidates).toEqual([])
  })

  it('does not double-fire a shape finding for a name whose every occurrence already sat under a header finding', () => {
    const source = {
      electiveHeaderFindings: [
        { detector: 'header', band: 'confirmed', sourceExcerpt: 'Chugim', row: 3, column: null },
      ],
      activityPeriods: { chugim: [true, true] },
      approved: { activities: ['Chugim'] },
    }
    const candidates = buildElectiveCandidates(source, { activities: [] })
    expect(candidates).toHaveLength(1)
    expect(candidates[0].detector).toBe('header')
  })

  it('dedups by column-signature — the same header finding text does not produce two candidates', () => {
    const source = {
      electiveHeaderFindings: [
        { detector: 'header', band: 'confirmed', sourceExcerpt: 'Indoor Elective', row: 8, column: 'Monday' },
        { detector: 'header', band: 'confirmed', sourceExcerpt: 'Indoor Elective', row: 8, column: 'Monday' },
      ],
      activityPeriods: {},
      approved: { activities: [] },
    }
    const candidates = buildElectiveCandidates(source, { activities: [] })
    expect(candidates).toHaveLength(1)
  })
})
