// F5 (docs/work/evidence/2026-10-11-f5-spans-first.md): a span activity
// (span_blocks N > 1) is one session of N contiguous blocks. It is placed FIRST
// within its priority round, because once single-block activities have taken
// the cells a span needs there is rarely a run of N free blocks left; and the
// repair pass fills a span as a unit and never splits one.
import { describe, it, expect } from 'vitest'
import buildSchedule from './buildSchedule.js'

const N_GROUPS = 6
const N_DAYS = 5
const N_BLOCKS = 6
const groups = Array.from({ length: N_GROUPS }, (_, i) => ({ id: `g${i}`, name: `G${i}`, tier_id: 't1', availability: 'all' }))
const days = Array.from({ length: N_DAYS }, (_, i) => ({ id: `d${i}`, label: `D${i}`, day_of_week: i + 1, sort_order: i }))
const timeBlocks = Array.from({ length: N_BLOCKS }, (_, i) => ({ id: `b${i}`, name: `B${i}`, start_time: `${String(8 + i).padStart(2, '0')}:00`, end_time: `${String(8 + i).padStart(2, '0')}:45`, sort_order: i, part_of_day: 'morning' }))
const act = (id, over = {}) => ({
  id, name: id, priority: 'high', min_per_week: 4, max_per_week: 6, max_groups_per_slot: 2,
  same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null, ...over,
})
const singles = ['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => act(id))
const lunch = act('lunch')
const ropes = act('ropes', { span_blocks: 2, min_per_week: 2, max_per_week: 4, max_groups_per_slot: 3 })
// A camp-wide fixed event at each listed block, every day. At blocks 1 and 4 of
// 6 the only two-block run left in a day is blocks 2-3, so a span competes with
// the singles for the one place it fits.
const fixedAt = (blocks) => blocks.map((b) => ({ id: `fe${b}`, activity_id: 'lunch', name: 'Lunch', unit_id: null, is_all_groups: true, group_ids: [], day_id: null, time_block_id: `b${b}`, span_blocks: 1 }))

function input(activities, fixedBlocks = [1, 4], blocks = timeBlocks) {
  return { groups, tiers: [{ id: 't1', name: 'T' }], days, timeBlocks: blocks, activities: [lunch, ...activities], fixedEvents: fixedAt(fixedBlocks), campId: 'c', replacedDayIds: [] }
}

const blockIdx = (id) => Number(id.slice(1))

// group|day -> sorted block indexes of `actId`
function cellsByGroupDay(slots, actId) {
  const by = new Map()
  for (const s of slots) {
    if (s.type !== 'activity' || s.activityId !== actId) continue
    const k = `${s.groupId}|${s.dayId}`
    by.set(k, [...(by.get(k) ?? []), s])
  }
  return by
}

describe('buildSchedule: span activities are placed first, contiguously, as one session', () => {
  it('every group gets its min_per_week span sessions, each a contiguous run of N in one day', () => {
    const { slots, findings } = buildSchedule(input([...singles, ropes]))
    for (const g of groups) {
      const runs = [...cellsByGroupDay(slots, 'ropes')].filter(([k]) => k.startsWith(`${g.id}|`)).map(([, v]) => v)
      expect(runs, g.id).toHaveLength(2)
      for (const run of runs) {
        const idx = run.map((s) => blockIdx(s.blockId)).sort((a, b) => a - b)
        expect(idx).toHaveLength(2)
        expect(idx[1] - idx[0]).toBe(1)
        // one head, one tail: the session counts once
        expect(run.filter((s) => s.is_span_head !== false)).toHaveLength(1)
      }
    }
    expect(findings.filter((f) => f.kind === 'UNDERSERVED' && f.activityId === 'ropes')).toEqual([])
  })

  it('a 3-block span is placed in the only 3-block runs a day has (either side of a midday fixed event)', () => {
    const wild = act('wild', { span_blocks: 3, min_per_week: 1, max_per_week: 3 })
    const seven = Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, start_time: `${String(8 + i).padStart(2, '0')}:00`, end_time: `${String(8 + i).padStart(2, '0')}:45`, sort_order: i, part_of_day: 'morning' }))
    const { slots } = buildSchedule(input([...singles, wild], [3], seven))
    for (const g of groups) {
      const runs = [...cellsByGroupDay(slots, 'wild')].filter(([k]) => k.startsWith(`${g.id}|`)).map(([, v]) => v)
      expect(runs, g.id).toHaveLength(1)
      const idx = runs[0].map((s) => blockIdx(s.blockId)).sort((a, b) => a - b)
      expect(idx).toEqual([idx[0], idx[0] + 1, idx[0] + 2])
    }
  })

  it('repair fills empty cells with a whole span, never a split one', () => {
    // One group, two days of three blocks. The two singles are capped at once a
    // week each, so the rounds leave cells only the (low, min 0) span can take.
    const g = [groups[0]]
    const three = timeBlocks.slice(0, 3)
    const capped = ['s1', 's2'].map((id) => act(id, { min_per_week: 0, max_per_week: 1, max_groups_per_slot: 1 }))
    const span = act('span', { span_blocks: 2, min_per_week: 0, max_per_week: 2, max_groups_per_slot: 1, priority: 'low' })
    const { slots } = buildSchedule({ groups: g, tiers: [{ id: 't1', name: 'T' }], days: days.slice(0, 2), timeBlocks: three, activities: [...capped, span], fixedEvents: [], campId: 'c', replacedDayIds: [] })
    expect(slots.filter((s) => s.flags?.UNFILLABLE)).toEqual([])
    const by = cellsByGroupDay(slots, 'span')
    expect(by.size).toBe(2)
    for (const run of by.values()) {
      const idx = run.map((s) => blockIdx(s.blockId)).sort((a, b) => a - b)
      expect(idx).toHaveLength(2)
      expect(idx[1] - idx[0]).toBe(1)
      expect(run.filter((s) => s.is_span_head !== false)).toHaveLength(1)
    }
  })

  it('is deterministic: the same input gives the same schedule', () => {
    const a = buildSchedule(input([...singles, ropes]))
    const b = buildSchedule(input([...singles, ropes]))
    expect(a).toEqual(b)
  })
})

// The per-activity group limit (max_groups_per_slot) holds in EVERY block a span covers, not only
// its first block: two groups' spans offset by one block must not over-fill the shared block.
describe('buildSchedule: a span respects max_groups_per_slot in every block it covers', () => {
  const overLimit = (slots, activities) => {
    const limit = new Map(activities.map((a) => [a.id, a.max_groups_per_slot]))
    const n = new Map()
    for (const s of slots) {
      if (s.type !== 'activity' || !limit.get(s.activityId)) continue
      const k = `${s.activityId}|${s.dayId}|${s.blockId}`
      n.set(k, (n.get(k) ?? 0) + 1)
    }
    return [...n].filter(([k, c]) => c > limit.get(k.split('|')[0]))
  }
  const cases = []
  for (const span of [2, 3]) for (const fixed of [[], [1], [2], [1, 4], [3]]) for (const minW of [1, 2, 3]) cases.push([span, fixed, minW])
  it.each(cases)('span %i, fixed at %j, min %i', (span, fixed, minW) => {
    const tight = act('ropes', { span_blocks: span, min_per_week: minW, max_per_week: 5, max_groups_per_slot: 1 })
    const acts = [...singles.slice(0, 3), tight]
    const { slots } = buildSchedule(input(acts, fixed))
    expect(overLimit(slots, acts)).toEqual([])
  })
})
