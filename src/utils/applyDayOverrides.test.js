// applyDayOverrides — T108 Phase 1 (day-overrides re-point).
// docs/work/specs/2026-08-21-day-overrides-repoint-design.md §5/§6.2, ADR
// docs/adr/2026-08-21-day-overrides-repoint-shape.md D1/D4.
//
// Pure render-time diff, same shape as withWeekClosureFlags/computeOverlaps:
// takes the resolved `slots` array plus the day_overrides rows already
// filtered to the current (schedule_week_id, day_id), returns a new slots
// array with matching cells rewritten. Never mutates its inputs.
import { describe, it, expect } from 'vitest'
import { applyDayOverrides } from './applyDayOverrides.js'

function slot(overrides = {}) {
  return {
    id: 'slot1',
    group_id: 'grp1',
    day_id: 'day1',
    time_block_id: 'block1',
    activity_id: 'act-swim',
    is_span_head: null,
    flags: null,
    ...overrides,
  }
}

function override(overrides = {}) {
  return {
    id: 'ovr1',
    schedule_week_id: 'week1',
    day_id: 'day1',
    group_id: 'grp1',
    time_block_id: 'block1',
    activity_id: 'act-art',
    kind: 'swap',
    note: null,
    ...overrides,
  }
}

describe('applyDayOverrides', () => {
  it('swap: replaces activity_id and stamps is_overridden + day_override_id', () => {
    const slots = [slot()]
    const result = applyDayOverrides(slots, [override()])
    expect(result[0].activity_id).toBe('act-art')
    expect(result[0].is_overridden).toBe(true)
    expect(result[0].day_override_id).toBe('ovr1')
  })

  it('pull: sets activity_id null and stamps is_pull + is_overridden', () => {
    const slots = [slot()]
    const result = applyDayOverrides(slots, [override({ kind: 'pull', activity_id: null })])
    expect(result[0].activity_id).toBeNull()
    expect(result[0].is_pull).toBe(true)
    expect(result[0].is_overridden).toBe(true)
    expect(result[0].day_override_id).toBe('ovr1')
  })

  it('multi-group: applies independently per group, leaves unmatched groups untouched', () => {
    const slots = [
      slot({ id: 's1', group_id: 'grp1' }),
      slot({ id: 's2', group_id: 'grp2', activity_id: 'act-boat' }),
    ]
    const overrides = [override({ id: 'ovr1', group_id: 'grp1', activity_id: 'act-art' })]
    const result = applyDayOverrides(slots, overrides)
    expect(result.find((s) => s.id === 's1').activity_id).toBe('act-art')
    expect(result.find((s) => s.id === 's1').is_overridden).toBe(true)
    expect(result.find((s) => s.id === 's2').activity_id).toBe('act-boat')
    expect(result.find((s) => s.id === 's2').is_overridden).toBeFalsy()
  })

  it('span-refusal: never rewrites a span head (is_span_head === true)', () => {
    const slots = [slot({ is_span_head: true })]
    const result = applyDayOverrides(slots, [override()])
    expect(result[0].activity_id).toBe('act-swim')
    expect(result[0].is_overridden).toBeFalsy()
  })

  it('span-refusal: never rewrites a span tail (isActivityTail via is_span_head === false)', () => {
    // Two contiguous blocks sharing activity_id, second is the tail
    // (is_span_head === false), matching gridGeometry.js's isActivityTail.
    const slots = [
      slot({ id: 's1', time_block_id: 'block1', is_span_head: true }),
      slot({ id: 's2', time_block_id: 'block2', is_span_head: false }),
    ]
    const overrides = [override({ id: 'ovr2', time_block_id: 'block2', activity_id: 'act-art' })]
    const result = applyDayOverrides(slots, overrides)
    expect(result.find((s) => s.id === 's2').activity_id).toBe('act-swim')
    expect(result.find((s) => s.id === 's2').is_overridden).toBeFalsy()
  })

  it('marker stamping travels through the row: is_overridden + day_override_id on swap', () => {
    const slots = [slot()]
    const result = applyDayOverrides(slots, [override({ id: 'ovr-xyz' })])
    expect(result[0].day_override_id).toBe('ovr-xyz')
  })

  it('pull-vs-UNFILLABLE: PULL applies even when the row already carries UNFILLABLE flags', () => {
    const slots = [slot({ flags: { UNFILLABLE: true } })]
    const result = applyDayOverrides(slots, [override({ kind: 'pull', activity_id: null })])
    expect(result[0].is_pull).toBe(true)
    // The UNFILLABLE flag is preserved for audit/export, not erased by the pull.
    expect(result[0].flags.UNFILLABLE).toBe(true)
  })

  it('override whose group/block is not in the current route slots is silently not applied', () => {
    const slots = [slot({ group_id: 'grp1', time_block_id: 'block1' })]
    const overrides = [override({ group_id: 'grp-missing', time_block_id: 'block9' })]
    const result = applyDayOverrides(slots, overrides)
    expect(result[0].activity_id).toBe('act-swim')
    expect(result[0].is_overridden).toBeFalsy()
  })

  it('returns the same array reference when there are no overrides (no-op stability)', () => {
    const slots = [slot()]
    const result = applyDayOverrides(slots, [])
    expect(result).toBe(slots)
  })

  it('does not mutate the input slots array', () => {
    const slots = [slot()]
    applyDayOverrides(slots, [override()])
    expect(slots[0].activity_id).toBe('act-swim')
    expect(slots[0].is_overridden).toBeUndefined()
  })
})
