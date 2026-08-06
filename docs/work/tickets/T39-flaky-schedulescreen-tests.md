---
title: T39-flaky-schedulescreen-tests
document_type: ticket
status: closed
created: 2026-08-03
closed: 2026-08-06
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

---

## Closure note (2026-08-06)

Fixed on `work/t39-flaky-tests`. **The ticket's diagnosis turned out to be stale** — worth recording,
because the fix is not the one predicted above. Both named seams were re-examined against current
`main` (`646d951`):

- Seam 1 (`copySwimPasteOntoSoccer`, ~`:570`) is *already* wrapped in `await waitFor(...)` — twice,
  deliberately, to force a macrotask boundary for the secondary week-scoped `loadAll()`. It was not
  a missing-await bug.
- Seam 2 (the `pointerEnter` → `getByTitle(/run into the next period/i)` hover-reveal, ~`:1263`) no
  longer exists; that interaction was refactored away since the ticket was written.

The real remaining cause is a **timeout budget**, not a missing await. `loadAll()` chains roughly a
dozen sequential `localClient.list()`/`listByScope()` calls before the grid replaces `Loading…`.
That fits inside React Testing Library's 1000ms default `asyncUtilTimeout` on an idle machine and
does not when the machine is loaded — which is exactly why the failure rotated between tests and
why the observed baseline failure was a `waitFor` *timing out* at `:587`, not a query throwing on a
missing element. The fix is a file-scoped `configure({ asyncUtilTimeout: 3000 })` in
`src/screens/ScheduleScreen.test.jsx`. This is not a `sleep`-style fixed delay: `waitFor` still
polls and returns the instant its condition holds, so the happy path is not slowed at all — only the
ceiling before it gives up moves. It is scoped to this one file rather than set as a Vitest global,
because this screen's initial load is genuinely heavier than other screens' and the wider suite
should keep the stricter default.

**Evidence:** `npx vitest run src/screens/ScheduleScreen.test.jsx` run five consecutive times by the
Governor with no change between runs — 54/54 passed on all five. A pre-fix baseline failure of this
same seam was observed on `main` during the full-suite run that preceded the work, confirming the
flake was real and pre-existing rather than introduced.

**Not addressed here (pre-existing, out of scope, tracked separately):** `test/governance.test.js`
fails on clean `main` because `.claude/agents/architecture-auditor.md` is absent from the
CONSTITUTION roster, and `npm run lint` reports 2 `no-unused-vars` errors in
`src/components/layout/Sidebar.jsx` / `Sidebar.test.jsx`.
