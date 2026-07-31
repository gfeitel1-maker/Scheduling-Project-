// Wait until a condition is actually true, instead of sleeping a guessed
// number of milliseconds and hoping.
//
// T25: the suite failed on roughly half of six identical full runs, with a
// different set of tests each time. The dominant cause was 62 fixed-duration
// sleeps standing in for "wait until the async thing happened":
//
//   await new Promise((resolve) => setTimeout(resolve, 50))
//   expect(db.prepare('SELECT ...').get()).toBeTruthy()
//
// On an idle machine 50ms is plenty. On a 4-core machine running 56 test files
// alongside other agent sessions, the event loop is starved and 50ms is not,
// so the assertion runs before the data arrives and the test reports a data
// loss that never happened. Lengthening the sleep does not fix this — it only
// moves the threshold and makes every green run slower.
//
// Polling a predicate is both faster in the normal case (it returns as soon as
// the condition holds, usually on the first tick) and correct in the slow one.

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_INTERVAL_MS = 10

/**
 * Poll `predicate` until it returns a truthy value, then return that value.
 *
 * Throws once `timeout` elapses, so a condition that never becomes true still
 * fails the test — this absorbs scheduling noise, not real breakage. The error
 * carries `message` so the failure names what was being waited for rather than
 * pointing at this file.
 *
 * A predicate that throws is treated as "not yet" until the timeout, at which
 * point its own error is rethrown; that keeps `waitFor(() => expect(...))`
 * usable without swallowing the assertion message.
 */
export async function waitFor(predicate, { timeout = DEFAULT_TIMEOUT_MS, interval = DEFAULT_INTERVAL_MS, message } = {}) {
  const deadline = Date.now() + timeout
  let lastError = null

  for (;;) {
    try {
      const result = await predicate()
      if (result) return result
      lastError = null
    } catch (err) {
      lastError = err
    }

    if (Date.now() >= deadline) {
      if (lastError) throw lastError
      throw new Error(
        `waitFor timed out after ${timeout}ms${message ? `: ${message}` : ''}`
      )
    }

    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

/**
 * Sleep for a fixed duration, for the cases where elapsed time is genuinely the
 * thing under test — proving a timeout fires, or that nothing arrives within a
 * window. Named so those uses stay visibly distinct from the ones that should
 * be `waitFor`.
 */
export function sleepBecauseTimeIsUnderTest(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
