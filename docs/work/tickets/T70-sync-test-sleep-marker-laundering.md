---
title: T70-sync-test-sleep-marker-laundering
document_type: ticket
status: completed
created: 2026-08-08
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T44-suite-flakiness-recurred-under-load.md, docs/work/tickets/T25-the-test-suite-fails-under-load.md]
archive_when: syncClient.test.js and syncServer.test.js have no arrival-then-assert sleeps, no load-unsafe wall-clock upper-bound assertions, and the noBareSleeps guard requires time to genuinely be under test rather than just checking marker presence
---

# T70 — `sleepBecauseTimeIsUnderTest` launders arrival-waits and the guard cannot tell

**Raised:** 2026-08-08, during T44 round 2 Verifier runs. Partial fix (ensure-abi.js) committed
in T44; this ticket covers the remaining flakiness cause the brief missed.

## The problem

`sleepBecauseTimeIsUnderTest()` was introduced in T25 as a marker that legitimately exempts a
sleep from the `noBareSleeps` guard — a `sleep(N)` where the test is explicitly measuring elapsed
time and N is intentionally part of the assertion. The guard (`electron/sync/noBareSleeps.test.js`)
checks that the marker is *present*, never that time is genuinely *under test*.

This means the marker now launders at least one arrival-wait:

**`syncClient.test.js` line ~1659:**
```js
await sleepBecauseTimeIsUnderTest(200)
// Wait for full-sync to populate the local camps row.
```
The comment names the real purpose: waiting for a DB row to arrive. That is an arrival-then-assert
wait — T25's exact failure class. Under load, 200ms isn't enough, the row isn't there, and the
next line throws `TypeError: Cannot read properties of undefined (reading 'signing_secret')`.
This failure reproduced in a Verifier run on 2026-08-08.

Additionally, T25 claimed to remove wall-clock upper-bound assertions. **It did not remove all of
them.** Two survive in `syncClient.test.js`:
- ~line 919: `expect(elapsed).toBeLessThan(10000)`
- ~line 1549: `expect(elapsedMs).toBeLessThan(1000)`

These assert nothing about correctness — only about how busy the machine was. Under load they
fail by construction and their failure is noise, not signal.

## Scope

**In:**

1. **Audit all `sleepBecauseTimeIsUnderTime` sites** in `electron/sync/` (13 across
   `syncClient.test.js` and `syncServer.test.js`). For each, determine: is time genuinely under
   test (the sleep is intentional and the test measures it), or is this an arrival-wait dressed in
   the wrong marker?
   - Arrival-waits → convert to `waitFor` (the `T25` helper, already imported).
   - Legitimate time-under-test sleeps → keep, but document with a comment naming the
     elapsed-time assertion they support.

2. **Delete the two wall-clock upper-bound assertions** (`toBeLessThan(10000)` at ~919,
   `toBeLessThan(1000)` at ~1549). They assert machine speed, not correctness. If a real
   latency bound matters, replace with a `waitFor`-style approach that retries until the
   condition holds rather than asserting it held in a fixed window.

3. **Tighten `noBareSleeps`** so the marker requires an accompanying elapsed-time assertion
   in the same test block to be legitimate. Pure presence of the marker is not sufficient — a
   marker with no `elapsed`/`toBeLessThan` nearby is an arrival-wait in disguise. The guard
   should enforce this mechanically, not by inspection.

**Out:**

- Extending the guard beyond `electron/sync/` (separate ticket per T44 escalation).
- The full ten-run proof for T44 — that closes separately once T70 lands.

## Definition of done

- No `sleepBecauseTimeIsUnderTest` site is an arrival-wait.
- No wall-clock upper-bound assertion (`toBeLessThan` on an elapsed time variable) survives
  unless it is paired with a `waitFor` retry structure.
- `noBareSleeps` guard rejects a `sleepBecauseTimeIsUnderTest` call that has no accompanying
  elapsed-time assertion in the same test block.
- `npm run test` and `npm run lint` pass.
- Full suite passes at least 3 consecutive times on unchanged code without the syncClient
  failures reproduced on 2026-08-08.

## Outcome (2026-08-08)

Two corrections to this ticket's own claims, found during the work:

- The `expect(elapsed).toBeLessThan(10000)` asserted to survive at ~line 919 **did not exist** —
  it had already been removed, and the comments at lines 1066/1151 record its removal. Only the
  `toBeLessThan(1000)` at ~1549 survived, and is now deleted.
- The proposed guard rule ("marker requires an elapsed-time assertion in the same test block")
  was **not implemented literally**, because it would reject the six legitimate sites — the
  throttle-crossing and proving-absence sleeps, which correctly have no elapsed assertion.
  Implemented instead: a closed-vocabulary `// time-under-test: <reason>` tag
  (`elapsed-assertion` | `crossing-interval` | `proving-absence`), with `elapsed-assertion`
  mechanically requiring an elapsed assertion in the enclosing `it()` block. The closed
  vocabulary means a new arrival-wait cannot land silently — it takes a consciously false tag.

The two failures "lost to log truncation" on 2026-08-08 **did not reproduce**: `syncClient.test.js`
ran 47/47 green four times under 12x CPU load. A full-suite run under heavy load produced only
indiscriminate 20-25s timeouts across `syncServer.test.js` — starvation noise from the load
harness, not signal. The 13-site audit stood in for that enumeration.

Verified: lint clean; full suite green on 3 consecutive runs (113 files, 1785 tests).

## Notes

- Test-only. No production code change unless investigation reveals a real sync race
  (T44's verdict is that the idempotency invariant is sound).
- `npm rebuild better-sqlite3` before each test run.
- Do not add a retry/rerun mechanism. Do not weaken correctness assertions.
- The two unidentified failures from the 2026-08-08 run (lost to log truncation) may surface
  additional sites — enumerate them before Maker starts.
