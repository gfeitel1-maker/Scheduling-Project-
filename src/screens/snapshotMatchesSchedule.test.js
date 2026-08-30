import { describe, it, expect } from 'vitest'
import { snapshotMatchesSchedule } from './snapshotMatchesSchedule'

function snap(slots) {
  return { id: 's1', slots: JSON.stringify(slots) }
}

const slotA = { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'a1', flags: {} }
const slotB = { group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'a2', flags: {} }

describe('snapshotMatchesSchedule', () => {
  it('matches when the version records the same week that is on screen', () => {
    expect(snapshotMatchesSchedule(snap([slotA, slotB]), { slots: [slotA, slotB] })).toBe(true)
  })

  it('ignores row order — the same week saved in a different order still matches', () => {
    expect(snapshotMatchesSchedule(snap([slotA, slotB]), { slots: [slotB, slotA] })).toBe(true)
  })

  it('does not match when a different activity sits in a block', () => {
    const changed = { ...slotB, activity_id: 'a9' }
    expect(snapshotMatchesSchedule(snap([slotA, slotB]), { slots: [slotA, changed] })).toBe(false)
  })

  it('does not match when the on-screen week has an extra slot', () => {
    expect(snapshotMatchesSchedule(snap([slotA]), { slots: [slotA, slotB] })).toBe(false)
  })

  it('ignores flags, which are recomputed annotations rather than the week itself', () => {
    const flagged = { ...slotA, flags: { UNFILLABLE: true } }
    expect(snapshotMatchesSchedule(snap([slotA]), { slots: [flagged] })).toBe(true)
  })

  it('is false for a version that recorded no schedule data', () => {
    expect(snapshotMatchesSchedule({ id: 's2', slots: null }, { slots: [] })).toBe(false)
  })

  it('matches two empty weeks', () => {
    expect(snapshotMatchesSchedule(snap([]), { slots: [] })).toBe(true)
  })

  it('is never decided by position in the list — an older version can be the one on screen', () => {
    // The defect this replaces: "newest" was read as "on screen". Here the week
    // on screen is the OLDER version's payload, and the newest one is not it.
    const newest = snap([slotA, slotB])
    const older = snap([slotA])
    expect(snapshotMatchesSchedule(newest, { slots: [slotA] })).toBe(false)
    expect(snapshotMatchesSchedule(older, { slots: [slotA] })).toBe(true)
  })
})
