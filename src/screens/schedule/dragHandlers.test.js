import { describe, it, expect, vi } from 'vitest'
import { makeDragHandlers } from './dragHandlers'

function baseDeps(overrides = {}) {
  const timeBlocks = [
    { id: 'b1', sort_order: 0, name: 'Block 1' },
    { id: 'b2', sort_order: 1, name: 'Block 2' },
  ]
  const days = [{ id: 'd1', label: 'Monday' }]
  const actMap = new Map([['act-1', { id: 'act-1', name: 'Swim' }]])
  return {
    timeBlocks,
    days,
    slots: [],
    actMap,
    getSlot: vi.fn(),
    expandSlot: vi.fn(),
    placeActivityManual: vi.fn(),
    swapSlots: vi.fn(),
    setExpandDragActive: vi.fn(),
    allowSwap: true,
    ...overrides,
  }
}

describe('makeDragHandlers', () => {
  it('group view: drag onto filled cell calls swapSlots (allowSwap true)', () => {
    const deps = baseDeps({ allowSwap: true })
    const { handleDragEnd } = makeDragHandlers(deps)
    const active = { id: 'a', data: { current: { slot: { groupId: 'g1', dayId: 'd1', blockId: 'b1', activity_id: 'act-1' } } } }
    const over = { id: 'o', data: { current: { slot: { groupId: 'g1', dayId: 'd1', blockId: 'b2', activity_id: 'act-2', type: 'filled' } } } }
    handleDragEnd({ active, over })
    expect(deps.swapSlots).toHaveBeenCalledTimes(1)
  })

  it('day view: drag onto filled cell still calls swapSlots (regression)', () => {
    const deps = baseDeps({ allowSwap: true })
    const { handleDragEnd } = makeDragHandlers(deps)
    const active = { id: 'a', data: { current: { slot: { groupId: 'g1', dayId: 'd1', blockId: 'b1', activity_id: 'act-1' } } } }
    const over = { id: 'o', data: { current: { slot: { groupId: 'g1', dayId: 'd1', blockId: 'b2', activity_id: 'act-2', type: 'filled' } } } }
    handleDragEnd({ active, over })
    expect(deps.swapSlots).toHaveBeenCalledTimes(1)
  })

  it('allowSwap: false short-circuits without crashing', () => {
    const deps = baseDeps({ allowSwap: false })
    const { handleDragEnd } = makeDragHandlers(deps)
    const active = { id: 'a', data: { current: { slot: { groupId: 'g1', dayId: 'd1', blockId: 'b1', activity_id: 'act-1' } } } }
    const over = { id: 'o', data: { current: { slot: { groupId: 'g1', dayId: 'd1', blockId: 'b2', activity_id: 'act-2', type: 'filled' } } } }
    expect(() => handleDragEnd({ active, over })).not.toThrow()
    expect(deps.swapSlots).not.toHaveBeenCalled()
  })

  describe('expand-drag and palette-drop behave identically for both views', () => {
    for (const view of ['group', 'day']) {
      it(`${view}: expand-drag calls expandSlot when tail block is adjacent`, () => {
        const deps = baseDeps({
          allowSwap: true,
          getSlot: vi.fn(() => ({ activity_id: 'act-1', is_anchor: false })),
        })
        const { handleDragStart, handleDragEnd } = makeDragHandlers(deps)
        const active = { id: 'a', data: { current: { expandDrag: { groupId: 'g1', dayId: 'd1', blockId: 'b1' } } } }
        handleDragStart({ active })
        expect(deps.setExpandDragActive).toHaveBeenCalledWith(true)

        const over = { id: 'o', data: { current: { slot: { groupId: 'g1', dayId: 'd1', blockId: 'b2' } } } }
        handleDragEnd({ active, over })
        expect(deps.setExpandDragActive).toHaveBeenCalledWith(false)
        expect(deps.expandSlot).toHaveBeenCalledWith('g1', 'd1', 'b1', 'b2', 'act-1', 'Swim', 'Block 2', 'Monday')
        expect(deps.swapSlots).not.toHaveBeenCalled()
      })

      it(`${view}: palette-drop calls placeActivityManual`, () => {
        const deps = baseDeps({
          allowSwap: true,
          getSlot: vi.fn(() => ({ is_anchor: false })),
        })
        const { handleDragEnd } = makeDragHandlers(deps)
        const active = { id: 'a', data: { current: { paletteActivity: { id: 'act-1' } } } }
        const over = { id: 'o', data: { current: { slot: { groupId: 'g1', dayId: 'd1', blockId: 'b1' } } } }
        handleDragEnd({ active, over })
        expect(deps.placeActivityManual).toHaveBeenCalledWith('act-1', 'g1', 'd1', 'b1')
        expect(deps.swapSlots).not.toHaveBeenCalled()
      })
    }
  })
})
