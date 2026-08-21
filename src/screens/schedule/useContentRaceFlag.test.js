// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useContentRaceFlag } from './useContentRaceFlag'

function slot(groupId, dayId, blockId, fields = {}) {
  return { group_id: groupId, day_id: dayId, time_block_id: blockId, activity_id: null, elective_set_id: null, ...fields }
}

function makeOwnWriteRef(entries = []) {
  const map = new Map(entries)
  return { current: map }
}

function setup(initialSlots, ownWriteRef, initialRoute = 'generated') {
  return renderHook(
    ({ slots, route }) => useContentRaceFlag(slots, route, ownWriteRef),
    { initialProps: { slots: initialSlots, route: initialRoute } }
  )
}

describe('useContentRaceFlag', () => {
  it('own-write suppression: a local write followed by the same kind lands with no flag', () => {
    const ownWriteRef = makeOwnWriteRef([
      ['g1|d1|b1', { kind: 'activity:act-1', atWriteToken: Date.now() }],
    ])
    const { result, rerender } = setup([slot('g1', 'd1', 'b1')], ownWriteRef)
    // Echo back the SAME kind this device just wrote.
    act(() => { rerender({ slots: [slot('g1', 'd1', 'b1', { activity_id: 'act-1' })], route: 'generated' }) })
    expect(result.current.racedKeys).toEqual([])
  })

  it('a different kind landing on the same cell after this device\'s own write fires the flag', () => {
    const ownWriteRef = makeOwnWriteRef([
      ['g1|d1|b1', { kind: 'activity:act-1', atWriteToken: Date.now() }],
    ])
    const { result, rerender } = setup([slot('g1', 'd1', 'b1')], ownWriteRef)
    // A DIFFERENT device's write landed instead — a real race.
    act(() => { rerender({ slots: [slot('g1', 'd1', 'b1', { elective_set_id: 'set-other' })], route: 'generated' }) })
    expect(result.current.racedKeys).toEqual(['g1|d1|b1'])
  })

  it('dismissing a raced flag locally means it does not reappear on the next unrelated slots change', () => {
    const ownWriteRef = makeOwnWriteRef([
      ['g1|d1|b1', { kind: 'activity:act-1', atWriteToken: Date.now() }],
    ])
    const { result, rerender } = setup([slot('g1', 'd1', 'b1')], ownWriteRef)
    act(() => { rerender({ slots: [slot('g1', 'd1', 'b1', { elective_set_id: 'set-other' })], route: 'generated' }) })
    expect(result.current.racedKeys).toEqual(['g1|d1|b1'])

    act(() => { result.current.dismiss('g1|d1|b1') })
    expect(result.current.racedKeys).toEqual([])

    // An unrelated slots change must not resurrect it.
    act(() => { rerender({ slots: [slot('g1', 'd1', 'b1', { elective_set_id: 'set-other' }), slot('g2', 'd1', 'b1')], route: 'generated' }) })
    expect(result.current.racedKeys).toEqual([])
  })

  it('a route switch clears any pending flag with no re-fire', () => {
    const ownWriteRef = makeOwnWriteRef([
      ['g1|d1|b1', { kind: 'activity:act-1', atWriteToken: Date.now() }],
    ])
    const { result, rerender } = setup([slot('g1', 'd1', 'b1')], ownWriteRef, 'generated')
    act(() => { rerender({ slots: [slot('g1', 'd1', 'b1', { elective_set_id: 'set-other' })], route: 'manual' }) })
    expect(result.current.racedKeys).toEqual([])
  })

  it('an own-write record older than the recency window is dropped without comparison (no flag, no matter what lands)', () => {
    const ownWriteRef = makeOwnWriteRef([
      ['g1|d1|b1', { kind: 'activity:act-1', atWriteToken: Date.now() - 10 * 60 * 1000 }],
    ])
    const { result, rerender } = setup([slot('g1', 'd1', 'b1')], ownWriteRef)
    act(() => { rerender({ slots: [slot('g1', 'd1', 'b1', { elective_set_id: 'set-other' })], route: 'generated' }) })
    expect(result.current.racedKeys).toEqual([])
  })

  it('a local undo of an elective placement, followed by the server ack for that undo, does not self-flag', () => {
    // The undo closure's own success path populates ownWriteRef with the
    // RESTORED kind ('empty') — not the forward write's 'elective:...' kind.
    const ownWriteRef = makeOwnWriteRef([
      ['g1|d1|b1', { kind: 'empty', atWriteToken: Date.now() }],
    ])
    const { result, rerender } = setup([slot('g1', 'd1', 'b1', { elective_set_id: 'set-1' })], ownWriteRef)
    // Server ack for the undo: the cell is now empty, matching the undo's own record.
    act(() => { rerender({ slots: [slot('g1', 'd1', 'b1')], route: 'generated' }) })
    expect(result.current.racedKeys).toEqual([])
  })

  it('a local redo likewise does not self-flag', () => {
    const ownWriteRef = makeOwnWriteRef([
      ['g1|d1|b1', { kind: 'elective:set-1', atWriteToken: Date.now() }],
    ])
    const { result, rerender } = setup([slot('g1', 'd1', 'b1')], ownWriteRef)
    act(() => { rerender({ slots: [slot('g1', 'd1', 'b1', { elective_set_id: 'set-1' })], route: 'generated' }) })
    expect(result.current.racedKeys).toEqual([])
  })
})
