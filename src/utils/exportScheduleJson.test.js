import { describe, it, expect } from 'vitest'
import { buildScheduleExport } from './exportScheduleJson.js'

const groups = [{ id: 'g1', name: 'Bunk 1' }, { id: 'g2', name: 'Bunk 2' }]
const days = [{ id: 'd1', label: 'Monday', day_of_week: 1 }]
const timeBlocks = [{ id: 'b1', name: 'Period 1', start_time: '09:00:00', end_time: '10:00:00' }]
const activities = [{ id: 'act-1', name: 'Swimming' }, { id: 'act-2', name: 'Kayaking' }]
const anchors = [{ id: 'anc-1', name: 'Lunch' }]
const electiveSets = [{ id: 'set-1', name: 'Afternoon Chugim' }]
const electiveSetActivities = [
  { elective_set_id: 'set-1', activity_id: 'act-1' },
  { elective_set_id: 'set-1', activity_id: 'act-2' },
]
const events = [{ id: 'ev-1', name: 'Color War' }]
const camp = { id: 'camp-1', name: 'Camp Shoresh' }
const week = { id: 'w1', name: 'Week 1' }

function base(slots) {
  return { slots, activities, anchors, groups, days, timeBlocks, electiveSets, electiveSetActivities, events, camp, week, route: 'generated' }
}

describe('buildScheduleExport — versioned JSON schedule export', () => {
  it('carries format_version 1 and the camp/week/route envelope', () => {
    const out = buildScheduleExport(base([]))
    expect(out.format_version).toBe(1)
    expect(out.camp).toEqual({ id: 'camp-1', name: 'Camp Shoresh' })
    expect(out.week).toEqual({ id: 'w1', name: 'Week 1' })
    expect(out.route).toBe('generated')
  })

  it('maps the axes to id-bearing structures', () => {
    const out = buildScheduleExport(base([]))
    expect(out.groups).toEqual([{ id: 'g1', name: 'Bunk 1' }, { id: 'g2', name: 'Bunk 2' }])
    expect(out.days).toEqual([{ id: 'd1', label: 'Monday', day_of_week: 1 }])
    expect(out.time_blocks).toEqual([{ id: 'b1', name: 'Period 1', start_time: '09:00:00', end_time: '10:00:00' }])
  })

  it('emits only occupied cells, as structured references', () => {
    const slots = [
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1' },
      { group_id: 'g2', day_id: 'd1', time_block_id: 'b1', activity_id: null }, // empty → omitted
    ]
    const out = buildScheduleExport(base(slots))
    expect(out.cells).toEqual([
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', kind: 'activity', ref_id: 'act-1', name: 'Swimming' },
    ])
  })

  it('represents each cell kind: anchor / event / elective (with members)', () => {
    const slots = [
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', is_anchor: 1, anchor_id: 'anc-1' },
      { group_id: 'g2', day_id: 'd1', time_block_id: 'b1', event_id: 'ev-1' },
    ]
    const out = buildScheduleExport(base(slots))
    expect(out.cells).toContainEqual({ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', kind: 'anchor', ref_id: 'anc-1', name: 'Lunch' })
    expect(out.cells).toContainEqual({ group_id: 'g2', day_id: 'd1', time_block_id: 'b1', kind: 'event', ref_id: 'ev-1', name: 'Color War' })

    const elOut = buildScheduleExport(base([{ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', elective_set_id: 'set-1' }]))
    expect(elOut.cells[0]).toEqual({
      group_id: 'g1', day_id: 'd1', time_block_id: 'b1', kind: 'elective', ref_id: 'set-1', name: 'Afternoon Chugim', members: ['Swimming', 'Kayaking'],
    })
  })

  it('flags a dangling reference with missing:true but keeps the ref', () => {
    const out = buildScheduleExport(base([{ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', event_id: 'ev-gone' }]))
    expect(out.cells[0]).toEqual({ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', kind: 'event', ref_id: 'ev-gone', name: null, missing: true })
  })

  it('null envelope when camp/week/route are absent', () => {
    const out = buildScheduleExport({ slots: [], groups, days, timeBlocks })
    expect(out.camp).toBeNull()
    expect(out.week).toBeNull()
    expect(out.route).toBeNull()
  })
})
