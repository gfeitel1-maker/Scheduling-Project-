---
title: T44-suite-flakiness-recurred-under-load
document_type: ticket
status: open
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

## Completion evidence

1. The full suite passes on unchanged code across at least ten consecutive runs, including under
   deliberate load.
2. The `syncClient` idempotency failure is explained with evidence — either shown to be a test
   artifact and fixed as one, or identified as a real race in the retry path and fixed there.
3. T25 is either reopened or its closure is explained.
4. T39 is resolved or explicitly folded into this ticket.
5. No test-level retry/rerun mechanism was introduced to mask a failure.
