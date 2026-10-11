// The copy is one atomic main-process write, so a failure means nothing was added
// (seededCount is 0 for it); the partial wording is kept for a count that is not 0.
// Its own module (rather than a named
// export alongside the screen's default component) so it can be unit-tested
// without react-refresh's only-export-components constraint.
export function seedFailureMessage(seededCount, totalCount) {
  return seededCount > 0
    ? `Added ${seededCount} of ${totalCount} blocks.`
    : "Couldn't add blocks."
}
