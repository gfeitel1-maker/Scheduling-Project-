---
title: T44-suite-flakiness-recurred-under-load
document_type: ticket
status: completed
created: 2026-08-04
governing_docs: [docs/governance/standards/TESTING_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_tickets: [docs/work/tickets/T25-the-test-suite-fails-under-load.md, docs/work/tickets/T39-flaky-schedulescreen-tests.md]
archive_when: resolved — the full suite passes repeatedly on unchanged code
---

# T44 — Load-dependent suite flakiness has recurred, and now reaches `syncClient.test.js`

**Risk:** High. It degrades the one gate the constitution treats as deterministic evidence
(Art. II — a reviewer score is never proof when a required gate fails; that rule assumes the gate
itself is trustworthy).
**Found:** Phases A–D, 2026-08-04, across repeated full-suite runs on unchanged code.

**This ticket does not duplicate T25 or T39 — read both first.** T25 (*the test suite fails under
load*, closed 2026-07-31) recorded exactly this failure class and was marked completed. T39
(*`ScheduleScreen.test.jsx` is flaky*, still open) covers one file. This ticket exists because the
problem is demonstrably **not** resolved, and is **not** confined to `ScheduleScreen`.

## Evidence gathered across four phases

Every observation below is on code that could not have caused it — the branches in question added
only test files or renderer-side refactors, and each failing file passed in isolation immediately
afterward.

- **Phase A** (`work/r1-projections-guard`): a full run reported `2 failed | 1347 passed`, both
  failures in `src/screens/ScheduleScreen.test.jsx` (a `getByPlaceholderText` query failing after a
  menu click). The same file then passed 54/54 twice in isolation on the same branch.
- **Phase A, second run:** the ScheduleScreen failures did not reproduce. Instead
  `electron/sync/syncClient.test.js` failed once — *"retrying a queued write after a timeout does
  not create a duplicate op (idempotent via client_write_id)"*, expecting 0 queued ops and finding 1.
  It passed on re-run and passed on `main`.
- **Phases B, C, D:** clean full runs, no failures.

The signature — a different test failing each time, always passing in isolation and on re-run, never
reproducing on demand — is characteristic of timing/resource contention under parallel load, not of
a defect in any one assertion.

## Why it matters

The `syncClient` case is the concerning one. `ScheduleScreen` flakiness (T39) is a rendering/async
-query problem in test code. But the flaky `syncClient` assertion is about **op-log idempotency
under retry** — the property that stops a retried write becoming a duplicate operation. If that test
is merely timing-sensitive, it is noise. If it is intermittently exposing a real race in retry
handling, it is a data-integrity bug in the sync path and the flakiness is the symptom, not the
problem. **Nobody has established which.** That question alone justifies this ticket.

Meanwhile, every phase of this program has had to caveat its own evidence with "the suite is
intermittently flaky," which is precisely the erosion T25 was opened to stop.

## Scope

**In:** reproduce deliberately (run the full suite repeatedly under artificial CPU/IO load on
unchanged code, capture every failure). Root-cause the `syncClient` idempotency case specifically
and determine whether it is a test-timing artifact or a real retry race — this is the priority.
Determine why T25 was closed while the condition persisted. Fix the underlying cause; where the
cause is genuinely test-local timing, fix the tests rather than adding retries.

**Out:** adding a blanket test-retry mechanism as the primary fix. That hides the very signal this
ticket needs, and would make the `syncClient` question permanently unanswerable.

## Findings (2026-08-04) — the central question is answered

**Verdict: test-timing artifact. The op-log idempotency invariant is NOT implicated. No production
code needed to change.** This was the thing worth knowing, and it is now settled by construction
rather than by sampling.

**The assertion was misread — by its own name.** The failing line
(`getQueuedOps()` length 0 after the retry flush) encodes **liveness**, not idempotency: it asserts
the retry drained inside the client's `submitTimeoutMs`, which the test set to **150ms** while the
retry performs a real WebSocket round trip against a live server. The actual idempotency invariant
is asserted on the next two lines (one row, matching `client_write_id`) and **never failed**.

**Proof it is benign.** Injecting a reply delayed past the budget reproduces the reported error
verbatim. In that same injected failure the op log holds `opRows=1, distinctCwid=1` — the write is
**not duplicated**; it is correctly left queued for another idempotent retry, which is exactly what
`flushQueue` is supposed to do on a slow reply. So the only observable consequence of crossing the
budget is a spurious extra retry, which `client_write_id` absorbs by design.

**Measurements.** Over six loaded full-suite runs the retry round trip took **3-5ms every time**
against a 150ms budget — only ~30x margin, on a file demonstrably capable of blowing past 150ms
under starvation. Natural reproduction of the originally-reported failure: **0/16**.

**A second, naturally-reproduced flake in the same file** (1-in-6): the reconnect-catch-up test used
a bare `setTimeout(150)` standing in for "wait until the replayed ops landed" — T25's exact root
cause, still present in the very file T25 converted.

**Both fixed, test-only** (`syncClient.test.js`): budget raised to 3000ms with the measurement
recorded in a comment, and the bare sleep converted to `waitFor`. No sleeps added, no retry
mechanism, no assertion weakened. Verified 30/30 clean under four competing CPU hogs, then
re-verified on current `main`: 6/6 clean under ambient load (loadavg ~50), full suite
**94 files / 1431 passed**, lint 0 errors, build clean.

### Why T25's closure was premature (answering completion item 3)

T25's diagnosis was right and its `waitFor` helper is the correct tool. Its **closure** was not sound:

- Its completion evidence was **6/6 green runs** — a sampling result, which cannot distinguish "the
  sleeps are gone" from "the sleeps didn't fire this time." T25 itself measured a ~50% baseline
  failure rate, so six clean runs is weak evidence.
- The conversion was done **by inspection** of arrival-then-assert sites, not structurally, and it
  missed several.
- T25 never audited the other half of its own finding: **short production timeouts passed as test
  options** (`submitTimeoutMs`, `lockTimeoutMs`) racing real I/O. It removed the `elapsed`
  assertions but left the budgets. That is precisely what recurred here.

## Remaining work (this ticket stays open)

1. **Six bare `setTimeout` sleeps remain in `syncClient.test.js`** (around lines 1372, 1681, 1687,
   1714, 1717, 1754 after the fix). Their own comments name them — *"Give server a tick to process
   the pairing_request"*, *"Wait for the message to be processed"*. They are latent flakes of the
   same class and are not even marked with T25's `sleepBecauseTimeIsUnderTest` convention.
2. **Enumerate them mechanically, not by inspection** — a lint rule banning bare `setTimeout` sleeps
   in tests (with an explicit opt-out marker for the legitimate time-under-test cases). Another
   inspection pass would repeat T25's mistake for the third time.
3. **Audit the remaining short production timeouts passed as test options** across the sync tests,
   which T25 never covered.
4. The ten-consecutive-full-suite-run proof below is not yet met — six file-level runs plus one full
   suite were done.

`ScheduleScreen.test.jsx` (T39) did **not** reproduce under these load conditions: 0 failures across
six loaded full-suite runs. Not investigated further — T39's scope.

## Completion evidence

1. The full suite passes on unchanged code across at least ten consecutive runs, including under
   deliberate load.
2. The `syncClient` idempotency failure is explained with evidence — either shown to be a test
   artifact and fixed as one, or identified as a real race in the retry path and fixed there.
3. T25 is either reopened or its closure is explained.
4. T39 is resolved or explicitly folded into this ticket.
5. No test-level retry/rerun mechanism was introduced to mask a failure.
