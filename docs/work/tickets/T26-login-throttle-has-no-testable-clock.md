---
title: T26-login-throttle-has-no-testable-clock
document_type: ticket
status: completed
created: 2026-07-31
governing_docs: [docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: []
archive_when: resolved
---

# T26 — The login throttle cannot be tested without racing the machine

**Risk:** Low for correctness, medium for confidence. The throttle is a security control
(it bounds unauthenticated PIN guessing) and its central behaviour has no test that can run.
**Found:** 2026-07-31, while clearing T25's remaining sleep-based tests.

---

## What happens

`electron/sync/syncServer.test.js` carries a skipped test:

> throttles a burst of rapid login messages from one connection, so not all of them reach
> attemptLogin / the per-name lockout

It was originally skipped as "timing-sensitive ... root cause is environmental". Attempting to
un-skip it during T25 — by replacing its guessed 800ms sleep with a poll — **failed**, with 6
replies against `expect(replies.length).toBeLessThan(5)`. That failure is the useful evidence.

## Why polling does not fix it

The throttle compares wall-clock time at **processing** time:

```js
// electron/sync/syncServer.js:471
const now = Date.now()
if (ws.lastLoginAttemptAt !== undefined && now - ws.lastLoginAttemptAt < LOGIN_MIN_INTERVAL_MS) {
  return
}
```

Each message that clears the throttle then runs `attemptLogin`, which runs `scryptSync` —
deliberately CPU-hard, measured at **~67ms on an idle machine** and considerably more when the
machine is starved. `LOGIN_MIN_INTERVAL_MS` is 300.

So the number of a 20-message burst that gets through is a direct function of how long scrypt
takes relative to 300ms. On a fast machine almost all are dropped; on a slow one each attempt
takes longer than the window and most get through. **The quantity under test is machine speed.**

This is a different failure from the ones T25 fixed. Polling repairs races about *when*
something happened. It cannot repair an assertion about *how many* events fit inside a
wall-clock window.

## Proposed fix

Give `handleLogin` an injectable clock — a `now()` the server defaults to `Date.now` and a test
can drive. The test then advances time deterministically and asserts exactly which messages are
dropped, on any machine.

This is a production change made for a test, which is why it is a ticket rather than something
folded into T25. It is a small and defensible seam — the throttle's whole contract is expressed
in time, so time is legitimately part of its interface — but it should be decided on its own
merits.

Worth checking at the same time whether `attemptLogin`'s lockout tracking has the same problem;
it also reasons about elapsed time (5 attempts, 30s).

## What is not at risk meanwhile

The throttle's user-visible guarantees do still have passing tests:

- a human-paced retry beyond the window is **not** dropped;
- the per-name lockout still trips after 5 genuine attempts.

What is uncovered is specifically the burst-drop count — the part that bounds an attacker
flooding the unauthenticated surface.

## Resolution — 2026-07-31

`electron/sync/rateLimit.js` now holds both intervals and the single question they reduce to,
`shouldThrottle(lastAt, now, minIntervalMs)`. `startSyncServer` takes `now = Date.now`, threaded
into `handleLogin` and the pairing rate limit — which had the same inline `Date.now()` shape and
is fixed at the same time.

**One behaviour change, deliberate.** `shouldThrottle` now fails **open** when the clock goes
backwards. The old expression `now - last < 300` treats a negative elapsed time as "too soon", so
an NTP correction or a director changing the system time would silently refuse legitimate logins
for as long as the skew lasted. That is the wrong direction to fail in: this throttle bounds
event-loop starvation, while the control that actually bounds PIN guessing is the per-name
lockout in `attemptLogin`, which is unaffected.

The test the ticket was filed for is un-skipped and its assertion is now **exact** — not "fewer
than five replies" but "exactly one" — because a frozen clock makes the outcome deterministic.
Its synchronisation is the clock function itself: `handleLogin` calls `now()` once per message
that clears the device-secret gate, so 20 calls means all 20 were processed. That is a real
signal rather than a guessed duration.

## Completion evidence

1. The skipped test runs, and passes on both an idle and a deliberately loaded machine —
   **met**: `syncServer.test.js` 50 passed / 0 skipped, and 3/3 green with two CPU hogs running.
2. It asserts which messages are dropped, not merely that "fewer than N" replies arrived —
   **met**: `expect(replies).toHaveLength(1)`.
3. The injected clock defaults to real time in production, with a test proving the default is
   what ships — **met**: "defaults to the real clock, so what ships is not the injected one"
   starts a server with no `now` and proves it still throttles.
4. No test of this behaviour reads `Date.now()` to decide whether it passed — **met**:
   `rateLimit.test.js` is pure arithmetic, including the window edge and the backwards clock.

Also checked, as the ticket asked: `attemptLogin`'s per-name lockout reasons about elapsed time
too (5 attempts, 30s). It is **not** fixed here — its tests pass and were not among the flakes —
but it carries the same untestable shape and is the next candidate if it ever starts failing.
