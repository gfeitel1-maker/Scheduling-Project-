// T350 slice 3 (docs/adr/2026-10-09-special-day-binds-to-a-week-day.md D4):
// a day bound to a special day is replaced, and the two engine entries apply
// that themselves at entry — placement, pre-placements and every findings loop.
import { describe, it, expect } from 'vitest'
import buildSchedule, { computeFindings } from './buildSchedule.js'
import { resolveEffectiveDays, dropReplacedPreplaced } from './effectiveDays.js'

const group = { id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }
const mon = { id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }
const tue = { id: 'd2', label: 'Tuesday', day_of_week: 2, sort_order: 1 }
const wed = { id: 'd3', label: 'Wednesday', day_of_week: 3, sort_order: 2 }
const block = { id: 'b1', name: 'Morning', start_time: '09:00', end_time: '10:15', sort_order: 0, part_of_day: 'morning' }

function activity(id, extra = {}) {
  return { id, name: id, priority: 'high', max_per_week: 5, min_per_week: 0, is_outdoor: false, location_id: null, max_groups_per_slot: 1, same_tier_only: false, eligible_tier_ids: [], eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null, ...extra }
}

function input(overrides = {}) {
  return {
    groups: [group], tiers: [{ id: 't1', name: 'Junior' }], days: [mon, tue], timeBlocks: [block],
    activities: [], fixedEvents: [], campId: 'test', replacedDayIds: [], ...overrides,
  }
}

describe('a locked activity on a replaced day (the first failing test)', () => {
  it('is not placed, does not count toward its goal, and does not hold its location', () => {
    const loc = { id: 'loc1', name: 'Range', capacity: 1 }
    const archery = activity('archery', { min_per_week: 1, location_id: 'loc1' })
    const { slots, findings } = buildSchedule(input({
      days: [mon, tue],
      activities: [archery],
      locations: [loc],
      preplacedSlots: [{ groupId: 'g1', dayId: 'd2', blockId: 'b1', activityId: 'archery' }],
      replacedDayIds: ['d2'],
    }))
    expect(slots.some(s => s.dayId === 'd2')).toBe(false)
    // Not counted: the goal is met by a placement on Monday instead, so the
    // locked Tuesday row neither satisfied it nor blocked Monday via the
    // per-day/location ledgers.
    const placed = slots.filter(s => s.activityId === 'archery')
    expect(placed.map(s => s.dayId)).toEqual(['d1'])
    expect(findings.some(f => f.kind === 'UNDERSERVED')).toBe(false)
  })
})

describe('replacedDayIds is required at both engine entries', () => {
  it('buildSchedule throws when it is absent', () => {
    const { replacedDayIds: _omit, ...rest } = input()
    expect(() => buildSchedule(rest)).toThrow(/replacedDayIds/)
  })
  it('computeFindings throws when it is absent', () => {
    expect(() => computeFindings({ slots: [], groups: [group], activities: [], days: [mon] })).toThrow(/replacedDayIds/)
  })
  it('[] changes nothing', () => {
    const acts = [activity('swim', { min_per_week: 2 }), activity('art', { min_per_week: 1 })]
    const a = buildSchedule(input({ activities: acts }))
    const b = buildSchedule(input({ activities: acts }))
    expect(a).toEqual(b)
    expect(a.slots.length).toBeGreaterThan(0)
  })
})

describe('nothing is generated on a replaced day', () => {
  it('places no slot of any kind on it, including fixed events and the cohorts signature', () => {
    const lunch = activity('lunch')
    const fe = { id: 'fe1', activity_id: 'lunch', unit_id: null, is_all_groups: true, group_ids: [], day_id: null, time_block_id: 'b1', span_blocks: 1 }
    const { slots } = buildSchedule(input({ activities: [lunch], fixedEvents: [fe], replacedDayIds: ['d1'] }))
    expect(slots.some(s => s.dayId === 'd1')).toBe(false)
    expect(slots.some(s => s.dayId === 'd2')).toBe(true)

    const { slots: cohortSlots } = buildSchedule({
      cohorts: [{
        cohort: { id: 'c1', fixed_event_model: 'fixed', capacity_source: 'groups_per_slot', session_week_start: 1, session_week_end: 1 },
        timeBlocks: [block], tiers: [], groups: [group], activityTargets: null,
        preplacedSlots: [{ groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'swim' }],
      }],
      days: [mon, tue], activities: [activity('swim')], campId: 'test', replacedDayIds: ['d1'],
    })
    expect(cohortSlots.some(s => s.dayId === 'd1')).toBe(false)
  })

  it('every day replaced: empty schedule, no throw', () => {
    const r = buildSchedule(input({ activities: [activity('swim', { min_per_week: 1 })], replacedDayIds: ['d1', 'd2'] }))
    expect(r.slots).toEqual([])
  })
})

