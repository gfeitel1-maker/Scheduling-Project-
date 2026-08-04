---
title: "Repository Architecture Map"
document_type: architecture-report
status: current
created: 2026-08-04
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
companions: [DEPENDENCY_FLOW_MAP.md, BOUNDARY_AUDIT.md, RESPONSIBILITY_MATRIX.md, TARGET_ARCHITECTURE.md]
---

# Repository Architecture Map

Descriptive, not authoritative. This records what exists on `main` as of 2026-08-04. Where it disagrees with the code, the code is right and this document is stale.

Scope: every major subsystem, its purpose, responsibilities, public interface, dependencies, and — the section that matters most for keeping boundaries honest — what it must never contain.

## Process topology

Shoresh runs three cooperating contexts inside one Electron app:

| Context | Lives in | May touch SQLite? | May import React? |
|---|---|---|---|
| Renderer | `src/**` | **Never** | Yes |
| IPC seam | `electron/preload.js` + `src/localClient.js` | Never | No |
| Main process | `electron/**` (except preload) | Yes, exclusively | Never |

The renderer's only door into data is `window.shoresh.*`, exposed by `contextBridge` in `electron/preload.js`. Everything below that door is Node; everything above it is React.

---

## 1. Schedule Engine

**Files**: `src/engine/buildSchedule.js`, `src/engine/weekCatalog.js`, `src/engine/readiness.js`

**Purpose**: turn setup data into a proposed schedule, and answer questions about that schedule, with no IO whatsoever.

**Responsibilities**
- Place activities into a group × day × time-block grid subject to eligibility, priority, `max_per_week`, one-per-day, multi-block span contiguity, and per-location group caps.
- Produce deterministic output for identical input.
- Compute findings (`UNDERSERVED`, `DISTRIBUTION`) and per-slot flags (`UNFILLABLE`).
- Filter a camp's catalog down to one week's effective catalog given that week's exclusions.
- Answer whether a camp has enough setup to build anything at all.

**Public interface**
- `buildSchedule(input)` — default export, `buildSchedule.js:498`. Accepts either the legacy shape `{ groups, tiers, days, timeBlocks, activities, anchors, campId, preplacedSlots }` or the multi-cohort shape `{ cohorts, days, activities, campId }`. Returns `{ slots, stats, conflicts, findings }`.
- `computeFindings({ slots, groups, activities, days })` — `buildSchedule.js:422`. Recomputes findings from already-persisted `template_slots` rows without re-placing anything. This is what lets the renderer refresh the findings rail after a manual edit.
- `resolveWeekCatalog({ groups, activities, anchors, weekId, activityExclusions, groupExclusions })` → `{ groups, activities, anchors, suppressedAnchors }` — `weekCatalog.js:7`.
- `getSetupGaps(collections)` / `describeSetupGaps(gaps)` — `readiness.js:102`, `readiness.js:114`.

**Dependencies**: none. All three files have literally zero import statements. Verified by reading, not assumed.

**Determinism**: `djb2(campId + cohortId)` (`buildSchedule.js:23`) seeds `mulberry32` (`buildSchedule.js:32`), called once per cohort at `buildSchedule.js:509`. The only randomness in the engine is the tie-break shuffle at `buildSchedule.js:310`, which draws from that seeded generator. No `Date.now()`, no `Math.random()`, no ambient state.

**Must never contain**: React, `localClient`, `window.shoresh`, Node built-ins, `Date.now()`, `Math.random()`, or any knowledge of `template_slots` row shape (the repository owns engine-slot → DB-row mapping).

---

## 2. Week Management

**Files**: `src/engine/weekCatalog.js` (pure filtering), `src/components/schedule/WeekSwitcher.jsx`, `WeekContextBar.jsx`, `DeleteWeekDialog.jsx` (UI), `electron/ops/duplicateWeek.js`, `electron/ops/deleteWeek.js` (main-process ops), `schedule_weeks` / `week_activity_exclusions` / `week_group_exclusions` tables (schema v27–v28).

**Purpose**: let a director run several weeks off one camp setup, with per-week deviations expressed as exclusions rather than as duplicated catalogs.

