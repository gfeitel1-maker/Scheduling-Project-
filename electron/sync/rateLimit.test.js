import { describe, it, expect } from 'vitest'
import { shouldThrottle, LOGIN_MIN_INTERVAL_MS, PAIRING_RATE_MS } from './rateLimit.js'

// T26. The two rate limits on the unauthenticated surface both reduce to one
// question — "has enough time passed since the last one?" — and that question
// is a pure function. Testing it as one means the boundary cases are settled
// by arithmetic rather than by racing a real clock, which is what made the
// burst test untestable in the first place (see T25 and the skipped test in
// syncServer.test.js).

describe('shouldThrottle', () => {
  it('lets the first attempt through, because there is nothing to compare against', () => {
    expect(shouldThrottle(undefined, 1000, 300)).toBe(false)
    expect(shouldThrottle(null, 1000, 300)).toBe(false)
  })

  it('drops an attempt inside the window', () => {
    expect(shouldThrottle(1000, 1000, 300)).toBe(true)
    expect(shouldThrottle(1000, 1299, 300)).toBe(true)
  })

  it('lets an attempt through exactly at the window edge', () => {
    // Strictly-less-than, so the boundary itself is allowed. Stated as a test
    // because "300ms apart" is how a human describes the rule and it should
    // mean the attempt is accepted, not dropped by one millisecond.
    expect(shouldThrottle(1000, 1300, 300)).toBe(false)
  })

  it('lets an attempt through well past the window', () => {
    expect(shouldThrottle(1000, 5000, 300)).toBe(false)
  })

  it('does not drop an attempt when the clock goes backwards', () => {
    // Wall clocks move backwards — NTP correction, or a director changing the
    // system time. A negative elapsed time is less than the interval, which
    // would silently lock out a legitimate user for as long as the skew lasts.
    // Failing open is right here: the per-name lockout in attemptLogin is the
    // control that actually bounds guessing, and it is not clock-dependent in
    // the same way.
    expect(shouldThrottle(5000, 1000, 300)).toBe(false)
  })

  it('carries the intervals the server actually uses', () => {
    expect(LOGIN_MIN_INTERVAL_MS).toBe(300)
    expect(PAIRING_RATE_MS).toBe(5000)
  })
})
