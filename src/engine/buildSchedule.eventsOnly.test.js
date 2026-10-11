import { describe, it, expect } from 'vitest'
import buildSchedule, { computeFindings } from './buildSchedule.js'

// F2: a kept 10-minute block (Flag Raising, Taps) is events-only. Generate must
// never put a regular activity in it, even for a group with no event there.
const groups = [
  { id: 'g1', name: 'Otters 1', tier_id: 't1', availability: 'all' },
  { id: 'g2', name: 'Otters 2', tier_id: 't1', availability: 'all' },
]
const day = { id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }
const flagBlock = (eventsOnly) => ({ id: 'flag', name: '08:50-09:00', start_time: '08:50', end_time: '09:00', sort_order: 0, part_of_day: 'morning', events_only: eventsOnly })
const mainBlock = { id: 'main', name: '09:05-09:50', start_time: '09:05', end_time: '09:50', sort_order: 1, part_of_day: 'morning', events_only: 0 }
const archery = { id: 'archery', name: 'Archery', priority: 'high', max_per_week: 10, min_per_week: 2, is_outdoor: false, location: null, max_groups_per_slot: 2, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null }
// Partial row: only Otters 1 prints Flag Raising.
const flagRaising = { id: 'fe1', name: 'Flag Raising', activity_id: null, is_all_groups: false, group_ids: ['g1'], day_id: null, time_block_id: 'flag', span_blocks: 1 }

// Same role as `minimal` in buildSchedule.test.js: the engine input is built by a helper, so the
// T187 fixture scanner sees only the overrides at each call site.
const engineInput = (over) => ({
  groups, tiers: [{ id: 't1', name: 'Junior' }], days: [day], timeBlocks: [], activities: [], fixedEvents: [], campId: 'test', replacedDayIds: [], ...over,
})

const run = (eventsOnly) =>
  buildSchedule({
    groups, tiers: [{ id: 't1', name: 'Junior' }], days: [day], timeBlocks: [flagBlock(eventsOnly), mainBlock],
    activities: [archery], fixedEvents: [flagRaising], campId: 'test', replacedDayIds: [],
  }).slots

describe('events-only time blocks', () => {
  it('Generate never places Archery in a 10-minute Flag Raising block, but the event still lands', () => {
    const cells = run(1)
    const inFlag = cells.filter((s) => s.blockId === 'flag')
    expect(inFlag.filter((s) => s.type === 'activity')).toEqual([])
    expect(inFlag.find((s) => s.groupId === 'g1').type).toBe('fixed_event')
    expect(cells.some((s) => s.blockId === 'main' && s.type === 'activity' && s.activityId === 'archery')).toBe(true)
  })

  it('a multi-block activity cannot span into an events-only block', () => {
    const span = { ...archery, id: 'ropes', name: 'Ropes', span_blocks: 2 }
    const blocks = [{ ...mainBlock, id: 'pre', sort_order: 0, start_time: '09:05', end_time: '09:50' }, flagBlock(1), { ...mainBlock, sort_order: 2, start_time: '10:00', end_time: '10:45' }]
    const { slots: cells } = buildSchedule({
      groups, tiers: [{ id: 't1', name: 'Junior' }], days: [day], timeBlocks: blocks, activities: [span], fixedEvents: [], campId: 'test', replacedDayIds: [],
    })
    expect(cells.filter((s) => s.blockId === 'flag' && s.type === 'activity')).toEqual([])
  })

  describe('a director-locked multi-block span across an events-only block (a lock wins)', () => {
    const span = { ...archery, id: 'ropes', name: 'Ropes', span_blocks: 2 }
    const blocks = [{ ...mainBlock, id: 'pre', sort_order: 0, start_time: '09:05', end_time: '09:50' }, flagBlock(1), { ...mainBlock, sort_order: 2, start_time: '10:00', end_time: '10:45' }]
    // Otters 1 prints Flag Raising in the events-only block; Otters 2 does not, and its lock runs through.
    const run = () => buildSchedule(engineInput({
      timeBlocks: blocks, activities: [span, archery], fixedEvents: [{ ...flagRaising, time_block_id: 'flag' }],
      preplacedSlots: [{ groupId: 'g2', dayId: 'd1', blockId: 'pre', activityId: 'ropes' }],
    }))
    const cell = (r, g, b) => r.slots.find((s) => s.groupId === g && s.blockId === b)

    it('keeps both cells as Ropes', () => {
      const r = run()
      expect(cell(r, 'g2', 'pre')).toMatchObject({ type: 'activity', activityId: 'ropes', is_span_head: true })
      expect(cell(r, 'g2', 'flag')).toMatchObject({ type: 'activity', activityId: 'ropes', is_span_head: false })
    })

    it('raises a finding naming the event', () => {
      const f = run().findings.filter((x) => x.kind === 'EVENTS_ONLY_SPAN')
      expect(f).toHaveLength(1)
      expect(f[0]).toMatchObject({ groupId: 'g2', activityId: 'ropes', reason: 'Ropes runs into Flag Raising (events only)' })
    })

    it('counts Ropes once as a session', () => {
      const ropes = run().slots.filter((s) => s.groupId === 'g2' && s.activityId === 'ropes' && s.type === 'activity' && s.is_span_head !== false)
      expect(ropes).toHaveLength(1)
    })

    it("Generate's own placements still never enter the events-only block", () => {
      const r = run()
      expect(r.slots.filter((s) => s.blockId === 'flag' && s.type === 'activity' && s.is_span_head !== false)).toEqual([])
    })
  })

  it('flipping the toggle off makes the block schedulable again', () => {
    const cells = run(0)
    expect(cells.some((s) => s.blockId === 'flag' && s.groupId === 'g2' && s.type === 'activity')).toBe(true)
  })
})

describe('computeFindings: a persisted lock span tail inside an events-only block', () => {
  it('raises EVENTS_ONLY_SPAN from the saved slots', () => {
    const span = { ...archery, id: 'ropes', name: 'Ropes', min_per_week: 0 }
    const findings = computeFindings({
      slots: [
        { group_id: 'g2', day_id: 'd1', time_block_id: 'pre', activity_id: 'ropes', is_span_head: true },
        { group_id: 'g2', day_id: 'd1', time_block_id: 'flag', activity_id: 'ropes', is_span_head: false },
      ],
      groups, activities: [span], days: [day], replacedDayIds: [],
      fixedEvents: [{ ...flagRaising, time_block_id: 'flag' }], timeBlocks: [flagBlock(1), mainBlock],
    })
    expect(findings.filter((f) => f.kind === 'EVENTS_ONLY_SPAN').map((f) => f.reason)).toEqual(['Ropes runs into Flag Raising (events only)'])
  })
})
