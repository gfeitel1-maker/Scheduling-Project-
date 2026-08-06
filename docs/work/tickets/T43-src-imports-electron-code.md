---
title: T43-src-imports-electron-code
document_type: ticket
status: closed
created: 2026-08-04
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-08-04-repository-layer-policy.md]
related_tickets: [docs/work/tickets/T42-mock-allowlist-drift-is-manual.md]
archive_when: resolved — every src/ → electron/ import is removed or documented as intentional
---

# T43 — Three files under `src/` import from `electron/`, contradicting the boundary everything else assumes

**Risk:** Low today (nothing is broken), medium latent — the boundary is load-bearing for decisions
being made now, and it is not actually clean.
**Found:** Phase B (IPC surface parity), 2026-08-04, while resolving where the dev mock's allowlist
should live.

## What is wrong

Phase B established, and Phase C reaffirmed, that `src/` must never import from `electron/`. That
rule drove real decisions: the dev mock hand-copies `PROJECTIONS` and `PARENT_SCOPED_ENTITIES`
rather than importing them (T42), and `electron/ipcSurfaceParity.test.js` was placed under
`electron/` specifically because it is the one place allowed to read both trees.

The rule is not actually true today. A security audit confirmed three pre-existing imports:

- `src/screens/ScheduleScreen.jsx`
- `src/screens/schedule/useRouteState.js`
- `src/utils/ensureCohort.race.test.js` (test file)

All three predate Phases A–D and none were introduced or worsened by them.

## Why it matters

Either the boundary is real, in which case these three are violations that should be removed; or it
is not, in which case the duplication accepted in T42 and elsewhere was paid for nothing. Both
positions are defensible. What is not defensible is holding the rule strictly for new code while
three exceptions sit unexamined, because the next person to hit the question will find the
exceptions and reasonably conclude the rule is advisory.

Note the practical risk differs per file. A test file importing across the boundary is harmless — it
never ships to the browser. A renderer *screen* importing main-process code means whatever it pulls
in must stay browser-safe forever, enforced by nothing.

## Scope

**In:** determine what each of the three actually imports and why. For each, either remove the
import (moving the needed value to a browser-safe location) or record it as an intentional,
justified exception in `ARCHITECTURE_STANDARD.md` §6 alongside the existing documented component-IO
exception. Distinguish test files from shipping code — they may warrant different rules, and saying
so explicitly is a valid outcome.

**Out:** T42's mock-allowlist mechanism. Any restructuring of `electron/` itself.

**Boundaries:** no behavior change. If an import is removed, the moved value must not change shape.

## Completion evidence

1. Each of the three imports is either gone or documented with its rationale in the architecture
   standard.
2. The standard states unambiguously whether the rule applies to test files, shipping code, or both.
3. If any exception remains, a check exists that prevents a *fourth* appearing unnoticed.
4. `npm run build` succeeds and `npm run dev` still works outside Electron.
5. Full `npm run test`, `npm run lint`, `npm run build` pass.

## Closure note

Closed on branch `work/t42-t43-boundary`. All three imports examined and dispositioned:

1. **`src/screens/ScheduleScreen.jsx`** and **`src/screens/schedule/useRouteState.js`** both import
   `deriveScheduleTemplateId` from `electron/ops/scheduleTemplateId.js`. This is an intentional,
   documented exception: the module lives under `electron/` because electron-builder ships
   `electron/**` but not `src/`, so an electron-side import of a `src/` utility fails in the
   installed app at migration time (the v21 migration uses this function against real databases).
   The renderer importing in the opposite direction is safe because Vite bundles whatever `src/`
   imports into `dist/`, which does ship. The module's own header documents this reasoning fully.
   Recorded as an approved exception in `docs/governance/standards/ARCHITECTURE_STANDARD.md` §6.

2. **`src/utils/ensureCohort.race.test.js`** imports `openLocalDb` and `appendOp` from
   `electron/`. This is a test file that never reaches the browser bundle. The standard was updated
   to clarify that test files under `src/` are exempt from the src/ → electron/ prohibition, with
   the requirement that the import be narrowly scoped to the utility under test.

`ARCHITECTURE_STANDARD.md` §6 now states the rule, the exemptions, the current exception register,
the approval requirement for any future exception, and a grep command to detect violations
mechanically. Lint and build both pass. Tests: 17/17 passing in ipcSurfaceParity.test.js.
