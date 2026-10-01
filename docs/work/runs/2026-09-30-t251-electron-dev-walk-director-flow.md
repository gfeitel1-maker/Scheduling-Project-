---
task: "T251/T199 — a director's-eye walk of the elective director flow in the real electron:dev app"
document_type: run
date: 2026-09-30
round: 1
status: escalated
task_class: test-infrastructure
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T251-t199-acceptance-fixture.md, docs/work/tickets/T199-individual-electives-end-to-end.md]
related_specs: [docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md]
related_adrs: []
related_runs: [docs/work/runs/2026-09-30-t251-t199-acceptance-fixture.md]
selected_agents: [maker, verifier]
omitted_agents:
  - agent: governor
    reason: not-applicable
    note: This was not a Governor-planned quality loop — the board worker drove the walk directly by hand against the real app, under the owner's own screen grant, and reported straight to the board. There was no brief to synthesize feedback against.
  - agent: architect
    reason: no-predicate
    note: No structural or schema design question was in scope. The two code changes (the fixture's dev-db stub and half-built-db cleanup) are additive fixes to a test-only script, not an architecture decision.
  - agent: designer
    reason: not-applicable
    note: No visual design changed. The walk observed existing T250 screens and found functional gaps (missing controls, a false stale-row warning, a silent merge), not visual-design defects.
  - agent: code-reviewer
    reason: human-waived
    note: "Owner's standing rule (2026-09-29, see memory feedback_build_board_is_the_queue): work the board sequentially, one item per session, no self-originated review fan-out. This session's scope was the walk and the record, not a review loop on the two-file fixture-script fix."
  - agent: tester
    reason: not-applicable
    note: The board worker performed the director's-eye walk itself in this session rather than dispatching Tester as a separate agent — there was no second session to delegate to.
  - agent: security
    reason: not-applicable
    note: No auth, secrets, IPC surface, or packaging change. The fixture-script fix touches only a dev-only stub and a cleanup helper for a script that never ships.
  - agent: red-hat
    reason: not-applicable
    note: No stored-data-shape, op-log, sync/replay, or migration change.
  - agent: grader
    reason: no-predicate
    note: No Verifier/Tester/Security/Red Hat/Code Reviewer report set exists to consolidate — this is a doc-only record of a manual walk, not a routed code-review task.
deterministic_checks: ["npx vitest run scripts/fixtures/electronStubLoader.test.mjs scripts/fixtures/electiveAcceptanceCamp.cleanup.test.mjs", "npx eslint scripts/fixtures", "npm run index:work", "npm run check:governance"]
human_gates: [owner's call on whether T251 and T199 flip status despite the four director-facing defects this walk found]
verdict: escalate
completion_evidence:
  - "evidence: docs/work/evidence/T251/ — 17 new 2026-09-30 CDP-captured frames (200-410 KB, 2800x1694), verified by size+md5 before this record was written; see the evidence table below"
  - "docs/work/tickets/T251-t199-acceptance-fixture.md and docs/work/tickets/T199-individual-electives-end-to-end.md — appended Walk 2026-09-30 sections"
  - "scripts/fixtures/electronStub.mjs, scripts/fixtures/electiveAcceptanceCamp.mjs — fixture-script fix made during the walk, see below"
  - "gate: see Verification section below for the quoted command output"
archive_when: the owner rules on the four director-flow defects below and T251/T199's status is updated to match
---

# T251/T199 — the electron:dev walk, 2026-09-30

## What this is

A director's-eye walk of the elective scheduling flow (import -> map -> solve -> commit -> lock ->
finalize -> Final view -> export -> start a new version) driven by hand against the real
`electron:dev` app, using the T251 acceptance camp, with the owner's own screen access granted to
the board worker for 19:10-20:16 on 2026-09-30. Vite ran on port 5210 because 5200 was already held
by another session. Electron was later relaunched with `--remote-debugging-port=9222` so the
renderer could be captured through the Chrome DevTools Protocol. The dev database was the T251
acceptance camp, rebuilt by `scripts/fixtures/electiveAcceptanceCamp.mjs` after fixing a gap in its
Electron stub (see "Fixture-script fix" below).

## The first capture attempt failed, and was caught before anything was written

The walk was first captured with the shell's `screencapture` command. All 24 resulting frames were
identical copies of the desktop wallpaper, not the app: the shell this session runs in has no
screen-recording permission on this machine, so `screencapture` silently captured whatever a
permission-less capture falls back to rather than erroring. A previous Maker on this branch
correctly refused to write any record on top of that evidence. It was deleted, and the walk was
re-run and re-captured through `Page.captureScreenshot` against the Electron renderer (reachable
once Electron was relaunched with `--remote-debugging-port=9222`), which writes real renderer
pixels rather than a desktop compositor frame. The verification below is what distinguishes this
pass from the first: real captures vary in size and content; the wallpaper captures would not have.

## Verification performed before this record was written

```
$ cd docs/work/evidence/T251 && for f in *.png; do echo "$(stat -f %z "$f") $(md5 -q "$f" | cut -c1-8) $f"; done
```
Sizes ranged 125265-405621 bytes overall; every 2026-09-30 frame fell in 200596-405621 bytes
(roughly 200-410 KB), consistent with a real, varied renderer capture rather than a repeated static
image.

```
$ md5 -q *.png | sort | uniq -c | sort -rn | head -3
   2 ddfa16e709c0d51a2e05b79f0bfd3842
   1 faf71a11aba3d96d8b6131a41367a3cb
   1 f2b80c88a500fbc85c7056ca43cb326b
```
Exactly one duplicate pair exists — `06b-D8-entry2-return-from-run-list.png` and
`08-reduced-motion-UNVERIFIED-byte-identical-to-06b.png`, both from the 2026-09-29 pre-fix walk and
already named to say so (the reduced-motion frame is a known byte-identical duplicate because
DevTools reduced-motion emulation could not be driven in that pass either). Every other hash across
29 files appears exactly once.

Three frames were opened directly with the Read tool and checked by eye against their filename's
claim and the DEV badge in the sidebar footer:
- `01-after-login.png` — Roots screen, "Acceptance Camp", DEV badge visible. Matches.
- `09-final-run-view-identity-false-stale-row-start-new-version-export.png` — Elective Schedules,
  "Final · Week 1 · finalized 2026-09-30 · by f0c9f725-…", the stale-row warning, "Start a new
  version", Export and Export Full Report. Matches.
- `12b-same-name-sheet-solved-2-of-3-no-refusal.png` — Elective Schedules, "2 campers placed · 6
  occurrences · 14 findings". Matches.

All three checks passed, which is why this record was written rather than refused.

## Evidence table

Every PNG under `docs/work/evidence/T251/`, its size, whether it is from the 2026-09-29 pre-fix
walk ("old") or newly captured 2026-09-30 ("new"), and what it shows. The walk narrative handed to
this session described 16 new frames; the actual count on disk, confirmed by the listing above, is
17 — that discrepancy is noted here rather than silently repeated, since the directory listing is
the measurement and the narrative is secondhand.

| File | Size | Age | What it shows |
|---|---|---|---|
| `01-after-login.png` | 202 KB | new | Roots screen after signing in as Director; DEV badge. |
| `01-blocked-import-NOT-refused-route-chooser.png` | 122 KB | old | 2026-09-29 pre-fix: blocked import reaches the route chooser instead of being refused. |
| `02-draft-preview-solved.png` | 195 KB | old | 2026-09-29 pre-fix: draft preview after solving. |
| `02-draft-run-view-52campers-phantom-locks.png` | 226 KB | old | 2026-09-29 pre-fix: draft run view, 52 campers, phantom locks. |
| `02-draft-run-view-cold-open-finalize-and-delete-controls.png` | 269 KB | new | The 18:57 unsolved import opened cold: "No campers placed yet.", "Finalize run", empty table, "Delete run". |
| `02-elective-runlist-cold-open.png` | 267 KB | new | Saved runs list cold: 18:57 DRAFT, 19:21 and 19:28 FINAL; disclosure still visible (also serves as the D8 entry-2 evidence — the walk returned here via Start a new version). |
| `02a-draft-phantom-stale-lock-wall.png` | 144 KB | old | 2026-09-29 pre-fix: a wall of phantom stale-lock messages. |
| `02a-generated-draft-cold-open-counts-finalize-control-table.png` | 376 KB | new | The 19:21 Generated-route run opened cold: placement counts and choice-rank summary, "Finalize run", placement table with day/time dropdowns and a LOCKED column. No `BUNDLE_TIER_NOT_COVERED` wall on cold open (that wall is session-scoped, riding a commit result). |
| `02b-draft-placement-table-day-labels-lock-column-camper-list.png` | 330 KB | new | The 2-sheet same-name draft opened cold: placement counts, day-labeled dropdowns, LOCKED column, camper list showing one merged "Ari Feldman" entry. |
| `02b-draft-placement-table-duplicated-no-day.png` | 199 KB | old | 2026-09-29 pre-fix: placement table rows duplicated, no day shown. |
| `02c-draft-camper-list-duplicate-names-no-division.png` | 145 KB | old | 2026-09-29 pre-fix: duplicate camper names shown with no division to disambiguate. |
| `02e-committing-spinner-while-write-already-landed.png` | 264 KB | new | "Committing…" shown while SQLite already held the new run row and the main process was idle (7% CPU) — a renderer/IPC-reply defect distinct from the freeze. |
| `03-chugim-set-detail-D8-disclosure-entry1.png` | 260 KB | new | Chugim set detail; the D8 at-rest-encryption disclosure visible on cold entry. |
| `03-chugim-set-detail.png` | 128 KB | old | 2026-09-29 pre-fix: chugim set detail, no disclosure captured. |
| `03-locked-seat-and-camper-week-panel-with-change-control.png` | 355 KB | new | A locked seat (checkbox) and the merged camper's week panel, which lists one period twice (the merge's doubled rows) with a "Change" control per row. |
| `03-locked-seat-no-regenerate-control.png` | 178 KB | old | 2026-09-29 pre-fix: a locked seat with no reachable regenerate control. |
| `04-delete-run-dialog-d10-copy.png` | 353 KB | new | The Delete dialog: "26 campers and 47 placements will be removed." plus the D10 honest-cost copy. Cancelled. |
| `05-finalize-refusal-inline-no-assignments.png` | 286 KB | new | Finalize on the empty draft: inline "Finalizing failed: run has no assignments." refusal copy. |
| `06a-D8-entry1-cold-open-panel.png` | 128 KB | old | 2026-09-29: D8 disclosure on cold panel entry (first entry point). |
| `06b-D8-entry2-return-from-run-list.png` | 144 KB | old | 2026-09-29: D8 disclosure on a second entry (return from run list). Byte-identical to `08` below. |
| `07-route-chooser-manual-vs-generated.png` | 124 KB | old | 2026-09-29: the route chooser, Manual vs Generated. |
| `08-reduced-motion-UNVERIFIED-byte-identical-to-06b.png` | 144 KB | old | 2026-09-29: attempted reduced-motion capture, byte-identical to `06b` — reduced motion was not actually exercised in that pass either. |
| `09-final-run-view-identity-false-stale-row-start-new-version-export.png` | 278 KB | new | Final view of the 19:28 Manual-route run: run identity, the false stale-generation row, "Start a new version", Export/Export Full Report. |
| `09b-generated-run-after-finalize-recovered.png` | 262 KB | new | The Generated run after Finalize recovered from the freeze: Final view, same false stale row, camper list disambiguated by group ("Ari Feldspar · Younger 1" / "· Older 2"). |
| `09c-final-run-camper-week-panel-ari-feldspar-delete-control.png` | 259 KB | new | Camper week panel on a Final run, with "Delete run" below. |
| `12-same-name-sheet-reaches-route-chooser-not-refused.png` | 267 KB | new | Confirm Mapping on the same-name sheet reaches the route chooser rather than a visible refusal. |
| `12a-same-name-sheet-mapping-two-ari-feldman-rows.png` | 230 KB | new | Mapping preview for the same-name sheet: two distinct "Ari Feldman" rows (different groups) plus "Noa Rosen". |
| `12b-same-name-sheet-solved-2-of-3-no-refusal.png` | 396 KB | new | Manual route solved: "2 campers placed" against a sheet naming three — the second Ari Feldman was silently merged. |
| `13-replace-picker-on-a-camper-week-row.png` | 356 KB | new | "Change" opens the re-place picker inline (activity dropdown, Remove, Cancel). Cancelled. |

