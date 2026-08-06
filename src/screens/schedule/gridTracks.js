// Row track sizing for the schedule grid. Pure: no DOM, no React, no data layer.
// Emits the value of the `--grid-rows` custom property on the grid container —
// collapse and density are the same string with different tracks (spec §2, §4).

export const COLLAPSED_TRACK = 20
export const ROW_FLOOR_NORMAL = 48
// 40px is the compact floor and the work stops there: below ~40px the floor stops
// binding and the row header becomes the constraint (spec §4 D3).
export const ROW_FLOOR_COMPACT = 40

// Column tracks. The leading 140px is the row-header column that placeCell's
// `columnIndex + 2` accounts for — the two must agree, so they are stated once
// here rather than re-typed in each of the four views (T56).
//
// minmax(0, 1fr) rather than the spec's minmax(<colFloor>, 1fr): no colFloor
// value was ever resolved (D1-D3 cover the ROW floors only), and any non-zero
// floor introduces horizontal scrolling the tables did not have, which would
// break the visual-parity predicate. Left for whoever resolves colFloor.
export function columnTracks(columnCount) {
  return `140px repeat(${columnCount}, minmax(0, 1fr))`
}

const NONE_COLLAPSED = new Set()

// `collapsedBlockIds` is a Set, not an array — the house shape for an id set
// (see dismissedFindingKeys in ScheduleScreen). T53 accepted either; T55 pinned
// it, because "accepts either" is permanent ambiguity nobody revisits.
export function buildRowTracks({ timeBlocks, collapsedBlockIds = NONE_COLLAPSED, density = 'normal' }) {
  if (timeBlocks.length === 0) return 'none'

  const floor = density === 'compact' ? ROW_FLOOR_COMPACT : ROW_FLOOR_NORMAL

  // A collapsed track is a fixed length, never `auto` — an auto max would let cell
  // content re-expand the row and defeat the collapse.
  return timeBlocks
    .map(block => (collapsedBlockIds.has(block.id) ? `${COLLAPSED_TRACK}px` : `minmax(${floor}px, auto)`))
    .join(' ')
}
