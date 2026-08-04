---
title: T42-mock-allowlist-drift-is-manual
document_type: ticket
status: open
created: 2026-08-04
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-08-04-repository-layer-policy.md]
related_tickets: [docs/work/tickets/T43-src-imports-electron-code.md]
archive_when: resolved — the mock's write allowlist cannot silently diverge from PROJECTIONS
---

# T42 — The dev mock's write allowlist is a hand-maintained copy of PROJECTIONS

**Risk:** Low today, medium over time. Staleness is loud, not silent — but it is still manual work
a person has to do correctly, forever.
**Found:** Phase B (IPC surface parity), 2026-08-04.

## What is wrong

`MOCK_WRITE_ALLOWLIST` in `src/localClient.mock.js` is a verbatim, hand-transcribed copy of every
`PROJECTIONS[entity].fields` from `electron/ops/projections.js`. The same pattern is used for
`MOCK_SCOPE_KEYS` (added in Phase C, mirroring `PARENT_SCOPED_ENTITIES.parentKey`).

The duplication is **deliberate and currently correct**: `src/` must not import from `electron/`,
because the mock ships into the browser bundle and `projections.js` is main-process code that pulls
in node-only dependencies the moment anyone adds one. `electron/ipcSurfaceParity.test.js` reconciles
the two registries bidirectionally, so drift fails the suite rather than shipping.

The gap is that **the reconciliation is a check, not a mechanism**. Adding a field to `PROJECTIONS`
still requires a human to remember to add it in a second place; the test tells them they forgot, but
only after they have already run it.

## Why it matters

The whole reason the allowlist exists is that a stale mock lets `npm run dev` report success for a
write the real Electron path would silently discard. A hand-maintained guard against a
hand-maintenance problem is one degree better, not a solution. Every registry in this codebase that
is manually kept in sync with another has eventually drifted — that is the finding that produced the
PROJECTIONS coverage guard in the first place (see commit `9f4b178`).

## Scope

**In:** replace the hand-maintained copies with a mechanical source. Options worth evaluating:
a build/codegen step emitting a browser-safe constants module from the electron registries; or
extracting the pure entity/field tables into a dependency-free shared module that both trees may
import without crossing the boundary in a meaningful sense. Whichever is chosen must keep the
browser bundle free of any node-only dependency.

**Out:** changing what the mock enforces, or the deliberate divergence where the mock throws for an
unregistered entity while production silently discards it (that divergence is correct — see the
comment in `localClient.mock.js`).

**Boundaries:** `src/` still must not gain a runtime dependency on main-process code. Do not solve
this by simply importing `projections.js`.

## Completion evidence

1. Adding a field to `PROJECTIONS` requires no second manual edit for the mock to accept it.
2. The bidirectional drift assertions in `electron/ipcSurfaceParity.test.js` either remain green or
   are replaced by something strictly stronger.
3. No node-only module reaches the browser bundle — `npm run build` succeeds and `npm run dev`
   still works outside Electron.
4. Full `npm run test`, `npm run lint`, `npm run build` pass.
