import { describe, it, expect } from 'vitest'
import { foldApprovedToRecords } from './fieldUpdate.js'

// T114 follow-up — co-schedule inference folds into `fields` so that the UPDATE
// path carries it. The create path reads it off the `_rule` side-channel
// instead (buildPlan gives a create `fields: {}`), so both halves are needed;
// wiring only one leaves either first imports or re-imports writing nothing.
describe('foldApprovedToRecords — co-schedule (T114)', () => {
  const fold = (co_schedule) => foldApprovedToRecords(
    { activities: ['Lunch 1'] },
    { 'Lunch 1': { co_schedule } },
    null,
    null,
  ).activities[0].fields

  it('folds max_groups_per_slot and same_tier_only', () => {
    expect(fold({ max_groups_per_slot: 3, same_tier_only: true })).toMatchObject({
      max_groups_per_slot: 3, same_tier_only: 1,
    })
  })

  it('folds a capacity of one — never seen sharing a slot is a finding, not an absence', () => {
    expect(fold({ max_groups_per_slot: 1 }).max_groups_per_slot).toBe(1)
  })

  it('omits same_tier_only when membership was unknown, rather than defaulting to false', () => {
    // "we could not tell" and "no, groups mixed" are different answers.
    expect('same_tier_only' in fold({ max_groups_per_slot: 2 })).toBe(false)
  })

  it('folds same_tier_only:false as 0, which is NOT the same as omitting it', () => {
    expect(fold({ max_groups_per_slot: 2, same_tier_only: false }).same_tier_only).toBe(0)
  })

  it('refuses a capacity that is not a positive integer', () => {
    for (const bad of [0, -1, 2.5, '3', null, undefined]) {
      expect('max_groups_per_slot' in fold({ max_groups_per_slot: bad })).toBe(false)
    }
  })

  it('never overwrites a value the record already carries', () => {
    const out = foldApprovedToRecords(
      { activities: [{ name: 'Lunch 1', fields: { max_groups_per_slot: 9 } }] },
      { 'Lunch 1': { co_schedule: { max_groups_per_slot: 3 } } },
      null, null,
    ).activities[0].fields
    expect(out.max_groups_per_slot).toBe(9)
  })

  it('writes nothing when the rule carries no co_schedule', () => {
    const f = fold(undefined)
    expect('max_groups_per_slot' in f).toBe(false)
    expect('same_tier_only' in f).toBe(false)
  })
})
