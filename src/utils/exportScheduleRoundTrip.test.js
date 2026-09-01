import { describe, it, expect } from 'vitest'
import { buildScheduleExport } from './exportScheduleJson.js'

// EXPORT TESTING PROTOCOL — Layer 1 (the backbone).
// See docs/work/testing/export-testing-protocol.md.
//
// One "everything-in-it" coverage fixture exercised three ways:
//   1. round-trip:  export survives JSON serialize→parse unchanged (no
//      undefined/NaN, unicode intact).
//   2. golden fidelity: the emitted cells equal a hand-authored expected set —
//      every cell kind, every edge case, nothing dropped/added/distorted.
//   3. edges: empty cells omitted, dangling refs flagged, spans emit per block,
//      empty schedule still valid, format_version pinned.
//
// The fixture uses the DB/snake_case slot shape (template_slots columns), the
// same shape the renderer and the MCP feed buildScheduleExport.

const groups = [
  { id: 'g1', name: 'Aleph' },
  { id: 'g2', name: 'Bet' },
  { id: 'g3', name: 'Gimel' },
]
const days = [
  { id: 'd1', label: 'Monday', day_of_week: 1 },
  { id: 'd2', label: 'Tuesday', day_of_week: 2 },
]
const timeBlocks = [
  { id: 'b1', name: 'Period 1', start_time: '09:00:00', end_time: '10:00:00' },
  { id: 'b2', name: 'Period 2', start_time: '10:00:00', end_time: '11:00:00' },
]
const activities = [
  { id: 'act-1', name: 'Swimming' },
  { id: 'act-2', name: 'Kayaking' },
  { id: 'act-3', name: 'שחייה' }, // Hebrew — unicode must survive serialization
]
const anchors = [{ id: 'anc-1', name: 'Lunch' }]
const events = [{ id: 'ev-1', name: 'Color War' }]
const electiveSets = [{ id: 'set-1', name: 'Afternoon Chugim' }]
const electiveSetActivities = [
  { elective_set_id: 'set-1', activity_id: 'act-1' },
  { elective_set_id: 'set-1', activity_id: 'act-2' },
]
const camp = { id: 'camp-1', name: 'Camp Test' }
const week = { id: 'w1', name: 'Week 1' }

