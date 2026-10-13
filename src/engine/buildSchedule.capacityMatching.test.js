// T379: in a week that fits exactly (every group's cells equal the sessions it is owed) activities capped
// to one group per slot compete for the same cells, a Latin-square problem. The slot-by-slot matching
// that runs before the greedy rounds must fill it on every seed, never move a locked cell, and keep a
// multi-block span one session.
import { describe, it, expect } from 'vitest'
import buildSchedule from './buildSchedule.js'

const N = 8
const groups = Array.from({ length: N }, (_, i) => ({ id: `g${i}`, name: `G${i}`, tier_id: 't1', availability: 'all' }))
const days = Array.from({ length: 4 }, (_, i) => ({ id: `d${i}`, label: `D${i}`, day_of_week: i + 1, sort_order: i }))
const timeBlocks = Array.from({ length: 2 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, start_time: `${9 + i}:00`, end_time: `${9 + i}:45`, sort_order: i, part_of_day: 'morning' }))
const act = (id, over = {}) => ({
  id, name: id, priority: 'high', min_per_week: 1, max_per_week: 1, max_groups_per_slot: 1,
  same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null, ...over,
})
const singles = Array.from({ length: N }, (_, i) => act(`a${i}`, { priority: i % 2 ? 'low' : 'high' }))
const input = (over = {}) => ({ groups, tiers: [{ id: 't1', name: 'T' }], days, timeBlocks, activities: singles, fixedEvents: [], campId: 'c', replacedDayIds: [], ...over })
const short = (r) => ({
  underserved: r.findings.filter((f) => f.kind === 'UNDERSERVED').length,
  unfillable: r.slots.filter((s) => s.flags?.UNFILLABLE).length,
})

describe('buildSchedule: capacity-capped activities in an exactly fitting week (T379)', () => {
  it('8 groups x 8 cells x 8 one-group-per-slot activities: nothing short on seeds 0..99', () => {
    const bad = []
    for (let i = 0; i < 100; i++) {
      const r = short(buildSchedule(input({ campId: `seed-${i}` })))
      if (r.underserved || r.unfillable) bad.push(`seed-${i}: ${JSON.stringify(r)}`)
    }
    expect(bad).toEqual([])
  })

  it('is deterministic: the same input gives the same week', () => {
    const a = buildSchedule(input({ campId: 'seed-7' }))
    const b = buildSchedule(input({ campId: 'seed-7' }))
    expect(b.slots).toEqual(a.slots)
  })

  it('never moves a locked cell', () => {
    const preplacedSlots = [{ groupId: 'g3', dayId: 'd2', blockId: 'b1', activityId: 'a5' }]
    for (let i = 0; i < 30; i++) {
      const { slots } = buildSchedule(input({ campId: `seed-${i}`, preplacedSlots }))
      const at = slots.find((s) => s.groupId === 'g3' && s.dayId === 'd2' && s.blockId === 'b1')
      expect(at.activityId, `seed-${i}`).toBe('a5')
    }
  })

  it('a double-block span among the capped activities stays one contiguous session', () => {
    const ropes = act('ropes', { span_blocks: 2, max_groups_per_slot: 4, min_per_week: 1, max_per_week: 1 })
    const activities = [...singles.slice(0, N - 2), ropes]
    const bad = []
    for (let i = 0; i < 30; i++) {
      const { slots } = buildSchedule(input({ activities, campId: `seed-${i}` }))
      for (const g of groups) {
        const cells = slots.filter((s) => s.groupId === g.id && s.activityId === 'ropes')
        if (cells.length !== 2 || cells.filter((s) => s.is_span_head !== false).length !== 1) bad.push(`seed-${i} ${g.id}: ${cells.length} cells`)
      }
    }
    expect(bad).toEqual([])
  })

  it('a low-priority capped activity never starves a high-priority uncapped minimum (seeds 0..99)', () => {
    const swim = act('swim', { priority: 'high', min_per_week: 2, max_per_week: 2, max_groups_per_slot: 0 })
    const capped = singles.slice(0, N - 2).map((a) => ({ ...a, priority: 'low' }))
    const bad = []
    for (let i = 0; i < 100; i++) {
      const { slots, findings } = buildSchedule(input({ activities: [swim, ...capped], campId: `seed-${i}` }))
      const swimShort = groups.filter((g) => slots.filter((s) => s.groupId === g.id && s.activityId === 'swim').length < 2).length
      const r = short({ slots, findings })
      if (swimShort || r.underserved || r.unfillable) bad.push(`seed-${i}: swimShort ${swimShort} ${JSON.stringify(r)}`)
    }
    expect(bad).toEqual([])
  })

  it('one spare cell per group (9 cells, 8 capped activities) still fills on seeds 0..99', () => {
    const wide = Array.from({ length: 3 }, (_, i) => ({ id: `d${i}`, label: `D${i}`, day_of_week: i + 1, sort_order: i }))
    const blocks = Array.from({ length: 3 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, start_time: `${9 + i}:00`, end_time: `${9 + i}:45`, sort_order: i, part_of_day: 'morning' }))
    const bad = []
    for (let i = 0; i < 100; i++) {
      const r = short(buildSchedule(input({ days: wide, timeBlocks: blocks, campId: `seed-${i}` })))
      if (r.underserved) bad.push(`seed-${i}: ${JSON.stringify(r)}`)
    }
    expect(bad).toEqual([])
  })

  it('capped activities sharing a location with a tight per-slot capacity still fill (seeds 0..99)', () => {
    const half = singles.map((a, i) => ({ ...a, max_groups_per_slot: 2, location_id: i < 4 ? 'locA' : 'locB' }))
    const locations = [{ id: 'locA', name: 'A', capacity: 4 }, { id: 'locB', name: 'B', capacity: 4 }]
    const bad = []
    for (let i = 0; i < 100; i++) {
      const r = short(buildSchedule(input({ activities: half, locations, campId: `seed-${i}` })))
      if (r.underserved || r.unfillable) bad.push(`seed-${i}: ${JSON.stringify(r)}`)
    }
    // main leaves 18 of 100 seeds short here; the matching leaves 2 (a location's capacity is checked per
    // seat, with no swap through it). Pinned so it cannot get worse.
    expect(bad.length, bad.join('; ')).toBeLessThanOrEqual(2)
  })
})
