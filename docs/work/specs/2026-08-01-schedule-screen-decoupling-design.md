---
title: "Decoupling the schedule screen — four-step design"
document_type: spec
status: implemented
created: 2026-08-01
task_class: architecture
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_adrs: [docs/adr/2026-08-01-schedule-screen-persistence-seam.md]
related_tickets: [docs/work/tickets/T28-schedule-screen-has-no-persistence-seam.md, docs/work/tickets/T29-schedule-grid-geometry-trapped-in-parent.md, docs/work/tickets/T30-schedule-feature-clusters-inline-in-god-component.md, docs/work/tickets/T31-schedule-route-state-doubling-unencapsulated.md]
archive_when: T28–T31 are all resolved and ScheduleScreen.jsx is a thin orchestrator
---

# Decoupling the schedule screen — four-step design

`src/screens/ScheduleScreen.jsx` is the largest file in the app (2,277 lines) and its most complex
screen. This spec is the design of record for cutting it down to a thin orchestrator, in four
ordered, individually-shippable, **behaviour-preserving** steps. It changes no feature and no
user-visible behaviour; it moves logic to where it can be owned and tested.

This is deliberately a program, not a single change. `CONSTITUTION.md` rule 7 (smallest responsible
workflow) and rule 5's preference for small reversible changes both point away from a big-bang
rewrite of a 2,277-line file. Each step below is its own ticket, its own Maker round, its own review,
and its own green gate.

## Why (the measured problem)

From the 2026-08-01 sprawl assessment. Measured on `main` at `c21266f`:

- **2,277 lines, 46 `useState`, ~50 handlers, ~485-line render.**
- **27** direct `localClient.*` calls across ~20 handlers; the auth token re-read from
  `localStorage` at **6** sites; the engine-slot→DB-row mapping hand-written **3 times and already
  drifting** (`is_span_head` in one copy, absent in two).
- The three grid views take **~29 / ~24 / 16 props** (mostly callbacks) because all grid-decision
  logic lives in the parent and is threaded down — and the cell-decision rendering is copy-pasted
  across all three.

The consequence that matters most: **only the pure engine is unit-tested.** Everything else —
persistence, grid geometry, every mutation — is fused into the component and can only be exercised
by mounting the whole screen. Decoupling is what creates the seams that make these testable, per
this project's own default of test-first work at important logic/data seams.

## What is already decoupled — out of scope, do not touch

The engine (`src/engine/buildSchedule.js`) and the pure-helper layer (`computeOverlaps`,
`normalizeSlots`, `normalizeActivityEligibility`, `exportSchedule`, `resolveSelection`,
`snapshotRestore`, `snapshotMatchesSchedule`) are already clean and tested. The good leaf components
(`SlotCell`, `VersionsDropdown`, `ActivityPalette`, `FieldTripDrawer`, the read-only
`ScheduleActivityView`, and the dumb modals) are fine. None of them are touched by this program.

## Invariants every step must hold (from ARCHITECTURE_STANDARD.md)

1. **Renderer never touches the DB** (§1) — extracted modules call `localClient`; none holds a DB
   handle or SQL. No new IPC channel.
2. **All mutations through the op-log, no new entity, no `PROJECTIONS` change** (§2).
3. **Engine stays pure** (§7) — no scheduling logic or mapping moves *into* the engine.
4. **Inline styling** (§6) — any component split keeps inline style objects; no CSS files.
5. **The plural-candidate (Manual/Generated) route model is preserved** exactly, per
   `docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`. Nothing here designates a canonical
   schedule.
6. **Behaviour-preserving.** The gate for every step is that the existing 1,247-line
   `ScheduleScreen.test.jsx` passes unchanged, plus the full suite, plus new unit tests for the
   extracted module.

## The four steps, in order

Order is by dependency and by risk-reduction: persistence is untangled and tested *first*, so the
later state/handler moves happen on a base whose data layer is already covered.

### Step 1 — Persistence seam · [T28] · ADR 2026-08-01-schedule-screen-persistence-seam

Extract `src/data/scheduleRepository.js`: a React-free, dependency-injected module owning token
acquisition, all schedule `list`/`write`/`bulkReplace`/`deleteEntity`, the single slot↔row and
snapshot↔row mappings, `normalizeSlots` on read, and write-result→typed-error translation. The
screen keeps state, error-banner copy, and route policy. **Decided in full by its ADR.** This is the
foundation: it must land and be green before Step 3 moves the handlers that call it.

### Step 2 — Grid-geometry / cell-decision module · [T29]

Extract the pure grid readers — `getSlot`, `overlayForCell`, `isOverlayHead`, `getOverlayRowSpan`,
`isAnchorTail`, `getAnchorRowSpan`, `isActivityTail`, `getActivityRowSpan` — into a pure module, and
collapse the cell-decision rendering that is currently copy-pasted across `ScheduleGroupView`,
`ScheduleDayView`, and `ManualBuildView`. This is what shrinks the ~29-prop view interfaces: the
views compute geometry from data + the shared module instead of receiving a dozen function props.
Pure functions ⇒ directly unit-testable. No ADR anticipated (no new architectural contract — pure
extraction within the existing renderer); if implementation surfaces a real new contract, Architect
writes one then.

### Step 3 — Feature hooks · [T30]

Move the self-contained state+handler clusters into hooks, one commit each where practical:
`useUndoRedo`, `useClipboardSelection` (selection + copy/paste + keyboard), `useSnapshots`
(versions CRUD + restore, over the Step-1 repository), `useGeneration` (generate/regenerate/
placeAnchors, over the repository + engine), `useOverlayFillStamp`. This is the step that most
reduces the 46 `useState` and ~50 handlers. Depends on Step 1 (the hooks call the repository, not
`localClient`).

### Step 4 — Route-state module · [T31]

Encapsulate the ~10 `byRoute` state atoms, the `routeSetter` wrappers, and the 11-field
transient-reset-on-route-change into a `useRouteState` module, preserving the plural-candidate model
exactly. After this, `ScheduleScreen.jsx` is a thin orchestrator: it wires the repository, the
geometry module, the feature hooks, and the route-state module to the presentational components.

## Execution per step (the loop)

Each step is a routed task under `CONSTITUTION.md` Article VII, `task_class: architecture`:

1. Governor writes the run record (`docs/work/runs/`) before dispatch.
2. Maker implements, **test-first** — the new module's unit tests are written and failing before the
   extraction, then made green; the existing suite is the behaviour-preservation gate.
3. Verifier runs the deterministic gates: `npm run test`, `npm run lint`, `npm run build`,
   `npm run check:governance`. A FAIL or unresolved UNVERIFIED blocks, whatever else says.
4. Code Reviewer + Red Hat review the diff (Security/Tester/Designer omitted with recorded reasons —
   no attack surface, no UX/visual change in a behaviour-preserving refactor; each omission
   justified in the run record, never waved).
5. Grader scores; pass is avg ≥ 4.0, no dimension < 3. Max two rounds, then escalate.

## Success predicate (whole program)

`ScheduleScreen.jsx` is materially smaller and contains no direct persistence, no inline grid
geometry, no self-contained feature-cluster state; the extracted modules each have unit tests; the
full suite and all gates are green; and there is zero user-visible behaviour change across all four
steps. Non-goal: any feature change, any visual change, any alteration to the route model.
