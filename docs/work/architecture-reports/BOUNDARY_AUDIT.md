---
title: "Boundary Audit"
document_type: architecture-report
status: current
created: 2026-08-04
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
companions: [REPOSITORY_ARCHITECTURE_MAP.md, DEPENDENCY_FLOW_MAP.md, RESPONSIBILITY_MATRIX.md, TARGET_ARCHITECTURE.md]
related: [docs/work/specs/architecture-restructure-proposal.md]
---

# Boundary Audit

> **SUPERSEDED IN PART — read this first (added 2026-08-04, Phase E).**
>
> This is a dated findings document, not living law. Its analysis is preserved as evidence; the
> following conclusions have since been decided and must not be read as open findings:
>
> - **The repository-layer finding is resolved.** Per
>   [ADR 2026-08-04](../../adr/2026-08-04-repository-layer-policy.md) and `ARCHITECTURE_STANDARD.md`
>   §6, there is **no mandatory repository tier**. Statements here that non-schedule screens calling
>   `localClient` directly are "the single largest structural gap", that the pattern is
>   "half-adopted", or that those screens "necessarily bypass a tier" are superseded — those call
>   sites are **conforming**. No migration plan is wanted; the ADR is the recorded decision.
> - **The four-tier chain is not the rule.** Where this document states
>   `Screens → Hooks → Repositories → localClient` as *the* layering rule, the current rule is the
>   two approved shapes in `ARCHITECTURE_STANDARD.md` §6.
> - **`DeleteWeekDialog`'s component IO is an approved exception**, not a finding. The approved
>   class and its full membership are now registered in `ARCHITECTURE_STANDARD.md` §6 — that
>   register, not this document, is the record.
> - **Line references are stale.** `ScheduleScreen.jsx:441, 448, 947` and `:1439-1440` no longer
>   exist; `ScheduleScreen.jsx` now has zero domain `localClient` calls.
>
> Two component-IO violations this audit did not catch (`Sidebar.jsx`, `RecordHistory.jsx`) are
> tracked in `docs/work/tickets/T47-component-io-outside-the-approved-exception.md`.

Module by module: what it does today, whether that is one job or several, what it holds that belongs elsewhere, and whether newer work is using it or routing around it.

**Working assumption**: the architecture is generally correct. Almost every boundary in this codebase is deliberate and commented. This audit looks for evidence of drift, not for opportunities to redesign. Where a file is large, the question asked is "does it have more than one independent reason to change?" — never "is it over N lines."

**Headline**: the two invariants that would be most expensive to lose — *all domain writes go through the op log*, and *the engine is pure* — are both intact, with zero violations found. The drift that exists is concentrated in the renderer's data-access layer and in one under-enforced registry.

---

## `src/screens/ScheduleScreen.jsx` (1458 lines)

**What it does today**: orchestrates both schedule routes. Loads all data (`loadAll`, `:264–417`), owns week selection and week CRUD, wires seven hooks together, hosts two `DndContext` trees with their handlers, derives the findings rail and its user-facing copy, and renders three views plus roughly ten modals and drawers.

**Cohesive?** No. It has at least six independent reasons to change: data loading, week management, DnD resolution, findings presentation, route/view selection, and layout. A change to any one of these touches this file.

**But size is not the finding.** The genuine mitigations are real and should be credited: the heavy state clusters were already extracted into `src/screens/schedule/*` (seven hooks plus five pure helpers), each independently tested. The remaining file is an orchestrator, and orchestrators legitimately reference many things. The specific findings are:

- **`loadAll` is doing four jobs in one closure** (`:264–417`): setup catalog, week resolution, week exclusions, template data — plus a fifth cross-cutting one, the "week deleted on another device" banner diff (`:338–343`) which compares against the previous `weeks` value captured in closure. Twenty-two state setters cross this function. None of the four concerns can be exercised without mounting the entire screen. This is C1 in the existing restructure proposal.

- **The two DnD handlers duplicate their expand-drag branch verbatim.** `handleGroupDragEnd` (`:510–550`) and `handleDayDragEnd` (`:559–611`) share identical logic at `:517–537` and `:566–585`; only the swap-slot tail differs (day view has it, group view does not). A bug fix must be applied twice. This is C2.

