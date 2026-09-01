import { describe, it, expect } from 'vitest'
import {
  buildScheduleLookups,
  resolveSlotCell,
  formatCellLabel,
  ELECTIVE_REMOVED_LABEL,
  EVENT_REMOVED_LABEL,
} from './scheduleCells.js'

const activities = [{ id: 'act-1', name: 'Swimming' }, { id: 'act-2', name: 'Kayaking' }]
const anchors = [{ id: 'anc-1', name: 'Lunch' }]
const electiveSets = [{ id: 'set-1', name: 'Afternoon Chugim' }]
const electiveSetActivities = [
  { elective_set_id: 'set-1', activity_id: 'act-1' },
  { elective_set_id: 'set-1', activity_id: 'act-2' },
]
const events = [{ id: 'ev-1', name: 'Color War' }]

const lookups = buildScheduleLookups({ activities, anchors, electiveSets, electiveSetActivities, events })

describe('resolveSlotCell — structured cell records', () => {
  it('empty for a falsy slot', () => {
    expect(resolveSlotCell(undefined, lookups)).toEqual({ kind: 'empty', ref_id: null, name: null })
    expect(resolveSlotCell(null, lookups)).toEqual({ kind: 'empty', ref_id: null, name: null })
  })

  it('activity cell resolves ref + name', () => {
    const c = resolveSlotCell({ activity_id: 'act-1' }, lookups)
    expect(c).toEqual({ kind: 'activity', ref_id: 'act-1', name: 'Swimming' })
  })

  it('a dangling activity_id keeps the ref with a null name', () => {
    const c = resolveSlotCell({ activity_id: 'gone' }, lookups)
    expect(c).toEqual({ kind: 'activity', ref_id: 'gone', name: null })
  })

  it('anchor cell resolves anchor ref + name', () => {
    const c = resolveSlotCell({ is_anchor: 1, anchor_id: 'anc-1' }, lookups)
    expect(c).toEqual({ kind: 'anchor', ref_id: 'anc-1', name: 'Lunch' })
  })

  it('event cell resolves ref + name, missing:false', () => {
    const c = resolveSlotCell({ event_id: 'ev-1' }, lookups)
    expect(c).toEqual({ kind: 'event', ref_id: 'ev-1', name: 'Color War', missing: false })
  })

  it('a dangling event_id sets missing:true, name null', () => {
    const c = resolveSlotCell({ event_id: 'ev-gone' }, lookups)
    expect(c).toEqual({ kind: 'event', ref_id: 'ev-gone', name: null, missing: true })
  })

  it('elective cell resolves set name + member names array', () => {
    const c = resolveSlotCell({ elective_set_id: 'set-1' }, lookups)
    expect(c).toEqual({ kind: 'elective', ref_id: 'set-1', name: 'Afternoon Chugim', members: ['Swimming', 'Kayaking'], missing: false })
  })

  it('a dangling elective_set_id sets missing:true, empty members', () => {
    const c = resolveSlotCell({ elective_set_id: 'set-gone' }, lookups)
    expect(c).toEqual({ kind: 'elective', ref_id: 'set-gone', name: null, members: [], missing: true })
  })

  it('precedence: anchor beats event/elective/activity on the same row', () => {
    const c = resolveSlotCell({ is_anchor: 1, anchor_id: 'anc-1', event_id: 'ev-1', activity_id: 'act-1' }, lookups)
    expect(c.kind).toBe('anchor')
  })
})

describe('formatCellLabel — matches the Excel labels exactly', () => {
  it('activity → name', () => {
    expect(formatCellLabel({ kind: 'activity', name: 'Swimming' })).toBe('Swimming')
  })
  it('activity with null name → empty string', () => {
    expect(formatCellLabel({ kind: 'activity', name: null })).toBe('')
  })
  it('anchor per-day → name, falling back to literal "Anchor"', () => {
    expect(formatCellLabel({ kind: 'anchor', name: 'Lunch' })).toBe('Lunch')
    expect(formatCellLabel({ kind: 'anchor', name: null })).toBe('Anchor')
  })
  it('anchor master sheet → "[Anchor] name"', () => {
    expect(formatCellLabel({ kind: 'anchor', name: 'Lunch' }, { anchorBracket: true })).toBe('[Anchor] Lunch')
    expect(formatCellLabel({ kind: 'anchor', name: null }, { anchorBracket: true })).toBe('[Anchor] ')
  })
  it('event → name; dangling → "Event (removed)"', () => {
    expect(formatCellLabel({ kind: 'event', name: 'Color War', missing: false })).toBe('Color War')
    expect(formatCellLabel({ kind: 'event', name: null, missing: true })).toBe(EVENT_REMOVED_LABEL)
  })
  it('elective with members → "set (a, b)"; no members → set; dangling → "Elective (removed)"', () => {
    expect(formatCellLabel({ kind: 'elective', name: 'Afternoon Chugim', members: ['Swimming', 'Kayaking'], missing: false }))
      .toBe('Afternoon Chugim (Swimming, Kayaking)')
    expect(formatCellLabel({ kind: 'elective', name: 'Afternoon Chugim', members: [], missing: false }))
      .toBe('Afternoon Chugim')
    expect(formatCellLabel({ kind: 'elective', name: null, members: [], missing: true }))
      .toBe(ELECTIVE_REMOVED_LABEL)
  })
  it('empty → empty string', () => {
    expect(formatCellLabel({ kind: 'empty' })).toBe('')
  })
})
