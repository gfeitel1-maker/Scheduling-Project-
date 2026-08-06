// T59. The pure half of roving-tabindex grid navigation: given the grid's cells
// and a logical position, where does an arrow key take you?
//
// THE SPANNING-CELL RULE (spec §0 predicate 6, T59 acceptance).
//
// Focus is a LOGICAL (row, col) coordinate, not an element. The focused element
// is whichever cell COVERS that coordinate — a cell spanning blocks 4-6 covers
// the coordinates (4,c), (5,c) and (6,c). Arrow keys move the coordinate; the
// covering cell is then focused. That single model settles every span question:
//
//   - Down out of a spanning cell lands on the row AFTER its whole extent
//     (from a 4-6 cell you emerge into row 7, never row 5). Row 5 has no
//     separate cell in that column, so landing there would re-focus the cell
//     you are already in — a dead keypress, the worst possible outcome.
//   - Up out of it lands on the row BEFORE its head (row 3).
//   - Vertical traversal is therefore reversible: 3 -> down -> the span ->
//     down -> 7 -> up -> the span -> up -> 3.
//   - Entering from the SIDE preserves your row. Arrowing down the column to
//     the left to row 5, then right, focuses the spanning cell while the
//     logical coordinate stays (5,c) — so pressing left again returns you to
//     row 5, not to row 4. The extent is announced by aria-rowspan and by the
//     cell's accessible name ("Swimming, Block 4 to Block 6, Tuesday"); the
//     user never has to infer their position from where focus jumped.
//
// Home/End move within the row; Ctrl+Home/Ctrl+End go to the grid's corners.
// PageUp/PageDown are deliberately NOT implemented — there is no "page" in a
// grid this short, and an arbitrary jump distance is not something a user can
// predict.

export function coordKey(row, col) {
  return `${row}|${col}`
}

// cells: [{ row, col, rowSpan, ...anything }] where `row` is the HEAD row.
// Returns Map<"row|col", cell> with one entry per coordinate the cell covers.
export function buildOccupancy(cells) {
  const occupancy = new Map()
  for (const cell of cells) {
    const span = cell.rowSpan > 1 ? cell.rowSpan : 1
    for (let r = cell.row; r < cell.row + span; r++) {
      occupancy.set(coordKey(r, cell.col), cell)
    }
  }
  return occupancy
}

export function cellAt(occupancy, pos) {
  return occupancy.get(coordKey(pos.row, pos.col)) ?? null
}

// Returns the new logical position, or the SAME position object's values when
// the key is unhandled or the move would leave the grid. Callers compare.
export function nextPosition(occupancy, bounds, pos, { key, ctrlKey = false, metaKey = false }) {
  const here = cellAt(occupancy, pos)
  if (!here) return pos

  const jump = ctrlKey || metaKey
  let target

  switch (key) {
    case 'ArrowLeft':
      target = { row: pos.row, col: pos.col - 1 }
      break
    case 'ArrowRight':
      target = { row: pos.row, col: pos.col + 1 }
      break
    case 'ArrowUp':
      // From the HEAD of the covering cell, not from the logical row: the cell
      // is one thing, and the thing above it is above its whole extent.
      target = { row: here.row - 1, col: pos.col }
      break
    case 'ArrowDown':
      target = { row: here.row + (here.rowSpan > 1 ? here.rowSpan : 1), col: pos.col }
      break
    case 'Home':
      target = jump ? { row: 1, col: 1 } : { row: pos.row, col: 1 }
      break
    case 'End':
      target = jump
        ? { row: bounds.rowCount, col: bounds.colCount }
        : { row: pos.row, col: bounds.colCount }
      break
    default:
      return pos
  }

  if (target.row < 1 || target.row > bounds.rowCount) return pos
  if (target.col < 1 || target.col > bounds.colCount) return pos
  // No cell covers the target (a hole in the grid): do not move rather than
  // move focus to nothing.
  if (!occupancy.has(coordKey(target.row, target.col))) return pos
  return target
}

export const NAVIGATION_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End',
])