- **Week CRUD has no hook.** Every other mutation cluster in this screen was extracted — slots, generation, snapshots, undo/redo, clipboard, overlay/stamp. Week create/rename/archive/unarchive/duplicate/delete are still written inline as JSX callback bodies at `:919–956`, each doing its own `repo` call and its own `setWeeks`. This is the single largest inconsistency in an otherwise consistent extraction pattern, and it is not covered by the existing C1–C6 proposal.

- **`findingReason` (`:647–659`) is domain copy in a render file.** It branches on `f.kind` and `isManual` to produce director-facing explanation text. Its natural neighbours are `findingHighlight.js` or a dedicated copy module.

- **`templateRowFor` / `resolveTemplateId` (`:58–69`)** are pure route-template resolution functions defined at module scope here, while the closely related `templateIdFor` lives in `useRouteState.js`. One concept, split across two files.

**Does newer work use it correctly or bypass it?** Mostly correctly — new schedule features have gone into new hooks under `src/screens/schedule/`, which is the right instinct. The exception is week management, which arrived (S3 slices) and stayed inline.

**Should anything move?** Yes, and the existing proposal already scopes most of it (C1, C2, C5). The un-scoped item is week CRUD → a `useWeeks` hook, mirroring the shape of `useSnapshots`.

---

## `src/screens/schedule/useRouteState.js`

**What it does today**: owns the eight by-route state atoms (`existingTemplates`, `templateIdByRoute`, `slotsByRoute`, `statsByRoute`, `findingsByRoute`, `dismissedByRoute`, `snapshotsByRoute`, `overlaysByRoute`) and derives current-route views and setters. Exports `ROUTES`, `EMPTY_BY_ROUTE`, `routeSetter`.

**Cohesive?** Yes — exactly one reason to change: how route-keyed state is shaped. Imports only `useState` and `deriveScheduleTemplateId`. No IPC, no repo.

**Logic belonging elsewhere?** No.

**Finding — a shallow interface over a wide surface.** It exposes all sixteen raw `xByRoute` / `setXByRoute` pairs *plus* the eight derived current-route views. Callers (chiefly `loadAll`) drive the raw setters twelve times in a row. This is the C5 "deepen `useRouteState`" candidate; the proposal correctly narrows the honest scope, having verified that the raw setters are used outside `loadAll` too.

**Route-keying gaps in the screen, not the hook.** `view`, `selectedGroup`, `selectedDay`, `selectedActivity`, `weatherMode`, and `railView` are plain screen state, not route-keyed, even though each is meaningfully per-route. The route-switch transient reset (`ScheduleScreen.jsx:255–262`) resets undo/redo, clipboard, `editSlot`, and overlay-fill/stamp, but deliberately leaves the rest. The comment at `:240–254` states the principle ("nothing persisted is touched") but does not explain why `editSlot` is inside the reset and `selectedGroup` is outside. Most of these self-heal on the next render; `railView` can persist across a route switch showing a filter (`UNFILLABLE`) that is meaningless in the route now displayed. Low severity, but the policy is currently undocumented rather than decided.

---

## `src/screens/schedule/useSlotMutations.js` (~522 lines)

**What it does today**: ten write handlers — `editSlotSave`, `swapSlots`, `dismissFlag`, `lockActivity`, `releaseCell`, `addOverlay`, `removeOverlay`, `updateOverlayRange`, `placeActivityManual`, `expandSlot`, `splitSlot` — each following read → `repo` write → optimistic patch → `pushUndo`.

**Cohesive?** Yes. One reason to change: how a cell or overlay write commits and records its inverse. Owns no state of its own (stated in its header, `:8–11`); everything arrives through `routeState` and `repo`.

**Logic belonging elsewhere?** No. But the file is long because each of the ten handlers repeats the same four-step boilerplate nearly identically, with no shared helper. That is duplication within a cohesive module — a readability cost, not a boundary problem, and extracting a `withUndo(...)` wrapper would be a reasonable small improvement rather than a restructure.

