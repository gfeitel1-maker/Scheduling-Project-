---
title: T43-src-imports-electron-code
document_type: ticket
status: open
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
