// Row track sizing for the schedule grid. Pure: no DOM, no React, no data layer.
// Emits the value of the `--grid-rows` custom property on the grid container —
// collapse and density are the same string with different tracks (spec §2, §4).

export const COLLAPSED_TRACK = 20
export const ROW_FLOOR_NORMAL = 48
// 40px is the compact floor and the work stops there: below ~40px the floor stops
// binding and the row header becomes the constraint (spec §4 D3).
export const ROW_FLOOR_COMPACT = 40

export function buildRowTracks({ timeBlocks, collapsedBlockIds = [], density = 'normal' }) {
  if (timeBlocks.length === 0) return 'none'

  const collapsed = collapsedBlockIds instanceof Set ? collapsedBlockIds : new Set(collapsedBlockIds)
  const floor = density === 'compact' ? ROW_FLOOR_COMPACT : ROW_FLOOR_NORMAL

  // A collapsed track is a fixed length, never `auto` — an auto max would let cell
  // content re-expand the row and defeat the collapse.
  return timeBlocks
    .map(block => (collapsed.has(block.id) ? `${COLLAPSED_TRACK}px` : `minmax(${floor}px, auto)`))
    .join(' ')
}