**Used correctly?** Yes. Every schedule write in the app goes through it. The route-pinned setters mean no handler can write to the wrong route.

---

## `src/screens/schedule/useGeneration.js`

**What it does today**: `generate`, `regenFromScratch`, `placeAnchors`. Calls the pure engine, then persists via `repo.replaceWeek`.

**Cohesive?** Yes.

**Notable good boundary decision, worth protecting**: it builds explicit generated-route setters via `routeSetter` rather than using "the current route" (`:12–16`), specifically to survive a same-tick `setRoute`. This is the kind of decision that looks like redundancy until someone removes it. It should be treated as load-bearing.

**Second good decision**: the auto-snapshot before replacement aborts the entire generation if the snapshot write fails (`:96–104`). Generation can never destroy prior work to make room for a proposal.

**Nothing to move.**

---

## `src/screens/schedule/useSnapshots.js`

**What it does today**: save, delete, restore, rename.

**Cohesive?** Yes.

**Notable**: `restoreSnapshot` compares `fullSnap.template_id !== templateId` and refuses across routes (`:120–123`). Combined with `useGeneration`'s explicit pinning, the two-route invariant is enforced at each write site rather than centrally — defensible, since there is no single chokepoint that all route-scoped writes pass through, but it does mean each new route-scoped feature must remember to add its own guard. There is no test or lint that would catch a new one forgetting.

---

## `src/engine/buildSchedule.js`

**What it does today**: the three-pass placement algorithm plus `computeFindings`.

**Cohesive?** Yes, and it is the cleanest module in the repository. Zero imports. Deterministic. Fully unit-tested independent of React, Electron, and SQLite.

**Logic belonging elsewhere?** No. The reverse question is more interesting — is anything *outside* it that belongs *in* it? `computeOverlaps` (`src/utils/computeOverlaps.js`) derives the manual-route-only `OVERLAP` flag at render time and is deliberately not persisted. That placement is correct: `OVERLAP` is a view concern about a schedule the director is building by hand, not an engine judgment about a schedule the engine produced.

**One duplication to track**: `djb2` is copied verbatim into `src/components/schedule/slotCellConstants.js:123–125`, with a comment explaining the copy exists to avoid coupling the pure engine to a UI file. That justification is sound. The consequence is that if the hash ever changes, the two must change together — though the UI copy only drives colour assignment, so a divergence would recolour activities rather than corrupt scheduling.

**Verdict**: do not touch this module's boundary. It is the reference example the rest of the codebase should be measured against.

---

## `src/screens/ImportScreen.jsx`

**What it does today**: file reading, two-format parsing, entity inference, duplicate detection, an approval UI, and a one-shot commit.

**Cohesive?** Arguably yes as a *flow* — it is one user journey with one exit. The heavy lifting is already delegated to `src/ingest/*`.

**Findings**:
- **Format support is a hardcoded `if/else` on file extension** (`:73–86`). The `pages` intermediate representation is a genuine extension seam, but there is no registry or strategy interface. Adding a third source means editing this branch.
- **Replace mode's pre-delete is a non-transactional loop** (`:146–153`) while the commit itself is transactional (`ingest.js`). A failure between them leaves entities deleted and nothing created. This asymmetry is real and undocumented.
- **The main process does not re-validate the inference, only the whitelist.** Correct for the current trust model (the payload is a list of names from the same user on the same device), but it means the whitelist is the entire defence at that seam.

**Used correctly?** It is the only screen that departs from the app-wide `load()`/CRUD pattern, and appropriately so — its header comment says as much.

---

## `electron/main.js` (1323 lines)

**What it does today**: Electron window/lifecycle, the `makeHandlers()` closure exposing every renderer-facing operation (`:131–879`), and a separate project-file lifecycle block (`:1020–1266`) that swaps the live `db`/`deviceId`/handler set.

**Cohesive?** Largely yes as an IPC handler layer, and better than its line count suggests. Nearly every handler is thin: validate → `authorize()` → delegate to `ops/*` or `syncClient`. **It contains no schedule-domain business logic** — `deleteRecord`, `deleteWeek`, `duplicateWeek`, `restoreEntity`, `commitIngest` are all real delegations. That is the discipline working.