describe('findings use effective days', () => {
  const swim = activity('swim', { prefer_before_day: 2, prefer_before_day_min: 1 })

  it('prefer_before_day on a replaced day yields an explicit DISTRIBUTION finding (buildSchedule)', () => {
    const { findings } = buildSchedule(input({ days: [mon, tue, wed], activities: [swim], replacedDayIds: ['d2'] }))
    const f = findings.find(x => x.kind === 'DISTRIBUTION' && x.activityId === 'swim')
    expect(f).toBeTruthy()
    expect(f.severity).toBe('info')
    expect(f.reason).toMatch(/can.t be met/i)
    expect(f.reason).toMatch(/before Tuesday/)
    expect(f.reason).not.toMatch(/day 2/)
  })

  it('prefer_before_day on a replaced day yields the same finding (computeFindings, manual route: no fixedEvents/weekId)', () => {
    const findings = computeFindings({ slots: [], groups: [group], activities: [swim], days: [mon, tue, wed], replacedDayIds: ['d2'] })
    const f = findings.find(x => x.kind === 'DISTRIBUTION')
    expect(f?.reason).toMatch(/can.t be met/i)
  })

  it('prefer_before_day on a normal day is unchanged', () => {
    const findings = computeFindings({ slots: [], groups: [group], activities: [swim], days: [mon, tue, wed], replacedDayIds: [] })
    const f = findings.find(x => x.kind === 'DISTRIBUTION')
    expect(f.reason).not.toMatch(/can.t be met/i)
    expect(f.beforeCount).toBe(0)
  })

  it('UNDERSERVED ignores stored rows on a replaced day (computeFindings)', () => {
    const goal = activity('art', { min_per_week: 1 })
    const slots = [{ group_id: 'g1', day_id: 'd2', time_block_id: 'b1', activity_id: 'art', is_fixed_event: false }]
    expect(computeFindings({ slots, groups: [group], activities: [goal], days: [mon, tue], replacedDayIds: [] })).toHaveLength(0)
    const findings = computeFindings({ slots, groups: [group], activities: [goal], days: [mon, tue], replacedDayIds: ['d2'] })
    expect(findings.map(f => f.kind)).toEqual(['UNDERSERVED'])
  })
})

describe('resolveEffectiveDays', () => {
  const specialDays = [{ id: 'sd1', name: 'Visiting Day' }]
  it('replaces a day bound in this week', () => {
    const r = resolveEffectiveDays({ days: [mon, tue], weekId: 'w1', specialDays, placements: [{ week_id: 'w1', day_id: 'd2', special_day_id: 'sd1' }] })
    expect(r.days).toEqual([mon])
    expect(r.replacedDayIds).toEqual(['d2'])
  })
  it('ignores orphans: other week, unknown day, unresolved or missing special day', () => {
    const r = resolveEffectiveDays({
      days: [mon, tue], weekId: 'w1', specialDays,
      placements: [
        { week_id: 'w2', day_id: 'd1', special_day_id: 'sd1' },
        { week_id: 'w1', day_id: 'gone', special_day_id: 'sd1' },
        { week_id: 'w1', day_id: 'd1', special_day_id: 'deleted' },
        { week_id: 'w1', day_id: 'd2', special_day_id: null },
      ],
    })
    expect(r.days).toEqual([mon, tue])
    expect(r.replacedDayIds).toEqual([])
  })
})

describe('dropReplacedPreplaced', () => {
  it('drops entries on replaced days, keeps the rest', () => {
    const pre = [{ dayId: 'd1', groupId: 'g1' }, { dayId: 'd2', groupId: 'g1' }]
    expect(dropReplacedPreplaced(pre, ['d2'])).toEqual([{ dayId: 'd1', groupId: 'g1' }])
    expect(dropReplacedPreplaced(undefined, ['d2'])).toEqual([])
  })
})
