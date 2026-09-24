---
title: "Restore the grace-window import undo — as a tray action, not a banner"
document_type: ticket
status: completed
created: 2026-09-24
archive_when: postImportBanner.jsx is absent from the tree AND the post-commit tray offers "Undo this import" whenever outcome.invertibleOps is populated AND the T253 regression guards stay green
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/adr/2026-08-17-onescreen-reconciliation-undo.md]
related_adrs: [docs/adr/2026-08-17-onescreen-reconciliation-undo.md]
related_tickets: [docs/work/tickets/T240-collapse-duplicate-ingest-layer.md]
---

# T253 — Restore the grace-window import undo

## Why

T240 documented the owner ruling: restore the grace-window "Undo this import" *capability*, not the
banner it used to live in. The undo was never deliberately removed — `0bc51e4b` built it inside
`postImportBanner.jsx`, and `66354590` retired that banner's rendering (product rule: no banners),
taking the only consumer of `useGraceWindowUndo` with it as collateral. The hook, the capture
plumbing (`captureInverse` through `ingestCommit`/`commitPlan`), and `ingestUndo` were never
touched — fully built, fully tested, and paid for on every `mode !== 'replace'` import — but nothing
called `start()` since. See the Amendment (2026-09-24, T253) section of
`docs/adr/2026-08-17-onescreen-reconciliation-undo.md` for the full design.

## Fix

- **`ImportScreen.handleReconciliationCommitted`** (`src/screens/ImportScreen.jsx`) no longer
  navigates to Roots on a successful commit. It does the same real work in the same order
  (`applyStagedSplits` awaited first, then version/compound-cell notices), then transitions the
  ledger to `{ ...prev, phase: 'committed', outcome, notices }` instead of `setLedger(null)`.
  `ImportScreen` still renders `ReconciliationScreen` whenever `ledger` is truthy, so the screen
  stays mounted and its `useGraceWindowUndo` instance survives the commit. The split-failure path is
  unchanged — it still clears `ledger` and returns without navigating; the grace window is
  deliberately not offered there this cycle (scope cut, not an oversight).
- **`ReconciliationScreen`** (`src/screens/ReconciliationScreen.jsx`) now owns its own
  `useGraceWindowUndo()` instance and gains `phase`/`outcome`/`notices` props. `apply()` calls
  `graceWindow.start(outcome)` when `Array.isArray(outcome?.invertibleOps)` — the ONLY eligibility
  check, read once, per Invariant 3 (`commitPlan` throws on `captureInverse && mode === 'replace'`,
  so that array is only ever populated when the commit was undo-capable). When `phase === 'committed'`
  the screen short-circuits to a new `CommittedTray` component instead of the triage flow, reusing
  the same `styles.tray` DOM slot and the existing `understoodRow`/`S.linkButton` "Show details"
  idiom for the two-tier undo receipt.
- **`commitTrayState`** (`src/screens/reconciliationTray.js`) — a new function, a sibling to
  `applyTrayState`, not a branch inside it. Pure: given `{ notices, undoCapable, undoState }` it
  returns `{ hint, primary, secondary, receipt }` per the exact copy table in the ADR amendment
  (never "always available" — "for the next few minutes" or a live countdown, per Invariant 5c; the
  not-undoable/replace state never mentions undo at all).
- **`useGraceWindowUndo`** (`src/hooks/useGraceWindowUndo.js`) — two changes: (1) the `catch` block
  now routes `undoError` through `describeWriteFailure` instead of the raw `err?.message`, so a raw
  SQLite/IPC string can never reach the director from an undo failure (the hook's existing
  stay-LIVE-on-error retry behaviour is unchanged); (2) a live countdown — `secondsLeft` — for the
  last 60 seconds of the fixed 5-minute window, timer-driven (a `setTimeout` that starts a 1/sec
  `setInterval`, never a `Date.now()` poll in a render loop), cleared on unmount, `clear()`, and
  `undo()`.
- **Deleted** `src/components/reconciliation/postImportBanner.jsx` and its test. Removed the
  `postImportBanner.jsx` entry from `src/orphanReactComponents.test.js`'s `KNOWN_ORPHANS` — that
  test still passes with the entry gone.
- **`docs/current/PLATFORM_STATE.md`**: the two live references to `postImportBanner.jsx` marked
  historical (`_Prior:` notes) rather than silently rewritten, per this repo's doc-staleness
  convention; both paths added to `scripts/check-governance.js`'s `DELIBERATELY_ABSENT` allowlist.
- Deliberately **not** salvaged: the banner's celebration artwork (`rootSystemArt`,
  `styles.celebration*`) — that asset placement rule is scoped to first-impression surfaces, and the
  post-commit tray is not one.

## Regression guard (mandatory — item 4 of the brief)

The silent drop of `invertibleOps`/`createdEntityIds` at `ImportScreen.jsx`'s post-commit handoff is
the entire reason this capability went dark for weeks. Two layers, both red-green proven:

