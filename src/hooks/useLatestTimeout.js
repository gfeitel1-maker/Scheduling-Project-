import { useCallback, useEffect, useRef } from 'react'

/**
 * A `setTimeout` the calling component OWNS, for the "show something, then
 * clear it after N ms" shape that recurs across this app — a saved flash, a
 * success banner, a press-scale reset, a paste error, a debounced dry-run.
 *
 * Writing that shape as a bare `setTimeout(() => setX(null), n)` has two costs,
 * both of which were live in this codebase before T218:
 *
 *  1. **It is not restartable.** Triggering again while a reset is pending
 *     leaves the FIRST timer running, so it clears state in the middle of the
 *     second occurrence — a press animation cut short, a banner that vanishes
 *     early. `start` cancels the pending timer, so the latest call wins.
 *  2. **It outlives the component.** An unmounted component still had a
 *     `setState` queued against it. React 18 drops that write silently, which
 *     is exactly why these survived review; under Vitest the callback can
 *     outlive the jsdom environment and throw `window is not defined` as an
 *     uncaught exception, failing a run in which every test passed.
 *
 * Returns `start(fn, ms)`, plus `cancel()` for the callers that need to stop a
 * pending reset on their own (a banner dismissed by hand, say). Both are stable
 * across renders, so they are safe in a dependency array.
 *
 * This is deliberately "latest wins" rather than a general timer pool: every
 * call site in this app wants one pending reset at a time, and a pool would let
 * the bug in (1) back in through the front door.
 */
export function useLatestTimeout() {
  const idRef = useRef(null)

  const cancel = useCallback(() => {
    if (idRef.current !== null) {
      clearTimeout(idRef.current)
      idRef.current = null
    }
  }, [])

  const start = useCallback((fn, ms) => {
    cancel()
    idRef.current = setTimeout(() => {
      idRef.current = null
      fn()
    }, ms)
  }, [cancel])

  useEffect(() => cancel, [cancel])

  return { start, cancel }
}
