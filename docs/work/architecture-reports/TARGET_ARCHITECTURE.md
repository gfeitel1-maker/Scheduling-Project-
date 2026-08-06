---
title: "Target Architecture — the trajectory this code is already on"
document_type: architecture-report
status: current
created: 2026-08-04
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
companions: [REPOSITORY_ARCHITECTURE_MAP.md, DEPENDENCY_FLOW_MAP.md, BOUNDARY_AUDIT.md, RESPONSIBILITY_MATRIX.md]
related: [docs/work/specs/architecture-restructure-proposal.md]
---

# Target Architecture

> **SUPERSEDED IN PART — read this first (added 2026-08-04, Phase E).**
>
> This is a dated findings document, not living law. Its analysis is preserved as evidence; several
> of its conclusions have since been decided or resolved and must not be read as open questions:
>
> - **§8 R5 is CLOSED.** The repository-layer policy was decided in
>   [ADR 2026-08-04](../../adr/2026-08-04-repository-layer-policy.md) and written into
>   `ARCHITECTURE_STANDARD.md` §6. A repository is required only where a domain has meaningful
>   shared persistence mapping to centralize; **there is no mandatory repository tier**. Where this
>   report frames screens calling `localClient` directly as a gap, violation, or "structural
>   fiction" (notably rows 3 and 5 of the violations table, and the §8 R5 discussion), that framing
>   is superseded — those call sites are **conforming**.
> - **§8 R2 is CLOSED** by
>   [ADR 2026-08-04](../../adr/2026-08-04-project-lifecycle-authorization-exemption.md) and the IPC
>   surface parity work.
> - **§8 R1 is CLOSED** by `electron/ops/projectionsCoverage.test.js`.
> - **Line references are stale.** `ScheduleScreen.jsx:441, 448, 947` no longer exist;
>   `duplicateWeek` now lives at `src/screens/schedule/useWeeks.js` as a documented conforming hook
>   call. `Sidebar.jsx`'s direct `window.shoresh` use is fixed — no `window.shoresh` reference
>   remains in `src/` outside `localClient.js`.
> - **"~15 screens" is 13.** See `docs/work/runs/2026-08-04-r5-conformance-summary.md` for the
>   precise, current enumeration.

**This is not a redesign.** The question answered here is narrower and more useful: if development continued for two more years with the current team, the current constraints, and the current architectural instincts, what would this code naturally become?

The answer is mostly reassuring. The load-bearing decisions — op-log-everything, a pure engine, a hard IPC seam, no router, two non-canonical routes — are the kind that get *more* valuable as a codebase grows, not less. The trajectory is not toward a rewrite. It is toward a handful of currently-implicit seams becoming explicit, mostly under pressure from features that already have obvious names.

**Styling is a convention, not a load-bearing decision.** It appeared here in that list, and it does not belong beside the four above: each of those was argued, and the styling rule never was — its earliest appearance is a tech-stack line in a since-superseded plan. The actual convention: global design tokens live in CSS (`src/index.css` defines `--primary` and the whole token set); component styles are inline React objects with `src/styles/shared.js` as the shared-token module; and there is **one scoped exception**, `src/components/schedule/scheduleGrid.css`, covering the schedule grid container, cell interaction pseudo-states, and cell data-attribute states. The reason is narrow and specific: pseudo-classes and attribute selectors do not exist in inline styles, and on a dense repeated element their absence is otherwise paid for with React state and re-renders across up to 480 cells. **The boundary is `src/components/schedule/` and does not extend beyond it.** Per-cell computed geometry (`gridRow`, `gridColumn`) and data-derived colours stay inline. A **new** ephemeral cell state is added as a data attribute plus a rule in `scheduleGrid.css`, not as React state ([ADR 2026-08-06](../../adr/2026-08-06-schedule-canvas-visual-layer.md), "Future constraints").

