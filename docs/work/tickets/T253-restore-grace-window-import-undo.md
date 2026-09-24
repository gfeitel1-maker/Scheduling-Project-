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