## Freeze measurements

Two reproductions of the same defect:

- **First pass** — Finalize clicked 19:33:00; `status='final'` plus 312 snapshot rows already in
  SQLite by 19:33:03; main process held ~25% CPU in a pure-JS stack (sampled with `sample`) through
  19:38:39, with the renderer stuck on "Finalizing…" and every click dead for the whole interval.
- **Second pass** — commit landed 20:02:21; CPU 29-74%; recovered around 20:08.
- Both times, the `operations` row count stopped growing early in the stall — the stall is in
  post-write work, not in the write itself.
- A commit of a 47-placement run separately showed "Committing…" for over 60 seconds
  (`02e-committing-spinner-while-write-already-landed.png`), and in that case SQLite already held
  the finished write while the spinner kept running — a distinct renderer/IPC-reply defect, not
  the same freeze.

## The four director-facing defects (board items)

1. `i-write-ipc-freezes-app-after-commit-and-finalize` — Commit and Finalize each lock the UI for
   minutes on a realistic-sized run.
2. `i-final-run-always-reads-out-of-date-since-v76` — every Final run shows a false
   "out of date" warning; root-caused to `electron/ops/finalizedAgainstStaleGeneration.js`
   comparing against `NULL` inherited `solver_generation` rows (234 `NULL` vs 78 matching, read
   from SQLite for the run in `09-final-run-view-…`).
