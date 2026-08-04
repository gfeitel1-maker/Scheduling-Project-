import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeDragHandlers } from './dragHandlers'

const SCHEDULE_SCREEN_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'ScheduleScreen.jsx'
)

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

// ---------------------------------------------------------------------------
// Call-site wiring guard.
//
// Every test above constructs allowSwap itself, so none of them can observe
// what ScheduleScreen.jsx actually passes. Before this guard existed, flipping
// the group call site to `allowSwap: false` left the ENTIRE suite green — the
// factory logic was covered, the wiring was not. ScheduleScreen.test.jsx does
// not simulate dnd-kit pointer drags either, so nothing else closes this.
//
// That gap matters because group view gaining slot-swap is a recorded,
// product-owner-approved behavior change ("C2 — Product decision (resolved
// 2026-08-04)" in docs/work/specs/architecture-restructure-proposal.md).
// Before the merge, group view's inability to swap was guaranteed TEXTUALLY —
// there was simply no swap code in that function, and a reviewer could see it.
// After the merge the guarantee is runtime-only, resting on one boolean in a
// prop-wiring block, where a copy-paste or a careless revert produces no
// visible diff signal. This static assertion is what restores a textual
// guarantee, and it is the thing Red Hat finding C2-R1 asked for.
// ---------------------------------------------------------------------------
describe('ScheduleScreen call-site wiring', () => {
  const source = fs.readFileSync(SCHEDULE_SCREEN_FILE, 'utf8')
  const callSites = source
    .split('\n')
    .filter((line) => line.includes('makeDragHandlers({'))

  it('has exactly two makeDragHandlers call sites', () => {
    expect(
      callSites.length,
      `Expected 2 makeDragHandlers call sites in ScheduleScreen.jsx, found ${callSites.length}. If a view was added or removed, update this guard deliberately.`
    ).toBe(2)
  })

  it('passes allowSwap: true at BOTH call sites (group view swap is an approved product decision)', () => {
    for (const line of callSites) {
      expect(
        /allowSwap:\s*true/.test(line),
        `A makeDragHandlers call site in ScheduleScreen.jsx does not pass 'allowSwap: true':\n  ${line.trim()}\nGroup view supporting slot-swap is a recorded product decision (see "C2 — Product decision (resolved 2026-08-04)" in docs/work/specs/architecture-restructure-proposal.md). Changing this is a director-visible behavior change and needs a new recorded decision, not a code edit.`
      ).toBe(true)
    }
  })

  it('passes a distinct expand-drag setter at each call site (C2-R2)', () => {
    const setters = callSites.map((line) => line.match(/setExpandDragActive:\s*(\w+)/)?.[1])
    expect(setters.every(Boolean), 'every call site must pass setExpandDragActive explicitly').toBe(true)
    expect(
      new Set(setters).size,
      `Both makeDragHandlers call sites pass the same expand-drag setter (${setters.join(', ')}). They must stay distinct — a shared flag cross-highlights expand state between the group and day views.`
    ).toBe(setters.length)
  })
})
