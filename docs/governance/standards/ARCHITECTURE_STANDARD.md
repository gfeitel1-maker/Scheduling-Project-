---
title: Architecture Standard
document_type: standard
authority: normative
status: active
applies_to: [architecture, engineering]
supersedes: []
last_reviewed: 2026-08-04
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

Two categories of handlers sit outside it deliberately, each with a recorded decision:

**Pre-session handlers** (`choose-mode`, `discover-hosts`, `login`, `bootstrap-camp`, `get-camp`)
run before any session token exists. Each carries an inline comment stating why. Adding a privileged
side effect to one of those is a change of security posture, not a refactor.

**Project-lifecycle handlers** (`get-current-project`, `create-project`, `open-project`,
`export-project`, `backup-project`, `restore-project`, `list-recent-projects`, `open-recent-project`)
are trusted local-device operations that manage which SQLite file is open. They are exempt because
requiring authentication against the currently-open camp database creates a circular recovery
dependency: a corrupted file cannot issue the token needed to open or restore it. See
[ADR 2026-08-04](../../adr/2026-08-04-project-lifecycle-authorization-exemption.md). Each handler
in this block carries the comment:
`// Project lifecycle — trusted local-device operation, exempt from camp session auth.`

This exemption covers file-level operations only. Every handler that reads or writes camp-scoped
data through the op-log must call `authorize()`, regardless of where in `main.js` it is registered.

## 5. Host and Client are asymmetric, permanently

One device is the Host: it runs the WebSocket server and holds the Ed25519 private key in
`host_signing_key`. That key never replicates. Clients receive only the public half and can verify
tokens but never mint them. Do not design anything that assumes a Client can act as a Host without
an explicit, human-approved promotion path.

## 6. Renderer dependency rule

Dependencies move downward across explicit boundaries. Pure domain modules and presentational
components may sit outside the persistence stack, but no lower layer may depend upward on UI or
renderer code.

The two approved dependency shapes in the renderer:

```
Complex mapped domain:
  Screen → Hook → Repository → localClient

Simple domain:
  Screen → Hook → localClient
```

**A repository is required when a domain has meaningful shared persistence mapping, normalization,
batching, or access policy worth centralizing.** Do not create pass-through repositories to satisfy
the diagram. The practical signal is the deletion test: if deleting the repository disperses real
complexity across call sites, it is earning its keep. `src/data/scheduleRepository.js` exists
because it replaced three separately-drifting copies of the same engine-slot → DB-row mapping.

A screen may call `localClient` directly for genuinely simple, screen-owned operations where a hook
adds no reusable behavior. The 13 non-schedule screens that do this are conforming under this rule,
as are the hooks (`useCohorts`, `useDeviceMode`, `usePendingConflicts`, `useWeeks`) that do the same.

`src/screens/schedule/useWeeks.js` is the worked example of the no-pass-through half of the rule: it
calls `localClient.duplicateWeek` directly because wrapping a cascading Host transaction in a
`repo.duplicateWeek` one-liner would add no mapping and would be exactly the pass-through this rule
forbids. It cites this ADR in a comment.

### Components and IO

Components (`src/components/**`) are presentational. They receive data and emit callbacks; they do
not perform IO. Exceptions must be approved explicitly and listed here — this register is the record,
not the boundary audit, which is a dated findings document rather than living law.

**Approved exception — a confirmation dialog may own its own destructive call.** A dialog whose
entire purpose is to confirm and then execute one destructive action may call `localClient` for that
action, because routing it back through the parent buys nothing: the parent would immediately call
the same method with the same arguments, and the dialog is the only thing that knows the user
confirmed. Current members of this class:

- `src/components/schedule/DeleteWeekDialog.jsx` — `localClient.deleteWeek`, plus repository reads
  to compute live deletion counts. Receives `localClient` and `repo` as injected props.
- `src/components/DeleteRecordDialog.jsx` — `localClient.deleteRecord`.

Prefer injecting `localClient` as a prop over importing it at module scope, as `DeleteWeekDialog`
does — it keeps the component testable without module mocking.

See [ADR 2026-08-04](../../adr/2026-08-04-repository-layer-policy.md) for the policy rationale.

### src/ → electron/ boundary

**Shipping code under `src/` must not import from `electron/`.** The boundary is what makes the
browser bundle safe to build: Vite bundles `src/` into `dist/` for the renderer, while
`electron/` is main-process code that may pull in node-only natives (`better-sqlite3`,
`node:crypto`, etc.) the moment a maintainer adds them. An import that happens to be safe today
becomes a build-time failure or a browser crash the instant any transitive dependency crosses that
line, with nothing to catch it ahead of time.

**Test files under `src/` are exempt from this rule.** A file that ends in `.test.js` or
`.test.jsx` is never bundled for the browser — Vitest runs it directly under Node, where
node-only dependencies are available. A test-only import from `electron/` is therefore harmless
as long as the import is narrowly scoped to the specific utility under test. Current examples:

- `src/utils/ensureCohort.race.test.js` imports `openLocalDb` and `appendOp` from
  `electron/db/localDb.js` and `electron/ops/operations.js` to exercise the real write path in
  a temporary in-memory database.