**Two genuine asymmetries:**

1. **Device-trust mutation is inline raw SQL, not an ops module.** `approveDevice`, `denyDevice`, `revokeDevice`, plus the Host auto-authorize paths, are ~80 lines of handler bodies with direct `UPDATE devices` statements (`:449–533`). Every other consequential mutation in this app earned a dedicated `electron/ops/` or `electron/auth/` module once it grew non-trivial. Device trust — which decides whether a machine on the LAN can read a camp's data — did not. It predates the convention and was never retrofitted. The SQL itself is correct and admin-gated; the finding is that this logic is harder to test and audit than its importance warrants.

2. **The project-file lifecycle block is a second, structurally different category bolted into the same file.** These handlers mutate module-level `db`/`dbPath`/`deviceId` and re-register the handler set. `electron/db/projectManager.js` already exists and is imported for the pure I/O parts (`writeUserBackup`, `rotatePreResolveBackups`, `readRecentProjects`), but the handler bodies — dialogs, validation, `reinitialize()` — stay in `main.js`.

**Authorization gap in the same block.** Every one of `get-current-project`, `create-project`, `open-project`, `export-project`, `backup-project`, `restore-project`, `list-recent-projects`, `open-recent-project` skips `authorize()` and takes no token. `restore-project` overwrites the live database file; `open-project` swaps which camp's data the app is looking at. These are gated only by the OS file dialog. This may well be the intended model — there is no per-device concept of "who may switch projects," and the operations are device-local rather than networked. But it is **the only group of un-`authorize()`d handlers in the file without an inline comment justifying the exemption**, whereas each pre-session exemption (`chooseMode`, `bootstrapCamp`, `discoverHosts`) carries an explicit rationale. The finding is the missing decision record, not a confirmed vulnerability.

**Is newer work following the pattern?** Yes, clearly. The schedule-weeks slice (`duplicateWeek.js`, `deleteWeek.js`, `scheduleTemplateId.js`) follows the established ops-module convention well — HOST-ONLY rationale documented, transactional, `appendOp`-only, ops returned rather than broadcast.

---

## `electron/ops/operations.js` and `projections.js`

**What they do today**: `operations.js` owns `appendOp`, `appendBulkReplaceOp`, conflict detection/recording, and value coercion. `projections.js` owns the `PROJECTIONS` registry and `applyProjection`.

**Cohesive?** Yes, both. The split is clean: `operations.js` owns the log, `projections.js` owns the materialization. Neither reaches into the other's table. Both are called identically from `main.js`, `syncServer.js`, and `syncClient.js`, which is the strongest available evidence that they are free of caller-specific assumptions.

**The one structural weakness in the whole main process:**

**An op for an entity absent from `PROJECTIONS` is durably logged and then silently discarded** (`projections.js:452`). No throw, no warning, no row. And `appendOp`'s field allowlist check only fires for entities that *are* registered (`operations.js:78–80`), so an unregistered entity receives no validation at all — just silent logging.

This is not theoretical. `projections.js:328–397` records that `schedule_snapshots` and `template_overlays` shipped unregistered and silently no-op'd for a period. `is_locked` was a third instance (fixed in T37, now at `projections.js:128`). Three occurrences of the same failure mode.

The silent-no-op contract is itself correct and deliberate (`operations.js:95–106`): a Host replaying a remote Client's op must not abort mid-transaction. The gap is that **nothing structurally enforces "every entity the renderer can write is registered."** Contrast with `restore.js:5–8`, where `restore.test.js` fails if a new `PROJECTIONS` entity lacks an explicit `RESTORE_DECISIONS` entry — a guard exists for the *restorability* decision but not for the more fundamental *registration* one. This is the highest-value gap this audit found.

**Known residual defects, acknowledged in-code and unfixed**: `schedule_templates.ensureExists` can leave a NULL-`week_id` orphan row under a specific write-ordering race, documented as "harmless clutter" (`projections.js:286–299`). Nine entities' `ensureExists` implementations repeat verbatim the same zero-camps caveat (a zero-camp database silently inserts `camp_id = NULL`) rather than resolving it once centrally.

