// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useFlagChangeAck, MAX_SINGLE_EDIT_CELLS } from './useFlagChangeAck'

function slot(groupId, dayId, blockId, flags) {
  return { group_id: groupId, day_id: dayId, time_block_id: blockId, flags }
}

function setup(initialSlots, initialRoute = 'generated', initialToken = 0) {
  return renderHook(
    ({ slots, route, resyncToken = 0 }) => useFlagChangeAck(slots, route, resyncToken),
    { initialProps: { slots: initialSlots, route: initialRoute, resyncToken: initialToken } }
  )
}

describe('useFlagChangeAck', () => {
  it('emits nothing on initial mount', () => {
    const { result } = setup([slot('g1', 'd1', 'b1', { UNFILLABLE: true })])
    expect(result.current).toEqual([])
  })

  it('emits exactly the changed cellKey for a single in-place flag change', () => {
    const s1 = slot('g1', 'd1', 'b1', {})
    const s2 = slot('g2', 'd1', 'b1', {})
    const { result, rerender } = setup([s1, s2])
    expect(result.current).toEqual([])

    const s1Changed = slot('g1', 'd1', 'b1', { OVERLAP: true })
    rerender({ slots: [s1Changed, s2], route: 'generated' })
    expect(result.current).toEqual(['g1|d1|b1'])
  })

  it('emits nothing when a change touches more than MAX_SINGLE_EDIT_CELLS cells (generation/undo proxy)', () => {
    const initial = Array.from({ length: MAX_SINGLE_EDIT_CELLS + 1 }, (_, i) =>
      slot(`g${i}`, 'd1', 'b1', {})
    )
    const { result, rerender } = setup(initial)
    expect(result.current).toEqual([])

    const changed = initial.map(s => slot(s.group_id, 'd1', 'b1', { UNFILLABLE: true }))
    rerender({ slots: changed, route: 'generated' })
    expect(result.current).toEqual([])
  })

  it('resets on route change so the first subsequent diff emits nothing', () => {
    const s1 = slot('g1', 'd1', 'b1', {})
    const { result, rerender } = setup([s1], 'generated')
    expect(result.current).toEqual([])

    // Same slot content, but a route switch — the first diff after this
    // must emit nothing even though nothing here looks "wholesale".
    rerender({ slots: [s1], route: 'manual' })
    expect(result.current).toEqual([])

    // Normal diffing resumes on the next genuine edit.
    const s1Changed = slot('g1', 'd1', 'b1', { OVERLAP: true })
    rerender({ slots: [s1Changed], route: 'manual' })
    expect(result.current).toEqual(['g1|d1|b1'])
  })

  it('emits nothing when a single-cell change coincides with a resyncToken bump (undo / small regeneration)', () => {
    // Red Hat HIGH+MEDIUM: an undo of a single-cell edit — and a regeneration
    // that happens to differ in <=3 cells — are structurally identical to a
    // real edit under the magnitude-only guard, so they used to re-fire the
    // ack. The action bumps resyncToken; the hook must then treat the next diff
    // as a wholesale reload and emit nothing.
    const s1 = slot('g1', 'd1', 'b1', {})
    const { result, rerender } = setup([s1], 'generated', 0)
    expect(result.current).toEqual([])

    const s1Changed = slot('g1', 'd1', 'b1', { OVERLAP: true })
    rerender({ slots: [s1Changed], route: 'generated', resyncToken: 1 })
    expect(result.current).toEqual([])

    // A genuine single-cell edit afterward (token unchanged) resumes emitting.
    const s1Cleared = slot('g1', 'd1', 'b1', {})
    rerender({ slots: [s1Cleared], route: 'generated', resyncToken: 1 })
    expect(result.current).toEqual(['g1|d1|b1'])
  })

  it('signature respects the _dismissed suffix', () => {
    const s1 = slot('g1', 'd1', 'b1', { UNFILLABLE: true })
    const { result, rerender } = setup([s1])
    expect(result.current).toEqual([])

    // Dismissing the flag changes the effective signature (UNFILLABLE no
    // longer counts as active) even though the raw flags object still has it.
    const s1Dismissed = slot('g1', 'd1', 'b1', { UNFILLABLE: true, UNFILLABLE_dismissed: true })
    rerender({ slots: [s1Dismissed], route: 'generated' })
    expect(result.current).toEqual(['g1|d1|b1'])

    // Re-render with the identical signature: no further change, no emit.
    rerender({ slots: [s1Dismissed], route: 'generated' })
    expect(result.current).toEqual([])
  })
})
