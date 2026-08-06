// The one piece of aggregate information a folded row must not swallow: a
// collapsed row that can hide a conflict turns a scanning aid into a scanning
// hazard (T55). Derived during the pass that already visits every cell of the
// row — never stored, never written to the db, the op-log or PROJECTIONS.
//
// It lives here rather than in a view because three views scan a row along
// different axes (group view and manual build across DAYS, day view across
// GROUPS) and the precedence rule must not be able to differ between them:
// UNFILLABLE (danger) outranks OVERLAP (advisory), and one dot is shown, never
// two.
//
// `cells` is a list of { groupId, dayId } — the axis is the caller's business.
export function rowFlagKind(geometry, cells, blockId) {
  let advisory = false
  for (const { groupId, dayId } of cells) {
    const flags = geometry.getSlot(groupId, dayId, blockId)?.flags
    if (!flags) continue
    if (flags.UNFILLABLE && !flags.UNFILLABLE_dismissed) return 'unfillable'
    if (flags.OVERLAP) advisory = true
  }
  return advisory ? 'advisory' : null
}

export const ROW_FLAG_TITLE = {
  unfillable: 'This period has an unfillable slot',
  advisory: 'This period has a clash',
}
