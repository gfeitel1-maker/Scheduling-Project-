import { describe, it, expect } from 'vitest'
import { placeCell, placeRowHeader } from './gridPlacement'

describe('placeCell', () => {
  // The origin cell is the boundary the off-by-one hides in: column 1 is the
  // row-header column, so the first data column is line 2, not line 1.
  it('places the origin cell at row line 1, column line 2', () => {
    expect(placeCell({ blockIndex: 0, columnIndex: 0 }))
      .toEqual({ gridRow: '1 / span 1', gridColumn: '2 / span 1' })
  })

  it('places an interior cell', () => {
    expect(placeCell({ blockIndex: 3, columnIndex: 4 }))
      .toEqual({ gridRow: '4 / span 1', gridColumn: '6 / span 1' })
  })

  it('places a rowSpan: 3 span head', () => {
    expect(placeCell({ blockIndex: 2, columnIndex: 1, rowSpan: 3 }))
      .toEqual({ gridRow: '3 / span 3', gridColumn: '3 / span 1' })
  })

  it('places a colSpan', () => {
    expect(placeCell({ blockIndex: 0, columnIndex: 2, colSpan: 4 }))
      .toEqual({ gridRow: '1 / span 1', gridColumn: '4 / span 4' })
  })

  it('places a cell spanning both axes', () => {
    expect(placeCell({ blockIndex: 1, columnIndex: 0, rowSpan: 2, colSpan: 3 }))
      .toEqual({ gridRow: '2 / span 2', gridColumn: '2 / span 3' })
  })

  it('defaults both spans to 1', () => {
    expect(placeCell({ blockIndex: 5, columnIndex: 6 }))
      .toEqual({ gridRow: '6 / span 1', gridColumn: '8 / span 1' })
  })
})

describe('placeRowHeader', () => {
  it('places the row header in column line 1', () => {
    expect(placeRowHeader({ blockIndex: 0 }))
      .toEqual({ gridRow: '1 / span 1', gridColumn: '1 / span 1' })
    expect(placeRowHeader({ blockIndex: 4 }))
      .toEqual({ gridRow: '5 / span 1', gridColumn: '1 / span 1' })
  })

  it('spans rows when given a rowSpan', () => {
    expect(placeRowHeader({ blockIndex: 2, rowSpan: 2 }))
      .toEqual({ gridRow: '3 / span 2', gridColumn: '1 / span 1' })
  })
})
