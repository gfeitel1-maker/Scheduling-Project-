// Packaged audit #12 — the post-import notice when the imported version was not
// saved at all. Placements left out of a saved version are leftOutPlacements.js.
export function unresolvedPlacementsNotice(version) {
  if (version?.allWeeksArchived) {
    return "Your imported schedule wasn't saved because every week is archived. On the Schedule screen, unarchive a week or add a new one, then import the file again."
  }
  if (version?.failed) {
    return `Your import finished, but the imported schedule couldn't be saved as a version (${version.failed}). Import the file again to save it.`
  }
  return null
}

// T219: an elective printed across adjacent periods is linked so a camper keeps one choice for
// the whole double period. When that could not happen the schedule still saved, and the director
// is told that each period will be chosen separately.
export function electiveLinkNotices(version) {
  const out = (version?.unlinkedSpans ?? []).map(({ electiveSetName, dayName }) =>
    `${electiveSetName ?? 'An elective'}${dayName ? ` on ${dayName}` : ''} runs across different periods for different groups, so its choices weren't linked across the double period. Each period is chosen separately.`)
  if (version?.linkFailed) {
    out.push(`Your schedule was saved, but its double-period electives couldn't be linked, so each period is chosen separately (${version.linkFailed}).`)
  }
  return out
}