This correction matters beyond tidiness: while the rule was still stated as "inline only, no CSS files," it was about to justify building a `<canvas>` ambient layer with a `requestAnimationFrame` paint loop, purely to buy back hover. An unargued convention promoted to load-bearing will be paid for in architecture.

---

## 1. Which modules are likely to grow, and why

### `electron/ops/` — grows steadily, and this is the healthy direction

The strongest habit visible in this codebase: when a main-process operation grows past "a handler body," it becomes a module in `electron/ops/`. `deleteRecord`, `deleteWeek`, `duplicateWeek`, `restore`, `ingest`, `trash` all followed that path. Newest work (the S3 week slices) followed it without prompting.

Expect this directory to keep accreting one module per consequential operation. That is fine — each has one reason to change and the directory has no coupling problem. The thing to watch is `trash.js`, which currently holds both deleted-record listing *and* entity history. Those are two different questions about the same table, and a history feature of any weight will split them.

### `electron/db/localDb.js` — grows monotonically and should not be split

At 1527 lines and 28 migrations, this file will pass 2000 lines. That is not a smell. Migrations are immutable history; a migration has no independent reason to change once shipped. Splitting into 28 files would produce 28 files nobody ever edits and would make the version-ordering logic — the genuinely subtle part (`:1264–1271`) — harder to see, not easier.

What *will* eventually need to move out is the non-migration logic: `repairMissingScheduleTemplates` (`:1400–1455`) and `parseSlotFlags` (`:1366–1374`). Not urgently, and `parseSlotFlags` has a hard packaging constraint keeping it there.

### `src/screens/schedule/` — grows, and is the pattern's success story

Seven hooks and five pure helpers, each independently tested. Every new schedule capability of the last several cycles landed here rather than in the screen. Expect ten to fifteen modules within two years. The directory is the right shape for that.

### `src/data/` — grows from one file to several, under feature pressure

Currently one repository, covering one domain. This will not stay at one — but it will not grow on architectural principle either. It will grow the first time a non-schedule entity needs the same treatment schedule slots needed: a shared row-mapping that three call sites were drifting on. `activities` is the most likely second, because it is the entity with the most fields, the most screens touching it, and an existing partial hook into `scheduleRepository` (`writeActivityFields`).

### `electron/sync/` — grows in message types, not in files

`syncServer.js` and `syncClient.js` are large because the protocol is large, and each message handler is thin. New capabilities add message types, not structure. The two files will keep growing; the moment to reconsider is when a *third* participant type appears (see §5).

### `ScheduleScreen.jsx` — shrinks, if the current trajectory continues

This is the one module whose current direction is *downward*. C1, C2 and C5 in the existing restructure proposal remove roughly 200 lines between them; a week-management hook removes another 40. That trend continues only as long as new schedule work keeps landing in hooks. Week CRUD shows it is not automatic.

---

## 2. Seams that are implicit today and will need to become explicit

Six, ordered by how soon the pressure arrives.

### 2.1 "Every writable entity is registered in `PROJECTIONS`"

**Today**: an unwritten rule, violated three times (`schedule_snapshots`, `template_overlays`, `is_locked`), caught each time by a human noticing that data was silently not saving.

**Pressure**: every new entity and every new field. This is the highest-frequency risk in the codebase.

**Natural form**: a test in the shape of the one that already exists for `RESTORE_DECISIONS` (`restore.js:5–8`) — enumerate the entities and fields the renderer can write, assert each is registered. The precedent for this seam is already in the repository; it simply has not been pointed at the more fundamental question.

### 2.2 The `localClient` ↔ `preload` surface contract

**Today**: `preload.js` exposes 46 methods; `localClient.js` wraps 37. The other nine have no wrapper, so `Sidebar.jsx` reaches `window.shoresh` directly. Separately, `localClient.mock.js` is missing those nine plus `onFullSyncApplied`, and would crash at runtime under `npm run dev` if they were called.

**Pressure**: every new IPC channel widens the gap three ways at once.

