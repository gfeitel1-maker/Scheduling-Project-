import { describe, it, expect } from 'vitest'
import {
  getSlot,
  isAnchorTail,
  getAnchorRowSpan,
  isActivityTail,
  getActivityRowSpan,
  makeGridGeometry,
  decideCell,
} from './gridGeometry'

// Fixtures use the shape normalizeSlots() produces: is_anchor / is_span_head /
// is_released are booleans (never 0/1), flags is a plain object.
function slot(overrides = {}) {
  return {
    id: 'slot-1',
    group_id: 'g1',
    day_id: 'd1',
    time_block_id: 'b1',
    activity_id: 'act-1',
    anchor_id: null,
    is_anchor: false,
    is_span_head: true,
    is_released: false,
    flags: {},
    ...overrides,
  }
}

// Three consecutive blocks for the same group+day.
const timeBlocks = [
  { id: 'b1', sort_order: 1 },
  { id: 'b2', sort_order: 2 },
  { id: 'b3', sort_order: 3 },
]

describe('getSlot', () => {
  it('finds the slot at a group/day/block coordinate', () => {
    const slots = [slot({ id: 's1', time_block_id: 'b1' }), slot({ id: 's2', time_block_id: 'b2' })]
    expect(getSlot(slots, 'g1', 'd1', 'b2')?.id).toBe('s2')
  })
  it('returns undefined when no slot is placed', () => {
    expect(getSlot([], 'g1', 'd1', 'b1')).toBeUndefined()
  })
})

describe('a plain filled slot', () => {
  const slots = [slot()]
  it('is not an activity tail', () => {
    expect(isActivityTail(slots, 'g1', 'd1', 'b1')).toBe(false)
  })
  it('has a rowspan of 1', () => {
    expect(getActivityRowSpan(slots, timeBlocks, 'g1', 'd1', 'b1')).toBe(1)
  })
})

describe('a merged-span activity pair', () => {
  // b1 = head (is_span_head true), b2 = tail (is_span_head false), same activity.
  const slots = [
    slot({ id: 'head', time_block_id: 'b1', is_span_head: true }),
    slot({ id: 'tail', time_block_id: 'b2', is_span_head: false }),
  ]
  it('head is not a tail and spans 2 rows', () => {
    expect(isActivityTail(slots, 'g1', 'd1', 'b1')).toBe(false)
    expect(getActivityRowSpan(slots, timeBlocks, 'g1', 'd1', 'b1')).toBe(2)
  })
  it('tail is suppressed (isActivityTail true, rowspan not counted from it)', () => {
    expect(isActivityTail(slots, 'g1', 'd1', 'b2')).toBe(true)
  })
})

describe('an anchor spanning two blocks', () => {
  const slots = [
    slot({ id: 'a1', time_block_id: 'b1', is_anchor: true, anchor_id: 'anc-1', activity_id: null }),
    slot({ id: 'a2', time_block_id: 'b2', is_anchor: true, anchor_id: 'anc-1', activity_id: null }),
  ]
  it('head is not an anchor tail and spans 2 rows', () => {
    expect(isAnchorTail(slots, timeBlocks, 'g1', 'd1', 'b1')).toBe(false)
    expect(getAnchorRowSpan(slots, timeBlocks, 'g1', 'd1', 'b1')).toBe(2)
  })
  it('tail is an anchor tail', () => {
    expect(isAnchorTail(slots, timeBlocks, 'g1', 'd1', 'b2')).toBe(true)
  })
  it('a lone anchor spans 1 and is not a tail', () => {
    const lone = [slot({ id: 'a1', time_block_id: 'b1', is_anchor: true, anchor_id: 'anc-9', activity_id: null })]
    expect(getAnchorRowSpan(lone, timeBlocks, 'g1', 'd1', 'b1')).toBe(1)
    expect(isAnchorTail(lone, timeBlocks, 'g1', 'd1', 'b1')).toBe(false)
  })
})

describe('makeGridGeometry (bound facade)', () => {
  const groups = [{ id: 'g1', tier_id: 't1' }]
  const slots = [slot({ time_block_id: 'b2' })]
  const geometry = makeGridGeometry({ slots, timeBlocks, groups })

  it('binds data so callers pass only coordinates', () => {
    expect(geometry.getSlot('g1', 'd1', 'b2')?.id).toBe('slot-1')
  })
})

