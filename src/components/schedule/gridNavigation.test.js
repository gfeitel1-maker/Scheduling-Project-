// T59. The spanning-cell focus rule is asserted here, not left emergent — the
// ticket makes that the deliverable as much as the code. See gridNavigation.js
// for the rule's statement and its justification.
import { describe, it, expect } from 'vitest'
import { buildOccupancy, cellAt, nextPosition, coordKey } from './gridNavigation'

// A 4-row x 3-col grid. Column 2 carries a cell spanning rows 2-4 (the
// "blocks 4 to 6" case, renumbered): its head is row 2 with rowSpan 3.
//
//        col1     col2       col3
// row1   a        b          c
// row2   d        SPAN(2-4)  e
// row3   f        "          g
// row4   h        "          i
const cells = [
  { row: 1, col: 1, rowSpan: 1, id: 'a' },
  { row: 1, col: 2, rowSpan: 1, id: 'b' },
  { row: 1, col: 3, rowSpan: 1, id: 'c' },
  { row: 2, col: 1, rowSpan: 1, id: 'd' },
  { row: 2, col: 2, rowSpan: 3, id: 'span' },
  { row: 2, col: 3, rowSpan: 1, id: 'e' },
  { row: 3, col: 1, rowSpan: 1, id: 'f' },
  { row: 3, col: 3, rowSpan: 1, id: 'g' },
  { row: 4, col: 1, rowSpan: 1, id: 'h' },
  { row: 4, col: 3, rowSpan: 1, id: 'i' },
]

const occupancy = buildOccupancy(cells)
const bounds = { rowCount: 4, colCount: 3 }

const move = (pos, key, mods = {}) => nextPosition(occupancy, bounds, pos, { key, ...mods })

describe('buildOccupancy', () => {
  it('registers a spanning cell at every coordinate it covers', () => {
    expect(occupancy.get(coordKey(2, 2)).id).toBe('span')
    expect(occupancy.get(coordKey(3, 2)).id).toBe('span')
    expect(occupancy.get(coordKey(4, 2)).id).toBe('span')
  })

  it('treats rowSpan 1 and a missing rowSpan the same', () => {
    const occ = buildOccupancy([{ row: 1, col: 1, id: 'x' }])
    expect(occ.size).toBe(1)
    expect(cellAt(occ, { row: 1, col: 1 }).id).toBe('x')
  })
})

describe('the spanning-cell rule — leaving a spanning cell', () => {
  it('Down out of a spanning cell lands on the row AFTER its whole extent', () => {
    // Inside the span at its head. rowSpan 3 from row 2 covers 2,3,4 — and
    // there is no row 5, so this must not move at all rather than land in 3.
    const inSpan = { row: 2, col: 2 }
    expect(move(inSpan, 'ArrowDown')).toEqual(inSpan)
  })

  it('Down out of a spanning cell skips its covered rows when there is room below', () => {
    const tall = [
      { row: 1, col: 1, rowSpan: 1, id: 'top' },
      { row: 2, col: 1, rowSpan: 3, id: 'span' },
      { row: 5, col: 1, rowSpan: 1, id: 'below' },
    ]
    const occ = buildOccupancy(tall)
    const b = { rowCount: 5, colCount: 1 }
    // From ANY covered row — 2, 3 or 4 — Down emerges into row 5, never 3 or 4.
    for (const row of [2, 3, 4]) {
      expect(nextPosition(occ, b, { row, col: 1 }, { key: 'ArrowDown' })).toEqual({ row: 5, col: 1 })
    }
  })

  it('Up out of a spanning cell lands on the row BEFORE its head', () => {
    // From any covered row — 2, 3 or 4 — Up emerges into row 1.
    for (const row of [2, 3, 4]) {
      expect(move({ row, col: 2 }, 'ArrowUp')).toEqual({ row: 1, col: 2 })
    }
  })

  it('vertical traversal through a spanning cell is reversible', () => {
    const start = { row: 1, col: 2 }
    const into = move(start, 'ArrowDown')
    expect(cellAt(occupancy, into).id).toBe('span')
    // Down again is blocked (nothing below row 4), so come back up.
    expect(move(into, 'ArrowUp')).toEqual(start)
  })
})

