// T59. The accessible name of a schedule cell (spec §0 predicate 6: "screen-
// reader navigation reports row/column position and the span extent of merged
// cells"). aria-rowspan gives a machine the extent; this gives it to a person.
//
// Composed only from data the view already holds — activity/overlay/anchor
// name, the block names the cell covers, and the column's day (group view,
// manual build, activity view) or group (day view, whose COLUMNS ARE GROUPS).
// No fetch, no state.
//
// The block part uses the block's OWN name rather than the word "blocks" plus
// an index, because a block's name is free text in this product ("Block 1",
// but also "Morning", "Lunch"). "blocks Morning to Lunch" is worse than
// "Morning to Lunch", and the range form already reads as an extent.

export function cellAccessibleName({ subject, blockNames = [], column }) {
  const blocks = blockNames.filter(Boolean)
  const blockPart = blocks.length > 1
    ? `${blocks[0]} to ${blocks[blocks.length - 1]}`
    : blocks[0]
  return [subject, blockPart, column].filter(Boolean).join(', ')
}

// The block names a cell covers, from the row it starts on and how far it
// spans. Views hold `timeBlocks` and the head's index already.
export function blockNamesForSpan(timeBlocks, blockIndex, rowSpan = 1) {
  return timeBlocks
    .slice(blockIndex, blockIndex + Math.max(1, rowSpan))
    .map(b => b.name)
}
