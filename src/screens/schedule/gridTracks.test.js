import { describe, it, expect } from 'vitest'
import {
  buildRowTracks,
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
    expect(buildRowTracks({ timeBlocks: blocks, collapsedBlockIds: [], density: 'normal' }))
      .toBe(Array(5).fill(NORMAL).join(' '))
  })

  it('uses the compact floor in compact density', () => {
    expect(buildRowTracks({ timeBlocks: blocks, collapsedBlockIds: [], density: 'compact' }))
      .toBe(Array(5).fill(COMPACT).join(' '))
  })

  it('replaces one collapsed block track', () => {
    expect(buildRowTracks({ timeBlocks: blocks, collapsedBlockIds: ['b2'], density: 'normal' }))
      .toBe([NORMAL, COLLAPSED, NORMAL, NORMAL, NORMAL].join(' '))
  })

  // Non-adjacent collapses are the case an index-range implementation gets wrong.
  it('replaces several non-adjacent collapsed block tracks', () => {
    expect(buildRowTracks({ timeBlocks: blocks, collapsedBlockIds: ['b1', 'b3', 'b5'], density: 'normal' }))
      .toBe([COLLAPSED, NORMAL, COLLAPSED, NORMAL, COLLAPSED].join(' '))
  })

  it('collapses every block when all are collapsed', () => {
    expect(buildRowTracks({ timeBlocks: blocks, collapsedBlockIds: blocks.map(b => b.id), density: 'normal' }))
      .toBe(Array(5).fill(COLLAPSED).join(' '))
  })

  it('collapse wins over density — a collapsed track is identical in both modes', () => {
    const args = { timeBlocks: blocks, collapsedBlockIds: ['b2'] }
    expect(buildRowTracks({ ...args, density: 'compact' }))
      .toBe([COMPACT, COLLAPSED, COMPACT, COMPACT, COMPACT].join(' '))
  })

  it('accepts collapsedBlockIds as a Set', () => {
    expect(buildRowTracks({ timeBlocks: blocks, collapsedBlockIds: new Set(['b2']), density: 'normal' }))
      .toBe([NORMAL, COLLAPSED, NORMAL, NORMAL, NORMAL].join(' '))
  })

  it('ignores collapsed ids that match no block', () => {
    expect(buildRowTracks({ timeBlocks: blocks, collapsedBlockIds: ['nope'], density: 'normal' }))
      .toBe(Array(5).fill(NORMAL).join(' '))
  })

  it('returns none for empty timeBlocks', () => {
    expect(buildRowTracks({ timeBlocks: [], collapsedBlockIds: [], density: 'normal' })).toBe('none')
  })

  it('defaults to no collapse and normal density', () => {
    expect(buildRowTracks({ timeBlocks: blocks })).toBe(Array(5).fill(NORMAL).join(' '))
  })

  // A collapsed track must be a fixed length: auto (or a minmax with an auto max)
  // would let cell content re-expand the row and defeat the collapse entirely.
  it('emits a collapsed track as the literal 20px, never auto and never a minmax', () => {
    const tracks = buildRowTracks({
      timeBlocks: blocks,
      collapsedBlockIds: blocks.map(b => b.id),
      density: 'compact',
    })
    expect(tracks).toBe('20px 20px 20px 20px 20px')
    expect(tracks).not.toContain('auto')
    expect(tracks).not.toContain('minmax')
  })
})
