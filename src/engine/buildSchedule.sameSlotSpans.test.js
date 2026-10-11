import { describe, it, expect } from 'vitest'
import buildSchedule, { computeFindings } from './buildSchedule.js'

// T363: the same event at one block for two group sets that hold it for different lengths imports as two
// rows (same name, day and block, different span_blocks). The engine must place both, each for its own groups.
const groups = [
  { id: 'g1', name: 'Otters 1', tier_id: 't1', availability: 'all' },
  { id: 'g2', name: 'Otters 2', tier_id: 't1', availability: 'all' },
  { id: 'g3', name: 'Badgers', tier_id: 't1', availability: 'all' },
]
const day = { id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }
const block = (id, order, start, end) => ({ id, name: `${start}-${end}`, start_time: start, end_time: end, sort_order: order, part_of_day: 'morning', events_only: 0 })
const timeBlocks = [block('b1', 0, '12:00', '12:45'), block('b2', 1, '12:45', '13:30'), block('b3', 2, '13:30', '14:15')]
const lunch = (id, ids, span) => ({ id, name: 'Lunch', activity_id: null, is_all_groups: false, group_ids: ids, day_id: 'd1', time_block_id: 'b1', span_blocks: span })

const engineInput = (over) => ({
  groups, tiers: [{ id: 't1', name: 'Junior' }], days: [day], timeBlocks, activities: [], fixedEvents: [], campId: 'test', replacedDayIds: [], ...over,
})

describe('two same-name events at one block with different spans', () => {
  const result = buildSchedule(engineInput({ fixedEvents: [lunch('fe1', ['g1', 'g2'], 1), lunch('fe2', ['g3'], 2)] }))
  const cell = (g, b) => result.slots.find((s) => s.groupId === g && s.blockId === b)

  it('places the one-block Lunch for the younger groups only', () => {
    expect(cell('g1', 'b1')).toMatchObject({ type: 'fixed_event' })
    expect(cell('g2', 'b1')).toMatchObject({ type: 'fixed_event' })
    expect(cell('g1', 'b2')?.type).not.toBe('fixed_event')
  })

  it('places the two-block Lunch across both blocks for the older group', () => {
    expect(cell('g3', 'b1')).toMatchObject({ type: 'fixed_event' })
    expect(cell('g3', 'b2')).toMatchObject({ type: 'fixed_event' })
    expect(cell('g3', 'b3')?.type).not.toBe('fixed_event')
  })

  it('raises no conflict for disjoint groups', () => {
    expect(result.conflicts).toEqual([])
  })
})

describe('two rows covering the same group at one block (overlapping scopes)', () => {
  const short = lunch('fe1', ['g1', 'g2'], 1)
  const long = lunch('fe2', ['g2', 'g3'], 2)

  it.each([['short first', true], ['long first', false]])('the larger span wins and a finding names the group, whatever the row order (%s)', (_n, shortFirst) => {
    const result = buildSchedule(engineInput({ fixedEvents: shortFirst ? [short, long] : [long, short] }))
    const cell = (g, b) => result.slots.find((s) => s.groupId === g && s.blockId === b)
    expect(cell('g2', 'b2')).toMatchObject({ type: 'fixed_event' })
    const overlaps = result.findings.filter((f) => f.kind === 'FIXED_EVENT_OVERLAP')
    expect(overlaps.map((f) => f.groupId)).toEqual(['g2'])
    expect(overlaps[0].severity).toBe('caution')
  })

  it('raises no finding when the rows cover different groups', () => {
    const result = buildSchedule(engineInput({ fixedEvents: [short, lunch('fe3', ['g3'], 2)] }))
    expect(result.slots.find((x) => x.groupId === 'g3' && x.blockId === 'b2')).toMatchObject({ type: 'fixed_event' })
    expect(result.findings.filter((f) => f.kind === 'FIXED_EVENT_OVERLAP')).toEqual([])
  })
})

describe('FIXED_EVENT_OVERLAP scope and persistence (Red Hat 3)', () => {
  it('two DIFFERENT events in one block raise no overlap finding and keep last-write-wins', () => {
    const swim = { ...lunch('fe2', ['g1'], 1), name: 'Swim Test' }
    const result = buildSchedule(engineInput({ fixedEvents: [lunch('fe1', ['g1'], 1), swim] }))
    expect(result.findings.filter((f) => f.kind === 'FIXED_EVENT_OVERLAP')).toEqual([])
    expect(result.slots.find((x) => x.groupId === 'g1' && x.blockId === 'b1')).toMatchObject({ type: 'fixed_event' })
  })

  it('an equal-span overlap does not claim the longer one is used', () => {
    const result = buildSchedule(engineInput({ fixedEvents: [lunch('fe1', ['g1'], 1), lunch('fe2', ['g1'], 1)] }))
    const f = result.findings.find((x) => x.kind === 'FIXED_EVENT_OVERLAP')
    expect(f.reason).not.toMatch(/longer/)
  })

  it('computeFindings reproduces the overlap finding from persisted slots (survives a recompute)', () => {
    const fixedEvents = [lunch('fe1', ['g1', 'g2'], 1), lunch('fe2', ['g2', 'g3'], 2)]
    const built = buildSchedule(engineInput({ fixedEvents }))
    const recomputed = computeFindings({
      slots: [], groups, activities: [], days: [day], timeBlocks, fixedEvents, weekId: null, replacedDayIds: [],
    })
    expect(recomputed.filter((f) => f.kind === 'FIXED_EVENT_OVERLAP').map((f) => f.groupId)).toEqual(
      built.findings.filter((f) => f.kind === 'FIXED_EVENT_OVERLAP').map((f) => f.groupId),
    )
    expect(recomputed.filter((f) => f.kind === 'FIXED_EVENT_OVERLAP')).toHaveLength(1)
  })

  it('computeFindings raises nothing for different-name events in one block', () => {
    const fixedEvents = [lunch('fe1', ['g1'], 1), { ...lunch('fe2', ['g1'], 1), name: 'Swim Test' }]
    const recomputed = computeFindings({ slots: [], groups, activities: [], days: [day], timeBlocks, fixedEvents, weekId: null, replacedDayIds: [] })
    expect(recomputed.filter((f) => f.kind === 'FIXED_EVENT_OVERLAP')).toEqual([])
  })
})
