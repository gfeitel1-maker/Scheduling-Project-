---
title: Architecture Standard
document_type: standard
authority: normative
status: active
applies_to: [architecture, engineering]
supersedes: []
last_reviewed: 2026-07-28
review_trigger: any ADR that changes the op-log, sync protocol, IPC surface, or isolation model
---

# Architecture Standard

What must remain structurally true, regardless of what any given feature does.

This is not a description of the system — that is [`docs/current/PLATFORM_STATE.md`](../../current/PLATFORM_STATE.md),
which is descriptive and ranks below code. This document is normative and ranks above it. Where the
code violates a rule here, that is a defect or a gap requiring human review, never evidence that the
rule has changed.

---

## 1. The renderer never touches the database

Every read and write goes through `window.shoresh` / `localClient` IPC. The renderer holds no
database handle, no SQL, and no direct file access. This boundary is what makes the app auditable:
`authorize()` sits on the other side of it, and code that bypasses the boundary bypasses
authorization by construction.

## 2. All mutations go through the op-log

Every write is appended to the `operations` table as an entity/field-level row carrying a
`client_write_id`, then projected into its table. This is what makes writes idempotent under retry
and replayable across devices.

**A new entity must be registered in `PROJECTIONS` (`electron/ops/projections.js`).** An
unregistered entity's writes succeed at the op-log and then silently never materialize — the row
simply never appears. This has cost this project real debugging time twice (`schedule_templates`,
`schedule_snapshots`). Registration is not optional and its absence fails silently, which is why it
is a standing rule rather than a code-review checklist item.

Genuine conflicting writes are recorded in `conflicts` and resolved explicitly by a human. **Nothing
is silently dropped or auto-merged** — see [`CONSTITUTION.md`](../constitution/CONSTITUTION.md)
Article V.

## 3. Camp isolation is structural

One camp per device database. Every camp lookup is `SELECT ... FROM camps LIMIT 1`. There is no
policy engine, no row-level security, and no tenant discriminator to get wrong — isolation holds
because there is only ever one camp in the file.

Never introduce a code path that could read or write across camps. `applyProjection`'s `camp_id`
overwrite guard exists to enforce this at the projection seam.

## 4. Every mutating handler is authorized

Mutating IPC handlers and mutating WebSocket handlers call `authorize()`
(`electron/auth/authorize.js`) before acting. `authorize()` re-derives role and device trust from
the database on every call and never trusts the token payload, which is what makes a role change or
a device revocation take effect on the very next request.

A handful of handlers sit outside it deliberately — they run before a session exists or carry no
caller-controlled authority. Each documents why in code. Adding a privileged side effect to one of
those is a change of security posture, not a refactor.

## 5. Host and Client are asymmetric, permanently

One device is the Host: it runs the WebSocket server and holds the Ed25519 private key in
`host_signing_key`. That key never replicates. Clients receive only the public half and can verify
tokens but never mint them. Do not design anything that assumes a Client can act as a Host without
an explicit, human-approved promotion path.

## 6. Styling is inline React style objects

No CSS files for component styling, no `className` used as a styling mechanism. Shared constants
live in `src/styles/shared.js`. Token values and their meanings are governed by
[`DESIGN_STANDARD.md`](DESIGN_STANDARD.md), not here.

## 7. The schedule engine is pure

`src/engine/buildSchedule.js` has no React and no IPC dependency. It is a pure function over its
inputs, seeded so identical inputs produce identical schedules. **Determinism is a product
guarantee**, not an implementation detail — a director must be able to trust that regenerating does
not silently reshuffle work they have already reviewed. Never introduce ambient state, wall-clock
reads, or unseeded randomness into it.

## 8. Code style

- **Validate at boundaries only** — user input, network messages, external APIs. Trust internal code
  and framework guarantees.
- **No error handling for cases that cannot happen.** Defensive code for impossible states hides
  real failures and misleads the next reader into thinking the state is reachable.
- **No premature abstraction.** Three similar lines beat a generalized helper built for a fourth
  case that does not exist.
- **Comments explain why, not what** — a hidden constraint, a workaround, an invariant. The code
  already says what it does.

## 9. Native module ABI

`better-sqlite3` is native and must be rebuilt when switching between Node (Vitest) and Electron.
See [`TESTING_STANDARD.md`](TESTING_STANDARD.md). A mismatch presents as a module-load error or a
startup crash, not as a test failure — do not debug it as a logic bug.