**Natural form**: one exported list of channel names that `preload.js`, `localClient.js`, and `localClient.mock.js` are all checked against by a single test. Not a code generator — a parity assertion.

### 2.3 Route-scoped write safety

**Today**: enforced at each write site independently — `useGeneration`'s explicit setter pinning (`:12–16`), `useSnapshots`' template-id comparison (`:120–123`). Both are correct. Neither is enforced.

**Pressure**: a third route (§4), or any new route-scoped mutation.

**Natural form**: since the route-pinned setters already come from one place (`routeSetter` in `useRouteState.js`), the seam wants to become "you cannot obtain a writer without naming a route" — a shape that is already 80% present. This is adjacent to C5's deepening of `useRouteState`.

### 2.4 The import `pages` representation

**Today**: a real seam with no name. Both parsers produce it; `extractEntities` consumes it; nothing documents its shape or asserts it.

**Pressure**: the third format. See §6.

### 2.5 Device-trust mutation

**Today**: ~80 lines of raw `UPDATE devices` inline in `main.js:449–533`, while every comparable operation has an ops module.

**Pressure**: any change to the pairing model — notably a read-only device role (§5), which would make device trust multi-valued rather than binary.

**Natural form**: `electron/auth/deviceTrust.js`, following the existing ops-module convention exactly.

### 2.6 Load orchestration

**Today**: `loadAll` (`ScheduleScreen.jsx:264–417`) is a 150-line closure crossing 22 setters and four concerns, with a fifth (the week-deleted banner diff) woven in.

**Pressure**: already at the limit — this is C1 in the existing proposal.

---

## 3. Where the two-route pattern will strain

The manual/generated split is well-implemented and constitutionally protected: neither is canonical, switching is pure navigation, and each route's slots live in a separate `schedule_templates` row. Route-keyed state via `useRouteState` is the right mechanism.

Multi-week is where it will feel pressure, for a specific structural reason: **weeks and routes multiply.**

- Every `weekId` change triggers `loadAll`, which loads *both* routes in full (`ScheduleScreen.jsx:374–403`). This is deliberate — it is what makes route switching instantaneous. But the cost is `O(weeks changed × routes)`, and it grows if a route is added, not if weeks are.
- A director working across eight weeks of a season, switching weeks frequently, is doing sixteen template loads' worth of work to look at eight schedules.
- `schedule_snapshots` is excluded from full sync to bound growth (`syncServer.js:22–24`). Snapshots are per-template, so their count scales with weeks × routes × edits-per-season. Version history is the schedule feature most likely to hit a real ceiling first.
- Per-slot flag semantics differ by route (`UNFILLABLE` generated-only, `OVERLAP` manual-only, derived at render). Each new route-aware feature must answer this question again, and there is no single place where the answer lives.

**The trajectory**: the two-route pattern itself holds. What strains is the *eager both-routes load*, and the natural evolution is lazy per-route loading with the non-visible route hydrated in the background — a change that C1's `useScheduleData` extraction makes cheap and that is nearly impossible while `loadAll` is a screen closure.

---

## 4. Where the god-component pattern is sustainable, and where it breaks

`ScheduleScreen.jsx` is not really a god component. It is a large orchestrator over a well-factored set of hooks — the state was already extracted; what remains is composition. That distinction determines where it holds.

**Sustainable indefinitely:**
- *Hook composition.* Wiring seven hooks together is what an orchestrator is for. An eighth or a tenth changes nothing structurally.
- *Modal and drawer hosting.* Ten modals in one screen is verbose, not incoherent. Each is presentational and prop-driven.
- *View switching* between group/day/activity. Three views over one dataset is one concern.

**Already breaking:**
- *`loadAll`.* Four concerns, 22 setters, untestable without a full mount. This is past the line today.
- *DnD handlers.* Verbatim duplication across two handlers means one bug requires two fixes. Also past the line.

