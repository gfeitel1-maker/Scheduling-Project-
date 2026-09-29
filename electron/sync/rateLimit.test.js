import { describe, it, expect } from 'vitest'
import { shouldThrottle, LOGIN_MIN_INTERVAL_MS, PAIRING_RATE_MS, SourceRateLimiter } from './rateLimit.js'

// T26. The two rate limits on the unauthenticated surface both reduce to one
// question — "has enough time passed since the last one?" — and that question
// is a pure function. Testing it as one means the boundary cases are settled
// by arithmetic rather than by racing a real clock, which is what made the
// burst test untestable in the first place (see T25; the skipped test it refers
// to lived in syncServer.test.js, deleted at the Stage 6c cutover).

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

// T288 round 3: the per-SOURCE throttle in authGate.js used to be keyed on
// shouldThrottle (min-interval), which meant two genuinely distinct
// identities sharing one source address (the loopback integration harness;
// in production, two devices behind the same NAT/CGNAT) throttled each other
// on their SECOND attempt within the window. SourceRateLimiter replaces that
// with a count within a rolling fixed window: many distinct identities from
// one source are fine up to maxAttempts, and only a flood beyond that is
// throttled — which is what actually bounds an identity-churn brute force,
// since the count is independent of how many different identities produced it.
describe('SourceRateLimiter', () => {
  it('allows up to maxAttempts distinct attempts from one source within the window', () => {
    const limiter = new SourceRateLimiter({ maxAttempts: 5, windowMs: 1000 })
    for (let i = 0; i < 5; i++) {
      expect(limiter.attempt('src-a', i * 10)).toBe(false)
    }
  })

  it('throttles attempts beyond maxAttempts within the window', () => {
    const limiter = new SourceRateLimiter({ maxAttempts: 3, windowMs: 1000 })
    expect(limiter.attempt('src-a', 0)).toBe(false)
    expect(limiter.attempt('src-a', 10)).toBe(false)
    expect(limiter.attempt('src-a', 20)).toBe(false)
    expect(limiter.attempt('src-a', 30)).toBe(true)
    expect(limiter.attempt('src-a', 40)).toBe(true)
  })

  it('resets the count once the window has fully elapsed', () => {
    const limiter = new SourceRateLimiter({ maxAttempts: 2, windowMs: 1000 })
    limiter.attempt('src-a', 0)
    limiter.attempt('src-a', 10)
    expect(limiter.attempt('src-a', 20)).toBe(true)
    expect(limiter.attempt('src-a', 1010)).toBe(false)
  })

  it('tracks distinct source keys independently — one source at its limit does not throttle another', () => {
    const limiter = new SourceRateLimiter({ maxAttempts: 1, windowMs: 1000 })
    expect(limiter.attempt('src-a', 0)).toBe(false)
    expect(limiter.attempt('src-a', 10)).toBe(true)
    expect(limiter.attempt('src-b', 10)).toBe(false)
  })

  it('evicts expired source entries so the map does not grow unbounded', () => {
    const limiter = new SourceRateLimiter({ maxAttempts: 5, windowMs: 1000 })
    for (let i = 0; i < 200; i++) limiter.attempt(`src-${i}`, 0)
    expect(limiter.size()).toBe(200)
    // Well past every prior entry's window — each access sweeps expired keys.
    limiter.attempt('src-tick', 5000)
    expect(limiter.size()).toBeLessThan(10)
  })
})