// Ordered exactly as the emitted cells will be (buildScheduleExport preserves
// slot order and drops empties). The empty g3/d1/b2 is interleaved to prove it
// is dropped without disturbing order.
const slots = [
  { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1' },              // plain activity
  { group_id: 'g1', day_id: 'd1', time_block_id: 'b2', is_anchor: 1, anchor_id: 'anc-1' },  // anchor
  { group_id: 'g2', day_id: 'd1', time_block_id: 'b1', event_id: 'ev-1' },                  // event
  { group_id: 'g2', day_id: 'd1', time_block_id: 'b2', elective_set_id: 'set-1' },          // elective + members
  { group_id: 'g3', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-3' },              // unicode name
  { group_id: 'g3', day_id: 'd1', time_block_id: 'b2', activity_id: null },                 // EMPTY → omitted
  { group_id: 'g1', day_id: 'd2', time_block_id: 'b1', activity_id: 'act-gone' },           // dangling activity
  { group_id: 'g2', day_id: 'd2', time_block_id: 'b1', event_id: 'ev-gone' },               // dangling event
  { group_id: 'g2', day_id: 'd2', time_block_id: 'b2', elective_set_id: 'set-gone' },       // dangling elective
  { group_id: 'g3', day_id: 'd2', time_block_id: 'b1', activity_id: 'act-1', is_span_head: 1 },  // span head
  { group_id: 'g3', day_id: 'd2', time_block_id: 'b2', activity_id: 'act-1', is_span_head: 0 },  // span tail
]

const fixture = { slots, activities, anchors, groups, days, timeBlocks, electiveSets, electiveSetActivities, events, camp, week, route: 'generated' }

const EXPECTED_CELLS = [
  { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', kind: 'activity', ref_id: 'act-1', name: 'Swimming' },
  { group_id: 'g1', day_id: 'd1', time_block_id: 'b2', kind: 'anchor', ref_id: 'anc-1', name: 'Lunch' },
  { group_id: 'g2', day_id: 'd1', time_block_id: 'b1', kind: 'event', ref_id: 'ev-1', name: 'Color War' },
  { group_id: 'g2', day_id: 'd1', time_block_id: 'b2', kind: 'elective', ref_id: 'set-1', name: 'Afternoon Chugim', members: ['Swimming', 'Kayaking'] },
  { group_id: 'g3', day_id: 'd1', time_block_id: 'b1', kind: 'activity', ref_id: 'act-3', name: 'שחייה' },
  { group_id: 'g1', day_id: 'd2', time_block_id: 'b1', kind: 'activity', ref_id: 'act-gone', name: null },
  { group_id: 'g2', day_id: 'd2', time_block_id: 'b1', kind: 'event', ref_id: 'ev-gone', name: null, missing: true },
  { group_id: 'g2', day_id: 'd2', time_block_id: 'b2', kind: 'elective', ref_id: 'set-gone', name: null, members: [], missing: true },
  { group_id: 'g3', day_id: 'd2', time_block_id: 'b1', kind: 'activity', ref_id: 'act-1', name: 'Swimming' },
  { group_id: 'g3', day_id: 'd2', time_block_id: 'b2', kind: 'activity', ref_id: 'act-1', name: 'Swimming' },
]

describe('export round-trip — Layer 1 backbone', () => {
  const out = buildScheduleExport(fixture)

  it('survives JSON serialize→parse unchanged (no undefined/NaN; unicode intact)', () => {
    const roundTripped = JSON.parse(JSON.stringify(out))
    expect(roundTripped).toEqual(out)
    // Hebrew name specifically survives the trip.
    const hebrew = roundTripped.cells.find((c) => c.ref_id === 'act-3')
    expect(hebrew.name).toBe('שחייה')
  })

  it('golden fidelity: emitted cells equal the hand-authored expected set', () => {
    // The strongest single assertion: every kind, every edge, exact order,
    // nothing dropped/added/distorted. A drift here is a visible diff and must
    // be a deliberate change (and bump format_version if the SHAPE changed).
    expect(out.cells).toEqual(EXPECTED_CELLS)
  })

  it('full envelope is correct and versioned', () => {
    expect(out.format_version).toBe(1)
    expect(out.camp).toEqual({ id: 'camp-1', name: 'Camp Test' })
    expect(out.week).toEqual({ id: 'w1', name: 'Week 1' })
    expect(out.route).toBe('generated')
    expect(out.groups).toEqual([{ id: 'g1', name: 'Aleph' }, { id: 'g2', name: 'Bet' }, { id: 'g3', name: 'Gimel' }])
    expect(out.days).toEqual([{ id: 'd1', label: 'Monday', day_of_week: 1 }, { id: 'd2', label: 'Tuesday', day_of_week: 2 }])
    expect(out.time_blocks).toEqual([
      { id: 'b1', name: 'Period 1', start_time: '09:00:00', end_time: '10:00:00' },
      { id: 'b2', name: 'Period 2', start_time: '10:00:00', end_time: '11:00:00' },
    ])
  })

  it('every cell kind is represented (explicit coverage guarantee)', () => {
    const kinds = new Set(out.cells.map((c) => c.kind))
    expect([...kinds].sort()).toEqual(['activity', 'anchor', 'elective', 'event'])
  })

  it('an empty cell is omitted, not exported blank', () => {
    const emptySpot = out.cells.find((c) => c.group_id === 'g3' && c.day_id === 'd1' && c.time_block_id === 'b2')
    expect(emptySpot).toBeUndefined()
    expect(out.cells).toHaveLength(10) // 11 slots, 1 empty dropped
  })

  it('dangling references are flagged (missing) not silently blanked', () => {
    const badEvent = out.cells.find((c) => c.ref_id === 'ev-gone')
    const badElective = out.cells.find((c) => c.ref_id === 'set-gone')
    expect(badEvent.missing).toBe(true)
    expect(badElective.missing).toBe(true)
    // A dangling ordinary activity keeps its ref with a null name (no data lied about).
    const badActivity = out.cells.find((c) => c.ref_id === 'act-gone')
    expect(badActivity).toMatchObject({ kind: 'activity', ref_id: 'act-gone', name: null })
  })

  it('a multi-block span emits one cell per block it covers', () => {
    const spanCells = out.cells.filter((c) => c.group_id === 'g3' && c.day_id === 'd2' && c.ref_id === 'act-1')
    expect(spanCells.map((c) => c.time_block_id).sort()).toEqual(['b1', 'b2'])
  })

  it('an empty schedule is still a valid, versioned export with zero cells', () => {
    const empty = buildScheduleExport({ slots: [], groups, days, timeBlocks })
    expect(empty.format_version).toBe(1)
    expect(empty.cells).toEqual([])
    expect(empty.groups).toHaveLength(3)
  })
})