---

## Raw SQL audit

Every write to a `PROJECTIONS`-registered table goes through `appendOp`/`appendBulkReplaceOp`. **No genuine violation found.** Raw SQL is confined to tables deliberately outside the synced model:

| Location | Table | Verdict |
|---|---|---|
| `main.js:117, 278–279, 362–363, 434, 479, 496, 515` | `devices` | Justified — device trust/pairing metadata, deliberately never synced as domain data (mirrored by `restore.js:30` refusing to restore `devices`) |
| `main.js:408, 417` | `camps` (bootstrap only) | Justified — `camps` is a singleton whose only creation path is `bootstrapCamp`; `projections.js:17–21` documents this exemption and refuses to create it via a normal op |
| `main.js:443` | `device_identity` | Justified — device-local sync bookkeeping |
| `localAuth.js:274–280` | `login_attempts` | Justified — auth rate-limiting state |
| `localAuth.js:44–51, 109–116` | `host_signing_key`, `camps.signing_public_key` | Justified — same bootstrap-singleton exemption. The actual user row goes through the injected `write` callback → `appendOp` |
| `localDb.js` | all | Excluded by rule — migrations |

**The one near-miss, and it is worth being precise about**: `duplicateWeek.js:71–74` does `INSERT OR IGNORE INTO schedule_weeks (...)` directly, on a schedule-domain table, to pre-seed the row so child FK references resolve. The same fields are then written through `appendOp` immediately afterward (`:178–201`), so the op log remains complete and a replay reaches identical state via `ensureExists`. **This is a legitimate documented exception, not a bypass** — but it is the only place a domain table is touched by hand, so it deserves to stay visible. That is exactly what C6 in the existing proposal does.

`deleteWeek.js`, `deleteRecord.js`, and `ingest.js` contain **zero** raw writes — pure SELECT plus `appendOp`.

---

## `electron/db/localDb.js` (1527 lines)

**What it does today**: schema init plus 28 sequential forward-only migrations, `openLocalDb`, `getSchemaVersion`, `getOrCreateDeviceId`.

**Cohesive?** Yes in kind — it is a migration ledger, and ledgers grow by append. Length here is not a smell; each migration is immutable history. Splitting it would produce 28 files with no independent reason to change.

**Logic that isn't schema/migration:**
- **`repairMissingScheduleTemplates` (`:1400–1455`)** replays `operations` rows through `applyProjection`/`applyBulkReplaceProjection` to rebuild missing rows. That is op-log replay — syncClient's responsibility everywhere else in the codebase — physically located in the DB module. It is local-only and migration-scoped, so this is a boundary observation rather than a live problem, but it is the only place replay logic lives outside the sync/ops layer.
- **`parseSlotFlags` (`:1366–1374`)** hand-reimplements `normalizeSlots`' coercion, with an explicit comment: electron-builder does not package `src/`, so importing across the boundary would work in dev and break in the packaged app. That is a real constraint, correctly documented. It is also a correctness-sensitive duplication (the comment specifically notes it must *not* add `stripStaleFlags`' `__proto__`/`constructor` sanitization) that a future `normalizeSlots` change could silently desync from.

**Migration-ordering hazard**: v27 uses a compound `>= 26 && < 27` guard rather than a bare `< 27`, because v26 uses a deferred-retry pattern (a snapshot write failure withholds the version stamp so it reruns next launch) and `getSchemaVersion` is `MAX(version)`. A bare guard would let v27 push MAX past 26 while v26 was still incomplete, permanently skipping its retry (`:1264–1271`). Correctly guarded — but the guard is enforced only by a comment. A future author copying the bare `< N` pattern next to a deferred-retry predecessor would reintroduce it silently.

---

## `electron/sync/syncServer.js` (1032 lines) and `syncClient.js` (1194 lines)

**What they do today**: the Host WebSocket endpoint and the per-device client, respectively.

**Cohesive?** Each has one reason to change: "how devices talk over the LAN," from its own side. They are large because the protocol is genuinely large — authentication, pairing, ops, bulk replace, locks, restores, deletes, token renewal, full sync, backfill. Each message type is a thin handler; there is no god-function inside either file.

