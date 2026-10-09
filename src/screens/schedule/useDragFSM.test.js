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
      expect.objectContaining({ toPalette: true, valid: true }),
      expect.anything()
    )
  })

  it('resolves the hit at the live pointer, not activator+delta, after the page scrolls mid-drag', () => {
    const cellAt = {}
    for (const [k, y] of [['g|d1|b1', 100], ['g|d1|b4', 400]]) {
      const el = makeEl(); el.setAttribute('data-cell-key', k); el.getBoundingClientRect = () => ({ top: y, bottom: y + 50, height: 50 }); cellAt[y] = el
    }
    document.elementFromPoint = (x, y) => (y >= 100 && y < 150 ? cellAt[100] : y >= 400 && y < 450 ? cellAt[400] : null)
    const { result } = renderHook(() => useDragFSM({
      commit: vi.fn(), describeDrag: () => 'x', describeHit: () => 'y', isOccupied: () => false,
    }))
    const active = { id: 'g|d1|b4', data: { current: { slot: { groupId: 'g', dayId: 'd1', blockId: 'b4' } } } }
    act(() => {
      result.current.surfaceProps.onPointerDownCapture({ clientX: 10, clientY: 420, target: cellAt[400] })
      result.current.dndProps.onDragStart({ active, activatorEvent: { clientX: 10, clientY: 420 }, delta: { x: 0, y: 0 } })
    })
    // Pointer really moved to y=120 (over b1); dnd-kit's delta also folds in a
    // 150px scroll adjustment, which activator+delta would land at y=-30.
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 120 }))
      result.current.dndProps.onDragMove({ active, activatorEvent: { clientX: 10, clientY: 420 }, delta: { x: 0, y: -450 } })
    })
    expect(cellAt[100].hasAttribute('data-drag-over')).toBe(true)
  })

  it('marks the picked-up cell with data-drag-source for the whole gesture', async () => {
    const src = makeEl(); src.setAttribute('data-cell-key', 'g0|d0|b0')
    document.elementFromPoint = () => src
    const { result } = renderHook(() => useDragFSM({
      commit: vi.fn(async () => {}), describeDrag: () => 'x', describeHit: () => 'y', isOccupied: () => false,
    }))
    const ev = { active: { id: 'g0|d0|b0', data: { current: { slot: {} } } }, activatorEvent: { code: 'Space' }, delta: { x: 0, y: 0 } }
    act(() => { result.current.dndProps.onDragStart(ev) })
    expect(src.hasAttribute('data-drag-source')).toBe(true)
    act(() => { result.current.dndProps.onDragCancel() })
    expect(src.hasAttribute('data-drag-source')).toBe(false)
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
