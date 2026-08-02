---
task: T32 — extract useSlotMutations from the orchestrator
document_type: run
date: 2026-08-01
round: 2
status: pass
task_class: architecture
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_tickets: [docs/work/tickets/T32-schedule-slot-mutations-inline-in-orchestrator.md]
related_specs: [docs/work/specs/2026-08-01-schedule-screen-decoupling-design.md]
related_adrs: []
selected_agents: [governor, maker, verifier, code-reviewer, red-hat, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: extraction of existing handlers into a hook; no new architectural contract
  - agent: designer
    reason: not-applicable
    note: behaviour-preserving, no visual/interaction change
  - agent: tester
    reason: not-applicable
    note: no user-visible change; covered by the unchanged ScheduleScreen suite (drag/merge/split behaviour tests)
  - agent: security
    reason: not-applicable
    note: no IPC/token/DB/auth surface (persistence already behind the T28 repo)
deterministic_checks: [test, lint, build]
human_gates: []
verdict: pass
completion_evidence:
  - src/screens/schedule/useSlotMutations.js
  - src/screens/schedule/useSlotMutations.test.js
  - src/screens/ScheduleScreen.jsx
archive_when: T32 resolved
---

# Run: T32 — extract useSlotMutations from the orchestrator

> Written before dispatch per `WORK_RECORD_STANDARD.md` §5.1. Follow-on to the completed
> four-step decoupling; product-owner asked for it after a worthwhileness check (Governor verdict:
> worthwhile, moderate value, highest risk of the program — mitigated by the behaviour-preservation
> test net).

## Brief

**Success predicate:** the ~11 per-cell slot/overlay mutation handlers live in
`src/screens/schedule/useSlotMutations.js` with unit tests (mutation + undo/redo, via a fake repo,
no full-screen mount); they are gone from `ScheduleScreen.jsx`; behaviour is identical (existing
suite unchanged) and all gates green.

**What does not count as done:** an undo/redo closure that no longer captures the route-pinned
setter/repo/id (a cross-candidate-write regression); the DnD event handlers or findings UI dragged
in; any user-visible change.

## Round 1 — CONCERNS (code correct; tests truncated by a crash)

- Baseline: committed `8a9088d` green.
- **Maker:** extracted all 11 handlers into `src/screens/schedule/useSlotMutations.js` (injected collaborators mirroring useGeneration; owns no state; undo/redo closures route-pinned via `routeState.setSlots`). ScheduleScreen 1648→1239. **The Maker process hit an external session usage limit mid-verification** (not a code failure) after writing the hook + a partial test file.
- **Crash recovery (Governor):** inspected the working tree directly (per this project's "check actual repo state before assuming nothing happened" lesson) — the hook + rewire were complete and coherent. Ran the gates the Maker didn't reach; lint surfaced 3 NEW errors (`templateId`/`setSlots`/`setOverlays` unused in the screen after their users moved into the hook). **Governor applied the fix directly** (small/mechanical, disclosed): removed the 3 unused names from the `routeState` destructure. Re-verified.
- **Verifier (Governor-run):** full renderer `npx vitest run src/` → **434/434**; lint → **0 errors**; build → clean; check:governance → clean.
- **Red Hat:** PASS, Resilience 5/5 — extracted all 11 handlers and diffed byte-for-byte vs HEAD (identical); undo/redo route-pinning proven sound (cross-candidate write impossible); the addOverlay/updateOverlayRange hoisted-wrapper cycle-break has no render-time/TDZ path; Governor's unused-var removal confirmed genuinely unused; no half-migration. One LOW: the wrapper cycle rests on an unenforced "never called during render" invariant — add a guard-comment (deferred).
- **Code Reviewer:** CONCERNS, Maintainability 4/5 — extraction clean/faithful/cohesive, param list justified (15, vs useGeneration 17), Governor fix sound. **The CONCERNS: the crash truncated the test file** — `redo()` never exercised and the highest-risk handlers (`expandSlot`/`splitSlot`/`placeActivityManual`) had no isolated tests, i.e. the ticket's completion-evidence #1 (the ticket's whole rationale) was only half-delivered. Also LOW: prefer lifting `displacedItems` to the screen over the wrapper cycle-break (follow-on); `actMap` built twice (minor).

## Round 2 — PASS (test-only, closes the CONCERNS)

- **Maker (test-only, production untouched):** completed `useSlotMutations.test.js` — 8→**15 tests**: a route-pinned `redo()` execution; `expandSlot` merge+undo (two-write sequence + displaced-tray add/remove); `splitSlot` split+undo; `placeActivityManual` eligible + UNFILLABLE-branch. Confirmed only the test file changed.
- **Verifier (Governor-run):** `useSlotMutations.test.js` 15/15; full renderer `npx vitest run src/` → **441/441**; lint 0 errors; build clean; check:governance clean. File set confirms production (`useSlotMutations.js`, `ScheduleScreen.jsx`) unchanged since round 1 — Red Hat's byte-perfect finding still holds.
- **Grade:** Resilience 5.0, Maintainability ~4.5 (CONCERNS closed); Security/UX/Visual N/A. Average 4.75, no dimension < 3 → **PASS**. Verifier gate green. Verdict: **PASS, round 2.**
- **Deferred follow-ons (LOW, not blocking, flagged for a possible future ticket):** (1) replace the `useOverlayFillStamp`↔`useSlotMutations` wrapper cycle-break by lifting `displacedItems` state to the orchestrator (Red Hat LOW + Code Reviewer LOW/MEDIUM); (2) inject the screen's `actMap` into the hook instead of rebuilding it; (3) add a guard-comment/ref making the wrapper's "never during render" invariant structural.
- ScheduleScreen.jsx: **1648 → 1239 lines** (2277 → 1239 across T28–T32).
- Committed with T32's own commit on the branch; branch pushed (per user 2026-08-01 authorization to commit and push).
