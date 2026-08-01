---
task: schedule-decoupling-handoff-2026-08-01
title: "Schedule-screen decoupling — handoff after steps 1–2 of 4"
document_type: handoff
status: superseded
created: 2026-08-01
related_specs: [docs/work/specs/2026-08-01-schedule-screen-decoupling-design.md]
related_tickets:
  - docs/work/tickets/T30-schedule-feature-clusters-inline-in-god-component.md
  - docs/work/tickets/T31-schedule-route-state-doubling-unencapsulated.md
related_runs:
  - docs/work/runs/2026-08-01-t28-schedule-persistence-seam-run.md
  - docs/work/runs/2026-08-01-t29-schedule-grid-geometry-run.md
archive_when: T30 and T31 are complete and ScheduleScreen.jsx is a thin orchestrator
---

# Schedule-screen decoupling — handoff after steps 1–2 of 4

The four-step program in `docs/work/specs/2026-08-01-schedule-screen-decoupling-design.md`. Steps 1
and 2 are DONE and verified (PASS round 1 each). Steps 3 and 4 remain. This file is the resume
pointer.

## Where the work lives

Worktree: `~/dev/shoresh/.claude/worktrees/schedule-decoupling-analysis`, branch
`work/schedule-decoupling-analysis`, based on `origin/main`. **Nothing is committed** (see Open
decision below). A separate live session works `main` directly — do NOT `git checkout -b` on shared
`main`; stay in this worktree. Node resolves the repo's `node_modules` from the worktree; tests and
`npm run check:governance` run fine here.

## Done (verified PASS)

- **T28 — persistence seam.** New `src/data/scheduleRepository.js` (React-free factory
  `createScheduleRepository({ localClient, getToken })`, single slot→row mapper). All schedule
  persistence + token reads moved out of `ScheduleScreen.jsx`; only `localClient.onOpApplied`
  remains. Tests: `src/data/scheduleRepository.test.js` (21). ADR
  `docs/adr/2026-08-01-schedule-screen-persistence-seam.md` (accepted, implemented).
- **T29 — grid geometry.** New pure `src/screens/schedule/gridGeometry.js` (8 readers +
  `makeGridGeometry` facade + `decideCell`). Views shrunk (Group 30→23, Day 25→18, Manual 16→14).
  Tests: `src/screens/schedule/gridGeometry.test.js` (21). ManualBuildView deliberately NOT folded
  into `decideCell`.
- **Metrics:** `ScheduleScreen.jsx` 2277 → **2097** lines. Full renderer suite **379/379**, build
  clean, `check:governance` clean. Lone lint warning (`loadAll` exhaustive-deps, line ~218) is
  pre-existing.

## Remaining

- **T30 — feature hooks (Step 3, the biggest).** Extract `useUndoRedo`, `useClipboardSelection`
  (selection + copy/paste + the Ctrl+C/A/Escape keyboard effect), `useSnapshots` (versions CRUD +
  restore, over the T28 repo), `useGeneration` (generate/regenerate/placeAnchors, over repo +
  engine), `useOverlayFillStamp` (fillState/stampMode + startFill/handleFillEnter/handleStampClick +
  the updateOverlayRange effect at ScheduleScreen ~:296-315). One hook per commit where practical.
  Ticket: `docs/work/tickets/T30-...md`.
- **T31 — route-state module (Step 4).** Encapsulate the ~10 `byRoute` atoms + `routeSetter` + the
  11-field transient reset (ScheduleScreen ~:206-220) into `useRouteState`, preserving the
  plural-candidate ADR (`docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`) exactly.
  Ticket: `docs/work/tickets/T31-...md`.

## Execution pattern that worked (reuse it)

1. Governor writes the run record from `docs/work/runs/TEMPLATE.md` BEFORE dispatch. All ten agents
   must appear in `selected_agents` or `omitted_agents` (incl. `governor`) or `check:governance`
   fails.
2. Baseline the test suite green before touching code.
3. Dispatch a **general-purpose** subagent as Maker (the project's custom `.claude/agents/*.md`
   are NOT registered as subagent_types this session — brief general-purpose with the persona file +
   the absolute worktree path + TDD + exact line cites + the known traps).
4. Governor runs the deterministic gates: `npx vitest run src/`, `npm run build`, `npx eslint`.
5. Dispatch Code Reviewer + Red Hat (general-purpose) in parallel against the diff.
6. Governor grades (avg ≥4.0, no dim <3) and finalizes: run record verdict, ticket → completed
   (+ `resolved_by`, `related_runs`), `npm run index:work`, `check:governance`.

## Traps for T30/T31 (from the code + prior rounds)

- **Route-reset semantics:** switching routes currently resets 11 pieces of transient state during
  render (ScheduleScreen ~:206-220). T30 hooks must preserve this exactly; T31 owns it. A hook that
  keeps undo/clipboard/selection across a route switch is a cross-candidate-write bug — the exact
  thing the route separation exists to prevent. Test it.
- **`generate`/`placeAnchors` closure subtlety:** both build route-specific setters explicitly
  (not the current-route ones) because they can be invoked from the first-run chooser where `route`
  in closure is stale. Preserve this in `useGeneration`.
- **`saveSnapshot` before destructive wipe:** `generate` aborts the `bulkReplace` if the pre-emptive
  auto-snapshot fails (a real T28-era fix, test-pinned). Keep that ordering in `useGeneration`.
- **Behaviour-preservation net:** the 50+ `ScheduleScreen.test.jsx` cases must pass unchanged every
  round; that is the real gate for these state-moving steps.

## Open decision for the product owner (needed at commit/push time)

Per the harness "commit only when the user asks" rule + this project's held-push convention, nothing
is committed. Because T28 and T29 were developed sequentially in one session without an intermediate
commit, their edits to `ScheduleScreen.jsx` interleave in the working tree — a clean per-step commit
split of that file is no longer practical without interactive hunk staging (Code Reviewer T29
MEDIUM). **The product owner needs to choose the commit boundary:** (a) commit the verified T28+T29
milestone as one commit now and take T30/T31 as separate commits going forward, or (b) accept a
single decoupling commit at the end. Until chosen, keep committing per-step from T30 onward so the
interleave does not grow.
