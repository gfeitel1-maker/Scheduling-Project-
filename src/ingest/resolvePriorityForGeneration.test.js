import { describe, it, expect } from 'vitest'
import { resolvePriorityForGeneration } from './resolvePriorityForGeneration.js'
import buildSchedule from '../engine/buildSchedule.js'

describe('resolvePriorityForGeneration', () => {
  it('passes through existing high/low priority unchanged', () => {
    const [high, low] = resolvePriorityForGeneration([
      { id: 'a', priority: 'high' },
      { id: 'b', priority: 'low' },
    ])
    expect(high.priority).toBe('high')
    expect(low.priority).toBe('low')
  })

  it('resolves undefined, null, and absent priority to low', () => {
    const [undef, nul, absent] = resolvePriorityForGeneration([
      { id: 'a', priority: undefined },
      { id: 'b', priority: null },
      { id: 'c' },
    ])
    expect(undef.priority).toBe('low')
    expect(nul.priority).toBe('low')
    expect(absent.priority).toBe('low')
  })

  it('never yields a value other than pass-through high/low or the "low" default', () => {
    const inputs = [
      { id: 'a', priority: 'high' },
      { id: 'b', priority: 'low' },
      { id: 'c', priority: undefined },
      { id: 'd', priority: null },
      { id: 'e' },
      { id: 'f', priority: 'bogus' },
    ]
    const out = resolvePriorityForGeneration(inputs)
    for (const a of out) {
      expect(['high', 'low']).toContain(a.priority)
    }
    // bogus (an invalid, non-'high' value) must resolve to 'low', never 'high'.
    expect(out.find((a) => a.id === 'f').priority).toBe('low')
  })

  it('is a pure map — does not mutate input objects', () => {
    const input = { id: 'a', priority: undefined }
    const [out] = resolvePriorityForGeneration([input])
    expect(input.priority).toBeUndefined()
    expect(out.priority).toBe('low')
  })
})

describe('resolvePriorityForGeneration + buildSchedule determinism', () => {
  const baseGroup = { id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }
  const baseDay = { id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }
  const baseBlock = { id: 'b1', name: 'Morning', start_time: '09:00', end_time: '10:15', sort_order: 0, part_of_day: 'morning' }

  function run() {
    const activities = resolvePriorityForGeneration([
      {
        id: 'act-unknown', name: 'Mystery', max_per_week: 5, min_per_week: 0,
        is_outdoor: false, location: null, max_groups_per_slot: 1, same_tier_only: false,
        eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null,
        // priority intentionally absent — UNKNOWN
      },
    ])
    return buildSchedule({
      groups: [baseGroup], tiers: [{ id: 't1', name: 'Junior' }], days: [baseDay],
      timeBlocks: [baseBlock], activities, anchors: [], campId: 'test',
    })
  }

  it('an unknown-priority activity (resolved to low) still participates and placement is deterministic across runs', () => {
    const r1 = run()
    const r2 = run()
    expect(r1.slots).toEqual(r2.slots)
    const placed = r1.slots.filter((s) => s.type === 'activity' && s.activityId === 'act-unknown')
    expect(placed.length).toBeGreaterThan(0)
  })
})