**Boundary quality is high.** Neither imports from `src/`. Every mutation goes through `electron/ops/*` — no raw domain SQL. The trust boundary is drawn explicitly and correctly: `authorize()` runs against the connection's own already-authenticated `ws.token`, never a client-supplied message field (`syncServer.js:518–526` says so in as many words). The `local`-token rejection at the WS boundary is real and verified: `if (verified.type !== 'camp') { ws.close(4402, 'local_token_not_valid_for_network') }` (`syncServer.js:335–338`), citing ADR 2026-07-25 §3.

**Unauthenticated message surface** is narrow and each entry is defensible: `pairing_request` (rate-limited, capped at 50 pending, cannot self-authorize), `login` (gated on device trust + constant-time secret compare before the PIN check ever runs), and `authenticate` itself (which can only self-register an unseen device as `pending`).

**Known accepted limitations, all documented in-code:**
- `sendMissedOps` / `sendFullSyncIfFirstPairing` are deliberately un-awaited from `handleAuthenticate` (`:405–409`, "must not block on either completing"). Their relative ordering is bounded only by the shared `asOfSeq` snapshot, not structurally enforced.
- Conflict *notifications* are not replayed on reconnect (`:238–247`). A device offline during a conflict's original recording can miss it.
- `writeBulkReplace` has no offline queue, unlike field writes (`syncClient.js:1008–1018`) — an explicit scope cut.
- `applyRemoteOp`'s FK-constrained DELETE failure leaves that device permanently diverged for that record (`syncClient.js:427–451`), deliberately not "fixed" by guessing at a local cascade.

**Verdict**: no drift. This is the most disciplined subsystem in the repository after the engine.

---

## `src/data/scheduleRepository.js` (236 lines)

**What it does today**: token acquisition, `writeFields`, the single `mapSlotToRow`, `normalizeSlots` on read, snapshot ↔ row mapping, and the bulk load/replace calls.

**Cohesive?** Yes — one reason to change: how schedule domain objects map to persisted rows. Its header's declared non-goals (no React state, no error copy, no route policy, no engine calls) are honoured in the code.

**Is it a real boundary or a naming layer?** A real one. `mapSlotToRow`'s existence replaced three separately-drifting copies, which is the deletion test passing: remove this module and that duplication returns.

**Three findings:**

1. **Its stated scope and its actual use disagree.** The header claims it owns "every read and write ScheduleScreen makes against the schedule entities." `ScheduleScreen` calls `localClient` directly in three places: `getDeviceId()` (`:441–443`), `onOpApplied(...)` (`:448`), and `duplicateWeek(...)` (`:947`). The first two are arguably infrastructure rather than schedule reads; `duplicateWeek` is not.

2. **It hands raw `localClient` to a component.** `DeleteWeekDialog` receives both `localClient` and `repo` as props (`ScheduleScreen.jsx:1439–1440`) and uses both. Whatever the merits, this licenses a component to bypass the seam.

3. **It is the only repository in the codebase.** `src/data/` contains this file and its test, nothing else. Every non-schedule entity — groups, tiers, activities, cohorts, time blocks, days, anchors, devices, users, camps — has no repository, so those screens call `localClient` directly. This is the single largest structural gap between the documented layering rule and the code.

---

## Week management (`WeekSwitcher` + `WeekContextBar` + `DeleteWeekDialog` + week ops)

**What it does today**: `WeekSwitcher` and `WeekContextBar` are properly presentational — every action is a callback prop, no IO. The main-process ops (`duplicateWeek.js`, `deleteWeek.js`) follow the established convention well.

**Findings:**

1. **`DeleteWeekDialog` performs its own IO** — `repo.loadTemplateData()` (`:16`), `repo.loadWeekExclusions()` (`:25`), `localClient.deleteWeek()` (`:42`) — unlike every sibling dialog in the same directory. Because it needs live counts to show what deletion will destroy, and the parent doesn't have them shaped that way. Defensible motive, inconsistent result: `VersionsDropdown` and `WeekSwitcher` solve comparable problems with callback props.

