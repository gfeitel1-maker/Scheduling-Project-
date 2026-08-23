// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useClipboardSelection } from './useClipboardSelection'

// Two filled cells for group g1 plus a fixed anchor, in the normalizeSlots
// shape (booleans, not 0/1) the hook receives from the derived `slots`.
function slot(overrides = {}) {
  return {
    id: 'slot-1', group_id: 'g1', day_id: 'd1', time_block_id: 'b1',
    activity_id: 'act-1', anchor_id: null, is_anchor: false, is_span_head: true, flags: {},
    ...overrides,
  }
}

const slots = [
  slot({ id: 's-a', time_block_id: 'b1', activity_id: 'act-1' }),
  slot({ id: 's-b', time_block_id: 'b2', activity_id: 'act-2' }),
  slot({ id: 's-anchor', time_block_id: 'b3', activity_id: null, is_anchor: true }),
]
const activities = [
  { id: 'act-1', name: 'Swim' },
  { id: 'act-2', name: 'Archery' },
]

function setup(overrides = {}) {
  const placeActivityManual = vi.fn(async () => {})
  const props = { slots, activities, selectedGroup: 'g1', placeActivityManual, ...overrides }
  const hook = renderHook((p) => useClipboardSelection(p), { initialProps: props })
  return { ...hook, placeActivityManual }
}

describe('useClipboardSelection', () => {
  it('single-click selects exactly one cell; a second single-click replaces it', () => {
    const { result } = setup()
    act(() => result.current.handleCellSelect({ groupId: 'g1', dayId: 'd1', blockId: 'b1' }, {}))
    expect([...result.current.selectedSlotKeys]).toEqual(['g1|d1|b1'])

    act(() => result.current.handleCellSelect({ groupId: 'g1', dayId: 'd1', blockId: 'b2' }, {}))
    expect([...result.current.selectedSlotKeys]).toEqual(['g1|d1|b2'])
  })

  it('ctrl/meta-click toggles a cell into and out of a multi-selection', () => {
    const { result } = setup()
    act(() => result.current.handleCellSelect({ groupId: 'g1', dayId: 'd1', blockId: 'b1' }, { ctrlKey: true }))
    act(() => result.current.handleCellSelect({ groupId: 'g1', dayId: 'd1', blockId: 'b2' }, { ctrlKey: true }))
    expect(result.current.selectedSlotKeys.size).toBe(2)

    act(() => result.current.handleCellSelect({ groupId: 'g1', dayId: 'd1', blockId: 'b1' }, { ctrlKey: true }))
    expect([...result.current.selectedSlotKeys]).toEqual(['g1|d1|b2'])
  })

  it('Ctrl+C copies the selected filled cells into clipboard/paste mode and clears the selection', () => {
    const { result } = setup()
    act(() => result.current.handleCellSelect({ groupId: 'g1', dayId: 'd1', blockId: 'b1' }, { ctrlKey: true }))
    act(() => result.current.handleCellSelect({ groupId: 'g1', dayId: 'd1', blockId: 'b2' }, { ctrlKey: true }))

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true })))
    expect(result.current.pasteMode).toBe(true)
    expect(result.current.clipboardItems).toEqual([
      { activityId: 'act-1', activityName: 'Swim' },
      { activityId: 'act-2', activityName: 'Archery' },
    ])
    expect(result.current.selectedSlotKeys.size).toBe(0)
  })

  it('Ctrl+A selects every filled, non-anchor cell in the current group', () => {
    const { result } = setup()
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true })))
    // b1 and b2 are filled; b3 is the anchor and is excluded.
    expect([...result.current.selectedSlotKeys].sort()).toEqual(['g1|d1|b1', 'g1|d1|b2'])
  })

  it('in paste mode, clicking a cell places the current clipboard item then advances / exits', async () => {
    const { result, placeActivityManual } = setup()
    // Enter paste mode with two items.
    act(() => result.current.handleCellSelect({ groupId: 'g1', dayId: 'd1', blockId: 'b1' }, { ctrlKey: true }))
    act(() => result.current.handleCellSelect({ groupId: 'g1', dayId: 'd1', blockId: 'b2' }, { ctrlKey: true }))
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true })))

    await act(async () => result.current.handleCellSelect({ groupId: 'g1', dayId: 'd1', blockId: 'b1', is_anchor: false, is_span_head: true }, {}))
    // A paste has no drag gestureId — it synthesizes its own one-off claim id
    // (2026-08-12 ADR, FIX 1) so it still participates in the per-cell write
    // queue rather than bypassing it.
    expect(placeActivityManual).toHaveBeenCalledWith('act-1', 'g1', 'd1', 'b1', undefined, expect.any(String))
    expect(result.current.pasteModeIndex).toBe(1)
    expect(result.current.pasteMode).toBe(true)

    await act(async () => result.current.handleCellSelect({ groupId: 'g1', dayId: 'd1', blockId: 'b2', is_anchor: false, is_span_head: true }, {}))
    expect(placeActivityManual).toHaveBeenCalledWith('act-2', 'g1', 'd1', 'b2', undefined, expect.any(String))
    // Last item placed → paste mode exits and clears.
    expect(result.current.pasteMode).toBe(false)
    expect(result.current.clipboardItems).toEqual([])
    expect(result.current.pasteModeIndex).toBe(0)
  })

  it('pasting onto an anchor or a span tail is refused with a transient pasteError', async () => {
    const { result, placeActivityManual } = setup()
    act(() => result.current.handleCellSelect({ groupId: 'g1', dayId: 'd1', blockId: 'b1' }, { ctrlKey: true }))
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true })))

    await act(async () => result.current.handleCellSelect({ groupId: 'g1', dayId: 'd1', blockId: 'b3', is_anchor: true }, {}))
    expect(placeActivityManual).not.toHaveBeenCalled()
    expect(result.current.pasteError).toContain('recurring event')
    expect(result.current.pasteMode).toBe(true)
  })

  it('Escape cancels paste mode when active, otherwise clears the selection', () => {
    const { result } = setup()
    // Selection present, not pasting → Escape clears selection.
    act(() => result.current.handleCellSelect({ groupId: 'g1', dayId: 'd1', blockId: 'b1' }, {}))
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(result.current.selectedSlotKeys.size).toBe(0)

    // Now in paste mode → Escape cancels paste.
    act(() => result.current.handleCellSelect({ groupId: 'g1', dayId: 'd1', blockId: 'b1' }, { ctrlKey: true }))
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true })))
    expect(result.current.pasteMode).toBe(true)
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(result.current.pasteMode).toBe(false)
    expect(result.current.clipboardItems).toEqual([])
  })

  it('reset() clears selection, clipboard, and paste state', () => {
    const { result } = setup()
    act(() => result.current.handleCellSelect({ groupId: 'g1', dayId: 'd1', blockId: 'b1' }, { ctrlKey: true }))
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true })))
    expect(result.current.pasteMode).toBe(true)

    act(() => result.current.reset())
    expect(result.current.selectedSlotKeys.size).toBe(0)
    expect(result.current.clipboardItems).toEqual([])
    expect(result.current.pasteMode).toBe(false)
    expect(result.current.pasteModeIndex).toBe(0)
    expect(result.current.pasteError).toBeNull()
  })
})
