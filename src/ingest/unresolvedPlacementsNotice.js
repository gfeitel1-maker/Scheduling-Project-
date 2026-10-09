// Packaged audit #12 — the post-import notice for placements the imported
// version could not carry: how many, which names, why, and what to do.
export function unresolvedPlacementsNotice(version) {
  if (version?.allWeeksArchived) {
    return "Your imported schedule wasn't saved because every week is archived. On the Schedule screen, unarchive a week or add a new one, then import the file again."
  }
  const count = version?.unresolvedCount ?? 0
  if (count === 0) return null
  const names = [...new Set(version.unresolvedNames ?? [])]
  const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? `, and ${names.length - 5} more` : '')
  const lead = version.created
    ? `${count} placement${count === 1 ? '' : 's'} couldn't be matched and ${count === 1 ? 'was' : 'were'} left out of the imported version`
    : `Your imported schedule couldn't be saved as a version: none of its ${count} placement${count === 1 ? '' : 's'} could be matched`
  return `${lead} (${shown}). They name an activity, group, day or time block your camp doesn't have. Add or rename it in setup, then import the file again.`
}