2. **The orchestration layer is missing.** All six week CRUD handlers are inline in `ScheduleScreen.jsx:919–956`. This is the newest significant feature area (S3 slices) and it is the one that did *not* get a hook. That is the clearest single instance of drift in this audit: the pattern was established, and the newest work did not follow it.

3. **`weekId` is correctly not route-keyed** — a week is shared across both routes. But every `weekId` change re-runs the full `loadAll`, reloading both routes unconditionally.

---

## Layering violations — the complete list

Against the rule `Screens → Hooks → Repositories → localClient → IPC → handlers → ops → SQLite`, no upward calls:

| # | Where | Violation | Severity |
|---|---|---|---|
| 1 | `src/components/layout/Sidebar.jsx:133–143` | A **component** calls `window.shoresh.getCurrentProject` / `backupProject` directly, skipping `localClient` entirely — while the same file also imports `localClient` (`:2`) for other calls. Two access paths to one bridge, in one file. This is the only direct `window.shoresh` use in `src/`. | Medium — clearest violation in the codebase |
| 2 | `src/localClient.js` | Does not wrap 8 project-lifecycle methods or `onFullSyncApplied`, all of which `preload.js` exposes. Violation #1 is the consequence, not the cause. | Medium — root cause of #1 |
| 3 | `src/screens/ScheduleScreen.jsx:441, 448, 947` | Screen calls `localClient` directly, skipping the repository. `duplicateWeek` is the substantive one. | Low–Medium |
| 4 | `src/components/schedule/DeleteWeekDialog.jsx:16, 25, 42` | Component performs IO. Mitigated by dependency injection via props rather than import. | Low |
| 5 | ~15 non-schedule screens | Call `localClient` directly because no repository exists for their entities. **Structural, not careless** — the layer they should call does not exist. | Low individually; structural in aggregate |
| 6 | `electron/db/localDb.js:1400–1455` | Op-replay logic in the DB module. Local-only, migration-scoped. | Low |

**No upward calls found anywhere else.** The schedule hooks never import the screen; every dependency is an explicit parameter. `electron/` never imports `src/`. The engine imports nothing. `scheduleRepository` imports only `localClient` and a normalizer.

---

## Architectural drift — where newer work quietly departed from the pattern

Four instances, in descending order of how much they matter:

1. **Week management skipped the hook-extraction pattern** (`ScheduleScreen.jsx:919–956`). Six mutation clusters got hooks; the seventh, and newest, did not.
2. **`Sidebar.jsx` reached past `localClient` to `window.shoresh`** (`:133–143`) — the app's only instance, and it is recent project-lifecycle code.
3. **The repository pattern is half-adopted.** `createScheduleRepository` is used by 3 of ~18 screens, and those three mix it with direct `localClient` calls for the same entities. There is no migration plan recorded anywhere in code or docs.
4. **`DeleteWeekDialog` broke the presentational-component norm** in a directory where 19 of 20 files hold it.

Everything else that looks like drift turns out, on reading, to be a documented deliberate exception with a stated rationale. That ratio is genuinely good.

---

## Technical debt register

Only items with direct code evidence. Speculation excluded.

### Architectural

| Item | Evidence |
|---|---|
| No structural guard that every writable entity is registered in `PROJECTIONS`; unregistered ops are logged then silently discarded | `projections.js:452`, `operations.js:78–80`; three historical occurrences at `projections.js:328–397` and the T37 `is_locked` fix |
| Repository layer covers one domain of many; ~15 screens necessarily bypass a tier that doesn't exist for them | `src/data/` contains one repository file |
| `localClient` doesn't wrap 8 preload methods, forcing `window.shoresh` use | `preload.js` vs `localClient.js`; consequence at `Sidebar.jsx:133–143` |
| Device-trust mutation is inline raw SQL in `main.js` rather than an ops/auth module | `main.js:449–533` |
| Project-lifecycle handlers ungated by `authorize()` with no recorded rationale, unlike every other exemption | `main.js:1046–1266` |
| Op-replay logic inside the DB migration module | `localDb.js:1400–1455` |
| Week CRUD not extracted to a hook, unlike all six sibling clusters | `ScheduleScreen.jsx:919–956` |

