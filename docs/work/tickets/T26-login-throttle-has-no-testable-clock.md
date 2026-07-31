---
title: T26-login-throttle-has-no-testable-clock
document_type: ticket
status: open
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

## Completion evidence

1. The skipped test runs, and passes on both an idle and a deliberately loaded machine.
2. It asserts which messages are dropped, not merely that "fewer than N" replies arrived.
3. The injected clock defaults to real time in production, with a test proving the default is
   what ships.
4. No test of this behaviour reads `Date.now()` to decide whether it passed.
