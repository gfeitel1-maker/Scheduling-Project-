---
title: "The restored grace-window import undo actually reverses an import"
document_type: evidence
status: active
date: 2026-09-24
task_class: ingestion
related_tickets: [docs/work/tickets/T253-restore-grace-window-import-undo.md]
related_specs: [docs/adr/2026-08-17-onescreen-reconciliation-undo.md]
archive_when: the undo has been exercised against Electron (not the :5200 mock) so the seq-gated field-update half is covered by observed evidence rather than unit tests alone
---

# T253 evidence — the grace-window import undo actually reverses an import

Branch: `claude/t253-restore-grace-window-import-undo`
Base: `09fe3a2f`

## What was verified, and how

The owner's requirement was not "a button renders" but "the undo actually undoes". This
record exists because the first evaluation pass of this ticket produced a *fabricated*
report — it claimed screenshots that were never written and quoted UI copy
(`"Removed 2 records — they were exactly as imported, so nothing had changed since."`)
that `grep` finds nowhere in the tree. Everything below was therefore driven and
observed directly, and the capture is scripted so it can be re-run rather than trusted.

Environment: `npm run dev` at `http://localhost:5200` (browser renderer against
`src/localClient.mock.js`; no Electron). Port ownership was confirmed before trusting
anything on it — `curl http://localhost:5200/src/screens/reconciliationTray.js` was
grepped for `commitTrayState` and for the round-2 string `Nothing to undo.`, because
`strictPort` makes a dev server from another worktree squat 5200 silently.

Capture script (re-runnable, no new dependencies — Chrome headless over CDP using
Node's global `WebSocket`): it reseeds the mock to a known state, drives the real
import UI, commits, screenshots, clicks the real Undo button, and screenshots again,
reading `localStorage['shoresh-mock-state']` at each beat.

## The reversal, measured

Fixture: `docs/work/specs/samples/campC-daysheet-synthetic.txt` — a fabricated
structural clone ("Placeholder Camp 2099"), deliberately chosen over the campA/campB
samples so no real camp data is involved.

| Beat | activities | groups | time_blocks | locations |
|---|---|---|---|---|
| before import | 5 | 3 | 4 | 0 |
| after import | 13 | 6 | 12 | 7 |
| after clicking **Undo this import** | 5 | 3 | 4 | 0 |

The eight activities the import created — `Closing Circle`, `Pick Up`, `Sign In`,
`Sailing`, `Pottery`, `Theme Day`, `Nature Walk`, `Drama Club` — were observably
present after the import and observably absent after the undo
(`importedRowsStillPresent: []`).

This is stated as a named-row check on purpose. An earlier attempt of mine compared
two empty lists and reported `reversedExactly: true`, which was vacuous — absence read
as success. The table above is non-vacuous: the rows were seen to exist before they
were seen to disappear.

## Screenshots

- `docs/work/evidence/t253-01-reconciliation-triage.png` — the triage screen before commit.
- `docs/work/evidence/t253-02-committed-tray-undo-offered.png` — the committed tray:
  *"Imported 28 records from the file."* / **Undo this import** / *"for the next few
  minutes"* / **Continue**. The director is NOT auto-navigated to Roots, which is the
  core behavioural change.
- `docs/work/evidence/t253-03-undo-receipt.png` — after the undo: *"Undo complete."* /
  *"Removed 42 records the import created."*, with the Undo button **removed** (not
  disabled — the action is genuinely one-shot).

Each PNG was opened and read, not merely checked for a plausible byte count.

## What is NOT proven here

- **The field-update (U1 updates) half.** The browser run exercised creations; an
  attempt to drive a field update through the mock produced `invertibleOps: 0` and
  therefore proved nothing. That path is covered deterministically by
  `electron/ops/ingestUndo.test.js`, which the gate runs. `src/localClient.mock.js`
  states in its own comment that it cannot model the real seq-gated "touched since"
  behaviour — the mock applies every captured inverse unconditionally, so :5200 will
  always look *more* successful than Electron. Nobody should read this record as
  evidence about the seq gate.
- **Anything under Electron.** This is the mock layer. Persistence, sync and the real
  referential/staleness checks are Electron-only by construction.

## Two findings this capture produced

Both were found by looking at the screenshots, and both are fixed on this branch:

1. **The counts contradicted each other.** The tray said "Imported 28 records" and the
   receipt said "Removed 42 records". Both numbers are correct and measure different
   things (plan records vs. rows actually created, including derived locations/groups/
   time blocks), but side by side they read as "the undo destroyed 14 more things than
   I imported" — the worst possible impression in a trust feature. Fixed by naming the
   unit, following the precedent already on this screen for the questions/entities
   counter.
2. **The receipt escaped the tray**, rendering detached above the card. Moved inside.

## One finding left open

After an undo, the sidebar still shows readiness ticks for **Locations**, **Fixed
Events** and **Recurring Events** although the undo removed all 7 locations (visible in
`t253-03-undo-receipt.png`). This is newly *exposed* by T253: previously a commit
navigated straight to Roots, remounting the shell and refreshing those ticks, whereas
the director now stays on a live screen. Not fixed here — the refresh seam is outside
this ticket's blast radius and likely affects other in-place mutations too.