describe('decideCell', () => {
  const groups = [{ id: 'g1', tier_id: 't1' }]

  it('returns empty when no slot is placed', () => {
    const geometry = makeGridGeometry({ slots: [], timeBlocks, groups })
    expect(decideCell(geometry, 'g1', 'd1', 'b1').kind).toBe('empty')
  })

  it('returns a slot decision with rowspan and activity cellType', () => {
    const slots = [slot({ time_block_id: 'b1' })]
    const geometry = makeGridGeometry({ slots, timeBlocks, groups })
    const d = decideCell(geometry, 'g1', 'd1', 'b1')
    expect(d.kind).toBe('slot')
    expect(d.cellType).toBe('activity')
    expect(d.rowSpan).toBe(1)
  })

  it('suppresses an activity tail as skip', () => {
    const slots = [
      slot({ id: 'head', time_block_id: 'b1', is_span_head: true }),
      slot({ id: 'tail', time_block_id: 'b2', is_span_head: false }),
    ]
    const geometry = makeGridGeometry({ slots, timeBlocks, groups })
    expect(decideCell(geometry, 'g1', 'd1', 'b1').rowSpan).toBe(2)
    expect(decideCell(geometry, 'g1', 'd1', 'b2').kind).toBe('skip')
  })

  it('treats a slot with no activity and no UNFILLABLE flag as empty (droppable)', () => {
    const slots = [slot({ time_block_id: 'b1', activity_id: null, flags: {} })]
    const geometry = makeGridGeometry({ slots, timeBlocks, groups })
    expect(decideCell(geometry, 'g1', 'd1', 'b1').kind).toBe('empty')
  })

  // Events overlay placement Slice 1 (docs/adr/2026-08-22-events-overlay-
  // placement.md §3) — an event cell (event_id set, activity_id null) has
  // real content and must render as a slot, same as an elective cell.
  it('treats a slot with only event_id set as content, not empty', () => {
    const slots = [slot({ time_block_id: 'b1', activity_id: null, event_id: 'ev-1', flags: {} })]
    const geometry = makeGridGeometry({ slots, timeBlocks, groups })
    const d = decideCell(geometry, 'g1', 'd1', 'b1')
    expect(d.kind).toBe('slot')
    expect(d.cellType).toBe('activity')
  })

  it('renders an UNFILLABLE-flagged empty slot as a slot cell (cellType activity)', () => {
    // The empty early-return only fires when NOT UNFILLABLE, so an UNFILLABLE
    // empty slot reaches cellType, which resolves to 'activity' (matches views).
    const slots = [slot({ time_block_id: 'b1', activity_id: null, flags: { UNFILLABLE: true } })]
    const geometry = makeGridGeometry({ slots, timeBlocks, groups })
    const d = decideCell(geometry, 'g1', 'd1', 'b1')
    expect(d.kind).toBe('slot')
    expect(d.cellType).toBe('activity')
  })

  // T108 Phase 2 (design §5.1) — a PULL override composed by applyDayOverrides
  // (is_overridden + is_pull stamped on the row) must route to 'pulled', never
  // 'empty' (which would render as a droppable EmptyCell).
  it('routes a pull-overridden slot to kind "pulled", not empty', () => {
    const slots = [slot({ time_block_id: 'b1', activity_id: null, is_overridden: true, is_pull: true, flags: {} })]
    const geometry = makeGridGeometry({ slots, timeBlocks, groups })
    const d = decideCell(geometry, 'g1', 'd1', 'b1')
    expect(d.kind).toBe('pulled')
    expect(d.slot).toBe(slots[0])
  })

  it('routes a swap-overridden slot to a normal slot decision (SlotCell renders the marker)', () => {
    const slots = [slot({ time_block_id: 'b1', activity_id: 'act-art', is_overridden: true, flags: {} })]
    const geometry = makeGridGeometry({ slots, timeBlocks, groups })
    const d = decideCell(geometry, 'g1', 'd1', 'b1')
    expect(d.kind).toBe('slot')
    expect(d.slot.is_overridden).toBe(true)
  })
})
