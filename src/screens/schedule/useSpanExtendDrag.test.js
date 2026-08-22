// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSpanExtendDrag } from './useSpanExtendDrag'

const timeBlocks = [
  { id: 'b1', name: 'Block 1', sort_order: 1 },
  { id: 'b2', name: 'Block 2', sort_order: 2 },
  { id: 'b3', name: 'Block 3', sort_order: 3 },
  { id: 'b4', name: 'Block 4', sort_order: 4 },
]
const activities = [{ id: 'actHead', name: 'Swim' }, { id: 'actLocked', name: 'Locked', is_locked: true }]

// Real DOM cells the hook's elementFromPoint-driven resolution reads —
// jsdom's elementFromPoint always returns null, so pointermove/up dispatch
// resolves the target cell via document.querySelector directly (mocked
// below), matching how resolveHit (dragFSM's own precedent) resolves off
// data-cell-key rather than coordinates in this same test style.
function makeCell(groupId, dayId, blockId) {
  const el = document.createElement('div')
  el.setAttribute('data-cell-key', `${groupId}|${dayId}|${blockId}`)
  document.body.appendChild(el)
  return el
}

describe('useSpanExtendDrag', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('paints data-drag-over on every covered cell as the pointer tracks forward, and calls expandSlot once on drop with the furthest valid block', () => {
    const b1 = makeCell('g1', 'd1', 'b1')
    const b2 = makeCell('g1', 'd1', 'b2')
    const b3 = makeCell('g1', 'd1', 'b3')
    document.elementFromPoint = () => b3

    const expandSlot = vi.fn()
    const slots = [
      { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: null },
      { id: 't2', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: null },
    ]
    const { result } = renderHook(() => useSpanExtendDrag({ slots, timeBlocks, activities, expandSlot }))

    act(() => { result.current.startExtend('g1', 'd1', 'b1', 'actHead') })
    expect(b1.hasAttribute('data-span-dragging')).toBe(true)

    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 0, clientY: 0 })) })
    expect(b2.getAttribute('data-drag-over')).toBe('')
    expect(b3.getAttribute('data-drag-over')).toBe('')

    act(() => { window.dispatchEvent(new MouseEvent('pointerup', { clientX: 0, clientY: 0 })) })

    expect(expandSlot).toHaveBeenCalledWith('g1', 'd1', 'b1', 'b3')
    // Preview cleared and the dragging marker removed on drop.
    expect(b2.hasAttribute('data-drag-over')).toBe(false)
    expect(b3.hasAttribute('data-drag-over')).toBe(false)
    expect(b1.hasAttribute('data-span-dragging')).toBe(false)
  })

  it('marks the last valid block data-drag-truncated when the pointer overshoots a stop condition, and drops at that block', () => {
    const b1 = makeCell('g1', 'd1', 'b1')
    const b2 = makeCell('g1', 'd1', 'b2')
    const b4 = makeCell('g1', 'd1', 'b4')
    document.elementFromPoint = () => b4

    const expandSlot = vi.fn()
    const slots = [
      { id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: null },
      { id: 'locked1', group_id: 'g1', day_id: 'd1', time_block_id: 'b3', activity_id: 'actLocked' },
    ]
    const { result } = renderHook(() => useSpanExtendDrag({ slots, timeBlocks, activities, expandSlot }))

    act(() => { result.current.startExtend('g1', 'd1', 'b1', 'actHead') })
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 0, clientY: 0 })) })

    expect(b2.getAttribute('data-drag-truncated')).toBe('')

    act(() => { window.dispatchEvent(new MouseEvent('pointerup', { clientX: 0, clientY: 0 })) })
    expect(expandSlot).toHaveBeenCalledWith('g1', 'd1', 'b1', 'b2')
    expect(b1.hasAttribute('data-span-dragging')).toBe(false)
    // b4 was never a valid covered cell.
    expect(b4.hasAttribute('data-drag-over')).toBe(false)
  })

  it('Escape cancels the gesture: preview clears and expandSlot is never called', () => {
    const b1 = makeCell('g1', 'd1', 'b1')
    const b2 = makeCell('g1', 'd1', 'b2')
    document.elementFromPoint = () => b2

    const expandSlot = vi.fn()
    const slots = [{ id: 't1', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: null }]
    const { result } = renderHook(() => useSpanExtendDrag({ slots, timeBlocks, activities, expandSlot }))

    act(() => { result.current.startExtend('g1', 'd1', 'b1', 'actHead') })
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 0, clientY: 0 })) })
    expect(b2.getAttribute('data-drag-over')).toBe('')

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })

    expect(b2.hasAttribute('data-drag-over')).toBe(false)
    expect(b1.hasAttribute('data-span-dragging')).toBe(false)

    act(() => { window.dispatchEvent(new MouseEvent('pointerup', { clientX: 0, clientY: 0 })) })
    expect(expandSlot).not.toHaveBeenCalled()
  })

  it('a pointer that never leaves the head (no valid covered block) calls expandSlot on nothing', () => {
    const b1 = makeCell('g1', 'd1', 'b1')
    document.elementFromPoint = () => b1

    const expandSlot = vi.fn()
    const { result } = renderHook(() => useSpanExtendDrag({ slots: [], timeBlocks, activities, expandSlot }))

    act(() => { result.current.startExtend('g1', 'd1', 'b1', 'actHead') })
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 0, clientY: 0 })) })
    act(() => { window.dispatchEvent(new MouseEvent('pointerup', { clientX: 0, clientY: 0 })) })

    expect(expandSlot).not.toHaveBeenCalled()
  })
})
