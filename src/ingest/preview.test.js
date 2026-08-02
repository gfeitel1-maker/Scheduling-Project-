import { describe, it, expect } from 'vitest'
import { buildPreview, describePreview, normalizeName, looksLikeAMerge } from './preview'

// docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md §1, §5.
//
// Skipping duplicates makes a normal import silently partial. These are the
// tests that keep it from being silent.

const proposal = (entities) => ({ entities: { groups: [], days_of_operation: [], time_blocks: [], activities: [], tiers: [], cohorts: [], ...entities } })

describe('normalizeName', () => {
  it('ignores case and collapses whitespace, like the per-screen imports', () => {
    expect(normalizeName('  Back   Playground ')).toBe('back playground')
    expect(normalizeName('SWIM')).toBe(normalizeName('swim'))
  })
})

describe('buildPreview names what it will skip, and what it matched', () => {
  it('separates what would be added from what is already there', () => {
    const preview = buildPreview(
      proposal({ activities: ['Swim', 'Archery', 'Drama'] }),
      { activities: [{ id: 'a1', name: 'archery' }] }
    )
    expect(preview.perEntity.activities.create).toEqual(['Swim', 'Drama'])
    expect(preview.perEntity.activities.skip).toEqual([
      { name: 'Archery', matched: 'archery', reason: 'already-in-camp' },
    ])
  })

  it('shows the existing record a skipped row collided with, not just a count', () => {
    // "12 rows skipped" is not something a director can check.
    const preview = buildPreview(
      proposal({ groups: ['Bunk 4'] }),
      { groups: [{ id: 'g1', name: 'bunk  4' }] }
    )
    expect(preview.perEntity.groups.skip[0].matched).toBe('bunk  4')
  })

  it('skips a row the file repeats, against the first spelling', () => {
    const preview = buildPreview(proposal({ activities: ['Swim', 'swim'] }), {})
    expect(preview.perEntity.activities.create).toEqual(['Swim'])
    expect(preview.perEntity.activities.skip[0].reason).toBe('repeated-in-file')
  })

  it('counts across every entity', () => {
    const preview = buildPreview(
      proposal({ groups: ['A', 'B'], activities: ['Swim'], days_of_operation: ['Monday'] }),
      { groups: [{ id: 'g', name: 'B' }] }
    )
    expect(preview.createTotal).toBe(3)
    expect(preview.skipTotal).toBe(1)
  })

  it('treats importing the same file twice as a no-op, not an error', () => {
    const p = proposal({ activities: ['Swim', 'Archery'] })
    const second = buildPreview(p, { activities: [{ id: '1', name: 'Swim' }, { id: '2', name: 'Archery' }] })
    expect(second.isNoOp).toBe(true)
    expect(second.createTotal).toBe(0)
    expect(second.skipTotal).toBe(2)
  })

  it('never proposes an entity outside the whitelist, whatever it is handed', () => {
    const preview = buildPreview(
      { entities: { activities: ['Swim'], template_slots: ['nope'], anchor_activities: ['nope'] } },
      {}
    )
    expect(preview.perEntity).not.toHaveProperty('template_slots')
    expect(preview.perEntity).not.toHaveProperty('anchor_activities')
  })

  it('survives being handed nothing', () => {
    expect(() => buildPreview(null, null)).not.toThrow()
    expect(buildPreview(null, null).createTotal).toBe(0)
  })
})

describe('describePreview speaks to a director', () => {
  it('says what would be added, and that the rest is left alone', () => {
    const preview = buildPreview(
      proposal({ groups: ['A', 'B'], activities: ['Swim'] }),
      { activities: [{ id: '1', name: 'Archery' }], groups: [{ id: 'g', name: 'A' }] }
    )
    expect(describePreview(preview)).toBe('This would add 1 group and 1 activity. 1 row is already in your camp and will be left alone.')
  })

  it('says plainly when there is nothing to do', () => {
    const preview = buildPreview(proposal({ activities: ['Swim'] }), { activities: [{ id: '1', name: 'Swim' }] })
    expect(describePreview(preview)).toMatch(/already in your camp. Nothing would be added/)
  })

  it('distinguishes "nothing new" from "nothing found"', () => {
    const empty = buildPreview(proposal({}), {})
    expect(describePreview(empty)).toMatch(/Nothing was found in this file/)
  })

  it('uses no table names', () => {
    const preview = buildPreview(proposal({ days_of_operation: ['Monday'], time_blocks: ['09:00-10:00'] }), {})
    expect(describePreview(preview)).not.toMatch(/days_of_operation|time_blocks|cohorts|tiers|entity/)
  })
})

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

describe('what starts ticked', () => {
  it('unticks a seen-once value and a merge, and leaves the real ones ticked', () => {
    const proposal = {
      entities: { activities: ['Drama', 'Opening', 'Opening Drama', 'One Off'], groups: [], days_of_operation: [], time_blocks: [], tiers: [], cohorts: [] },
      seenCounts: { activities: { Drama: 36, Opening: 21, 'Opening Drama': 2, 'One Off': 1 } },
    }
    const { lowConfidence, create } = buildPreview(proposal, {}).perEntity.activities
    expect(create).toContain('Opening Drama')   // shown, never hidden
    expect(lowConfidence).toContain('Opening Drama')
    expect(lowConfidence).toContain('One Off')
    expect(lowConfidence).not.toContain('Drama')
    expect(lowConfidence).not.toContain('Opening')
  })
})
