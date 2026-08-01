---
task: T31 — encapsulate the route (Manual/Generated) state module
document_type: run
date: 2026-08-01
round: 1
status: pass
task_class: architecture
governing_docs:
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
  - docs/governance/constitution/CONSTITUTION.md
related_tickets: [docs/work/tickets/T31-schedule-route-state-doubling-unencapsulated.md]
related_specs: [docs/work/specs/2026-08-01-schedule-screen-decoupling-design.md]
related_adrs: [docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
selected_agents: [governor, maker, verifier, code-reviewer, red-hat, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: encapsulation of existing route-scoped state within the renderer; preserves the plural-candidate ADR, introduces no new contract
  - agent: designer
    reason: not-applicable
    note: behaviour-preserving, no visual/interaction change
  - agent: tester
    reason: not-applicable
    note: no user-visible change; covered by the unchanged ScheduleScreen suite (incl. the separate-manual-and-generated route tests)
  - agent: security
    reason: not-applicable
    note: no IPC/token/DB/auth surface
deterministic_checks: [test, lint, build]
human_gates: []
verdict: pass
completion_evidence:
  - src/screens/schedule/useRouteState.js
  - src/screens/schedule/useRouteState.test.js
  - src/screens/ScheduleScreen.jsx
archive_when: T31 resolved
---

# Run: T31 — encapsulate the route (Manual/Generated) state module

> Written before dispatch per `WORK_RECORD_STANDARD.md` §5.1.

## Brief

**Success predicate:** the route-scoped state — the 8 `byRoute` atoms (`slotsByRoute`,
`statsByRoute`, `findingsByRoute`, `dismissedByRoute`, `overlaysByRoute`, `snapshotsByRoute`,
`existingTemplates`, `templateIdByRoute`), the `routeSetter`/`EMPTY_BY_ROUTE`/`ROUTES` machinery, the
current-route derived values + setters, and the transient-reset-on-route-switch — live in one
`useRouteState` module with unit tests (incl. a test that switching routes does not carry
undo/clipboard/selection across candidates). `ScheduleScreen.jsx` becomes a thin orchestrator: no
inline `byRoute` atom soup, no render-time reset block. The separate-manual-and-generated tests in
`ScheduleScreen.test.jsx` pass unchanged; all gates green.

**Preserve exactly (plural-candidate ADR 2026-07-28):** neither route canonical; route selection is
local UI state that does not replicate; no confirmation on switch; no cross-candidate write on
switch. Also fold in the two T30-review LOWs that land here naturally: consolidate the triplicated
`routeSetter` into one shared module, and let `useSnapshots`/`useGeneration` consume route state from
`useRouteState` so their ~19–22-param injected lists collapse.

**What does not count as done:** any change to the route model's meaning; a `useRouteState` that
leaks a canonical designation or drops the switch-reset guarantee; leaving the big param lists
un-collapsed when they were the stated point of doing this last.

## Round 1 — PASS

- Baseline: post-T30 green (renderer 422/422).
- **Maker:** created `src/screens/schedule/useRouteState.js` (owns the 8 byRoute atoms + `routeSetter`/`EMPTY_BY_ROUTE`/`ROUTES` + current-route derivations/setters + `templateIdFor`) + `useRouteState.test.js`. Consolidated `routeSetter` to one source; collapsed `useSnapshots` params 19→8 and `useGeneration` 22→17 by having them consume `routeState`. Route selection + `withOverlapFlags` derivation stay in the screen.
- **Verifier (Governor-run):** `npx vitest run src/` → **426/426** (39 files); `npm run lint` → **0 errors**; `npm run build` → clean; `check:governance` → clean. ScheduleScreen 1690→**1648** lines, `useState` 36→**28**; no byRoute atoms remain in the screen (grep clean). Worktree integrity: only expected files changed.
- **Red Hat:** PASS, Resilience 5/5 — plural-candidate ADR preserved byte-for-byte (ADR diff = 0 lines); no-canonical, per-route isolation, route-explicit generate/placeAnchors/saveSnapshot, loadAll dual-route refresh, templateIdFor fallback all faithful, each backed by a test. LOW: ticket cited HEAD :178-183, actual :186-191 (doc typo).
- **Code Reviewer:** PASS, Maintainability 4.5/5 — `routeSetter` single-sourced, param collapse real (not reshuffled), encapsulation coherent, tests strong (incl. the no-canonical-key regex guard). Whole-program read: god-component → orchestrator confirmed (2277/46 → 1648/29). LOW-1 wide return surface (justified), LOW-2 fn identity (cheap).
- **MEDIUM-1 disposition (Governor accepted interpretation):** the literal predicate said the transient-reset should live in `useRouteState`; instead it stays in the screen and delegates to the T30 feature hooks' `reset()`. This is the architecturally correct outcome once T30 moved transient state into those hooks (owning their reset in the route module would invert the dependency). The switch-drops-transient guarantee is preserved and tested (integration `ScheduleScreen.test.jsx:1023` + per-hook `reset()` unit tests). Recorded as an accepted interpretation of the predicate, not a defect — behaviour and coverage intact.
- **Grade:** Maintainability 4.5, Resilience 5.0; Security/UX/Visual N/A. Average 4.75, no dimension < 3 → **PASS**. Verifier gate green. Verdict: **PASS, round 1.**
- **Future ticket flagged (not in scope):** Code Reviewer noted a possible later `useSlotMutations`/`useSpanEditing` hook for the ~15 per-cell mutation handlers still in the screen (legitimate orchestrator glue today; deliberately not pursued — beyond the four-step program).
- Committed as part of the single end-of-program `decouple schedule screen` commit (per user 2026-08-01); not pushed.
