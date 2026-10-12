// T377 (consistency audit 2026-10-12, A9): Fixed and Recurring Events show one row per event name,
// not one per day. Storage stays one row per day; this is the grouping the table renders.
import { describe, it, expect } from 'vitest'
import { groupFixedEvents, compactDays } from './groupFixedEvents'

const DAYS = [
  { id: 'mon', label: 'Monday', day_of_week: 1, sort_order: 1 },
  { id: 'tue', label: 'Tuesday', day_of_week: 2, sort_order: 2 },
  { id: 'wed', label: 'Wednesday', day_of_week: 3, sort_order: 3 },
  { id: 'thu', label: 'Thursday', day_of_week: 4, sort_order: 4 },
  { id: 'fri', label: 'Friday', day_of_week: 5, sort_order: 5 },
]
const ev = (id, day_id, o = {}) => ({ id, name: 'Lineup', day_id, time_block_id: 'b1', unit_ids: [], is_all_groups: 1, schedule_week_id: null, location_id: null, ...o })

describe('compactDays', () => {
  it('collapses a run of three or more consecutive days into a range', () => {
    expect(compactDays(['mon', 'tue', 'wed', 'thu', 'fri'], DAYS)).toBe('Mon–Fri')
  })
  it('lists non-consecutive days, and a run of two, by name', () => {
    expect(compactDays(['mon', 'wed', 'fri'], DAYS)).toBe('Mon, Wed, Fri')
    expect(compactDays(['mon', 'tue', 'thu'], DAYS)).toBe('Mon, Tue, Thu')
  })
  it('mixes ranges and single days, in the camp day order whatever the input order', () => {
    expect(compactDays(['fri', 'mon', 'tue', 'wed'], DAYS)).toBe('Mon–Wed, Fri')
  })
  it('abbreviates by weekday, not by a custom label', () => {
    const days = [{ ...DAYS[0], label: 'Color War Day' }, ...DAYS.slice(1)]
    expect(compactDays(['mon', 'wed'], days)).toBe('Mon, Wed')
  })
  it('a single day reads as its full name', () => {
    expect(compactDays(['wed'], DAYS)).toBe('Wednesday')
  })
})

describe('groupFixedEvents', () => {
  it('groups rows by name (ignoring case and spacing) into one entry per event, days in camp order', () => {
    const groups = groupFixedEvents([ev('3', 'wed'), ev('1', 'mon'), ev('2', 'tue', { name: ' lineup ' }), ev('9', 'mon', { name: 'Swim' })], DAYS)
    expect(groups.map((g) => g.name)).toEqual(['Lineup', 'Swim'])
    expect(groups[0].events.map((e) => e.id)).toEqual(['1', '2', '3'])
    expect(groups[0].daysLabel).toBe('Mon–Wed')
  })
  it('flags a field that differs between the days, and keeps it when they agree', () => {
    const [same] = groupFixedEvents([ev('1', 'mon'), ev('2', 'tue')], DAYS)
    expect(same.timesVary).toBe(false)
    expect(same.timeBlockId).toBe('b1')
    const [mixed] = groupFixedEvents([ev('1', 'mon'), ev('2', 'tue', { time_block_id: 'b2' })], DAYS)
    expect(mixed.timesVary).toBe(true)
    expect(mixed.timeBlockId).toBe(null)
  })
  it('flags differing weeks and differing age divisions separately', () => {
    const [g] = groupFixedEvents([ev('1', 'mon', { schedule_week_id: 'w1' }), ev('2', 'tue', { unit_ids: ['t1'] })], DAYS)
    expect(g.weeksVary).toBe(true)
    expect(g.scopeVaries).toBe(true)
    expect(g.timesVary).toBe(false)
  })
})