**Responsibilities**
- Own the `schedule_weeks` list, its ordering, archive state, and the currently-selected week.
- Duplicate a week (setup + both routes' slots) as a single main-process transaction.
- Permanently delete a week and everything scoped to it.
- Express per-week activity/group suppression as exclusion rows, resolved at build time by `resolveWeekCatalog`.

**Public interface**
- Renderer: `localClient.duplicateWeek(sourceWeekId, campId)`, `localClient.deleteWeek(weekId)`, plus `repo.loadWeeks()`, `repo.createWeek(...)`, `repo.loadWeekExclusions(weekId)`, `repo.toggleActivityExclusion(...)`, `repo.toggleGroupExclusion(...)`.
- Main: `duplicateWeek(db, {token, sourceWeekId})`, `deleteWeek(db, {token, weekId})` — both HOST-ONLY, both transactional, both `appendOp`-only apart from one documented pre-seed (see BOUNDARY_AUDIT §duplicateWeek).

**Dependencies**: the ops modules depend on `electron/ops/operations.js` and `electron/ops/scheduleTemplateId.js`; the UI depends on props supplied by `ScheduleScreen`.

**Must never contain**: a notion of "the current week" persisted anywhere but the renderer's own state, or per-week copies of the camp catalog (exclusions exist precisely to avoid that).

**Note**: week management is the one mutation cluster of comparable complexity to slots that has **no dedicated renderer hook**. Its create/rename/archive/unarchive/duplicate/delete handlers are written inline in `ScheduleScreen.jsx:919–956`. See BOUNDARY_AUDIT.

---

## 3. Import / Ingest

**Files**: renderer half — `src/screens/ImportScreen.jsx`, `src/ingest/textGrid.js`, `sheetGrid.js`, `extractEntities.js`, `preview.js`. Main half — `electron/ops/ingest.js`.

**Purpose**: bootstrap a camp's setup from last year's spreadsheet or text grid, with the director approving every inferred row before anything is written.

**Responsibilities**
- Renderer: read files, normalize both `.xlsx`-family and `.txt/.csv/.tsv` inputs into a common `pages` intermediate representation, infer candidate entities with confidence scores, compare against existing records for duplicate detection, present an approve/reject list, and commit once.
- Main: validate the approved payload against the `INGESTIBLE_ENTITIES` whitelist (`ingest.js:23`) and write every accepted entity through `appendOp` inside one transaction.

**Public interface**
- Renderer → main: `localClient.ingestCommit(approved, { groups: groupUnits }, cohortId)` (`ImportScreen.jsx:163`). This is the single seam; there is no other write path out of the import flow except the optional pre-delete loop in replace mode (`ImportScreen.jsx:146–153`).
- `commitIngest(db, {token, approved, links, cohort_id})` on the main side.

**Dependencies**: `xlsx` (renderer), `electron/ops/operations.js` (main).

**Extension seam**: the `pages` intermediate representation. Adding a source means adding a branch at `ImportScreen.jsx:73–86` that produces `pages`. There is currently no plugin/strategy interface — it is one `if/else` on file extension.

**Must never contain**: placements or schedule rows (explicitly out of scope per `ingest.js`'s header), writes to any entity outside the whitelist, or a silent drop of a proposed row (unaccepted rows must be shown unticked, per `ImportScreen.jsx:16–22`).

---

## 4. LAN Sync

**Files**: `electron/sync/syncServer.js` (1032 lines), `syncClient.js` (1194), `discovery.js`, `lockManager.js`, `pendingWrites.js`, `pendingRestores.js`, `rateLimit.js`.

**Purpose**: keep every device's SQLite database converged, over the local network only, with one device acting as Host.

**Responsibilities**
- **Server (Host)**: accept WebSocket connections, authenticate devices, gate every mutating message through `authorize()`, receive and apply ops, broadcast them, drive pairing, and ship the first-pairing full sync.
- **Client**: connect and reconnect, submit ops (lock-then-submit for field writes, direct submit for bulk replace), apply remote ops idempotently, and drain offline write/restore queues.
- **Discovery**: mDNS advertise/browse, with defensive shape validation of untrusted LAN broadcasts (`toValidatedHost`).
- **Lock manager**: advisory presence hints only — explicitly *not* hard exclusion (`lockManager.js:1–9`).
- **Pending queues**: durable offline storage; deliberately "dumb SQL" with all timing decisions in the drainer (`pendingWrites.js:6–8`).
- **Rate limit**: pure arithmetic with an injectable clock — `shouldThrottle(lastAt, now, minIntervalMs)`.

**Public interface**
- `startSyncServer(db, {port, onPairingRequest, now})` → `{ wss, close, sendPairingApproved, sendPairingDenied }`.
- `createSyncClient(db, {device_id, author_user_id, serverUrl, token, device_name, ...})` → `{ write, writeBulkReplace, onOpApplied, onOpConflict, onFullSyncApplied, isConnected, onConnectionChange, getQueuedOps, requestRestore, requestDelete, getPendingRestores, drainPendingRestores, flushQueue, waitUntilConnected, loginRemote, onPairingApproved, onPairingDenied, onTokenRenewed, close }`. With no `serverUrl` it degrades to an offline client that writes straight through `appendOp` — this is the shape the Host itself uses (`syncClient.js:139–207`).

**Dependencies**: `electron/ops/operations.js`, `electron/ops/projections.js`, `electron/auth/*`, `electron/audit/auditLog.js`, `bonjour-service`, `ws`. Never imports from `src/`.

**Must never contain**: raw SQL writes to any `PROJECTIONS`-registered table (all go through `appendOp`/`applyProjection`/`appendBulkReplaceProjection`), or acceptance of a `local` token for network trust (`syncServer.js:335` closes such a connection with code 4402).

---

## 5. Authentication

**Files**: `electron/auth/localAuth.js`

**Purpose**: prove that a person at a device is a known user of this camp, and mint a token that says so.

**Responsibilities**
- Hash and verify PINs (`scryptSync` + `timingSafeEqual`, `localAuth.js:69–77`).
- Track lockout: 5 attempts, 30s window (`LOGIN_MAX_ATTEMPTS` / `LOGIN_LOCKOUT_MS`, `localAuth.js:17–18`), stored in `login_attempts`.
- Own the Host's Ed25519 signing-key lifecycle (`host_signing_key`, Host-only, never replicated).
- Issue and verify two token types.

**Public interface**: `attemptLogin(db, {name, pin, deviceId})`, `issueCampToken`, `issueLocalToken`, `verifySessionToken(db, token)`, `createUser(...)`.

**The two token types** — the single most important invariant in this subsystem:

| | `camp` | `local` |
|---|---|---|
| Signed with | Host's Ed25519 private key (`host_signing_key`) | that device's `device_secret_identifier`, HMAC-SHA256 |
| Who can mint | only the Host | only the device itself |
| Accepted by local IPC | yes | yes |
| Accepted by the WS server | yes | **no** — connection closed 4402 |
| TTL | 24h | 24h |

Token *type* is parsed from the unverified payload but used only to select which key/method to verify with; behavior branches only after the signature check passes (`localAuth.js:200–204`, correctly implemented). The type is re-derived from local state at login (`localAuth.js:193–196`) and never supplied by a caller.

**Must never contain**: authorization decisions (that is `authorize.js`), or trust in any claim carried inside a token beyond `{userId, deviceId}`.

---

## 6. Authorization

**Files**: `electron/auth/authorize.js`, `permissions.js`, `deriveWriteAction.js`

**Purpose**: decide whether *this* session, on *this* device, may perform *this* action, right now.

**Responsibilities**: verify the token afresh, re-query the user's role and the device's trust state (`authorized_at` / `revoked_at`) from the database **on every call**, match the action against `PERMISSIONS`, and audit-log every `users.*` allow and every denial.

**Public interface**: `authorize({ db, token, action, resourceId })`.

**Denial reasons** (`authorize.js:18–81`): `invalid_token`, `invalid_action`, `db_error`, `user_not_found`, `device_not_found`, `device_not_authorized`, `device_revoked`, `forbidden`.

**Dependencies**: `localAuth.js` (for `verifySessionToken`), `permissions.js`, `electron/audit/auditLog.js`.

**Must never contain**: a cache. The no-cache property is what makes device revocation take effect on the very next IPC call rather than on the next login.

---

## 7. Local Database

**Files**: `electron/db/localDb.js` (1527 lines), `electron/db/schema.sql`, `electron/db/userDataPath.js`, `electron/db/projectManager.js`

**Purpose**: own the SQLite file — its location, its schema, and its forward-only migration to the current version.

**Responsibilities**
- Open the database at an explicitly-chosen path (dev vs packaged directories are deliberately separate — `userDataPath.js`; ADR 2026-07-28).
- Initialize schema and run 28 sequential migrations.
- Hard-block startup if the file's schema is newer than this build understands.
- Mint/read the per-install `device_identity`.

**Public interface**: `openLocalDb(filePath)`, `getSchemaVersion(db)`, `getOrCreateDeviceId(db)`, `CURRENT_SCHEMA_VERSION = 28`.

**Tables by concern**
- *Identity/auth*: `camps`, `users`, `devices`, `host_signing_key`, `device_identity`, `login_attempts`
- *Op-log & sync plumbing*: `operations`, `conflicts`, `locks`, `pending_writes`, `pending_restores`
- *Camp setup*: `cohorts`, `days_of_operation`, `time_blocks`, `groups`, `tiers`, `activities`, `anchor_activities`, `day_override_templates`, `day_override_template_slots`
- *Schedule*: `schedule_weeks`, `schedule_templates`, `template_slots`, `template_overlays`, `schedule_snapshots`, `week_activity_exclusions`, `week_group_exclusions`
- *Audit*: `audit_events` (local-only; deliberately does not flow through `operations` or sync)
- *Migration journals*: `migration_v24_repoint_log`, `migration_v26_retired_orphan_log`

**Version guard**: `openLocalDb` throws `{ code: 'schema_too_new' }` when `MAX(schema_migrations.version) > CURRENT_SCHEMA_VERSION` (`localDb.js:1470–1480`). A best-effort `.bak` is written before any migration runs against an existing file.

**Must never contain**: sync/network logic. It currently does contain one adjacent thing — `repairMissingScheduleTemplates` (`localDb.js:1400–1455`) replays `operations` rows through `applyProjection` as part of a migration. See BOUNDARY_AUDIT.

---

## 8. Electron IPC

**Files**: `electron/preload.js` (72 lines), `electron/main.js` (1323 lines), `src/localClient.js` (76 lines), `src/localClient.mock.js` (621 lines)

**Purpose**: the one narrow door between React and Node.

**Responsibilities**
- `preload.js`: expose a fixed, enumerable set of `ipcRenderer.invoke` / `.on` pass-throughs on `window.shoresh`. It contains no logic at all.
- `main.js`: register a handler per channel, validate arguments, call `authorize()`, and delegate to an `ops/*` module or to `syncClient`. Also owns Electron window lifecycle, startup-failure handling, and the project-file lifecycle handlers.
- `localClient.js`: the renderer-side wrapper. Thin, with two deliberate additions — it reads `shoresh-token` from `localStorage` so most read calls need not thread a token (`localClient.js:16–19`), and it translates `deleteEntity` into a `write` with the `__deleted__` sentinel (`localClient.js:32–33`).
- `localClient.mock.js`: the browser-dev stand-in backing `npm run dev` on port 5200. **It is not the real stack**; it is `localStorage`-backed and has no op log.

**Interface surface**: 46 invoke channels plus 8 push events. The full inventory with authorization and op-log status per channel is in DEPENDENCY_FLOW_MAP §Appendix.

**Push events**: `shoresh:op-applied`, `shoresh:op-conflict`, `shoresh:full-sync-applied`, `shoresh:pairing-request`, `shoresh:pairing-approved`, `shoresh:pairing-denied`, `shoresh:token-renewed`, `shoresh:sync-status-changed`.

**Must never contain**: domain logic in `preload.js` (it has none), or schedule-domain business logic in `main.js` (it has none — every schedule mutation delegates to `electron/ops/*`).

---

## 9. Operations (op-log)

**Files**: `electron/ops/operations.js`, `projections.js`, plus the operation modules `ingest.js`, `deleteRecord.js`, `deleteWeek.js`, `duplicateWeek.js`, `restore.js`, `trash.js`, `pinFields.js`, `campScopedEntities.js`, `scheduleTemplateId.js`

**Purpose**: make every mutation a durable, replayable, attributable, field-level record — and make the materialized tables a pure function of that record stream.

**Responsibilities**
- `appendOp` — validate the field against the entity's allowlist, coerce the value for SQLite, insert into `operations`, re-read the row for its assigned `seq`, and immediately call `applyProjection`. All in one transaction.
- `appendBulkReplaceOp` / `applyBulkReplaceProjection` — scope-wide delete-and-reinsert, used for schedule replacement.
- `detectConflict` / `detectBulkReplaceConflict` / `recordConflict` / `listPendingConflicts` — conflict detection and durable recording.
- `applyProjection` — the single function that turns one op into one row mutation.

**The `PROJECTIONS` registry** (`projections.js`) maps entity name → `{ table, key, fields, ensureExists }`. Currently registered: `camps`, `users`, `cohorts`, `groups`, `days_of_operation`, `time_blocks`, `tiers`, `activities`, `anchor_activities`, `day_override_templates`, `day_override_template_slots`, `week_activity_exclusions`, `week_group_exclusions`, `schedule_weeks`, `schedule_templates`, `schedule_snapshots`, `template_overlays`, `template_slots`, `conflicts`.

**The registry's failure mode, stated plainly**: an op for an entity absent from `PROJECTIONS` is durably written to `operations` and then silently discarded by `applyProjection` (`projections.js:452`) — no error, no log, no row. The same file's own comments (`projections.js:328–397`) record that `schedule_snapshots` and `template_overlays` shipped unregistered and silently no-op'd for a period. This is not hypothetical.

**Silent-no-op contract**: `appendOp` deliberately does not throw when a write is rejected (unregistered entity, disallowed field on an unregistered entity, or a `camp_id` that doesn't match this device's camp), so that a Host replaying a remote Client's op cannot abort mid-transaction (`operations.js:95–106`). The one documented exception that does throw is `schedule_templates.ensureExists`'s `SCHEDULE_TEMPLATE_KIND_CONFLICT` backstop (`projections.js:319–325`).

**Idempotency**: `client_write_id` is the retry key. `findOpByClientWriteId` is a lookup helper; callers (notably `syncServer.handleSubmitOp`) check it *before* calling `appendOp`. `appendOp` itself does not dedupe.

**Must never contain**: UI concerns or IPC message shapes — these modules are called identically from `main.js`, `syncServer.js`, and `syncClient.js`.

---

## 10. Rendering / Screen Routing

**Files**: `src/App.jsx`, `src/components/layout/Shell.jsx`, `Sidebar.jsx`

**Purpose**: decide which screen is on-screen, without a router.

**Responsibilities**
- `App()` switches on `device.phase` (from `useDeviceMode`) to render `ModeSelectScreen`, `CampBootstrapScreen`, `JoinScreen`, `LoginScreen`, `PairingPendingScreen`, or the full `AppShell`.
- `AppShell` holds a `screen` string in `useState`, looks it up in the `SCREENS` map (`App.jsx:29`), and falls back to `TiersScreen` (`App.jsx:107`).
- `campId` and `onNavigate` are threaded as props into every screen.

**Public interface**: the `SCREENS` map — 29 screen modules — and the `onNavigate(screenName)` prop contract.

**Must never contain**: a router, a navigation Context, or URL state. This is a deliberate constraint, not an oversight; the app is a single-window desktop tool with no deep-linking requirement.

---

## 11. Components

**Files**: `src/components/**` — notably `src/components/schedule/` (20 files) and `src/components/layout/`

**Purpose**: presentational units that render state and emit intent.

**The house rule**: components receive data and callbacks via props and perform no IO. Two files depart from it, both knowingly:
- `DeleteWeekDialog.jsx` receives `repo` and `localClient` as props and calls them itself (`:16`, `:25`, `:42`) to compute live delete counts.
- `Sidebar.jsx` imports `localClient` (`:2`) *and* separately reaches `window.shoresh.getCurrentProject` / `backupProject` directly (`:133–143`).

**Route awareness**: most components are route-agnostic and receive route-specific data via props. Deliberate exceptions: `ExportChooserModal` (forces an explicit per-export route choice, never remembered), `ConfirmRegenModal` (copy asserts the manual route is untouched), `FindingsRail` (omits dismiss for `OVERLAP`, which is manual-only), and `slotCellConstants.legendEntriesFor(route)`.

**Styling**: inline React style objects only, drawing on `src/styles/shared.js` (`S.*`) and CSS custom properties. No CSS files, no CSS modules, no `className` used for styling. Verified across every file read; the residual hardcoded values are listed in BOUNDARY_AUDIT.

**Must never contain**: `localClient` imports, `window.shoresh` access, or engine calls.

---

## 12. Hooks

**Files**: `src/hooks/` (`useCohorts.js`, `useDeviceMode.js`, `usePendingConflicts.js`) and `src/screens/schedule/` (the schedule-scoped hook cluster)

Two distinct families, and it is worth naming the distinction because they follow different rules.

**App-level hooks** (`src/hooks/`) own IO. They call `localClient` directly and are the layer screens are supposed to consume instead of touching `localClient` themselves.
- `useDeviceMode()` — the `error → loading → mode-select → bootstrap/join → login → session` phase machine, plus the callbacks (`login`, `bootstrapCamp`, `chooseHost`) that the pre-session screens use.
- `usePendingConflicts()` — single source of truth for the conflict list and its resolution. Strips PIN values at the fetch boundary (`usePendingConflicts.js:7–25`) so a PIN never becomes UI state.
- `useCohorts()` — loads, sorts, and tracks the active cohort.

**Schedule-scoped hooks** (`src/screens/schedule/`) own state and orchestration but reach persistence only through the injected `repo`. None of them import `ScheduleScreen`; every dependency arrives as an explicit parameter, so there are no circular imports in this cluster.
- `useRouteState(weekId, route)` — the eight by-route state atoms and their current-route views. Also exports `ROUTES`, `EMPTY_BY_ROUTE`, `routeSetter`.
- `useSlotMutations({...})` — ten per-cell/overlay write handlers, each read → write → optimistic patch → `pushUndo`.
- `useGeneration({...})` — `generate`, `regenFromScratch`, `placeAnchors`. Deliberately targets the generated route's setters explicitly rather than "the current route" (`useGeneration.js:12–16`).
- `useSnapshots({...})` — save/delete/restore/rename, including the cross-route contamination guard at `useSnapshots.js:120–123`.
- `useUndoRedo({...})` — domain-agnostic two-stack machine plus Ctrl/Cmd+Z/Y.
- `useClipboardSelection({...})` — selection set, clipboard, paste mode, Ctrl+C/A/Escape.
- `useOverlayFillStamp({...})` — field-trip stamp mode, fill-drag preview, displaced-activity tray.

**Pure helpers in the same directory** (not hooks, no React): `gridGeometry.js`, `findingHighlight.js`, `resolveSelection.js`, `snapshotRestore.js`, `snapshotMatchesSchedule.js`.

**Must never contain**: direct `window.shoresh` access (use `localClient`), or — for the schedule cluster — direct `localClient` access (use the injected `repo`).

---

## 13. Repositories

**Files**: `src/data/scheduleRepository.js` (236 lines) — the only file in `src/data/`.

**Purpose**: be the one place that knows how schedule domain objects map to and from persisted rows.

**Responsibilities**
- Acquire the token (`getToken`).
- `writeFields` — loop a field map into per-field `localClient.write` calls, throwing on the first result that is neither `applied` nor `queued`.
- `mapSlotToRow` — the single engine-slot → DB-row mapper. Its header comment records that it replaced three separately-drifting copies.
- `normalizeSlots` on every read.
- Snapshot ↔ row mapping for `restoreSnapshotRows`.
- Bulk operations: `replaceWeek`, `reloadSlots`, `reloadOverlays`, `loadTemplateData`, `loadSetupLists`, `loadWeeks`, `createWeek`, `loadWeekExclusions`, `toggleActivityExclusion`, `toggleGroupExclusion`, `getSnapshot`, `restoreSnapshotRows`, `writeSlotFields`, `writeActivityFields`.

**Public interface**: `createScheduleRepository({ localClient })` → the object above.

**Declared non-goals** (its own header): no React state, no error-banner copy, no route-selection policy, no engine calls.

**Coverage**: this repository covers the schedule domain only. There is no repository for `groups`, `tiers`, `activities` (beyond `writeActivityFields`), `cohorts`, `time_blocks`, `days_of_operation`, `anchor_activities`, `devices`, `users`, or `camps`. Screens for those call `localClient` directly. The "Screens → Hooks → Repositories → localClient" rule is therefore honoured for one domain and structurally unavailable for the rest.

**Must never contain**: React, engine calls, or knowledge of which route is on screen.

---

## Cross-cutting invariants

These hold across subsystems and are the things most worth protecting.

1. **Every mutation to a `PROJECTIONS`-registered table goes through `appendOp` or `appendBulkReplaceOp`.** Audited; no violations found. Raw SQL exists only on non-synced device/auth-local tables (`devices`, `login_attempts`, `host_signing_key`, `device_identity`) and the one-time `camps` singleton bootstrap.
2. **The renderer never touches SQLite.** Structurally guaranteed by `contextBridge`.
3. **The engine is pure.** Verified by import inspection.
4. **Neither schedule route is canonical.** No code designates one as active, real, or default; where exactly one is required (export), the director chooses at that moment and the choice is not remembered.
5. **`authorize()` re-queries role and device trust on every mutating call.** No caching anywhere.
6. **The WS server rejects `local` tokens.** `syncServer.js:335`.
7. **Migrations are forward-only, and a newer-schema file is a hard startup block.**
