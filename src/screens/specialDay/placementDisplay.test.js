import { describe, it, expect } from 'vitest'
import { placementChips, placementSublabel } from './placementDisplay'

const weeks = [
  { id: 'w2', name: 'Week 2', sort_order: 1, is_archived: 0 },
  { id: 'w1', name: 'Week 1', sort_order: 0, is_archived: 0 },
  { id: 'wa', name: 'Week 0', sort_order: -1, is_archived: 1 },
]
const days = [
  { id: 'd2', label: 'Tuesday', sort_order: 1 },
  { id: 'd1', label: 'Monday', sort_order: 0 },
]
const p = (week_id, day_id, special_day_id = 'sd') => ({ id: `${week_id}:${day_id}`, week_id, day_id, special_day_id })

describe('placementChips', () => {
  it('orders by week sort_order then day sort_order', () => {
    const chips = placementChips({ specialDayId: 'sd', placements: [p('w2', 'd1'), p('w1', 'd2'), p('w1', 'd1')], weeks, days })
    expect(chips.map(c => c.label)).toEqual(['Week 1 · Mon', 'Week 1 · Tue', 'Week 2 · Mon'])
  })
  it('marks an archived week in the chip text', () => {
    const chips = placementChips({ specialDayId: 'sd', placements: [p('wa', 'd1')], weeks, days })
    expect(chips.map(c => c.label)).toEqual(['Week 0 (archived) · Mon'])
  })
  it('drops orphans and other special days', () => {
    const chips = placementChips({ specialDayId: 'sd', placements: [p('gone', 'd1'), p('w1', 'gone'), p('w1', 'd1', 'other')], weeks, days })
    expect(chips).toEqual([])
  })
})

describe('placementSublabel', () => {
  const args = (placements) => ({ specialDayId: 'sd', placements, weeks, days })
  it('none for zero placements', () => expect(placementSublabel(args([]))).toBeNull())
  it('names the one day', () => expect(placementSublabel(args([p('w2', 'd2')]))).toBe('Placed Week 2 Tue'))
  it('counts two or more, ignoring orphans', () => {
    expect(placementSublabel(args([p('w1', 'd1'), p('w2', 'd2'), p('w2', 'd1'), p('gone', 'd1')]))).toBe('Placed 3 days')
  })
  it('an orphan alone is no placement', () => expect(placementSublabel(args([p('gone', 'd1')]))).toBeNull())
})
