import { describe, it, expect } from 'vitest'
import { cellAccessibleName, blockNamesForSpan } from './cellLabel'

const timeBlocks = [
  { id: 'b1', name: 'Block 1' },
  { id: 'b2', name: 'Block 2' },
  { id: 'b3', name: 'Block 3' },
]

describe('cellAccessibleName', () => {
  it('names a single-block cell with its activity, block and day', () => {
    expect(cellAccessibleName({ subject: 'Swimming', blockNames: ['Block 4'], column: 'Tuesday' }))
      .toBe('Swimming, Block 4, Tuesday')
  })

  it('states the extent of a spanning cell as a range', () => {
    expect(cellAccessibleName({ subject: 'Swimming', blockNames: ['Block 4', 'Block 5'], column: 'Tuesday' }))
      .toBe('Swimming, Block 4 to Block 5, Tuesday')
  })

  it('names the ends of a span of three or more, not every block it covers', () => {
    expect(cellAccessibleName({ subject: 'Hike', blockNames: ['Block 4', 'Block 5', 'Block 6'], column: 'Tuesday' }))
      .toBe('Hike, Block 4 to Block 6, Tuesday')
  })

  it('announces an empty cell as empty rather than as a blank cell', () => {
    expect(cellAccessibleName({ subject: 'Empty', blockNames: ['Block 1'], column: 'Monday' }))
      .toBe('Empty, Block 1, Monday')
  })

  it('announces an unavailable cell as unavailable', () => {
    expect(cellAccessibleName({ subject: 'Unavailable', blockNames: ['Block 1'], column: 'Monday' }))
      .toBe('Unavailable, Block 1, Monday')
  })

  it('takes a group as the column in day view', () => {
    expect(cellAccessibleName({ subject: 'Soccer', blockNames: ['Morning'], column: 'Alpha' }))
      .toBe('Soccer, Morning, Alpha')
  })

  it('drops missing parts rather than emitting stray separators', () => {
    expect(cellAccessibleName({ subject: 'Empty', blockNames: [], column: undefined })).toBe('Empty')
    expect(cellAccessibleName({ subject: 'Empty', blockNames: [null, undefined], column: 'Monday' }))
      .toBe('Empty, Monday')
  })
})

describe('blockNamesForSpan', () => {
  it('returns one name for a single-block cell', () => {
    expect(blockNamesForSpan(timeBlocks, 0)).toEqual(['Block 1'])
    expect(blockNamesForSpan(timeBlocks, 0, 1)).toEqual(['Block 1'])
  })

  it('returns every covered block for a spanning cell', () => {
    expect(blockNamesForSpan(timeBlocks, 0, 2)).toEqual(['Block 1', 'Block 2'])
    expect(blockNamesForSpan(timeBlocks, 1, 2)).toEqual(['Block 2', 'Block 3'])
  })

  it('does not run past the end of the schedule', () => {
    expect(blockNamesForSpan(timeBlocks, 2, 3)).toEqual(['Block 3'])
  })
})