1. `src/screens/ImportScreen.test.jsx` — commits with a fixture outcome carrying populated
   `invertibleOps`/`createdEntityIds` and asserts "Undo this import" becomes reachable (an
   observable UI assertion, matching how the original failure actually manifested — the button
   silently never appearing, not a thrown error). A sibling test asserts the replace-mode shape
   (`invertibleOps` absent) does NOT show it.
2. `src/screens/reconciliationTray.test.js` — a `commitTrayState` unit test asserting `secondary` is
   non-null iff `undoCapable` is true and null when `invertibleOps` is absent/undefined.

## Tests

- `src/screens/reconciliationTray.test.js` — `commitTrayState`: eligibility gating, every copy-table
  state (available >60s / ≤60s countdown / in-flight / succeeded / failed-retryable / expired), and
  the three-bucket receipt summary/detail (all-three, deletions-only, nothing-removed).
- `src/hooks/useGraceWindowUndo.test.js` — `describeWriteFailure` routing on a failed undo (asserted
  against a raw `FOREIGN KEY constraint failed` message never reaching `undoError`); the countdown's
  timer-driven start-at-60s / per-second ticks / clearing on undo success / clearing on `clear()` /
  no post-unmount firing.
- `src/screens/ImportScreen.test.jsx` — the post-commit tray replaces auto-navigation (`Continue`
  now does the navigating); the two T253 regression guards above.
- `src/orphanReactComponents.test.js` — still green with `KNOWN_ORPHANS` empty.

## Out of scope (explicit, per the brief)

- The split-failure path does not get an undo offer this cycle.
- `src/screens/RootsHomeScreen.jsx` — untouched; another stream owns it.
- No persistence of the grace window across crash/close/reload — Invariant 5 is unchanged: the
  window is gone and the import stands.

## Round 2 — three HIGH defects confirmed by review, fixed

Round 1 was plan-aligned (Security 5/5, Code Reviewer confirmed ADR alignment) but reviewers found
three HIGH-severity bugs by reading the code, plus one LOW. All four fixed test-first.

1. **`receiptFor` told a false story when `D === 0` (HIGH)** — `src/screens/reconciliationTray.js`
   unconditionally read the `D === 0` branch as "everything had changed since import," but
   `ingestUndo` (`electron/ops/ingest.js`) can also reach `D === 0` with `kept` populated and
   `skipped` empty — rows deliberately retained because deleting them would orphan a live reference
   (`reason: 'still_referenced'`), nothing to do with a concurrent edit. `receiptFor` now composes
   the `D === 0` summary from `K`/`R` the same way the `D > 0` branch already did: `K>0,R=0` →
   "everything had changed since import" (unchanged, now correctly scoped); `R>0` → "kept ... still
   in use" (with the changed-since-import clause folded in when `K>0` too); `K=0,R=0` → "Nothing to
   undo." Test: `src/screens/reconciliationTray.test.js`, three new cases (`D=0/K=0/R>0`,
   `D=0/K=0/R=0`, `D=0/K>0/R>0`), red before the fix (old code returned the "changed since import"
   sentence for all three), green after.
2. **A second commit could steal the first commit's undo window (HIGH)** — `ReconciliationScreen`'s
   `apply()` called `onCommitted?.(outcome)` without awaiting it, then its `finally` immediately ran
   `setApplying(false)`, re-enabling the Apply button while `ImportScreen.handleReconciliationCommitted`
   was still awaiting the real `applyStagedSplits` IPC round-trip and had not yet flipped
   `ledger.phase` to `'committed'`. A director clicking Apply again in that window issued a second
   `ingestCommit`, whose `graceWindow.start(outcome)` silently overwrote the first window's state
   (Invariant 5b, by design for a genuinely new import — but this was the SAME import). Fixed with
   two changes in `apply()`: `await onCommitted?.(outcome)` (so `applying` cannot go false before the
   phase transition completes), and a synchronous `applyPendingRef` guard set *before* the first
   await, the same idiom `useGraceWindowUndo.undo()` already uses for the identical reason (state
   lags a render; a ref does not). Test: `src/screens/ReconciliationScreen.test.jsx`, "double-submit
   guard on apply() (HIGH 2)" — two synchronous `apply()` invocations (dispatched inside one `act()`,
   before React flushes `applying`) issue exactly one `ingestCommit`; a second test asserts the
   button still reads "Applying…" after `ingestCommit` resolves but before a slow `onCommitted`
   resolves. Both red before the fix (2 calls / button re-enabled early), green after.