### Domain

| Item | Evidence |
|---|---|
| FK-constrained remote DELETE leaves a device permanently diverged for that record | `syncClient.js:427–451` |
| `writeBulkReplace` has no offline queue while field writes do | `syncClient.js:1008–1018` |
| Conflict notifications are not replayed on reconnect | `syncServer.js:238–247` |
| Two dismissal mechanisms for findings (persisted flag vs ephemeral `Set`) unified only by a branch | `useSlotMutations.dismissFlag` vs `ScheduleScreen.jsx:495–501`, branched at `:719–725` |
| `schedule_templates.ensureExists` can leave NULL-`week_id` orphans | `projections.js:286–299` |
| "Unprotected" template scopes acknowledged as pre-existing drift | `deleteRecord.js:68–72` |
| Import replace-mode pre-delete is non-transactional while the commit is | `ImportScreen.jsx:146–153` vs `ingest.js` |

### UI

| Item | Evidence |
|---|---|
| `'var(--primary)22'` alpha-suffix concatenation instead of the `color-mix(in srgb, …)` convention used ~40 places elsewhere | `SlotCell.jsx`, `ScheduleGroupView.jsx`, `ScheduleDayView.jsx` |
| Hardcoded amber warning-banner colours duplicated across two screens instead of a `shared.js` token | `ActivitiesScreen.jsx:224, 749`; `GroupsScreen.jsx:400, 513, 745` |
| Route-switch reset policy is inconsistent and undocumented | `ScheduleScreen.jsx:255–262` |

### Performance

| Item | Evidence |
|---|---|
| `listDeleted` is a full grouped scan of `operations` with no supporting index; its own comment concedes it holds only "at camp scale" | `trash.js:9–13` |
| `sendMissedOps` and snapshot insert loops are per-row round trips, not batched | `syncServer.js:305–309`, `syncClient.js:106–112` |
| Every `weekId` change reloads both routes in full | `ScheduleScreen.jsx:427` |
| `schedule_snapshots` excluded from full sync — a late-pairing device never receives history | `syncServer.js:22–24` |

### Developer experience

| Item | Evidence |
|---|---|
| `parseSlotFlags` hand-duplicates `normalizeSlots` coercion, with a documented reason and an explicit correctness caveat | `localDb.js:1358–1374` |
| Migration deferred-retry guard enforced only by comment | `localDb.js:1264–1271` |
| `djb2` duplicated between engine and UI constants | `buildSchedule.js:23` / `slotCellConstants.js:123–125` |
| `useSlotMutations`' ten handlers repeat identical write/patch/undo boilerplate with no shared helper | `useSlotMutations.js:25–522` |

### Testing

| Item | Evidence |
|---|---|
| No parity check between `preload.js` and `localClient.mock.js`; 8 methods plus `onFullSyncApplied` are missing from the mock and would surface only as a runtime crash under `npm run dev` | `preload.js` vs `localClient.mock.js` |
| `ActivitiesScreen.jsx` (837 lines, second-most complex screen) has no test file, while its near-identical sibling `GroupsScreen.jsx` does | file listing |
| A `RESTORE_DECISIONS` guard exists but no equivalent `PROJECTIONS` registration guard | `restore.js:5–8` |
| `pendingRestores.migration.test.js` asserts byte-identical DDL between `schema.sql` and a migration constant — a hand-maintained invariant with a single enforcement point | `localDb.js:1022–1025` |
| The mock hand-maintains a `UNIQUE_KEYS` subset of the real schema's uniqueness rules with nothing keeping them in sync | `localClient.mock.js:148–154` |

### Governance

| Item | Evidence |
|---|---|
| Correctness-critical decisions are recorded as prose comments citing prior review rounds ("Round 2 Security MEDIUM #2", "GOVERNOR round 1 rejected as CRITICAL") scattered through implementation files rather than in durable ADRs a future maintainer could audit against | `main.js`, `operations.js`, `projections.js` throughout |
| The project-lifecycle authorization exemption has no ADR or comment stating it was decided rather than overlooked | `main.js:1046–1266` |
