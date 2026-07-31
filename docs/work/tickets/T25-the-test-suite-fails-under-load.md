---
title: T25-the-test-suite-fails-under-load
document_type: ticket
status: open
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

## Two distinct causes, not one

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

### 2. A 5s default timeout against very slow test files

The other three failures are all `Test timed out in 5000ms`, and they land in the three heaviest
files:

```
electron/main.test.js         95 tests   118s
electron/sync/syncClient.test.js  44 tests    78s
src/screens/ScheduleScreen.test.jsx  50 tests   57s
```

Which individual test crosses 5s is essentially arbitrary. Note these are not the same three
tests each run — run 5 hit LoginScreen, main, syncClient and ScheduleScreen; run 6 hit none.

Raising `testTimeout` is the obvious lever and is probably part of the answer, but it is a
sedative rather than a diagnosis: a per-test budget of 5s is not unreasonable, and a unit test
taking longer than that is itself worth understanding. Establish why `main.test.js` needs two
minutes for 95 tests before deciding the timeout is the problem.

Precedent worth reading first: the ESLint timeout was raised to 240s on 2026-07-30 **with the
reason recorded**, after being wrongly reverted as "masking". Same shape — record the why.

## Where to look

- `vite.config.js` — the `test` block; no `testTimeout` is set today, so the 5000ms default applies.
- `electron/sync/syncClient.test.js:1046-1064` — cause 1, in full.
- Per-file setup in the three slow files — whether each test rebuilds a database or a server that
  could be shared across a describe block.

## Completion evidence

1. Ten consecutive full runs on unchanged code produce ten identical results.
2. That holds while the machine is deliberately loaded, not only when it is idle.
3. The sync timeout-safety-net behaviour is still covered, by a test that cannot fail on timing.
4. Any timeout that is raised carries a comment saying what was measured and why, per the ESLint
   precedent.
5. A test that genuinely hangs still fails — the fix must not be a timeout so large that nothing
   ever trips it.
