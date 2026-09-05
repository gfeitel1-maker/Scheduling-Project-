import { describe, it, expect } from 'vitest'
import { computeOverlaps, withOverlapFlags } from './computeOverlaps'

// Capacity now lives on the PLACE (ADR D2). The activity carries a location_id;
// the place carries the capacity. Two activities can share one place.
const pool = { id: 'poolL', camp_id: 'c', name: 'Pool', capacity: 2 }
const swim = { id: 'swim', name: 'Swimming', location_id: 'poolL' }
const freeSwim = { id: 'freeSwim', name: 'Free Swim', location_id: 'poolL' }

function slot(id, groupId, extra = {}) {
  return { id, group_id: groupId, day_id: 'd1', time_block_id: 'b1', activity_id: 'swim', is_anchor: false, ...extra }
}

describe('OVERLAP', () => {
  it('is silent while the booking is within capacity', () => {
    const slots = [slot('s1', 'g1'), slot('s2', 'g2')]
    expect(computeOverlaps({ slots, activities: [swim], locations: [pool] }).size).toBe(0)
  })

  it('marks EVERY cell in an over-booking, not just the last one placed', () => {
    const slots = [slot('s1', 'g1'), slot('s2', 'g2'), slot('s3', 'g3')]
    const result = computeOverlaps({ slots, activities: [swim], locations: [pool] })
    expect([...result.keys()].sort()).toEqual(['s1', 's2', 's3'])
    expect(result.get('s1')).toBe('3 groups booked into Pool — it holds 2')
  })

  it('clears from all of them as soon as one is removed', () => {
    const slots = [slot('s1', 'g1'), slot('s2', 'g2')]
    expect(computeOverlaps({ slots, activities: [swim], locations: [pool] }).size).toBe(0)
  })

  it('keeps different blocks apart', () => {
    const slots = [
      slot('s1', 'g1'), slot('s2', 'g2'), slot('s3', 'g3', { time_block_id: 'b2' }),
    ]
    expect(computeOverlaps({ slots, activities: [swim], locations: [pool] }).size).toBe(0)
  })

  // THE FIX (assessment §3.3): two DIFFERENT activities at one place used to be
  // two independent buckets, neither over capacity, so no OVERLAP fired at any
  // group count — the manual route was completely place-blind. Now they share
  // the location_id bucket and are correctly seen as co-located.
  it('counts two different activities sharing one place together against its capacity', () => {
    const slots = [
      slot('s1', 'g1', { activity_id: 'swim' }),
      slot('s2', 'g2', { activity_id: 'freeSwim' }),
      slot('s3', 'g3', { activity_id: 'freeSwim' }),
    ]
    const result = computeOverlaps({ slots, activities: [swim, freeSwim], locations: [pool] })
    expect([...result.keys()].sort()).toEqual(['s1', 's2', 's3'])
    expect(result.get('s1')).toBe('3 groups booked into Pool — it holds 2')
  })

  it('keeps activities at DIFFERENT places apart', () => {
    const gymL = { id: 'gymL', camp_id: 'c', name: 'Gym', capacity: 1 }
    const basketball = { id: 'bball', name: 'Basketball', location_id: 'gymL' }
    const slots = [
      slot('s1', 'g1', { activity_id: 'swim' }),
      slot('s2', 'g2', { activity_id: 'swim' }),
      slot('s3', 'g3', { activity_id: 'bball' }),
    ]
    // Pool holds 2 (2 swimmers, silent); Gym holds 1 (1 baller, silent).
    expect(computeOverlaps({ slots, activities: [swim, basketball], locations: [pool, gymL] }).size).toBe(0)
  })

  it('counts a group once even when its placement spans two blocks of the same booking', () => {
    const slots = [
      slot('s1', 'g1'), slot('s2', 'g1'), slot('s3', 'g2'),
    ]
    expect(computeOverlaps({ slots, activities: [swim], locations: [pool] }).size).toBe(0)
  })

  it('ignores anchors and empty cells', () => {
    const slots = [
      slot('s1', 'g1', { is_anchor: true }),
      slot('s2', 'g2', { activity_id: null }),
      slot('s3', 'g3'),
    ]
    expect(computeOverlaps({ slots, activities: [swim], locations: [pool] }).size).toBe(0)
  })

  // Interim M1→M3: an activity with no location_id has no place, so no
  // place-capacity marker (matches the engine's interim behavior).
  it('does not mark activities that have no location_id', () => {
    const placeless = { id: 'swim', name: 'Swimming', location_id: null }
    const slots = [slot('s1', 'g1'), slot('s2', 'g2'), slot('s3', 'g3')]
    expect(computeOverlaps({ slots, activities: [placeless], locations: [pool] }).size).toBe(0)
  })

  // Round-2 fix (B1, Red Hat edge): a location_id that doesn't resolve to a
  // real locations row (deleted place, cross-device race, stale import —
  // "dangling") is UNCONSTRAINED, not a capacity-1 default — matching
  // buildSchedule's placeBlocked and useSlotMutations' locationFull. Pre-fix
  // this defaulted to capacity 1 and flagged OVERLAP, disagreeing with both.
  it('does not flag OVERLAP for a dangling location_id (unconstrained, same as the engine)', () => {
    const slots = [slot('s1', 'g1'), slot('s2', 'g2'), slot('s3', 'g3')]
    expect(computeOverlaps({ slots, activities: [swim], locations: [] }).size).toBe(0)
  })

  it('the activity-cap bucket still applies to a slot at a dangling place', () => {
    const capped = { id: 'swim', name: 'Swimming', location_id: 'poolL', max_groups_per_slot: 1 }
    const slots = [slot('s1', 'g1'), slot('s2', 'g2')]
    const result = computeOverlaps({ slots, activities: [capped], locations: [] })
    expect([...result.keys()].sort()).toEqual(['s1', 's2'])
    expect(result.get('s1')).toBe('2 groups booked for Swimming — its limit is 1 per slot')
  })

  // ACTIVITY cap (max_groups_per_slot) — the pre-M2 marker the director wants
  // back. It fires on the activity's own per-slot limit, independently of the
  // place's capacity.
  it('marks an activity booked past max_groups_per_slot even when its place has slack', () => {
    const capped = { id: 'swim', name: 'Swimming', location_id: 'poolL', max_groups_per_slot: 1 }
    // Pool holds 2, so the place is NOT over capacity; the activity cap of 1 is.
    const slots = [slot('s1', 'g1'), slot('s2', 'g2')]
    const result = computeOverlaps({ slots, activities: [capped], locations: [pool] })
    expect([...result.keys()].sort()).toEqual(['s1', 's2'])
    expect(result.get('s1')).toBe('2 groups booked for Swimming — its limit is 1 per slot')
  })

  it('marks an activity past its cap even with no location_id (interim M1→M3)', () => {
    const placeless = { id: 'swim', name: 'Swimming', location_id: null, max_groups_per_slot: 2 }
    const slots = [slot('s1', 'g1'), slot('s2', 'g2'), slot('s3', 'g3')]
    const result = computeOverlaps({ slots, activities: [placeless], locations: [pool] })
    expect([...result.keys()].sort()).toEqual(['s1', 's2', 's3'])
    expect(result.get('s1')).toBe('3 groups booked for Swimming — its limit is 2 per slot')
  })

  it('does not apply an activity cap when max_groups_per_slot is null or 0', () => {
    const uncapped = { id: 'swim', name: 'Swimming', location_id: null, max_groups_per_slot: null }
    const zeroCap = { id: 'swim', name: 'Swimming', location_id: null, max_groups_per_slot: 0 }
    const slots = [slot('s1', 'g1'), slot('s2', 'g2'), slot('s3', 'g3')]
    expect(computeOverlaps({ slots, activities: [uncapped], locations: [] }).size).toBe(0)
    expect(computeOverlaps({ slots, activities: [zeroCap], locations: [] }).size).toBe(0)
  })

  // When one slot trips BOTH limits, the reasons are joined so the reader sees
  // each one; the distinguishing text ("booked into <place> — it holds" vs
  // "booked for <activity> — its limit is") tells them which limit was hit.
  it('surfaces both limits, distinguishably, when a slot is over place AND activity cap', () => {
    const capped = { id: 'swim', name: 'Swimming', location_id: 'poolL', max_groups_per_slot: 1 }
    // 3 groups: over Pool's capacity (2) AND over Swimming's cap (1).
    const slots = [slot('s1', 'g1'), slot('s2', 'g2'), slot('s3', 'g3')]
    const reason = computeOverlaps({ slots, activities: [capped], locations: [pool] }).get('s1')
    expect(reason).toContain('booked into Pool — it holds 2')
    expect(reason).toContain('booked for Swimming — its limit is 1 per slot')
  })

  it('reads the place limit and the activity limit differently', () => {
    const placeOnly = { id: 'swim', name: 'Swimming', location_id: 'poolL', max_groups_per_slot: null }
    const actOnly = { id: 'swim', name: 'Swimming', location_id: null, max_groups_per_slot: 1 }
    const slots = [slot('s1', 'g1'), slot('s2', 'g2'), slot('s3', 'g3')]
    const placeReason = computeOverlaps({ slots, activities: [placeOnly], locations: [pool] }).get('s1')
    const actReason = computeOverlaps({ slots, activities: [actOnly], locations: [] }).get('s1')
    expect(placeReason).toContain('Pool')
    expect(placeReason).toContain('holds')
    expect(actReason).toContain('Swimming')
    expect(actReason).toContain('limit is')
    expect(placeReason).not.toBe(actReason)
  })

  it('decorates flags without touching the persisted rows', () => {
    const slots = [slot('s1', 'g1'), slot('s2', 'g2'), slot('s3', 'g3')]
    const decorated = withOverlapFlags(slots, [swim], [pool])
    expect(decorated[0].flags.OVERLAP).toBe(true)
    expect(slots[0].flags).toBeUndefined()
  })

  // Electives are "a schedule within a schedule": an offering consumes a
  // real location via activities.location_id, and the two independent
  // checks (this one, and useSlotMutations' write-time check) were both
  // blind to it because elective slots carry elective_set_id with
  // activity_id: null and got skipped entirely.
  function electiveSlot(id, groupId, electiveSetId, extra = {}) {
    return { id, group_id: groupId, day_id: 'd1', time_block_id: 'b1', activity_id: null, elective_set_id: electiveSetId, is_anchor: false, ...extra }
  }

  it('flags an elective occupying a location where a regular group slot also sits', () => {
    // Pool holds 2. One regular swimmer + one elective (also resolving to
    // the pool) = 2 groups, within capacity — bump to a 3rd to trip it.
    const slots = [
      slot('s1', 'g1', { activity_id: 'swim' }),
      electiveSlot('s2', 'g2', 'set-1'),
      electiveSlot('s3', 'g3', 'set-1'),
    ]
    const electiveSetActivities = [{ elective_set_id: 'set-1', activity_id: 'swim' }]
    const result = computeOverlaps({ slots, activities: [swim], locations: [pool], electiveSetActivities })
    expect([...result.keys()].sort()).toEqual(['s1', 's2', 's3'])
    expect(result.get('s1')).toBe('3 groups booked into Pool — it holds 2')
  })

  it('handles a multi-location elective set — a distinct location per offering, each contending separately', () => {
    const gymL = { id: 'gymL', camp_id: 'c', name: 'Gym', capacity: 1 }
    const basketball = { id: 'bball', name: 'Basketball', location_id: 'gymL' }
    // set-1 offers both swim (pool) and basketball (gym). g1's elective slot
    // occupies BOTH places at once. A second group also at the gym (via a
    // regular bball booking) trips the gym's capacity-1 limit, while the
    // pool (capacity 2, only g1's elective there) stays silent.
    const slots = [
      electiveSlot('s1', 'g1', 'set-1'),
      slot('s2', 'g2', { activity_id: 'bball' }),
    ]
    const electiveSetActivities = [
      { elective_set_id: 'set-1', activity_id: 'swim' },
      { elective_set_id: 'set-1', activity_id: 'bball' },
    ]
    const result = computeOverlaps({ slots, activities: [swim, basketball], locations: [pool, gymL], electiveSetActivities })
    expect([...result.keys()].sort()).toEqual(['s1', 's2'])
    expect(result.get('s1')).toBe('2 groups booked into Gym — it holds 1')
  })

  it('does not crash or false-positive on an elective whose offering has no location_id', () => {
    const placelessAct = { id: 'craft', name: 'Crafts', location_id: null }
    const slots = [electiveSlot('s1', 'g1', 'set-1'), electiveSlot('s2', 'g2', 'set-1')]
    const electiveSetActivities = [{ elective_set_id: 'set-1', activity_id: 'craft' }]
    expect(computeOverlaps({ slots, activities: [placelessAct], locations: [pool], electiveSetActivities }).size).toBe(0)
  })

  it('does not crash or false-positive on a dangling elective_set_id (no matching electiveSetActivities row)', () => {
    const slots = [electiveSlot('s1', 'g1', 'set-gone'), electiveSlot('s2', 'g2', 'set-gone')]
    expect(computeOverlaps({ slots, activities: [swim], locations: [pool], electiveSetActivities: [] }).size).toBe(0)
  })

  it('does not false-positive on a non-clashing elective (place has slack)', () => {
    const slots = [electiveSlot('s1', 'g1', 'set-1')]
    const electiveSetActivities = [{ elective_set_id: 'set-1', activity_id: 'swim' }]
    expect(computeOverlaps({ slots, activities: [swim], locations: [pool], electiveSetActivities }).size).toBe(0)
  })

  // Anchor semantics — an anchor is immovable declared truth about where a
  // group is and is never itself flagged, but it still occupies the place
  // and constrains what else can go there.
  describe('anchors', () => {
    const flagpole = { id: 'flag', name: 'Flagpole', location_id: 'flagL' }
    const flagpoleL = { id: 'flagL', camp_id: 'c', name: 'Flagpole', capacity: 1 }

    it('never flags a bucket made entirely of anchors, no matter how many share a capacity-1 place', () => {
      // Every group's Flagpole anchor, all at the same capacity-1 location —
      // this is correct by construction and must stay silent.
      const slots = [
        slot('s1', 'g1', { activity_id: 'flag', is_anchor: true }),
        slot('s2', 'g2', { activity_id: 'flag', is_anchor: true }),
        slot('s3', 'g3', { activity_id: 'flag', is_anchor: true }),
      ]
      expect(computeOverlaps({ slots, activities: [flagpole], locations: [flagpoleL] }).size).toBe(0)
    })

    it('flags only the non-anchor row when a placed group shares a full anchor place', () => {
      // Flagpole (capacity 1) already holds g1's anchor. g2 is a regular
      // (non-anchor) placement into the same location at the same time —
      // over capacity, and only g2's row should be flagged.
      const otherAtFlagL = { id: 'otherAct', name: 'Assembly', location_id: 'flagL' }
      const slots = [
        slot('s1', 'g1', { activity_id: 'flag', is_anchor: true }),
        slot('s2', 'g2', { activity_id: 'otherAct' }),
      ]
      const result = computeOverlaps({ slots, activities: [flagpole, otherAtFlagL], locations: [flagpoleL] })
      expect([...result.keys()]).toEqual(['s2'])
      expect(result.get('s2')).toContain('held by an anchor')
    })

    it('does not flag a non-anchor group when the anchor place still has room', () => {
      const roomyL = { id: 'roomyL', camp_id: 'c', name: 'Field', capacity: 2 }
      const anchorAct = { id: 'flag2', name: 'Flagpole', location_id: 'roomyL' }
      const otherAct = { id: 'otherAct', name: 'Drill', location_id: 'roomyL' }
      const slots = [
        slot('s1', 'g1', { activity_id: 'flag2', is_anchor: true }),
        slot('s2', 'g2', { activity_id: 'otherAct' }),
      ]
      expect(computeOverlaps({ slots, activities: [anchorAct, otherAct], locations: [roomyL] }).size).toBe(0)
    })

    it('never treats anchor-vs-anchor as a conflict, even past capacity', () => {
      const slots = [
        slot('s1', 'g1', { activity_id: 'flag', is_anchor: true }),
        slot('s2', 'g2', { activity_id: 'flag', is_anchor: true }),
      ]
      expect(computeOverlaps({ slots, activities: [flagpole], locations: [flagpoleL] }).size).toBe(0)
    })

    it('anchor plus elective: flags only the elective row when the anchor already fills the place', () => {
      const electiveOffering = { id: 'craft', name: 'Crafts', location_id: 'flagL' }
      const slots = [
        slot('s1', 'g1', { activity_id: 'flag', is_anchor: true }),
        electiveSlot('s2', 'g2', 'set-1'),
      ]
      const electiveSetActivities = [{ elective_set_id: 'set-1', activity_id: 'craft' }]
      const result = computeOverlaps({
        slots, activities: [flagpole, electiveOffering], locations: [flagpoleL], electiveSetActivities,
      })
      expect([...result.keys()]).toEqual(['s2'])
    })

    it('leaves pure non-anchor overbooking behavior unchanged (regression)', () => {
      const slots = [slot('s1', 'g1'), slot('s2', 'g2'), slot('s3', 'g3')]
      const result = computeOverlaps({ slots, activities: [swim], locations: [pool] })
      expect([...result.keys()].sort()).toEqual(['s1', 's2', 's3'])
      expect(result.get('s1')).toBe('3 groups booked into Pool — it holds 2')
    })
  })
})
