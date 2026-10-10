// Packaged audit #12 — the post-import notice when the imported version was not
// saved at all. Placements left out of a saved version are leftOutPlacements.js.
export function unresolvedPlacementsNotice(version) {
  if (version?.allWeeksArchived) {
    return "Your imported schedule wasn't saved because every week is archived. On the Schedule screen, unarchive a week or add a new one, then import the file again."
  }
  return null
}
