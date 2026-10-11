// The post-import line that says where last year's schedule went. An import
// never fills the live grid (docs/adr/2026-09-02-imported-schedule-materializes-
// as-a-version.md); it saves a version, and without this line the director lands
// on an empty grid with no sign it exists.
export function importedVersionLine(version) {
  if (!version?.created || !version.versionName) return null
  return {
    text: `Last year's schedule is saved as a version: ${version.versionName}.`,
    versionName: version.versionName,
  }
}
