import { describe, it, expect } from 'vitest'
import {
  buildRowTracks,
  columnTracks,
  COLLAPSED_TRACK,
  ROW_FLOOR_NORMAL,
  ROW_FLOOR_COMPACT,
} from './gridTracks'

const blocks = ['b1', 'b2', 'b3', 'b4', 'b5'].map((id, i) => ({ id, sort_order: i }))

const NORMAL = `minmax(${ROW_FLOOR_NORMAL}px, auto)`
const COMPACT = `minmax(${ROW_FLOOR_COMPACT}px, auto)`
const COLLAPSED = `${COLLAPSED_TRACK}px`

describe('constants', () => {
  it('are the resolved spec values', () => {
    expect(COLLAPSED_TRACK).toBe(20)
    expect(ROW_FLOOR_NORMAL).toBe(48)
    expect(ROW_FLOOR_COMPACT).toBe(40)
  })
})

describe('buildRowTracks', () => {
  it('gives every block the normal floor when nothing is collapsed', () => {
    expect(buildRowTracks({ timeBlocks: blocks, collapsedBlockIds: new Set(), density: 'normal' }))
      .toBe(Array(5).fill(NORMAL).join(' '))
  })

  it('uses the compact floor in compact density', () => {
    expect(buildRowTracks({ timeBlocks: blocks, collapsedBlockIds: new Set(), density: 'compact' }))
      .toBe(Array(5).fill(COMPACT).join(' '))
  })

  it('replaces one collapsed block track', () => {
    expect(buildRowTracks({ timeBlocks: blocks, collapsedBlockIds: new Set(['b2']), density: 'normal' }))
      .toBe([NORMAL, COLLAPSED, NORMAL, NORMAL, NORMAL].join(' '))
  })

  // Non-adjacent collapses are the case an index-range implementation gets wrong.
  it('replaces several non-adjacent collapsed block tracks', () => {
    expect(buildRowTracks({ timeBlocks: blocks, collapsedBlockIds: new Set(['b1', 'b3', 'b5']), density: 'normal' }))
      .toBe([COLLAPSED, NORMAL, COLLAPSED, NORMAL, COLLAPSED].join(' '))
  })

  it('collapses every block when all are collapsed', () => {
    expect(buildRowTracks({ timeBlocks: blocks, collapsedBlockIds: new Set(blocks.map(b => b.id)), density: 'normal' }))
      .toBe(Array(5).fill(COLLAPSED).join(' '))
  })

  it('collapse wins over density — a collapsed track is identical in both modes', () => {
    const args = { timeBlocks: blocks, collapsedBlockIds: new Set(['b2']) }
    expect(buildRowTracks({ ...args, density: 'compact' }))
      .toBe([COMPACT, COLLAPSED, COMPACT, COMPACT, COMPACT].join(' '))
  })

  // T55 pinned the contract to a Set. An array is no longer accepted: Array has
  // no .has, so a caller that regresses to one throws here rather than silently
  // rendering every row uncollapsed.
  it('requires collapsedBlockIds to be a Set — an array is not silently tolerated', () => {
    expect(() => buildRowTracks({ timeBlocks: blocks, collapsedBlockIds: ['b2'], density: 'normal' }))
      .toThrow()
  })

  it('ignores collapsed ids that match no block', () => {
    expect(buildRowTracks({ timeBlocks: blocks, collapsedBlockIds: new Set(['nope']), density: 'normal' }))
      .toBe(Array(5).fill(NORMAL).join(' '))
  })

  it('returns none for empty timeBlocks', () => {
    expect(buildRowTracks({ timeBlocks: [], collapsedBlockIds: new Set(), density: 'normal' })).toBe('none')
  })

  it('defaults to no collapse and normal density', () => {
    expect(buildRowTracks({ timeBlocks: blocks })).toBe(Array(5).fill(NORMAL).join(' '))
  })

  // A collapsed track must be a fixed length: auto (or a minmax with an auto max)
  // would let cell content re-expand the row and defeat the collapse entirely.
  it('emits a collapsed track as the literal 20px, never auto and never a minmax', () => {
    const tracks = buildRowTracks({
      timeBlocks: blocks,
      collapsedBlockIds: new Set(blocks.map(b => b.id)),
      density: 'compact',
    })
    expect(tracks).toBe('20px 20px 20px 20px 20px')
    expect(tracks).not.toContain('auto')
    expect(tracks).not.toContain('minmax')
  })
})

// The 140px lead track is the row-header column that placeCell's `columnIndex + 2`
// accounts for. If the two ever disagree every cell in every view is off by one,
// silently — which is the whole reason both live in one place.
describe('columnTracks', () => {
  it('leads with the 140px row-header column and one flexible track per column', () => {
    expect(columnTracks(5)).toBe('140px repeat(5, minmax(0, 1fr))')
    expect(columnTracks(1)).toBe('140px repeat(1, minmax(0, 1fr))')
  })
})
