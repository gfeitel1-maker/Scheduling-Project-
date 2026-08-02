// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useOverlayFillStamp } from './useOverlayFillStamp'

const groups = [{ id: 'g1', tier_id: 't1' }]
const timeBlocks = [
  { id: 'b1', sort_order: 1 },
  { id: 'b2', sort_order: 2 },
  { id: 'b3', sort_order: 3 },
]
const overlays = [{ id: 'ov-1', unit_id: 't1', day_id: 'd1', from_block_order: 1, to_block_order: 1 }]

function setup(overrides = {}) {
  const addOverlay = vi.fn(async () => {})
  const updateOverlayRange = vi.fn(async () => {})
  const props = { groups, timeBlocks, overlays, addOverlay, updateOverlayRange, ...overrides }
  const hook = renderHook((p) => useOverlayFillStamp(p), { initialProps: props })
  return { ...hook, addOverlay, updateOverlayRange }
}

describe('useOverlayFillStamp', () => {
  it('handleStampClick creates an overlay at the clicked cell using the active stamp', async () => {
    const { result, addOverlay } = setup()
    act(() => result.current.setStampMode('Field Trip'))
    await act(async () => result.current.handleStampClick('g1', 'd1', 'b2'))
    expect(addOverlay).toHaveBeenCalledWith({
      unitId: 't1', dayId: 'd1', fromBlockOrder: 2, toBlockOrder: 2, label: 'Field Trip',
    })
  })

  it('handleStampClick is a no-op when no stamp is active or the cell is unknown', async () => {
    const { result, addOverlay } = setup()
    await act(async () => result.current.handleStampClick('g1', 'd1', 'b2'))
    expect(addOverlay).not.toHaveBeenCalled()

    act(() => result.current.setStampMode('Field Trip'))
    await act(async () => result.current.handleStampClick('nope', 'd1', 'b2'))
    expect(addOverlay).not.toHaveBeenCalled()
  })

  it('startFill primes fillState from the overlay; handleFillEnter extends the preview forward only', () => {
    const { result } = setup()
    act(() => result.current.startFill(overlays[0]))
    expect(result.current.fillState).toEqual({ overlayId: 'ov-1', previewToOrder: 1 })

    act(() => result.current.handleFillEnter(3))
    expect(result.current.fillState.previewToOrder).toBe(3)

    // Below the overlay's from_block_order is ignored (no shrinking past the head).
    act(() => result.current.handleFillEnter(0))
    expect(result.current.fillState.previewToOrder).toBe(3)
  })

  it('committing the fill on pointerup calls updateOverlayRange with the new extent and clears fillState', async () => {
    const { result, updateOverlayRange } = setup()
    act(() => result.current.startFill(overlays[0]))
    act(() => result.current.handleFillEnter(3))

    await act(async () => { window.dispatchEvent(new Event('pointerup')) })
    expect(updateOverlayRange).toHaveBeenCalledWith('ov-1', 3)
    expect(result.current.fillState).toBeNull()
  })

  it('pointerup with an unchanged extent clears fillState without a write', async () => {
    const { result, updateOverlayRange } = setup()
    act(() => result.current.startFill(overlays[0])) // previewTo === to_block_order (1)
    await act(async () => { window.dispatchEvent(new Event('pointerup')) })
    expect(updateOverlayRange).not.toHaveBeenCalled()
    expect(result.current.fillState).toBeNull()
  })

  it('dismissDisplaced removes the matching tray entry only', () => {
    const { result } = setup()
    act(() => result.current.setDisplacedItems([
      { activityId: 'a1', fromBlockName: 'Morning' },
      { activityId: 'a1', fromBlockName: 'Afternoon' },
    ]))
    act(() => result.current.dismissDisplaced('a1', 'Morning'))
    expect(result.current.displacedItems).toEqual([{ activityId: 'a1', fromBlockName: 'Afternoon' }])
  })

  it('reset() clears stamp, fill, and displaced state', () => {
    const { result } = setup()
    act(() => {
      result.current.setStampMode('Field Trip')
      result.current.startFill(overlays[0])
      result.current.setDisplacedItems([{ activityId: 'a1', fromBlockName: 'Morning' }])
    })
    act(() => result.current.reset())
    expect(result.current.stampMode).toBeNull()
    expect(result.current.fillState).toBeNull()
    expect(result.current.displacedItems).toEqual([])
  })
})
