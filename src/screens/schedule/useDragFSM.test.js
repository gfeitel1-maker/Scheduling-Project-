// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDragFSM } from './useDragFSM'

function makeEl() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

describe('useDragFSM — static-ghost replace attribute', () => {
  it('showDragPreview sets data-drag-replace when isOccupied(hit) is true for a slot-move drag', () => {
    const el = makeEl()
    el.setAttribute('data-cell-key', 'g1|d1|b1')
    document.elementFromPoint = () => el
    const isOccupied = vi.fn(() => true)
    const { result } = renderHook(() => useDragFSM({
      commit: vi.fn(), describeDrag: () => 'x', describeHit: () => 'y', isOccupied,
    }))
    act(() => {
      result.current.dndProps.onDragStart({
        active: { data: { current: { slot: { groupId: 'g0', dayId: 'd0', blockId: 'b0' } } } },
        activatorEvent: { clientX: 5, clientY: 5 },
        delta: { x: 0, y: 0 },
      })
    })
    expect(el.hasAttribute('data-drag-replace')).toBe(true)
    expect(isOccupied).toHaveBeenCalled()
  })

  it('does not set data-drag-replace when isOccupied(hit) is false', () => {
    const el = makeEl()
    el.setAttribute('data-cell-key', 'g1|d1|b1')
    document.elementFromPoint = () => el
    const { result } = renderHook(() => useDragFSM({
      commit: vi.fn(), describeDrag: () => 'x', describeHit: () => 'y', isOccupied: () => false,
    }))
    act(() => {
      result.current.dndProps.onDragStart({
        active: { data: { current: { slot: { groupId: 'g0', dayId: 'd0', blockId: 'b0' } } } },
        activatorEvent: { clientX: 5, clientY: 5 },
        delta: { x: 0, y: 0 },
      })
    })
    expect(el.hasAttribute('data-drag-replace')).toBe(false)
  })

  it('resolveHit returns a toPalette hit when the release point is over the palette container, not a cell', async () => {
    const paletteEl = makeEl()
    paletteEl.setAttribute('data-activity-palette', '')
    document.elementFromPoint = () => paletteEl
    const commit = vi.fn()
    const { result } = renderHook(() => useDragFSM({
      commit, describeDrag: () => 'x', describeHit: () => 'y', isOccupied: () => false,
    }))
    act(() => {
      result.current.dndProps.onDragStart({
        active: { data: { current: { slot: { groupId: 'g0', dayId: 'd0', blockId: 'b0' } } } },
        activatorEvent: { clientX: 5, clientY: 5 },
        delta: { x: 0, y: 0 },
      })
    })
    await act(async () => {
      result.current.dndProps.onDragEnd({
        active: { data: { current: { slot: { groupId: 'g0', dayId: 'd0', blockId: 'b0' } } } },
        activatorEvent: { clientX: 5, clientY: 5 },
        delta: { x: 0, y: 0 },
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(commit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toPalette: true, valid: true })
    )
  })

  it('two sequential drags are armed with two distinct gestureIds', async () => {
    const el = makeEl()
    el.setAttribute('data-cell-key', 'g1|d1|b1')
    document.elementFromPoint = () => el
    const commit = vi.fn(async () => {})
    const { result } = renderHook(() => useDragFSM({
      commit, describeDrag: () => 'x', describeHit: () => 'y', isOccupied: () => false,
    }))
    const dragEvent = {
      active: { data: { current: { slot: { groupId: 'g0', dayId: 'd0', blockId: 'b0' } } } },
      activatorEvent: { clientX: 5, clientY: 5 },
      delta: { x: 0, y: 0 },
    }

    act(() => { result.current.dndProps.onDragStart(dragEvent) })
    const firstGestureId = result.current.peekState().context.gestureId
    expect(firstGestureId).toBeTruthy()
    await act(async () => {
      result.current.dndProps.onDragEnd(dragEvent)
      await Promise.resolve()
      await Promise.resolve()
    })

    act(() => { result.current.dndProps.onDragStart(dragEvent) })
    const secondGestureId = result.current.peekState().context.gestureId
    await act(async () => {
      result.current.dndProps.onDragEnd(dragEvent)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(secondGestureId).toBeTruthy()
    expect(secondGestureId).not.toBe(firstGestureId)
    expect(commit).toHaveBeenCalledTimes(2)
  })
})