3. `i-same-name-sheet-solves-silently-dropping-a-camper` — a same-name sheet that
   `scripts/preferenceSheetCli.test.js` expects the CLI to refuse instead solves in the UI, merging
   the two same-named campers and dropping one's rows.
4. `i-bundle-tier-not-covered-wall-and-raw-codes` — a wall of repeated
   `BUNDLE_TIER_NOT_COVERED`-style paragraphs and raw `OUTER_RESOURCE_CONFLICT` code bullets,
   session-scoped to a commit result; not reproduced in the captured pass because resolving the
   underlying Lakefront capacity conflict was required to reach Finalize at all.

Full detail and the frames supporting each one are in the "Walk 2026-09-30" section appended to
`docs/work/tickets/T251-t199-acceptance-fixture.md`.

## Fixture-script fix

Driving `scripts/fixtures/electiveAcceptanceCamp.mjs` against the real `electron/main.js` module
load path (needed to rebuild the acceptance camp for this walk) surfaced two gaps in
`scripts/fixtures/electronStub.mjs`, the stand-in for the `electron` module this script and
`electron/main.js`'s own module-load-time startup run under:

- `app.setName` was missing from the stub, and `electron/main.js`'s top-level IIFE calls it from
  `applyUserDataPath` before the process is recognizably "Electron" — the script failed with
  "`app.setName is not a function`" until the stub grew a no-op `setName`.
