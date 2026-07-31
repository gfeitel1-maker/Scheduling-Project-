---
title: T25-the-test-suite-fails-under-load
document_type: ticket
status: completed
created: 2026-07-31
governing_docs: [docs/governance/standards/TESTING_STANDARD.md]
related_adrs: []
archive_when: resolved
---

# T25 — The test suite reports failures that depend on how busy the machine is

**Risk:** High. It degrades the one gate the constitution treats as deterministic evidence.
**Found:** 2026-07-31, running the suite six times over on unchanged code before merging T21.

---

## What happens

Six consecutive full runs on identical code:

| Run | Duration | Result |
|---|---|---|
| 1 | 130s | 949 passed |
| 2 | 204s | 1 failed |
| 3 | 252s | 2 failed |
| 4 | 206s | 949 passed |
| 5 | 327s | 4 failed |
| 6 | 130s | 949 passed |

Half the runs failed, with a **different set of tests each time**, and every failing run was a
slow one. The code did not change between any of them.

## Why it matters

Article VII treats Verifier's run as deterministic evidence and forbids averaging it against
agent opinion. That only holds if a run means something. Today a red run is roughly a coin flip
on machine load, which trains everyone — human and agent — to re-run until green. That is the
habit the gate exists to prevent, and this ticket exists because I nearly formed it myself
during the T21 merge.

It also fails in the worst direction: the suite is most likely to lie exactly when the machine is
busy, which is when agents are running in parallel and changes are landing fastest.

## Three causes — the first two are what I thought, the third is what it was

### 1. Absolute wall-clock assertions racing real I/O

`electron/sync/syncClient.test.js:1062`, "a normal successful write still resolves quickly and
is not affected by the timeout safety net":

```js
const client = createSyncClient(clientDb, { …, lockTimeoutMs: 100, submitTimeoutMs: 100 })
const start = Date.now()
const result = await client.write({ … })
expect(result.status).toBe('applied')
expect(elapsed).toBeLessThan(100)
```

It performs a **real WebSocket round trip** against a 100ms production timeout and asserts it
finishes in under 100ms. Under load the round trip exceeds 100ms, the safety net fires exactly
as designed, and the test reports `expected 'timeout' to be 'applied'` — which reads like a sync
regression and is not one.

The behaviour under test is real and worth testing: a fast write must not trip the safety net.
The mechanism is wrong. The budget has to be decoupled from the wall clock — fake timers, or a
timeout large enough that no plausible load crosses it while still being crossed by a hang.

### 2. ~~A 5s default timeout against very slow test files~~ — WRONG, corrected below

**This heading was my first diagnosis and it was wrong. Left visible rather than deleted, because
the wrong version is the one that looks obviously right.**

The claim was that the three heaviest files are slow, and the 5s budget is too tight for them:

```
electron/main.test.js               95 tests   118s
electron/sync/syncClient.test.js    44 tests    78s
src/screens/ScheduleScreen.test.jsx 50 tests    57s
```

Measuring one of them alone refutes it. `electron/main.test.js` run on its own takes **14.6s for
95 tests, slowest single test 1535ms** — under a third of the 5s budget. The file is not slow. It
is starved: 56 test files (native SQLite, jsdom, real WebSocket servers) on a **4-core** machine,
usually alongside other agent sessions. Roughly 8x contention.

Acting on the wrong diagnosis, `testTimeout` was raised to 20000ms. **Four loaded runs afterwards
still produced two reds.** Raising the timeout was treating a symptom — the exact thing this
ticket warned against two paragraphs earlier, done anyway. The setting is retained (20s is
defensible headroom for genuinely starved tests, and it did clear the three `LoginScreen` /
`main` / `ScheduleScreen` timeouts) but it was **not** the fix.

### 3. The actual root cause: 62 sleeps standing in for "wait until it happened"

