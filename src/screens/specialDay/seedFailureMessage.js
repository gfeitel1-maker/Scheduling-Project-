import { describeWriteFailure } from '../../utils/writeErrorMessage'

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

export const COPY_TIMEOUT_MESSAGE = "Couldn't confirm the copy finished \u2014 check the schedule before copying again."
export const DOC_WARNING = 'Copied here, but syncing to other devices may be incomplete.'

// The copy is one call, so "did it land?" is unknown after a timeout: say that, not a plain failure.
export function copyFailureMessage(err) {
  if (err?.timedOut) return COPY_TIMEOUT_MESSAGE
  return describeWriteFailure(err, seedFailureMessage(err?.seededCount ?? 0, err?.totalCount ?? 0))
}
