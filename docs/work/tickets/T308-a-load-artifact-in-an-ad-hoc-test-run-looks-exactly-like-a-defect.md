---
title: "A load artifact in an ad-hoc test run looks exactly like a defect"
document_type: ticket
status: open
created: 2026-09-29
task_class: test-infrastructure
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T304-a-staff-session-can-see-what-the-import-left-unnamed.md]
archive_when: "a test failing because this machine is oversubscribed is distinguishable from a failing test WITHOUT running the full gate — so that a session running one file gets the same INCONCLUSIVE judgement `npm run verify` already gives, rather than a plain red it then bisects; and the unbounded parallelism that produces the load in the first place is either bounded or deliberately documented as unbounded"
---

# T308 — A load artifact in an ad-hoc test run looks exactly like a defect

Filed from direct observation on 2026-09-29, not from a report: two sessions independently
concluded they had broken something, and both were wrong in the same way within the same hour.

## The finding, stated correctly

**It is not that these tests are slow.** That was the first framing and the evidence contradicts it.
Both files run in about five and a half seconds *in total* on a clean CI runner, and the individual
tests that failed locally are sub-2s there.

The finding is that **`npm run verify` already knows how to tell a load artifact from a defect, and
nothing else does** — so the same failure that the gate would correctly report as `⚠️ VERIFY
INCONCLUSIVE` reads as a plain red when a session runs one file directly, which is what a session
does dozens of times an hour.

## Evidence

### Measured by me, GitHub Actions run 36608706053 (PR #621's successor #622, clean Linux runner, 2026-09-29T18:00Z)

| | CI | reported locally |
|---|---|---|
| `scripts/mcp/tools.test.js` (whole file, 32 tests) | **5209ms** | — |
| ↳ `commits campers when allowWrite is set` | **882ms** | 20s timeout |
| `scripts/preferenceSheetCli.test.js` (whole file, 9 tests) | **5484ms** | — |
| ↳ `is idempotent on the same bytes …` | **2011ms** | 20–34s |

An 882ms test hitting a 20 000ms ceiling is a contention factor of **≥23×**.

### Measured by me on this machine, 2026-09-29 14:18:15

```
load average: 518.69 492.13 413.40     cores: 4
matching vitest/verify processes: 213
```

That is **~130× core count.** For comparison, `vite.config.js` sized `testTimeout: 20000` against a
*measured* ~8× contention (`electron/main.test.js`: 14.6s alone, 118s in-suite; slowest single test
1535ms; 1535ms × 8 ≈ 12s, "so 20s clears the worst observed case with headroom").

**The premise behind the 20s ceiling has been invalidated by how the machine is now used** — not by
any change to the tests. That is the whole ticket.

### Reported to me by other sessions (their observation, not mine, labelled as such)

Two sessions hit these timeouts and both began investigating their own changes: one started a
bisect, one ran a revert-to-HEAD probe. Both stopped when shown the CI numbers above. Neither
failure was a defect. One of them also reported a machine load reading of 85/103/80 on 4 cores
earlier in the day — consistent with mine in direction, and lower, taken at a quieter moment.

## Mechanism, confirmed in the source

1. **The gate is load-aware and does this well.** `scripts/verify.js` (T164/T178) downgrades a
   failure to `⚠️ VERIFY INCONCLUSIVE` (exit 2, never a pass) when the machine is oversubscribed —
   but only when **both** filters hold: the step is in `LOAD_SENSITIVE_STEPS` (`test`,
   `test:integration` only) and the failure was slow (`MIN_LOAD_TIMEOUT_MS`, 10s). That two-filter
   design is deliberate and correct; an earlier cut of it laundered two real defects and was
   tightened. **Nothing in this ticket should weaken it.**

2. **Only the full gate takes the lock.** `scripts/gateLock.js` is imported by exactly one caller,
   `scripts/verify.js`. `npm run test` is a bare `vitest run`, and an ad-hoc `npx vitest run <file>`
   takes no lock at all. So the lock serialises full gates while leaving ad-hoc runs unbounded —
   N sessions × M vitest workers, with nothing bounding the product.

3. **Therefore the two paths disagree about the same failure.** Run through the gate: INCONCLUSIVE,
   with an instruction to re-run quiet before concluding anything. Run directly: a red, with no
   signal that the machine is at 130× cores. The second is the path a session actually uses while
   iterating.

I contributed to the load myself today — I ran targeted `npx vitest run <file>` repeatedly while
working T304. This is not other sessions misbehaving; it is the normal working loop.

## What is NOT the fix

**Raising `testTimeout`.** `vite.config.js` says so in the comment above the value — *"If this ever
needs raising again, measure first and record the numbers, as here. Do not treat a rising timeout as
the fix — it is the symptom."* That is right, and at 130× cores no defensible ceiling exists anyway:
20s × 16 would be five minutes per test.

**Making these two tests faster.** They are not slow. 882ms and 2011ms on a clean runner. Optimising
them would move the threshold slightly and leave every other test with the same exposure.

## Success predicate

A session that runs a single test file on this machine can tell, **without running the full gate**,
whether a failure is a load artifact — getting the same judgement `verify` already makes, on the
same two filters, rather than a bare red it then spends twenty minutes bisecting.

Secondarily: total vitest parallelism across concurrent sessions is either bounded, or the decision
to leave it unbounded is written down with its reasoning, so the next person who measures load 518
finds an answer instead of a surprise.

## Notes for whoever takes this

- The `verdict()` logic in `scripts/verify.js` is already the right judgement in the right shape.
  The question is how a one-file run reaches it — a wrapper, a reporter, or a `vitest.setup.js`
  hook are all plausible; this ticket deliberately does not choose.
- Whatever ships must keep T178's two filters intact. A fast assertion failure and a deterministic
  step must stay plain reds. The failure mode to design against is not "a red that was really load"
  — it is **"a defect dressed as load"**, which is strictly worse, and is why the current filters
  exist.
- **The failure mode of the fix is the failure mode the fix is for**, and that is the sentence to
  keep in view while building it. The obvious implementation is "let an ad-hoc run reach the
  INCONCLUSIVE verdict too" — and the obvious way to get there is to widen that path. Widen it
  without carrying BOTH of T178's filters and every load-shaped red becomes a laundered defect,
  silently, on the exact command sessions run most. This ticket exists because a correct judgement
  could not reach the working loop; it must not be closed by making an incorrect judgement reach it.
  A fix that trades a red-that-was-load for a defect-dressed-as-load has made the codebase worse
  than leaving this ticket open.
  _(Framing contributed by the session that lost an afternoon to this, reviewing the merged ticket.)_
- Bounding parallelism and improving the signal are separable. The signal is the one that cost two
  sessions time today; the bound is what stops load 518 recurring. Either is shippable alone.