**One documented exception for shipping code:** `electron/ops/scheduleTemplateId.js` is a pure,
dependency-free utility (no imports at all) that must live under `electron/` because
electron-builder ships `electron/**` but not `src/`. An electron-side import of a `src/` module
works in `npm run electron:dev` and fails in the installed app at migration time. The renderer
may import this module in the opposite direction safely: Vite bundles whatever it imports into
`dist/`, so `dist/` ships. The module's own header documents this reasoning. Current importers:

- `src/screens/ScheduleScreen.jsx`
- `src/screens/schedule/useRouteState.js`

**A new `src/` → `electron/` import in shipping code requires explicit approval here.** Before
adding one, check: (a) does the module have any imports of its own — if yes, stop and move the
value to `src/utils/` instead; (b) if the module is provably dependency-free forever, document
it in this register with the same three fields: what is imported, from where, and why it cannot
live in `src/`. If neither condition holds, the value must move.

To detect violations mechanically: `grep -r "from '.*electron/" src/ --include="*.jsx" --include="*.js" | grep -v ".test."` lists every non-test shipping import across the boundary. Run it before committing a new file under `src/`.

## 7. Styling is inline React style objects, with one scoped exception

**Global design tokens live in CSS.** `src/index.css` defines `--primary` and the whole token set.
(A dead `src/App.css` of unimported Vite boilerplate — never referenced by any code — was removed
2026-08-29.) The pre-2026-08-06 wording of this section ("no CSS files for component styling")
described a convention that the codebase never actually matched: the token layer has always lived
in `index.css`.

**Component styles are inline React style objects.** Shared constants live in
`src/styles/shared.js`. Token values and their meanings are governed by
[`DESIGN_STANDARD.md`](DESIGN_STANDARD.md), not here.

**One scoped exception: `src/components/schedule/scheduleGrid.css`.** It covers the schedule grid
container, cell interaction pseudo-states (`:hover`, `:focus-visible`, `:focus-within`), and cell
data-attribute states (`[data-collapsed]`, `[data-drag-over]`, `[data-drop-edge]`, …).

*The reason, which is mechanical rather than stylistic:* pseudo-classes and attribute selectors do
not exist in inline styles. On a dense repeated element their absence is paid for with React state
and re-renders across up to 480 cells. In the withdrawn first revision of
`docs/work/specs/2026-08-06-schedule-canvas-redesign.md` that cost was about to justify building a
`<canvas>` ambient layer with a `requestAnimationFrame` paint loop — a parallel renderer, to work
around a styling convention that had never been argued.

*The boundary:* `src/components/schedule/`, and it does not extend beyond it. **Adding a second
stylesheet, or converting another component to CSS, is the drift this exception is scoped to
prevent.** Per-cell computed geometry (`gridRow`, `gridColumn`) and data-derived colours stay inline
on the element that computes them — they are data, not style.

*Consequence:* a **new** ephemeral cell state in the schedule grid is added as a data attribute plus
a rule in `scheduleGrid.css`, not as React state. See
[`docs/adr/2026-08-06-schedule-canvas-visual-layer.md`](../../adr/2026-08-06-schedule-canvas-visual-layer.md)
"Future constraints".

> **Amendment record.** Amended 2026-08-06 by product owner decision (Art. IV human gate), as part
> of T60, closing the T50 schedule-grid migration. The previous wording forbade what
> `scheduleGrid.css` does; leaving it would have left the governing contract contradicting approved,
> shipped code.

## 8. The schedule engine is pure

`src/engine/buildSchedule.js` has no React and no IPC dependency. It is a pure function over its
inputs, seeded so identical inputs produce identical schedules. **Determinism is a product
guarantee**, not an implementation detail — a director must be able to trust that regenerating does
not silently reshuffle work they have already reviewed. Never introduce ambient state, wall-clock
reads, or unseeded randomness into it.

## 9. Code style

- **Validate at boundaries only** — user input, network messages, external APIs. Trust internal code
  and framework guarantees.
- **No error handling for cases that cannot happen.** Defensive code for impossible states hides
  real failures and misleads the next reader into thinking the state is reachable.
- **No premature abstraction.** Three similar lines beat a generalized helper built for a fourth
  case that does not exist.
- **Comments explain why, not what** — a hidden constraint, a workaround, an invariant. The code
  already says what it does.

## 10. Application data location is explicit

`app.setName()` and the userData path are set explicitly in `electron/db/userDataPath.js`, before
any `app.getPath()` call and before `whenReady()`. Never read a path that Electron inferred from
argv: the fallback is its own built-in constant, which put every development clone in one shared
directory while the packaged app used another, with nothing on screen to distinguish them.

Development and packaged builds resolve **different** directories, and the UI must always show which
one is loaded. See [ADR 2026-07-28](../../adr/2026-07-28-explicit-userdata-directory.md).

## 11. Native module ABI

`better-sqlite3` is native and must be rebuilt when switching between Node (Vitest) and Electron.
See [`TESTING_STANDARD.md`](TESTING_STANDARD.md). A mismatch presents as a module-load error or a
startup crash, not as a test failure — do not debug it as a logic bug.
