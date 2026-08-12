import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeDragHandlers } from './dragHandlers'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCHEDULE_SCREEN_FILE = path.join(HERE, '..', 'ScheduleScreen.jsx')
const SCHEDULE_COMPONENTS_DIR = path.join(HERE, '..', '..', 'components', 'schedule')

// T58 reshaped this adapter. It used to take dnd-kit's ({ active, over }) and
// own the expand-drag boolean; it now takes (active, hit) — `hit` being the cell
// the FSM resolved from pointer coordinates against data-cell-key, because the
// per-cell droppables that used to supply `over.data` are gone. The eligibility
// rules below are unchanged in effect; only where the target comes from moved.
function hit(groupId, dayId, blockId, edge = 'top') {
  return { groupId, dayId, blockId, cellKey: `${groupId}|${dayId}|${blockId}`, edge, valid: true }
}

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
    replaceSlot: vi.fn(),
    ...overrides,
  }
}

const filledTarget = { activity_id: 'act-2', is_anchor: false }

describe('makeDragHandlers.commit', () => {
  it('group view: drop onto a filled cell calls replaceSlot', () => {
    const deps = baseDeps({ getSlot: vi.fn(() => filledTarget) })
    const { commit } = makeDragHandlers(deps)
    const active = { data: { current: { slot: { groupId: 'g1', dayId: 'd1', blockId: 'b1', activity_id: 'act-1' } } } }
    commit(active, hit('g1', 'd1', 'b2'))
    expect(deps.replaceSlot).toHaveBeenCalledWith(
      { groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'act-1' },
      { groupId: 'g1', dayId: 'd1', blockId: 'b2' },
      undefined
    )
  })

  it('day view: drop onto a filled cell also calls replaceSlot', () => {
    const deps = baseDeps({ getSlot: vi.fn(() => filledTarget) })
    const { commit } = makeDragHandlers(deps)
    const active = { data: { current: { slot: { groupId: 'g1', dayId: 'd1', blockId: 'b1', activity_id: 'act-1' } } } }
    commit(active, hit('g1', 'd1', 'b2'))
    expect(deps.replaceSlot).toHaveBeenCalledWith(
      { groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'act-1' },
      { groupId: 'g1', dayId: 'd1', blockId: 'b2' },
      undefined
    )
  })

  it('drop onto an EMPTY cell also calls replaceSlot (grid-to-grid move, not a no-op)', () => {
    const deps = baseDeps({ getSlot: vi.fn(() => ({ activity_id: null, is_anchor: false })) })
    const { commit } = makeDragHandlers(deps)
    const active = { data: { current: { slot: { groupId: 'g1', dayId: 'd1', blockId: 'b1', activity_id: 'act-1' } } } }
    commit(active, hit('g1', 'd1', 'b2'))
    expect(deps.replaceSlot).toHaveBeenCalledWith(
      { groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'act-1' },
      { groupId: 'g1', dayId: 'd1', blockId: 'b2' },
      undefined
    )
  })

  it('does not replace onto an empty target when there is no slot row at all (getSlot returns undefined)', () => {
    const deps = baseDeps({ getSlot: vi.fn(() => undefined) })
    const { commit } = makeDragHandlers(deps)
    const active = { data: { current: { slot: { groupId: 'g1', dayId: 'd1', blockId: 'b1', activity_id: 'act-1' } } } }
    commit(active, hit('g1', 'd1', 'b2'))
    expect(deps.replaceSlot).not.toHaveBeenCalled()
  })

  it('drop onto an anchor cell does not call replaceSlot', () => {
    const deps = baseDeps({ getSlot: vi.fn(() => ({ is_anchor: true })) })
    const { commit } = makeDragHandlers(deps)
    const active = { data: { current: { slot: { groupId: 'g1', dayId: 'd1', blockId: 'b1', activity_id: 'act-1' } } } }
    commit(active, hit('g1', 'd1', 'b2'))
    expect(deps.replaceSlot).not.toHaveBeenCalled()
  })

  it('does not replace a cell onto itself', () => {
    const deps = baseDeps({ getSlot: vi.fn(() => filledTarget) })
    const { commit } = makeDragHandlers(deps)
    const active = { data: { current: { slot: { groupId: 'g1', dayId: 'd1', blockId: 'b1', activity_id: 'act-1' } } } }
    commit(active, hit('g1', 'd1', 'b1'))
    expect(deps.replaceSlot).not.toHaveBeenCalled()
  })

  it('is inert when there is no resolved hit', () => {
    const deps = baseDeps({ getSlot: vi.fn(() => filledTarget) })
    const { commit } = makeDragHandlers(deps)
    const active = { data: { current: { slot: { groupId: 'g1', dayId: 'd1', blockId: 'b1', activity_id: 'act-1' } } } }
    expect(() => commit(active, null)).not.toThrow()
    expect(deps.replaceSlot).not.toHaveBeenCalled()
  })

  it('dragging a grid card onto the palette clears the source slot', () => {
    const deps = baseDeps()
    const { commit } = makeDragHandlers(deps)
    const active = { data: { current: { slot: { groupId: 'g1', dayId: 'd1', blockId: 'b1', activity_id: 'act-1' } } } }
    commit(active, { toPalette: true, valid: true })
    expect(deps.replaceSlot).toHaveBeenCalledWith(
      { activityId: null },
      { groupId: 'g1', dayId: 'd1', blockId: 'b1' },
      undefined
    )
  })

  it('a toPalette release with no source slot (e.g. a palette-to-palette drag) is a no-op', () => {
    const deps = baseDeps()
    const { commit } = makeDragHandlers(deps)
    const active = { data: { current: { paletteActivity: { id: 'act-1' } } } }
    expect(() => commit(active, { toPalette: true, valid: true })).not.toThrow()
    expect(deps.replaceSlot).not.toHaveBeenCalled()
    expect(deps.placeActivityManual).not.toHaveBeenCalled()
  })

  describe('expand-drag and palette-drop behave identically for both views', () => {
    for (const view of ['group', 'day']) {
      it(`${view}: expand-drag calls expandSlot when the tail block is adjacent`, () => {
        const deps = baseDeps({
          getSlot: vi.fn(() => ({ activity_id: 'act-1', is_anchor: false })),
        })
        const { commit } = makeDragHandlers(deps)
        const active = { data: { current: { expandDrag: { groupId: 'g1', dayId: 'd1', blockId: 'b1' } } } }
        commit(active, hit('g1', 'd1', 'b2'))
        expect(deps.expandSlot).toHaveBeenCalledWith('g1', 'd1', 'b1', 'b2', 'act-1', 'Swim', 'Block 2', 'Monday', undefined)
        expect(deps.replaceSlot).not.toHaveBeenCalled()
      })

      it(`${view}: expand-drag ignores a non-adjacent tail block`, () => {
        const deps = baseDeps({
          timeBlocks: [
            { id: 'b1', sort_order: 0, name: 'Block 1' },
            { id: 'b2', sort_order: 1, name: 'Block 2' },
            { id: 'b3', sort_order: 2, name: 'Block 3' },
          ],
          getSlot: vi.fn(() => ({ activity_id: 'act-1', is_anchor: false })),
        })
        const { commit } = makeDragHandlers(deps)
        const active = { data: { current: { expandDrag: { groupId: 'g1', dayId: 'd1', blockId: 'b1' } } } }
        commit(active, hit('g1', 'd1', 'b3'))
        expect(deps.expandSlot).not.toHaveBeenCalled()
      })

      it(`${view}: expand-drag ignores a tail in another column`, () => {
        const deps = baseDeps({
          getSlot: vi.fn(() => ({ activity_id: 'act-1', is_anchor: false })),
        })
        const { commit } = makeDragHandlers(deps)
        const active = { data: { current: { expandDrag: { groupId: 'g1', dayId: 'd1', blockId: 'b1' } } } }
        commit(active, hit('g2', 'd1', 'b2'))
        expect(deps.expandSlot).not.toHaveBeenCalled()
      })

      it(`${view}: palette-drop onto an EMPTY cell calls placeActivityManual`, () => {
        const deps = baseDeps({ getSlot: vi.fn(() => ({ is_anchor: false, activity_id: null })) })
        const { commit } = makeDragHandlers(deps)
        const active = { data: { current: { paletteActivity: { id: 'act-1' } } } }
        commit(active, hit('g1', 'd1', 'b1'))
        expect(deps.placeActivityManual).toHaveBeenCalledWith('act-1', 'g1', 'd1', 'b1', undefined, undefined)
        expect(deps.replaceSlot).not.toHaveBeenCalled()
      })

      it(`${view}: palette-drop onto an EMPTY cell forwards the drag gestureId as placeActivityManual's claim id (2026-08-12 ADR, FIX 1)`, () => {
        const deps = baseDeps({ getSlot: vi.fn(() => ({ is_anchor: false, activity_id: null })) })
        const { commit } = makeDragHandlers(deps)
        const active = { data: { current: { paletteActivity: { id: 'act-1' } } } }
        commit(active, hit('g1', 'd1', 'b1'), 'gesture-xyz')
        expect(deps.placeActivityManual).toHaveBeenCalledWith('act-1', 'g1', 'd1', 'b1', undefined, 'gesture-xyz')
      })

      it(`${view}: palette-drop onto an occupied cell calls replaceSlot, not placeActivityManual`, () => {
        const deps = baseDeps({ getSlot: vi.fn(() => ({ is_anchor: false, activity_id: 'act-2' })) })
        const { commit } = makeDragHandlers(deps)
        const active = { data: { current: { paletteActivity: { id: 'act-1' } } } }
        commit(active, hit('g1', 'd1', 'b1'))
        expect(deps.replaceSlot).toHaveBeenCalledWith(
          { activityId: 'act-1' },
          { groupId: 'g1', dayId: 'd1', blockId: 'b1' },
          undefined
        )
        expect(deps.placeActivityManual).not.toHaveBeenCalled()
      })

      it(`${view}: palette-drop onto an anchor is refused`, () => {
        const deps = baseDeps({ getSlot: vi.fn(() => ({ is_anchor: true })) })
        const { commit } = makeDragHandlers(deps)
        const active = { data: { current: { paletteActivity: { id: 'act-1' } } } }
        commit(active, hit('g1', 'd1', 'b1'))
        expect(deps.placeActivityManual).not.toHaveBeenCalled()
        expect(deps.replaceSlot).not.toHaveBeenCalled()
      })
    }
  })
})

