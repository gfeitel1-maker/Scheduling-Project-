---
title: T31-schedule-route-state-doubling-unencapsulated
document_type: ticket
status: completed
created: 2026-08-01
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_specs: [docs/work/specs/2026-08-01-schedule-screen-decoupling-design.md]
related_adrs: [docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
related_tickets: [docs/work/tickets/T28-schedule-screen-has-no-persistence-seam.md]
related_runs: [docs/work/runs/2026-08-01-t31-schedule-route-state-run.md]
resolved_by: [src/screens/schedule/useRouteState.js]
archive_when: resolved
---

# T31 — The Manual/Generated route doubling is correct but unencapsulated

**Risk:** Low, behaviour-preserving. **Depends on:** T28–T30 (this is the final consolidation).
Step 4 of [the decoupling program](../specs/2026-08-01-schedule-screen-decoupling-design.md).

## What is wrong

The plural-candidate model (`docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`) is
implemented as inline duplication in `ScheduleScreen.jsx`: ~10 `byRoute` state atoms
(`slotsByRoute`, `statsByRoute`, `findingsByRoute`, `dismissedByRoute`, `overlaysByRoute`,
`snapshotsByRoute`, `existingTemplates`, `templateIdByRoute`, …), the `routeSetter` wrapper pattern
applied per atom, and an 11-field "transient reset on route change" done inline during render.

The model is **correct and intentional** — this ticket does not change it. The problem is that it is
open-coded, so the route contract (what is per-route, what resets on switch, what must never cross
candidates) is spread across the file rather than owned in one place.

## Why it matters

Cross-candidate writes are exactly what the route separation exists to prevent; keeping the rule
implicit across ~10 atoms and a render-time reset is fragile, and it is the last big block of
boilerplate keeping the screen from being a thin orchestrator.

## Scope

**In:** encapsulate the route-scoped state and its transient-reset semantics into a `useRouteState`
(or equivalent) module with a small interface: current route, per-route values, per-route setters,
and the switch-time reset. Preserve the plural-candidate ADR exactly, including that route selection
is local UI state that does not replicate and that neither route is canonical.

**Out:** any change to the route model's meaning; persistence (T28), geometry (T29), other feature
hooks (T30) — though this may consume them.

**Boundaries:** behaviour-preserving; the ADR-backed guarantees (no canonical schedule, no
cross-candidate write on switch, no confirmation on switch) must hold identically; no IPC/entity/
engine change.

## Completion evidence

1. Route-scoped state and the switch-time transient reset live in one module with unit tests,
   including a test that switching routes does not carry undo/clipboard/selection across candidates.
2. `ScheduleScreen.jsx` is a thin orchestrator: no inline `byRoute` atom soup, no render-time reset
   block.
3. The separate-manual-and-generated behaviour tests in `ScheduleScreen.test.jsx` pass unchanged;
   full `npm run test` green.
4. `npm run check:governance`, `npm run lint`, `npm run build` pass. No engine/IPC/entity change.
