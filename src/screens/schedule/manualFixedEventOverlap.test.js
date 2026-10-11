import { describe, it, expect } from 'vitest'
import { recalcFindings, findingsContext } from './useScheduleData'

// The Manual route must show a fixed event booked twice for one group, and keep
// showing it after a drag or reload, without the generated-only
// FIXED_EVENT_DUPLICATE ("regenerate to clear it").
const groups = [{ id: 'g1', name: 'Otters 1', tier_id: 't1' }, { id: 'g2', name: 'Otters 2', tier_id: 't1' }]
const days = [{ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }]
const timeBlocks = [{ id: 'b1', name: '12:00-12:45', start_time: '12:00', end_time: '12:45', sort_order: 0 }]
const lunch = (id, ids, span) => ({ id, name: 'Lunch', activity_id: null, is_all_groups: false, group_ids: ids, day_id: 'd1', time_block_id: 'b1', span_blocks: span })
const swim = { id: 'a1', name: 'Swim' }
const all = {
  groups, activities: [swim], days, timeBlocks, replacedDayIds: [], weekId: null,
  fixedEvents: [lunch('fe1', ['g1', 'g2'], 1), { ...lunch('fe2', ['g2'], 2), activity_id: 'a1' }],
  activityExclusions: [], groupExclusions: [], locationExclusions: [],
}
// A manual slot placing the fixed event's activity: generated would flag it FIXED_EVENT_DUPLICATE.
const slots = [{ group_id: 'g2', day_id: 'd1', time_block_id: 'b1', activity_id: 'a1' }]

describe('Manual route findings', () => {
  it('raise FIXED_EVENT_OVERLAP for a group booked twice', () => {
    const f = recalcFindings(slots, findingsContext('manual', all))
    expect(f.filter((x) => x.kind === 'FIXED_EVENT_OVERLAP').map((x) => x.groupId)).toEqual(['g2'])
  })
  it('never raise the generated-only FIXED_EVENT_DUPLICATE', () => {
    const f = recalcFindings(slots, findingsContext('manual', all))
    expect(f.filter((x) => x.kind === 'FIXED_EVENT_DUPLICATE')).toEqual([])
  })
  it('generated keeps both', () => {
    const f = recalcFindings(slots, findingsContext('generated', all))
    expect(f.some((x) => x.kind === 'FIXED_EVENT_OVERLAP')).toBe(true)
    expect(f.some((x) => x.kind === 'FIXED_EVENT_DUPLICATE')).toBe(true)
  })
})

// Every findings recompute in the schedule screens goes through recalcFindings +
// findingsContext, so a new site cannot drop the Manual double-booking check again.
describe('findings recompute sites', () => {
  it('no screen calls computeFindings directly', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = path.resolve(__dirname, '..')
    const files = fs.readdirSync(dir, { recursive: true })
      .filter((f) => /\.(js|jsx)$/.test(f) && !/\.test\./.test(f) && !f.endsWith('useScheduleData.js'))
    const offenders = files.filter((f) => /\bcomputeFindings\(/.test(fs.readFileSync(path.join(dir, f), 'utf8')))
    expect(offenders).toEqual([])
  })
})
