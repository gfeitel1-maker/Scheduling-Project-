import { useCallback, useLayoutEffect, useRef } from 'react'
import { buildOccupancy, cellAt, nextPosition, NAVIGATION_KEYS } from './gridNavigation'

// T59. The DOM half of grid navigation: roving tabindex plus arrow keys.
//
// THE GRID IS ONE TAB STOP. Exactly one cell carries tabindex="0" and every
// other carries -1, so Tab moves into and out of the grid rather than through
// 480 cells; arrows move focus and move the 0.
//
// It is DOM-driven rather than React state on purpose. The alternative —
// threading an `isActive` prop from four views through three cell components —
// would re-render the whole grid on every arrow keypress, which is exactly the
// per-interaction re-render T56 spent itself removing. Focus is a DOM concern;
// this reads the ARIA structure the views already emit (aria-rowindex on the
// row wrapper, aria-colindex and aria-rowspan on the cell) and writes one
// property. Nothing here is a source of truth the views have to be kept in
// sync with.
//
// Keyboard DRAG is not this hook's business: that is dnd-kit's keyboard sensor
// and its aria-live announcements, shipped in T58. This moves focus, not slots.

const CELL_SELECTOR = '[role="gridcell"], [role="columnheader"], [role="rowheader"]'

// A row header's real focus target is its collapse <button>, not the cell box:
// putting the roving 0 on the button keeps Enter/Space and aria-expanded on the
// platform's own path, and keeps that button from being a second tab stop.
// That is the keyboard half of the accepted WCAG 2.5.8 deviation (T55) — this
// hook must not weaken it.
function focusTargetOf(element) {
  return element.querySelector('.row-header-toggle') ?? element
}

function readCells(frame) {
  const cells = []
  for (const rowEl of frame.querySelectorAll('[role="row"]')) {
    const row = Number(rowEl.getAttribute('aria-rowindex'))
    if (!row) continue
    for (const element of rowEl.querySelectorAll(CELL_SELECTOR)) {
      const col = Number(element.getAttribute('aria-colindex'))
      if (!col) continue
      cells.push({
        row,
        col,
        rowSpan: Number(element.getAttribute('aria-rowspan')) || 1,
        element,
      })
    }
  }
  return cells
}

function boundsOf(cells) {
  let rowCount = 0
  let colCount = 0
  for (const c of cells) {
    if (c.row + (c.rowSpan > 1 ? c.rowSpan : 1) - 1 > rowCount) rowCount = c.row + (c.rowSpan > 1 ? c.rowSpan : 1) - 1
    if (c.col > colCount) colCount = c.col
  }
  return { rowCount, colCount }
}

export default function useGridKeyboardNav() {
  const frameRef = useRef(null)
  // The grid's origin, like every spreadsheet: tabbing in lands top-left, and
  // the position is stable across re-renders because it is a coordinate, not
  // an element identity.
  const posRef = useRef({ row: 1, col: 1 })

  // Writes the roving 0 onto whichever cell covers the current position and -1
  // onto every other. Runs after EVERY render, because a render can add,
  // remove or re-span cells (collapse, week switch, a drop landing) and the
  // grid must never be left with zero tab stops or two.
  const applyRoving = useCallback(() => {
    const frame = frameRef.current
    if (!frame) return
    const cells = readCells(frame)
    if (cells.length === 0) return

    const occupancy = buildOccupancy(cells)
    // The position can be stranded by a re-render (the cell it named is gone,
    // or now covered by a longer span in a different column). Fall back to the
    // first cell rather than leaving the grid unreachable by Tab.
    if (!cellAt(occupancy, posRef.current)) {
      posRef.current = { row: cells[0].row, col: cells[0].col }
    }
    const active = cellAt(occupancy, posRef.current)

    for (const cell of cells) {
      const target = focusTargetOf(cell.element)
      const want = cell === active ? 0 : -1
      if (target.tabIndex !== want) target.tabIndex = want
    }
  }, [])

  useLayoutEffect(applyRoving)

  const onKeyDown = useCallback(event => {
    if (!NAVIGATION_KEYS.has(event.key)) return
    // T112 fast-follow. An open CellInlineEditor's text input is inside a
    // cell, so without this guard an arrow/Home/End typed there is claimed by
    // grid navigation instead of the input: focus moves to another cell,
    // which blurs the editor and CellInlineEditor's onBlur discards the
    // in-progress edit as an implicit cancel. Enter/Escape are handled by the
    // editor itself and are not in NAVIGATION_KEYS, so only this leak exists.
    if (event.target.closest('.cell-inline-editor')) return
    const frame = frameRef.current
    if (!frame) return
    // Only when focus is actually on a cell — a control inside a cell (the
    // merge, split or remove button) counts, a stray focus in the frame does not.
    const from = event.target.closest(CELL_SELECTOR)
    if (!from || !frame.contains(from)) return

    const cells = readCells(frame)
    const occupancy = buildOccupancy(cells)
    const next = nextPosition(occupancy, boundsOf(cells), posRef.current, event)
    // Claim the key even when the move is blocked at an edge, so an arrow at
    // the grid's boundary does not scroll the page out from under the user.
    event.preventDefault()
    if (next === posRef.current) return

    posRef.current = next
    const cell = cellAt(occupancy, next)
    if (!cell) return
    applyRoving()
    focusTargetOf(cell.element).focus()
  }, [applyRoving])

  // Adopts whatever the user clicked or tabbed to, so arrows continue from
  // there and Tab away then back returns to it.
  const onFocus = useCallback(event => {
    const frame = frameRef.current
    if (!frame) return
    const cellEl = event.target.closest(CELL_SELECTOR)
    if (!cellEl || !frame.contains(cellEl)) return

    const cells = readCells(frame)
    const occupancy = buildOccupancy(cells)
    // Do NOT clobber the position when it already resolves to this cell. That
    // is the spanning case: entering a 4-6 cell from the side at logical row 5
    // focuses the cell, and adopting its head row here would silently move the
    // user to row 4 and break the rule the tests assert.
    if (cellAt(occupancy, posRef.current)?.element === cellEl) return

    const found = cells.find(c => c.element === cellEl)
    if (!found) return
    posRef.current = { row: found.row, col: found.col }
    applyRoving()
  }, [applyRoving])

  return { ref: frameRef, onKeyDown, onFocus }
}