- `ipcMain.removeHandler` was missing; added as a no-op alongside the existing `handle`/`on`.
- A failure after the camp row was already written left a fresh db file holding a half-built camp,
  which is worse than the "already holds N camp(s)" guard the script already had: a retry then sees
  a real camp row and refuses without `--force`, hiding that the camp is incomplete.
  `deleteHalfBuiltDb` in `scripts/fixtures/electiveAcceptanceCamp.mjs` now deletes the db file (and
  its `-wal`/`-shm` sidecars) on that failure path, but only when this run created the file —
  a failure against a db the caller already owned is not this script's to delete.
- The stub's bare `BrowserWindow` (a function with no methods) stayed as-is: this script's path
  never constructs a window, so the gap is inert for it, not fixed.

`scripts/fixtures/electronStubLoader.test.mjs` (new) spawns a real `node` process through
`registerElectronStub.mjs` and imports `electron/main.js` for real, asserting no "is not a
function" appears in its output — the regression guard for the `app.setName` gap specifically.
`scripts/fixtures/electiveAcceptanceCamp.cleanup.test.mjs` (new) covers `deleteHalfBuiltDb`.

## Verification

```
$ npx vitest run scripts/fixtures/electronStubLoader.test.mjs scripts/fixtures/electiveAcceptanceCamp.cleanup.test.mjs
 FAIL  |isolated| scripts/fixtures/electronStubLoader.test.mjs > electron stub loader > lets
       electron/main.js load without "is not a function" on any stubbed app member
AssertionError: expected 'menu/about-panel install failed (non-…' not to match /is not a function/
+ Received: "menu/about-panel install failed (non-fatal): app.setAboutPanelOptions is not a
  function ..."
 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 3 passed (4)
```
**This gate does not pass.** The test this session was handed as already-fixed (the `app.setName`
gap) does pass — `electronStubLoader.test.mjs`'s own regression target is clean — but the same test
file catches a *different*, still-open stub gap: `app.setAboutPanelOptions` is also called at
`electron/main.js` module-load time and is also missing from `scripts/fixtures/electronStub.mjs`.
This was not part of the fix described to this session ("stub needed app.setName +
ipcMain.removeHandler") and is not fixed here: this session's scope is documentation (ticket
sections and this record), and `scripts/fixtures/electronStub.mjs` is code, not something this
session was authorized to extend further. Reported honestly rather than silently patched or
silently omitted from the quoted result. `electiveAcceptanceCamp.cleanup.test.mjs` (the other file
in this gate) passes — all 3 of its tests are in the "3 passed" count.

```
$ npx eslint scripts/fixtures
(no output — clean)
```

```
$ npm run index:work
Wrote docs/work/INDEX.md (322 lines)
```

```
$ npm run check:governance
check:governance — advisory (does NOT fail the run) — 1 finding(s)
  platform-state-stale (1)
    - docs/current/PLATFORM_STATE.md is behind the last structural change (schema, migrations, ADRs
      or screens) — run `/update-state` and land it with this work
No blocking findings. Advisory items above are worth fixing and do not fail the run.
```
No blocking findings, one pre-existing advisory (`platform-state-stale`) unrelated to this walk.

## Status

`escalated`, not `pass`: the walk closes real gaps (the loop is reachable end to end, condition 11
is met) but surfaces four new director-facing defects at the same owned seam, finds the "run is
stale" half of condition 9 is not merely unimplemented but actively wrong (a false positive on
every run), and the vitest gate itself is red on a second, previously-unreported stub gap
(`app.setAboutPanelOptions`) in `scripts/fixtures/electronStub.mjs`. Per the owner's board-queue
rule, this record states the gaps and leaves T251 and T199 exactly as the walk found them —
in-progress and open — for the owner to rule on.
