import { describe, it, expect } from 'vitest'
import { snapshotMatchesSchedule } from './snapshotMatchesSchedule'

function snap(slots, overlays = []) {
  return { id: 's1', slots: JSON.stringify(slots), overlays: JSON.stringify(overlays) }
}

const slotA = { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'a1', flags: {} }
const slotB = { group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'a2', flags: {} }
const overlay = { unit_id: 'u1', day_id: 'd1', from_block_order: 1, to_block_order: 2, label: 'Trip' }

describe('snapshotMatchesSchedule', () => {
  it('matches when the version records the same week that is on screen', () => {
    expect(snapshotMatchesSchedule(snap([slotA, slotB]), { slots: [slotA, slotB], overlays: [] })).toBe(true)
  })

  it('ignores row order — the same week saved in a different order still matches', () => {
    expect(snapshotMatchesSchedule(snap([slotA, slotB]), { slots: [slotB, slotA], overlays: [] })).toBe(true)
  })

  it('does not match when a different activity sits in a block', () => {
    const changed = { ...slotB, activity_id: 'a9' }
    expect(snapshotMatchesSchedule(snap([slotA, slotB]), { slots: [slotA, changed], overlays: [] })).toBe(false)
  })

  it('does not match when the on-screen week has an extra slot', () => {
    expect(snapshotMatchesSchedule(snap([slotA]), { slots: [slotA, slotB], overlays: [] })).toBe(false)
  })

  it('takes overlays into account', () => {
    expect(snapshotMatchesSchedule(snap([slotA], [overlay]), { slots: [slotA], overlays: [] })).toBe(false)
    expect(snapshotMatchesSchedule(snap([slotA], [overlay]), { slots: [slotA], overlays: [overlay] })).toBe(true)
  })

  it('treats a block order stored as text the same as one stored as a number', () => {
    const asText = { ...overlay, from_block_order: '1', to_block_order: '2' }
    expect(snapshotMatchesSchedule(snap([slotA], [overlay]), { slots: [slotA], overlays: [asText] })).toBe(true)
  })

  it('ignores flags, which are recomputed annotations rather than the week itself', () => {
    const flagged = { ...slotA, flags: { UNFILLABLE: true } }
    expect(snapshotMatchesSchedule(snap([slotA]), { slots: [flagged], overlays: [] })).toBe(true)
  })

  it('is false for a version that recorded no schedule data', () => {
    expect(snapshotMatchesSchedule({ id: 's2', slots: null }, { slots: [], overlays: [] })).toBe(false)
  })

  it('matches two empty weeks', () => {
    expect(snapshotMatchesSchedule(snap([]), { slots: [], overlays: [] })).toBe(true)
  })

  it('is never decided by position in the list — an older version can be the one on screen', () => {
    // The defect this replaces: "newest" was read as "on screen". Here the week
    // on screen is the OLDER version's payload, and the newest one is not it.
    const newest = snap([slotA, slotB])
    const older = snap([slotA])
    expect(snapshotMatchesSchedule(newest, { slots: [slotA], overlays: [] })).toBe(false)
    expect(snapshotMatchesSchedule(older, { slots: [slotA], overlays: [] })).toBe(true)
  })
})
