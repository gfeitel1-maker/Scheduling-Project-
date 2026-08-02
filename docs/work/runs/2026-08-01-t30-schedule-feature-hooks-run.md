---
task: T30 — extract schedule feature hooks
document_type: run
date: 2026-08-01
round: 1
status: pass
task_class: architecture
governing_docs:
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
  - docs/governance/constitution/CONSTITUTION.md
related_tickets: [docs/work/tickets/T30-schedule-feature-clusters-inline-in-god-component.md]
related_specs: [docs/work/specs/2026-08-01-schedule-screen-decoupling-design.md]
related_adrs: []
selected_agents: [governor, maker, verifier, code-reviewer, red-hat, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: extraction of existing state/handlers into hooks within the renderer; no new architectural contract
  - agent: designer
    reason: not-applicable
    note: behaviour-preserving, no visual/interaction change
  - agent: tester
    reason: not-applicable
    note: no user-visible change; covered by the unchanged ScheduleScreen suite
  - agent: security
    reason: not-applicable
    note: no IPC/token/DB/auth surface change (persistence already behind the T28 repo)
deterministic_checks: [test, lint, build]
human_gates: []
verdict: pass
completion_evidence:
  - src/screens/schedule/useUndoRedo.js
  - src/screens/schedule/useClipboardSelection.js
  - src/screens/schedule/useOverlayFillStamp.js
  - src/screens/schedule/useSnapshots.js
  - src/screens/schedule/useGeneration.js
  - src/screens/ScheduleScreen.jsx
archive_when: T30 resolved
---

# Run: T30 — extract schedule feature hooks

> Written before dispatch per `WORK_RECORD_STANDARD.md` §5.1.

## Brief

**Success predicate:** the self-contained feature clusters (undo/redo; selection+clipboard+paste+
keyboard; snapshots/versions; generation; overlay-fill/stamp) live in hooks under
`src/screens/schedule/`, each with unit tests where feasible; `ScheduleScreen.jsx`'s `useState` and
handler counts drop materially; behaviour is identical (existing suite unchanged) and all gates
green.

**Design constraint (critical):** route-scoped state (`slotsByRoute`/`overlaysByRoute`/
`snapshotsByRoute`/`statsByRoute`/`findingsByRoute` and their route setters) stays in the screen
until T31 — hooks that touch it (`useSnapshots`, `useGeneration`) take those values/setters + the
T28 repo + the pure engine as INJECTED params; they must not own or re-key route state. Transient
hooks (`useUndoRedo`, `useClipboardSelection`, `useOverlayFillStamp`) own their own state and expose
a `reset()` the screen calls from the existing transient-reset block (ScheduleScreen ~:203) on route
switch — preserving the current cross-candidate-reset semantics exactly.

**What does not count as done:** a hook that carries undo/clipboard/selection/fill across a route
switch (that is the cross-candidate bug the reset exists to prevent); losing the `generate` aborts-
on-failed-auto-snapshot ordering or its route-explicit setters; any user-visible change.

## Round 1 — PASS

- Baseline: post-T29 green (renderer 379/379).
- **Maker:** extracted 5 hooks under `src/screens/schedule/` (`useUndoRedo`, `useClipboardSelection`, `useOverlayFillStamp` — own transient state + `reset()`; `useSnapshots`, `useGeneration` — take route state injected, own none) + 5 `.test.js` (43 tests). Transient-reset block now calls the three `reset()`s; generate route-explicit setters + abort-before-wipe preserved verbatim.
- **Verifier (Governor-run):** `npx vitest run src/` → **422/422** (38 files); `npm run lint` → **0 errors**, 10 warnings (all pre-existing files; ScheduleScreen/hooks/repo clean); `npm run build` → clean. ScheduleScreen 2097→**1690** lines; `useState` 46→36; top-level handlers 45→29; effects 5→2. Worktree integrity checked: only expected files changed (the Maker's "other process" observation left no trace — `readiness.test.js` unchanged from HEAD).
- **Red Hat:** PASS, Resilience 5/5 — all six faithfulness seams preserved (11/11 transient-reset atoms, route-explicit generation, abort-before-wipe ordering, undo-closure route-pinning, effect gating/deps, injected wiring) + re-audited T28/T29 surface; lint suppressions confirmed faithful no-ops.
- **Code Reviewer:** PASS, Maintainability 4.5/5 — design constraint honored (snapshot/generation hooks own no route state), reductions real, tests strong (renderHook, real transitions). Two LOW deferred to T31: (a) `routeSetter` now triplicated → consolidate into a shared module; (b) `useGeneration`/`useSnapshots` ~19–22 injected params → collapse once T31 owns route state. Lint deviation clean.
- **Grade:** Maintainability 4.5, Resilience 5.0; Security/UX/Visual N/A. Average 4.75, no dimension < 3 → **PASS**. Verifier gate green. Verdict: **PASS, round 1.**
- **Disclosed process deviations (Maker):** (1) undo/redo keyboard effect moved into `useUndoRedo` (cohesive, behaviour-preserving); (2) `loadAll` effects relocated below its (hoisted) declaration + 2 react-hooks rules suppressed on the pre-existing mount effect — surfaced only because the shrunk file now fully analyzes; both reviewers confirmed faithful no-op; (3) a local `routeSetter` copy in the hooks (LOW, to consolidate in T31).
- Not committed (one-commit-at-end, per user 2026-08-01).