**Will break next, in order:**
1. **Week management.** Six CRUD handlers inline in JSX, and this is the *active* feature area. Multi-week work will keep landing here, and it is the one cluster with no hook to land in. This is where the next unpleasant merge conflict lives.
2. **Findings presentation.** `findingReason` (`:647`) already generates director-facing copy in a render file. A third finding kind, or localization, forces it out.
3. **Route-transient reset.** The reset block (`:255–262`) resets some state on route switch and not other state, with no documented rationale. Each new piece of screen state adds a coin-flip to that list.

**The honest read**: this file is on a downward trajectory for the first time. Whether it stays there depends entirely on whether the next feature lands in a hook or in the render body — and the last one (week management) landed in the render body.

---

## 5. Natural evolution of the sync layer, given a third device role

Suppose a read-only viewer role is added — a device that shows the schedule on a wall display but can never write. Trace it through the code that exists:

**What already works, unmodified:**
- `authorize()` re-queries role on every call, so a `viewer` role is a `permissions.js` entry with only `*.read` actions. No new enforcement mechanism.
- The WS server gates every mutating message behind `authorize()` against the connection's own token (`syncServer.js:518–526`), so a viewer's `submit_op` is denied by the existing path.
- Full sync and `sendMissedOps` are role-blind — a viewer receives ops exactly like anyone else. Correct: it needs the data, just not the ability to change it.
- The `local`-vs-`camp` token distinction is orthogonal to role and needs no change.

**What strains:**

1. **Device trust becomes multi-valued.** `devices` currently encodes trust as `authorized_at` / `revoked_at` / `pairing_status` — binary. A viewer is authorized *and* restricted. Role lives on `users`, not `devices`, so a viewer is currently expressible only as a *user* with a viewer role, which means the wall display needs a login. If the product wants a device that shows the schedule without anyone logging in, that is a genuinely new concept and it lands squarely on the inline raw-SQL device-trust code in `main.js:449–533` — the seam identified in §2.5. **This is the concrete feature that forces that extraction.**

