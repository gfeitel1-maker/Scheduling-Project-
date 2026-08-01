---
task: T29 — extract the schedule grid-geometry module
document_type: run
date: 2026-08-01
round: 1
status: pass
task_class: architecture
governing_docs:
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
  - docs/governance/constitution/CONSTITUTION.md
related_tickets: [docs/work/tickets/T29-schedule-grid-geometry-trapped-in-parent.md]
related_specs: [docs/work/specs/2026-08-01-schedule-screen-decoupling-design.md]
related_adrs: []
selected_agents: [governor, maker, verifier, code-reviewer, red-hat, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: pure extraction of existing read/geometry logic within the renderer; introduces no new architectural contract. If the fillState-coupled overlay geometry forces a genuinely new contract, Architect is added mid-round.
  - agent: designer
    reason: not-applicable
    note: behaviour-preserving; zero visual/interaction change
  - agent: tester
    reason: not-applicable
    note: no user-visible change; covered by the unchanged ScheduleScreen suite
  - agent: security
    reason: not-applicable
    note: pure functions over in-memory data; no IPC/token/DB/auth surface
deterministic_checks: [test, lint, build]
human_gates: []
verdict: pass
completion_evidence:
  - src/screens/schedule/gridGeometry.js
  - src/screens/schedule/gridGeometry.test.js
  - src/screens/ScheduleScreen.jsx
archive_when: T29 resolved
---

# Run: T29 — extract the schedule grid-geometry module

> Written before dispatch per `WORK_RECORD_STANDARD.md` §5.1.

## Brief

**Product outcome:** none visible; the grid renders identically. The gain is that grid geometry
becomes a pure, tested module and the three grid views stop being ~29-prop shells driven entirely by
the parent.

**Success predicate:** the pure grid readers (`getSlot`, `isAnchorTail`, `getAnchorRowSpan`,
`isActivityTail`, `getActivityRowSpan`, `overlayForCell`, `isOverlayHead`, `getOverlayRowSpan`) live
in a pure module with direct unit tests over DB-shaped rows (merged-span, anchor-tail, overlay-head,
and the fillState-preview cases); the three views no longer receive those eight as function props;
the duplicated cell-decision rendering exists once; behaviour is identical (existing ScheduleScreen
suite unchanged) and all gates green.

**What does not count as done:** moving the functions but still threading them as props (no prop
reduction); making the overlay geometry impure by reaching for component state instead of taking
`fillState` as an explicit argument; any change to what a cell renders; touching Step 3's fill/stamp
*handlers* (`startFill`/`handleFillEnter`/`handleStampClick`) — those are out of scope.

## Round 1 — PASS

- Baseline: post-T28 state green (renderer 356/356).
- **Maker:** created pure `src/screens/schedule/gridGeometry.js` (8 readers with explicit inputs + `makeGridGeometry` facade + `decideCell` discriminated-union cell descriptor) + `gridGeometry.test.js` (21 tests, test-first). Rewired the screen and the three views. `overlayForCell`/`isOverlayHead`/`getOverlayRowSpan` take `fillState` as an explicit arg (module stays pure). Cell-decision logic consolidated for Group+Day into `decideCell`; ManualBuildView deliberately excluded (its behaviour genuinely differs — no overlays, forced rowSpan=1, droppable-empty).
- **Verifier (Governor-run):** `npx vitest run src/` → **379/379** (33 files, +23 vs pre-T29 from new tests); `npm run build` → clean; eslint changed files → 0 errors, 1 pre-existing warning. ScheduleScreen 2199→**2097** lines; all 8 geometry fns confirmed removed from the screen (grep clean).
- **Red Hat:** PASS, Resilience 5/5 — geometry bodies byte-for-byte faithful; `decideCell` reproduces both views' shared decision order while each keeps its distinct props; fillState drag-preview still live; ManualBuildView exclusion provably behaviour-preserving; no stale facade bindings. One LOW: a pre-existing unreachable `cellType:'unavailable'` branch, faithfully carried over (not introduced).
- **Code Reviewer:** PASS, Maintainability 4.5/5 — module genuinely pure, prop reduction real (Group 30→23, Day 25→18, Manual 16→14), `decideCell` a sound DRY-over-two-identical-sites (not premature), tests strong. One **MEDIUM (process, non-blocking): commit co-mingling** — T28 and T29 are both uncommitted so `git diff` interleaves them, weakening the spec's "individually-shippable, own commit" intent.
- **Grade:** Maintainability 4.5, Resilience 5.0; Security/UX/Visual N/A. Average 4.75, no dimension < 3 → **PASS**. Verifier gate green. Verdict: **PASS, round 1.**
- **Disposition of the MEDIUM:** it is a packaging concern, not a code defect (both reviewers confirmed the T29 code is correctly scoped). Per the harness "commit only when the user asks" rule and this project's held-push convention, the Governor did NOT commit unprompted. Deferred to commit/push time and surfaced to the product owner: the working tree currently bundles T28+T29 (and will accrue T30/T31); because the same-session sequential edits to `ScheduleScreen.jsx` interleave, a clean per-step commit split of that file is no longer practical without interactive hunk staging. Recommendation offered to the user: either commit the current verified T28+T29 milestone as one commit and take T30/T31 as separate commits going forward, or accept a single decoupling commit at the end. Awaiting the user's commit-boundary preference; does not block the refactor.
- Not committed (held for the user, per convention + the commit-boundary question above).
