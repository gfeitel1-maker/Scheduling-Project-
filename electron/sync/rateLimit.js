// The two rate limits guarding the unauthenticated side of the peer handshake,
// and the one question they both reduce to. Both constants are live: their
// consumer is the auth-over-libp2p gate (electron/sync/automerge/authGate.js,
// which applies LOGIN_MIN_INTERVAL_MS to 'login' and PAIRING_RATE_MS to
// 'pairing_request', keyed per peer, per device_id and per source).
//
// _Prior: "the unauthenticated WebSocket surface". The WS transport was deleted
// at the Stage 6 cutover; the limits outlived it because the exposure they
// address is a property of accepting pre-authentication messages from a peer, not
// of any one transport._
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
// with zero prior authentication (unlike the document-sync protocol, which an
// admitted peer only reaches after the handshake has bound it to a trusted
// device): a single connection hammering 'login' in a tight loop drives
// synchronous better-sqlite3 calls on Node's single-threaded event loop,
// starving every other connected device's sync traffic. _Prior: that cost was
// stated as starving "acquire_lock/submit_op responses and op_applied
// broadcasts", and the authenticated comparison was "an already-authenticated
// ws.deviceId" — all three names went with the WS transport at the Stage 6
// cutover. The starvation argument is unchanged, because it is about the shared
// event loop, not about which messages are queued behind it._ 300ms bounds
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

// T288 round 3: a per-SOURCE-HOST counter, replacing the min-interval throttle that used to be
// keyed on rateLimitKeyFor's source key (authGate.js). A min-interval on source throttles two
// genuinely distinct identities (different peer id, different device_id) that merely share a
// network source — real for two devices behind one NAT/CGNAT, and exactly what the loopback
// integration harness hits (every scenario's peers share 127.0.0.1). A fixed-window COUNT is the
// right shape instead: allow up to `maxAttempts` pairing/login attempts per source within
// `windowMs`, and only throttle beyond that. The count is what actually bounds an identity-churn
// flood (fromPeerId/device_id are free to mint; the source host is not), independent of how many
// distinct identities produced the attempts.
//
// Fixed window, not sliding: simpler, and the boundary imprecision (a burst can land up to 2x
// maxAttempts across a window edge) is an acceptable tradeoff for a counter whose job is bounding
// a grind of millions of attempts, not policing exact fairness at the edge.
export class SourceRateLimiter {
  constructor({ maxAttempts, windowMs }) {
    this.maxAttempts = maxAttempts
    this.windowMs = windowMs
    this.windows = new Map() // sourceKey -> { windowStart, count }
  }

  // Returns true if this attempt should be throttled. Always records the attempt (even when
  // throttled) so a sustained flood keeps reporting throttled rather than oscillating.
  attempt(sourceKey, now) {
    this._evictExpired(now)

    const entry = this.windows.get(sourceKey)
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.windows.set(sourceKey, { windowStart: now, count: 1 })
      return false
    }

    entry.count += 1
    return entry.count > this.maxAttempts
  }

  // Bounds map growth (Red Hat LOW, round 1): a churning source-key attacker cannot grow this map
  // without bound, because every access sweeps out windows that have fully expired.
  _evictExpired(now) {
    for (const [key, entry] of this.windows) {
      if (now - entry.windowStart >= this.windowMs) this.windows.delete(key)
    }
  }

  size() {
    return this.windows.size
  }
}
