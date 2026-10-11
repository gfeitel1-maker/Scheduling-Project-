// The post-import line that says where last year's schedule went. An import
// never fills the live grid (docs/adr/2026-09-02-imported-schedule-materializes-
// as-a-version.md); it saves a version, and without this line the director lands
// on an empty grid with no sign it exists.
export function importedVersionLine(version) {
  if (!version?.created || !version.versionName) return null
  const electiveNote = version.electiveCellCount > 0
    ? ' Restore it to see the electives, then confirm the proposed choices in Electives before Generate will assign them.'
    : ''
  return {
    text: `Last year's schedule is saved as a version: ${version.versionName}.${electiveNote}`,
    versionName: version.versionName,
  }
}