2. **`sendFullSyncIfFirstPairing` gets a filter.** Today it ships `users` and `camps` to every newly-paired device. A wall display in a public space arguably should not receive the `users` table. That means the full-sync payload becomes role-dependent, and its all-or-nothing latch (`last_synced_at` set only after the Client's `full_sync_applied` ack) has to stay correct across differently-shaped payloads.

3. **The advisory lock model needs a rule.** Locks are presence hints (`lockManager.js:1–9`). A viewer should never acquire one. The current path denies it by role, but the lock table would benefit from never seeing viewer devices at all.

4. **Broadcast fan-out stops being trivial.** `sendMissedOps` serially awaits `sendWithAck` per op (`syncServer.js:305–309`). Fine at camp scale with a handful of devices. A deployment with several always-on displays plus staff devices multiplies a per-row round-trip loop by device count. Batching becomes worth doing at roughly the same moment a third role appears — not before.

**The trajectory**: the sync layer absorbs a viewer role well, because its trust boundary is drawn in the right place and re-checked on every message. The pressure lands on `devices` (trust becomes a spectrum), on the full-sync payload (becomes role-shaped), and on fan-out performance — not on the protocol.

---

## 6. Natural evolution of the import layer

Today: two formats (`.xlsx` family, `.txt/.csv/.tsv`), forked by a hardcoded `if/else` on file extension (`ImportScreen.jsx:73–86`), both producing a common `pages` representation consumed by `extractEntities`.

**This is better positioned than it looks.** The intermediate representation is the hard part of a pluggable importer and it already exists. The main process is format-blind by construction — `commitIngest` receives approved names and validates against a whitelist, so no new format touches it at all. That is the property that keeps adding formats cheap.

**Trajectory:**

1. **Two formats justify an `if/else`. Three justify a registry.** The natural minimal form is a map from extension to parser, with `readFiles` looking up rather than branching. Not a plugin architecture — a lookup table.
2. **`pages` acquires a documented shape.** Currently it is whatever both parsers happen to produce. A third parser written by someone who did not write the first two is the moment this needs to be written down and asserted.
3. **Confidence scoring becomes format-aware.** Confidence currently drives the default-checked state (`:111–121`). Different sources carry different reliability; a structured export deserves higher default confidence than a text grid. That is a parameter on the parser, not a change to `extractEntities`.
4. **The non-transactional pre-delete becomes untenable.** Replace mode deletes existing records in a loop (`:146–153`) *outside* the transaction that then creates the new ones. Today the exposure is a single-user, single-device flow. A second import source, or an import that runs longer, makes a partial failure — entities deleted, nothing created — a real support call. The natural fix is to move the delete inside `commitIngest`'s existing transaction, which is a main-process change, not a screen change.

**What will not happen naturally, and should not be forced**: a generic "data source connector" abstraction. Every source this app plausibly ingests is a grid of names in a file. The `pages` representation is already the right level.

---

## 7. Dependency rules

### The rule

```
Screens                     src/screens/*.jsx
  ↓
Hooks                       src/hooks/*, src/screens/schedule/use*.js
  ↓
Repositories                src/data/*
  ↓
localClient                 src/localClient.js
  ↓  ═══════ IPC seam ═══════  electron/preload.js
Handlers                    electron/main.js
  ↓
Ops                         electron/ops/{operations,projections}.js + operation modules
  ↓
SQLite                      better-sqlite3
```

**No layer calls upward.** Additionally:
- **Components** (`src/components/**`) sit *beside* screens, not in the stack. They receive props and emit callbacks. They perform no IO.
- **The engine** (`src/engine/**`) sits outside the stack entirely. Pure functions in, pure data out. It may import nothing and be imported by hooks and screens.
- **Pure helpers** (`gridGeometry.js`, `findingHighlight.js`, `computeOverlaps.js`, …) likewise sit outside.
- **`electron/**` must never import from `src/**`.** Enforced by reality as much as convention: electron-builder does not package `src/`, so such an import works in dev and breaks in the packaged app (see `localDb.js:1358–1365`, which documents having hit exactly this).

### Current violations

| # | Violation | Location | Severity | Direction of drift |
|---|---|---|---|---|
| 1 | Component → IPC seam, skipping `localClient` | `Sidebar.jsx:133–143` | Medium | Recent code; the only instance in `src/` |
| 2 | `localClient` does not wrap 8 preload methods + `onFullSyncApplied` | `localClient.js` vs `preload.js` | Medium | Root cause of #1 |
| 3 | Screen → `localClient`, skipping the repository | `ScheduleScreen.jsx:441, 448, 947` | Low–Medium | `duplicateWeek` is the substantive one |
| 4 | Component performs IO | `DeleteWeekDialog.jsx:16, 25, 42` | Low | Mitigated by prop injection |
| 5 | ~15 screens → `localClient`, skipping a repository tier | non-schedule screens | Low each, structural in aggregate | **Not carelessness** — the tier does not exist for those entities |
| 6 | Op-replay logic inside the DB migration module | `localDb.js:1400–1455` | Low | Local-only, migration-scoped |

**Not found, and worth stating explicitly**: no upward call anywhere. No hook imports a screen. No `electron/` file imports `src/`. The engine imports nothing. No renderer code touches SQLite. No domain write bypasses the op log.

**On violation #5**: the layering rule as written describes an aspiration for one domain and a fiction for the rest. Either the rule should say "repositories exist where a domain has shared mapping logic; otherwise hooks call `localClient`," or ~15 repositories should be written. The first is closer to what the code has actually chosen, and closer to what is worth doing.

---

## 8. Prioritized roadmap

Five initiatives. The existing `docs/work/specs/architecture-restructure-proposal.md` covers C1, C2, C4, C5, C6 at the code level and remains the implementation authority for those; this roadmap sits above it and includes work it does not cover.

**Ordering principle**: correctness guards before ergonomics; things that prevent silent data loss before things that reduce line counts.

---

### R1 — Registry enforcement for `PROJECTIONS`

**Why.** An op for an unregistered entity is durably logged and silently discarded (`projections.js:452`); an unregistered entity gets no field validation at all (`operations.js:78–80`). This has shipped wrong three times — `schedule_snapshots`, `template_overlays`, `is_locked` — each caught by a human noticing data was not saving. It is the only failure mode in this codebase where the app reports success and loses the write. Every new entity or field re-rolls the dice.

**Risk.** Low. Test-only; no production code path changes. The main risk is scope creep into "fix the zero-camps `camp_id = NULL` caveat while we're here" — that is a separate question and should stay separate.

**Effort.** S.

**Dependencies.** None. Can start today. The pattern already exists at `restore.js:5–8`.

**Stopping condition.** A test fails when an entity or field reachable from a renderer write path is absent from `PROJECTIONS`. Demonstrated by temporarily removing a registered field and watching it go red.

---

### R2 — IPC surface parity

**Why.** Three artifacts describe one contract and none agree: `preload.js` exposes 46 methods, `localClient.js` wraps 37, `localClient.mock.js` implements neither the missing nine nor `onFullSyncApplied`. The visible consequences are `Sidebar.jsx` reaching `window.shoresh` directly (the app's only such violation) and a class of `npm run dev` crashes that no test can catch. Every new channel widens the gap three ways.

**Risk.** Low–Medium. Wrapping the project-lifecycle methods in `localClient` is mechanical. The judgement call bundled in: those handlers are also the only ungated ones in `main.js` (`:1046–1266`) with no recorded rationale. **Decide and record whether that exemption is intentional** — do not silently add `authorize()` to `restore-project` as a drive-by, since it overwrites the live database and a wrong answer either breaks recovery or leaves a gap.

**Effort.** S–M.

**Dependencies.** None. Independent of R1.

**Stopping condition.** A test asserts every `preload.js` channel has a `localClient` wrapper and a `localClient.mock.js` implementation. `grep -rn 'window\.shoresh' src/ | grep -v localClient` returns nothing. The project-lifecycle authorization decision is written down — in an ADR or an inline comment matching the style of the pre-session exemptions.

---

### R3 — Land the existing restructure proposal (C4 → C5 → C1, plus C2, C6)

**Why.** C1 is the largest single lever in the renderer: `loadAll`'s four concerns and 22 setters are what make the schedule load path untestable without a full mount, and — per §3 — what makes lazy per-route loading impossible. C2 removes a verbatim duplication where one bug needs two fixes. The proposal has already been through an Architect pass, a Red Hat pass, and Governor verification of the two claims where those disagreed; two of the original audit's own proposals were verified wrong and corrected in it.

**Risk.** Medium — the highest in this roadmap. C1 touches the load path every schedule feature depends on, and folds in a pre-existing `loadAll` re-entrancy fix. Mitigated by the proposal's sequencing (`C4 → C5 → C1`, C2 and C6 independent), its explicit behavior-preservation constraint on C2 (group view does **not** gain slot-swap), and its non-goals — no persisted shape, migration, op-log, or projection change.

**Effort.** L in aggregate; each candidate is S–M and its own ticket and commit. C4 and C1 each warrant their own Verifier gate run.

**Dependencies.** Internally sequenced as above. R1 should land first — C4 touches `campScopedEntities.js` and `schema.sql`, and a registration guard is worth having in place before touching read scoping.

**Stopping condition.** Each candidate's own stopping condition and deletion test, as written in the proposal. Overall: `ScheduleScreen.jsx` no longer contains `loadAll`; the two DnD handlers share one resolution path with group view's behavior unchanged; the proposal is archived per its own `archive_when`.

---

### R4 — Extract week management to `useWeeks`

**Why.** Six CRUD handlers (create, rename, archive, unarchive, duplicate, delete) are inline JSX callback bodies at `ScheduleScreen.jsx:919–956`. Every comparable mutation cluster in this screen — slots, generation, snapshots, undo/redo, clipboard, overlay/stamp — was extracted into a tested hook. Week management is the newest of the seven and the only one that was not. This is the clearest instance of architectural drift this audit found, and multi-week is the active feature area, so the cost compounds. It also removes the last reason for the screen to call `localClient.duplicateWeek` directly (violation #3).

**Risk.** Low–Medium. Mechanical extraction into a shape that six siblings already demonstrate. The real risk is scope: `DeleteWeekDialog`'s self-fetching (`:16, 25, 42`) is adjacent and tempting. **Leave it alone in this initiative** — it fetches live delete counts, which is a genuine need, and reshaping that is a separate decision.

**Effort.** M.

**Dependencies.** After R3's C1. `useScheduleData` will own week loading and `liveWeekId` resolution; `useWeeks` owns week *mutation*. Building the second before the first means writing the seam twice.

**Stopping condition.** No week CRUD logic remains in `ScheduleScreen.jsx`'s render body. `useWeeks` has a test file matching the coverage shape of `useSnapshots.test.js`. `ScheduleScreen.jsx` no longer imports `localClient` for week operations.

---

### R5 — Decide and record the repository-layer policy

**Why.** The documented rule says Screens → Hooks → **Repositories** → localClient. Exactly one repository exists, covering one domain. About fifteen screens necessarily bypass a tier that does not exist for their entities, and three screens mix repository calls with direct `localClient` calls for the *same* entities. A reader looking for "the way schedule data is written" finds two coexisting patterns in one file. This is not a bug — no data is at risk — but an architectural rule that is 90% aspiration teaches new contributors that the rules are decorative, which is how the other drift in this audit happened.

**Risk.** Low technically; the risk is choosing wrong. Writing fifteen repositories to satisfy a rule would add fifteen pass-through files with no shared mapping logic to justify them — the deletion test would fail for most of them. The recommendation is the opposite: **amend the rule to match the code's actual, sound choice** — a repository exists where a domain has shared row-mapping logic worth centralizing (as `mapSlotToRow` demonstrably was, having replaced three drifting copies); otherwise hooks call `localClient` directly. Then name the one or two domains that currently qualify (`activities` is the strongest candidate) and leave the rest.

**Effort.** S for the decision and the ADR; M if `activities` gets a repository as the first application.

**Dependencies.** After R2, which resolves the `localClient` surface those hooks would call.

**Stopping condition.** An ADR records the policy with its rationale. `ARCHITECTURE_STANDARD.md`'s layering section matches it. Every current deviation is either resolved or explicitly listed as conforming under the amended rule.

---

### Deliberately not on this roadmap

Named so their absence reads as a decision:

- **Splitting `localDb.js`.** Migrations are immutable history with no independent reason to change. Splitting makes the subtle part — version-ordering (`:1264–1271`) — harder to see.
- **Splitting `syncServer.js` / `syncClient.js`.** Large because the protocol is large; every handler is thin. Revisit only if a third device role lands (§5).
- **A generic import connector abstraction.** Every plausible source is a grid of names in a file. `pages` is already the right level. Add a lookup table at the third format; nothing more (§6).
- **Fixing the FK-DELETE divergence** (`syncClient.js:427–451`). Deliberately unfixed, with a stated rationale: cascading locally means guessing at a cascade the Host did not perform. Changing it is a product decision about conflict semantics, not a refactor.
- **Indexing `operations`.** `listDeleted`'s full scan (`trash.js:9–13`) is a known, bounded ceiling that camp-scale data does not reach. The feature that forces it is a change feed (RESPONSIBILITY_MATRIX X3). Do it then, with a real query to measure.
- **An offline queue for `writeBulkReplace`.** An explicit scope cut (`syncClient.js:1008–1018`). It becomes necessary when offline schedule editing becomes a product goal, and not before.
