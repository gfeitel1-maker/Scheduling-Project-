// Pure decision logic for the deploy-local.sh launch smoke test.
//
// The smoke test waits for the packaged app to write a heartbeat marker
// (electron/main.js, did-finish-load) after the renderer has actually
// loaded, instead of the old "process still alive after N seconds" check,
// which false-passed whenever a main-process crash was held alive behind
// Electron's own error dialog.
//
// A marker on disk is only trustworthy if it came from THIS launch, not a
// stale one left over from a previous run. deploy-local.sh defends against
// staleness primarily by deleting the marker file before launching. This
// module is the second line of defense: even if a stale marker survived,
// its commit must match the commit that was just deployed, or it is
// rejected as untrustworthy rather than accepted as a pass.
//
// The deployed commit the script compares against is DEPLOYED_COMMIT, read
// from the bundle's own build-info.json — the same plain (never "-dirty")
// git sha the marker's commit field is written from (electron/buildInfo.js).
// EXPECTED_COMMIT, by contrast, can carry a "-dirty" suffix for an uncommitted
// tree. Comparing against DEPLOYED_COMMIT (already plain) is the robust
// choice: it means a dirty-tree deploy never false-fails just because "-dirty"
// isn't present in the marker. stripDirtySuffix exists so this still holds
// even if a future caller passes EXPECTED_COMMIT instead.

export function stripDirtySuffix(commit) {
  if (typeof commit !== 'string') return commit
  return commit.endsWith('-dirty') ? commit.slice(0, -'-dirty'.length) : commit
}

// Decide whether a marker just read from disk should be accepted as proof
// that THIS deploy's app finished loading.
export function markerMatchesDeploy(markerCommit, expectedCommit) {
  if (typeof markerCommit !== 'string' || markerCommit.length === 0) return false
  if (typeof expectedCommit !== 'string' || expectedCommit.length === 0) return false
  return markerCommit === stripDirtySuffix(expectedCommit)
}
