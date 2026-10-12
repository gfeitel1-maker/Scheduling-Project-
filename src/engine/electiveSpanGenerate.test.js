import { describe, it, expect } from 'vitest'
import buildSchedule from './buildSchedule.js'
import { derivePreplacedSlots } from '../screens/schedule/preplacedSlots.js'

// T219: Generate keeps an imported double-period elective as one span. The
// stored cells (head + tail) go through the same derivePreplacedSlots ->
// buildSchedule path the Generate button uses.
describe('Generate keeps a spanning elective', () => {
  const blocks = [
    { id: 'b1', name: '9:00', start_time: '09:00', end_time: '10:00', sort_order: 0 },
    { id: 'b2', name: '10:00', start_time: '10:00', end_time: '11:00', sort_order: 1 },
  ]
  const stored = [
    { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', elective_set_id: 'set1', is_span_head: true },
    { group_id: 'g1', day_id: 'd1', time_block_id: 'b2', elective_set_id: 'set1', is_span_head: false },
  ]

  it('emits the head and the tail with their span marking', () => {
    const { slots } = buildSchedule({
      groups: [{ id: 'g1', name: 'Aleph', tier_id: 't1', availability: 'all' }],
      tiers: [{ id: 't1', name: 'Junior' }],
      days: [{ id: 'd1', label: 'Monday', day_of_week: 1, sort_order: 0 }],
      timeBlocks: blocks, activities: [], fixedEvents: [], campId: 'c', replacedDayIds: [],
      preplacedSlots: derivePreplacedSlots(stored, []),
    })
    const cells = slots.filter((s) => s.type === 'elective').map((s) => [s.blockId, s.electiveSetId, s.is_span_head])
    expect(cells).toEqual([['b1', 'set1', true], ['b2', 'set1', false]])
  })

  it('a stored elective with no span marking stays its own head', () => {
    expect(derivePreplacedSlots([{ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', elective_set_id: 'set1' }], [])[0].isSpanHead).toBeUndefined()
  })
})