// ---------------------------------------------------------------------------
// Call-site wiring guard.
//
// The third assertion (distinct setExpandDragActive setters) is GONE, deliberately:
// T58 deleted those setters. Its purpose was to stop one shared boolean
// cross-highlighting expand state between the group and day views; that class of
// bug is now structurally impossible, because there is no shared boolean — each
// DndContext gets its own useDragFSM, and drag-over is a data attribute on one
// element rather than a flag broadcast to every cell. The two greps below are
// what replace it.
//
// The swap-gating boolean this file used to guard is retired
// (drag-first-placement, 2026-08-09): every grid-to-grid or palette-onto-
// occupied drop now always replaces, so there is no longer a product-decision
// toggle to guard here.
// ---------------------------------------------------------------------------
describe('ScheduleScreen call-site wiring', () => {
  const source = fs.readFileSync(SCHEDULE_SCREEN_FILE, 'utf8')
  const callSites = source
    .split('\n')
    .filter((line) => line.includes('makeDragHandlers({') || line.includes('makeDragHandlers(dragDeps'))

  it('has exactly two makeDragHandlers call sites', () => {
    expect(
      callSites.length,
      `Expected 2 makeDragHandlers call sites in ScheduleScreen.jsx, found ${callSites.length}. If a view was added or removed, update this guard deliberately.`
    ).toBe(2)
  })

  it('keeps no boolean drag flag in ScheduleScreen.jsx (T58)', () => {
    expect(
      /isExpandDragActive|isGroupExpandDragActive|isDayExpandDragActive/.test(source),
      'A boolean drag flag is back in ScheduleScreen.jsx. Drag state is the FSM\'s (dragFSM.js) and reaches the DOM as data-drag-over / data-drop-edge written by a side effect. A boolean re-renders the whole cell tree to tint one cell, which is what T58 removed.'
    ).toBe(false)
  })

  it('leaves no per-cell droppable under src/components/schedule/ (T58)', () => {
    const offenders = fs.readdirSync(SCHEDULE_COMPONENTS_DIR)
      .filter((f) => /\.jsx?$/.test(f) && !f.includes('.test.'))
      .filter((f) => /\buseDroppable\s*\(/.test(fs.readFileSync(path.join(SCHEDULE_COMPONENTS_DIR, f), 'utf8')))

    expect(
      offenders,
      `These components call useDroppable: ${offenders.join(', ')}. Exactly one droppable exists, on the grid surface (GridDragSurface.jsx); cells are resolved from pointer coordinates against data-cell-key. Up to 480 per-cell subscribers evaluating isOver on every pointer event is the cost T58 removed, and a per-cell droppable cannot express closest-edge.`
    ).toEqual([])
  })
})