3. **A failed undo permanently killed the countdown (HIGH)** — `useGraceWindowUndo.undo()` called
   `clearCountdown()` unconditionally before the try, correct on success (status goes terminal) but
   never rescheduled on failure — the hook deliberately keeps `status` at `LIVE` on a failed undo so
   the director can retry, but nothing restarted the countdown, so a transient IPC error inside the
   last 90 seconds could silently erase the only warning the design gives before the window expires
   (Invariant 5c). Fixed by extracting the interval-scheduling logic from `start()` into a shared
   `scheduleCountdown(remainingMs)`, and a new `expiresAtRef` tracking the window's absolute expiry;
   on a failed undo, `scheduleCountdown(expiresAtRef.current - Date.now())` reschedules against
   whatever time is actually left — starting the interval immediately if already inside the last 60s,
   or a `setTimeout` for the remainder otherwise. `expiresAtRef` is cleared on `clear()` and on a
   successful undo. Tests: `src/hooks/useGraceWindowUndo.test.js`, three new cases — a failed undo at
   90s remaining resumes the countdown at the 60s boundary; a failed undo at 30s remaining (already
   inside the countdown window) resumes immediately at 30 and keeps ticking; a failed-undo-then-
   unmount settles without a leaked timer firing. All three red before the fix (`secondsLeft` stayed
   `null`, or stopped ticking), green after.
4. **Debounced dry-run inert only by accident once the screen stays mounted through commit (LOW)** —
   `startDryRunDebounce`/`useLatestTimeout` had no guard against firing once `phase === 'committed'`;
   it was safe only because `CommittedTray`'s early return happens to precede the JSX reading
   `report`/`error`. Made structural: a `phaseRef` (always current, unlike the debounced callback's
   own stale `phase` closure) short-circuits `runDryRun` when `phaseRef.current === 'committed'`, and
   a `useEffect` on `phase` calls `cancelDryRunDebounce()` at the commit transition so a pending
   250ms-debounced dry-run scheduled just before commit never fires at all. Test:
   `src/screens/ReconciliationScreen.test.jsx`, "debounced dry-run is cancelled at the commit
   transition (LOW 4)" — stages a decision (scheduling the debounce), rerenders with
   `phase="committed"` before the 250ms elapses, waits past the window, asserts `ingestReconcile` was
   never called a second time. Red before the fix (2 calls), green after.

No existing test was weakened or deleted to make any of the above pass.

Focused gate: `npx vitest run --no-file-parallelism src/screens/reconciliationTray.test.js
src/hooks/useGraceWindowUndo.test.js src/screens/ReconciliationScreen.test.jsx
src/screens/ImportScreen.test.jsx` — 113 passed, 0 failed.

## Round 3 (two findings, both from driving the real app at :5200)

A. **The imported count and the undo receipt count contradicted each other (HIGH)** —
   `commitTrayState`'s `importedHint` reports `outcome.total` (records in the import plan) while
   `receiptFor`'s summary reports `deleted.length` (rows undo actually removed, including derived
   rows the import created — locations, time blocks, groups). Both numbers are correct, but on a
   real import they read as "Imported 28 records." followed later by "Removed 42 records." — an
   apparent contradiction (undo looks like it destroyed 14 more things than were imported) with no
   way for a director to tell it's a unit mismatch rather than a bug. Same class of defect as the
   progress-counter fix in `ReconciliationScreen.jsx` ("Naming the unit costs a word and removes
   it.") — neither number changed; the fix names what each counts: `importedHint` now reads
   "Imported N records **from the file**." and the receipt summary reads "Removed N records **the
   import created**." Changed: `src/screens/reconciliationTray.js` (`importedHint`, both `D > 0`
   branches of `receiptFor`'s summary). Tests: `src/screens/reconciliationTray.test.js` — updated
   the 6 existing assertions pinning the old bare-noun copy, and added
   `'names the unit so the imported count and the removed count cannot read as a contradiction'`,
   which builds a 28-imported / 42-removed scenario and pins both phrases. All 7 red before the fix
   (old bare "records." copy), green after.

B. **The undo receipt rendered outside the tray card (HIGH)** — `CommittedTray` rendered
   `tray.receipt` as a sibling positioned above `styles.tray` instead of inside it, so in the running
   app "Removed N records." floated detached above the white tray card while "Undo complete." and
   the buttons sat inside it (see `docs/work/evidence/t253-03-undo-receipt.png`, captured against
   this branch's HEAD before the fix). Spec order is hint, then receipt, then the button row, all
   inside one tray card. Fixed by moving the receipt block inside `styles.tray`, nested with the hint
   in a shared wrapper div so the tray's existing 2-slot flex row (info on the left, buttons on the
   right) is preserved — only the receipt moved; the `collapseStyle`/`prefersReducedMotion` handling
   and the `understoodRow`/`S.linkButton` "Show details" idiom are untouched. Test: new file
   `src/screens/ReconciliationScreen.committedTray.test.jsx` — mocks `useGraceWindowUndo` to a fixed
   `'used'` status with one deleted row, renders `<ReconciliationScreen phase="committed" .../>`
   directly, and asserts the tray container (queried by its `surface-elevated` background) contains
   both the receipt text and the Continue button. Red before the fix (receipt was a sibling, not a
   descendant, of the tray div), green after.

No existing test was weakened or deleted to make either of the above pass.

Focused gate: `npx vitest run --no-file-parallelism src/screens/reconciliationTray.test.js
src/screens/ReconciliationScreen.committedTray.test.jsx src/screens/ReconciliationScreen.test.jsx` —
54 passed, 0 failed.
