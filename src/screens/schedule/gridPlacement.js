// Explicit grid placement for schedule cells. Pure: no DOM, no React.
//
// A <td> inherits its column from document order; a grid child does not. A cell
// with no explicit grid-column stacks in column 1 and nothing throws, so the
// off-by-one lives here once rather than in each of the four views.

// blockIndex -> row line: +1 for CSS Grid's 1-based lines.
// columnIndex -> column line: +1 for 1-based lines, +1 for the row-header column.
export function placeCell({ blockIndex, columnIndex, rowSpan = 1, colSpan = 1 }) {
  return {
    gridRow: `${blockIndex + 1} / span ${rowSpan}`,
    gridColumn: `${columnIndex + 2} / span ${colSpan}`,
  }
}

export function placeRowHeader({ blockIndex, rowSpan = 1 }) {
  return {
    gridRow: `${blockIndex + 1} / span ${rowSpan}`,
    gridColumn: '1 / span 1',
  }
}