describe('the spanning-cell rule — entering a spanning cell from the side', () => {
  it('preserves the logical row, so the cell is entered at the row you came from', () => {
    const entered = move({ row: 3, col: 1 }, 'ArrowRight')
    expect(entered).toEqual({ row: 3, col: 2 })
    expect(cellAt(occupancy, entered).id).toBe('span')
  })

  it('is reversible: entering at row 3 and leaving sideways returns to row 3', () => {
    const entered = move({ row: 3, col: 1 }, 'ArrowRight')
    expect(move(entered, 'ArrowLeft')).toEqual({ row: 3, col: 1 })
    expect(move(entered, 'ArrowRight')).toEqual({ row: 3, col: 3 })
  })

  it('leaves vertically by the cell extent even when entered mid-span', () => {
    const entered = move({ row: 3, col: 1 }, 'ArrowRight')
    // Entered at logical row 3, but Up still exits above the HEAD (row 2).
    expect(move(entered, 'ArrowUp')).toEqual({ row: 1, col: 2 })
  })
})

describe('plain movement and bounds', () => {
  it('moves one cell per arrow key', () => {
    expect(move({ row: 1, col: 1 }, 'ArrowRight')).toEqual({ row: 1, col: 2 })
    expect(move({ row: 1, col: 2 }, 'ArrowLeft')).toEqual({ row: 1, col: 1 })
    expect(move({ row: 1, col: 1 }, 'ArrowDown')).toEqual({ row: 2, col: 1 })
    expect(move({ row: 2, col: 1 }, 'ArrowUp')).toEqual({ row: 1, col: 1 })
  })

  it('does not wrap or leave the grid at any edge', () => {
    expect(move({ row: 1, col: 1 }, 'ArrowUp')).toEqual({ row: 1, col: 1 })
    expect(move({ row: 1, col: 1 }, 'ArrowLeft')).toEqual({ row: 1, col: 1 })
    expect(move({ row: 4, col: 3 }, 'ArrowDown')).toEqual({ row: 4, col: 3 })
    expect(move({ row: 4, col: 3 }, 'ArrowRight')).toEqual({ row: 4, col: 3 })
  })

  it('does not move to a coordinate no cell covers', () => {
    // Nothing is registered at (3,2)'s neighbour in a grid with a hole.
    const occ = buildOccupancy([{ row: 1, col: 1, rowSpan: 1, id: 'only' }])
    const b = { rowCount: 2, colCount: 2 }
    expect(nextPosition(occ, b, { row: 1, col: 1 }, { key: 'ArrowRight' })).toEqual({ row: 1, col: 1 })
  })

  it('returns the position unchanged for an unhandled key', () => {
    const pos = { row: 2, col: 2 }
    expect(move(pos, 'PageDown')).toBe(pos)
    expect(move(pos, 'a')).toBe(pos)
  })

  it('returns the position unchanged when it is not on any cell', () => {
    const pos = { row: 9, col: 9 }
    expect(move(pos, 'ArrowLeft')).toBe(pos)
  })
})

describe('Home and End', () => {
  it('move to the first and last column of the current row', () => {
    expect(move({ row: 3, col: 3 }, 'Home')).toEqual({ row: 3, col: 1 })
    expect(move({ row: 3, col: 1 }, 'End')).toEqual({ row: 3, col: 3 })
  })

  it('with Ctrl or Meta move to the grid corners', () => {
    expect(move({ row: 3, col: 3 }, 'Home', { ctrlKey: true })).toEqual({ row: 1, col: 1 })
    expect(move({ row: 1, col: 1 }, 'End', { ctrlKey: true })).toEqual({ row: 4, col: 3 })
    expect(move({ row: 3, col: 3 }, 'Home', { metaKey: true })).toEqual({ row: 1, col: 1 })
  })
})
