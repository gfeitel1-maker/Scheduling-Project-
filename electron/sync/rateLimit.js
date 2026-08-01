// The two rate limits guarding the unauthenticated WebSocket surface, and the
// one question they both reduce to.
//
// T26: this used to live inline in handleLogin as `Date.now() - last < 300`,
// which made the behaviour untestable — the burst test had to race a real
// clock against scryptSync, so how many messages got through was a function of
// how busy the machine was, and the test was skipped for years as
// "environmental". Extracted here so the rule is settled by arithmetic, and
// injected as a clock so the integration test can drive time instead of
// hoping.

// Minimum spacing between 'login' messages accepted from a single connection.
// This is a per-connection throttle, distinct from and in addition to the
// per-name lockout inside attemptLogin. It exists because 'login' is reachable
// with zero prior authentication (unlike acquire_lock/submit_op, which require
// an already-authenticated ws.deviceId): a single connection hammering 'login'
// in a tight loop drives synchronous better-sqlite3 calls on Node's
// single-threaded event loop, starving every other connected device's
// acquire_lock/submit_op responses and op_applied broadcasts. 300ms bounds
// that risk while comfortably allowing a real user's retry-after-wrong-pin
// flow (type PIN, get it wrong, retry).
export const LOGIN_MIN_INTERVAL_MS = 300

// Per-device spacing for pairing_request, which is likewise reachable before
// any authentication.
export const PAIRING_RATE_MS = 5000

/**
 * Has too little time passed since the last attempt?
 *
 * `lastAt` is undefined/null when nothing has been seen yet, which is never
 * throttled — there is nothing to be too close to.
 *
 * A backwards clock (NTP correction, or a director changing the system time)
 * produces a negative elapsed time. That is explicitly NOT treated as "too
 * soon": it would silently refuse a legitimate user for as long as the skew
 * lasted. Failing open is the right call because this throttle bounds event-loop
 * starvation, while the control that actually bounds PIN guessing is the
 * per-name lockout in attemptLogin.
 */
export function shouldThrottle(lastAt, now, minIntervalMs) {
  if (lastAt === undefined || lastAt === null) return false
  const elapsed = now - lastAt
  if (elapsed < 0) return false
  return elapsed < minIntervalMs
}
