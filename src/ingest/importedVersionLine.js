// The post-import line that says where last year's schedule went. An import
// never fills the live grid (docs/adr/2026-09-02-imported-schedule-materializes-
// as-a-version.md); it saves a version, and without this line the director lands
// on an empty grid with no sign it exists.
export function importedVersionLine(version, proposedChoiceCount = 0) {
  if (!version?.created || !version.versionName) return null
  const next = proposedChoiceCount > 0 ? 'confirm the proposed choices' : 'add choices'
  const electiveNote = version.electiveCellCount > 0
    ? ` Restore it to see the electives, then ${next} in Electives before Generate will assign them.`
    : ''
  return {
    // Director test 2026-10-12: "saved as a version: Imported from…" read as jargon. The version name
    // stays the link target (versionName below), not the sentence.
    text: `Last year's schedule is saved.${electiveNote}`,
    versionName: version.versionName,
  }
}
