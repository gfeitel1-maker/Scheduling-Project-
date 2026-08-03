---
title: T39-flaky-schedulescreen-tests
document_type: ticket
status: open
created: 2026-08-03
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: []
archive_when: resolved — suite passes reliably across repeated runs
---

# T39 — `ScheduleScreen.test.jsx` is flaky (async/timing)

**Risk:** Medium for CI trust — green is not reliably green, which erodes the deterministic-evidence
gate the workflow depends on.
**Found:** 2026-08-03, merging the generated-schedule blank-cell fix onto `main`.
**Status:** CONFIRMED by observation — pre-existing on `main`, independent of the blank-cell fix.

---

## The defect

`src/screens/ScheduleScreen.test.jsx` passes or fails **non-deterministically**. Across repeated
runs of the same commit (no code change), the failure count moved between 0 and 1, and the *failing
test rotated*, which is the signature of async/timing flake rather than a real assertion failure.

Observed failing tests (each intermittent, each in a **different** run):

1. **`placeActivityManual eligibility (T6 …) > an activity with no eligibility restrictions … is
   placed with no UNFILLABLE flag`** — failed querying for text `Soccer` while the component was
   still showing `Loading…` (`scheduleCell` at `:28`, via `copySwimPasteOntoSoccer` at `:570`). The
   test asserted before the async load resolved.

2. **`T4: merging a cell down > sends the displaced activity to the tray instead of dropping it`** —
   `fireEvent.click(within(headCell).getByTitle(/run into the next period/i))` at `:1264` failed
   because the hover-revealed resize handle title was not present yet (`pointerEnter` at `:1263`
   hadn't produced the element by the time `getByTitle` ran).

The blank-cell fix's own new test (EditModal preselection) did **not** flake in any run.

## Why it matters

A flaky suite means a passing run is not proof. The engineering workflow treats test output as the
deterministic evidence gate; intermittent failures force re-runs and let real regressions hide
behind "probably just the flake."

## Likely cause (to verify)

Synchronous queries (`getByText` / `getByTitle`) run before an async state settle:
- `getElementError` shows `Loading…` still mounted → the initial `loadAll()` hadn't resolved.
- The hover-driven resize handle is revealed on `pointerEnter`; the query fires in the same tick.

## Observable completion evidence

1. `ScheduleScreen.test.jsx` passes on **N consecutive runs** (e.g. 10/10) with no code change.
2. Fixes use `findBy*` / `await waitFor(...)` at the two seams above (post-load queries and the
   hover-reveal) rather than synchronous `getBy*`.
3. No `sleep`-style fixed delays introduced.

## Files expected to change

- `src/screens/ScheduleScreen.test.jsx` — the `scheduleCell` helper usage around `:28`/`:570`, and
  the merge/displaced interaction around `:1263-1266`. **Test-only; no product code.**