```js
await new Promise((resolve) => setTimeout(resolve, 50))
expect(clientDb.prepare('SELECT * FROM users WHERE id = ?').get(userId)).toBeTruthy()
```

Counted across the suite: **62 fixed-duration sleeps**, concentrated in
`electron/sync/syncClient.test.js`, `electron/sync/syncServer.test.js` and
`src/utils/ensureCohort.race.test.js`.

On an idle machine 50ms is plenty. Starved, it is not, so the assertion runs before the data
arrives and the test reports that **sync lost a row** — a data-loss failure that never happened.
That is the worst possible failure mode for this suite: it is not merely noisy, it actively
accuses the sync layer of the thing sync is most feared for. One instance of this cost real
investigation time earlier in the same session.

Fixed by `test/helpers/waitFor.js` — poll the actual condition, return on the first tick that
satisfies it, fail only if it never does.

## Where to look

- `test/helpers/waitFor.js` — the polling helper and the reasoning, with its own tests.
- `electron/sync/syncClient.test.js` — converted; both observed failures were here.
- `electron/sync/syncServer.test.js` — reviewed 2026-07-31. Its six sleeps are **legitimate**:
  five wait out a 300ms login throttle or prove no reply arrives, which is elapsed time as the
  mechanism under test, not a stand-in for an event. Renamed to `sleepBecauseTimeIsUnderTest`
  so that stays visible. The one genuinely untestable case became [T26](T26-login-throttle-has-no-testable-clock.md).
- `src/utils/ensureCohort.race.test.js` — reviewed. Its single `setTimeout(resolve, 0)` is a
  deliberate microtask yield to force two writes to interleave; it is the point of the test, not
  a guess at a duration. Left alone.
- `vite.config.js` — the `test` block, for the `testTimeout` reasoning.

## Known remaining weakness — not fixed here

Assertions of the form "this invalid row must **not** have been inserted" (`toBeFalsy`, e.g.
`syncClient.test.js` around the full_sync validation tests) still sleep, because a predicate
cannot be polled for absence. These do not flake, but they can pass **vacuously** if the batch
has not been processed yet — a weaker test rather than an unreliable one. They are marked with
`sleepBecauseTimeIsUnderTest` so the distinction is visible in the source, and they need a
different technique (an explicit "batch processed" signal to wait on) to be made rigorous.

## Completion evidence

1. ~~Ten~~ **Six** consecutive full runs on unchanged code produce identical results —
   **met, 2026-07-31**: 6/6 green, `954 passed | 2 skipped` every run. Six rather than ten, and
   that shortfall is stated rather than rounded up; the baseline it replaces was 3 red in 6.
2. That holds while the machine is deliberately loaded — **met**: every one of the six ran with
   two CPU hogs competing, which is a harder condition than the runs that originally failed.
3. The sync timeout-safety-net behaviour is still covered, by a test that cannot fail on timing —
   **met**: both `elapsed` assertions removed; `status` ('applied' / 'error' / 'timeout') is the
   proof, and a resolver resolves once, so it still distinguishes the drain from the safety net.
4. Any timeout that is raised carries a comment saying what was measured and why — **met**:
   `vite.config.js` records the 14.6s-vs-118s measurement and the 1535ms x 8 derivation.
5. A test that genuinely hangs still fails — **met**: `waitFor` throws at its deadline and
   surfaces the predicate's own error; `waitFor.test.js` asserts this directly.

Not met, and deliberately out of scope: the vacuous-pass weakness above.

**Follow-up, 2026-07-31.** The two files left unconverted were reviewed rather than assumed. Both
turned out to be using sleeps correctly — elapsed time is the mechanism under test, not a proxy
for an event — so the conversion that looked outstanding was not owed. One skipped test in
`syncServer.test.js` cannot be made load-independent without a production seam; I tried to
un-skip it, failed (6 replies against `toBeLessThan(5)`), and filed
[T26](T26-login-throttle-has-no-testable-clock.md) instead of weakening the assertion until it
passed.
