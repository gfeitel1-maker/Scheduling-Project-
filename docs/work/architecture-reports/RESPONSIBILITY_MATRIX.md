---
title: "Responsibility Matrix"
document_type: architecture-report
status: current
created: 2026-08-04
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
companions: [REPOSITORY_ARCHITECTURE_MAP.md, DEPENDENCY_FLOW_MAP.md, BOUNDARY_AUDIT.md, TARGET_ARCHITECTURE.md]
---

# Responsibility Matrix

One row per responsibility, one owner per row. Where a responsibility has more than one owner, that is stated plainly rather than smoothed over — a split owner is a finding, not a formatting problem.

Legend: **Owner** is where the decision is made. **Contributors** are files that participate but do not decide.

---

## Renderer responsibilities

| Responsibility | Owner | Contributors | Notes |
|---|---|---|---|
| Rendering (schedule grid) | `src/components/schedule/*` | `ScheduleScreen.jsx` composes | Presentational; all data via props |
| Rendering (all other screens) | each `src/screens/*.jsx` | `src/styles/shared.js` | Inline style objects only |
| Screen routing | `AppShell` in `src/App.jsx` (`SCREENS` map, `:29`; fallback `TiersScreen`, `:107`) | `Shell.jsx`, `Sidebar.jsx` render chrome | No router, no Context — deliberate |
| Session phase routing | `src/hooks/useDeviceMode.js` | `App()` switches on `device.phase` | `error → loading → mode-select → bootstrap/join → login → session` |
| Cell selection | `useClipboardSelection.js` | `resolveSelection.js` (pure) | Single owner |
| Clipboard / paste | `useClipboardSelection.js` | delegates the actual write to injected `placeActivityManual` | Single owner; clean delegation |
| DnD event handling | **Split** — `ScheduleScreen.handleGroupDragEnd` (`:510`) and `handleDayDragEnd` (`:559`) | dnd-kit `PointerSensor`, `distance: 8` | Two near-duplicate handlers; no shared "resolve a drag-end into an action" owner. C2 in the restructure proposal |
| Grid geometry (spans, tails, overlays, cell decisions) | `src/screens/schedule/gridGeometry.js` | — | Pure, tested, no violations |
| Undo/redo mechanism | `useUndoRedo.js` | — | Domain-agnostic; entries are opaque `{description, undo, redo}` |
| Undo/redo *content* | `useSlotMutations.js` | | Mechanism/payload split is deliberate and correct |
| Optimistic state patching | `useSlotMutations.js`, `useGeneration.js`, `useSnapshots.js` | | Each patches its own route-pinned setter after a successful write |
| Route-keyed state | `useRouteState.js` | | Eight atoms; `view`/`selectedGroup`/`selectedDay`/`railView` are *not* route-keyed — see BOUNDARY_AUDIT |
| Findings presentation | **Split** — `FindingsRail.jsx` renders; `ScheduleScreen.findingReason` (`:647`) writes the copy; `findingHighlight.js` maps findings to cells | | Copy generation sits in a render file |
| Overlay / field-trip stamp mode | `useOverlayFillStamp.js` | `FieldTripDrawer.jsx`, `OverlayCell.jsx` | Single owner |
| Displaced-activity tray | `useOverlayFillStamp.js` | `DisplacedPalette.jsx` | |

## Domain responsibilities

| Responsibility | Owner | Contributors | Notes |
|---|---|---|---|
| Schedule generation | `src/engine/buildSchedule.js` | `useGeneration.js` orchestrates | Pure, deterministic, zero imports |
| Week catalog resolution (exclusions applied) | `src/engine/weekCatalog.js` | | Pure |
| Setup readiness | `src/engine/readiness.js` | | Pure |
| Schedule validation — `UNFILLABLE` | `buildSchedule.js` pass 3 (`:323–406`); set on manual placement by `useSlotMutations.placeActivityManual` when `route !== 'manual'` | | Generated route only; persisted in `flags` |
| Schedule validation — `UNDERSERVED` / `DISTRIBUTION` | `buildSchedule.computeFindings` (`:422`) | | Aggregate findings, never per-slot |
| Schedule validation — `OVERLAP` | `src/utils/computeOverlaps.js` | `SlotCell.jsx` renders it | Manual route only; **derived at render time, never persisted** |
| Finding dismissal | **Split by kind** — `UNFILLABLE` → `useSlotMutations.dismissFlag` (persisted flag write); `UNDERSERVED`/`DISTRIBUTION` → `ScheduleScreen.dismissFinding` (`:495`, ephemeral `Set`) | branched at `ScheduleScreen.jsx:719–725` | Different persistence models justify different mechanisms; they are not behind one interface |
| Snapshot management | `useSnapshots.js` | `VersionsDropdown.jsx`, `snapshotRestore.js`, `snapshotMatchesSchedule.js` | Includes the cross-route contamination guard (`:120–123`) |
| Week management — persistence ops | `electron/ops/duplicateWeek.js`, `deleteWeek.js` | | HOST-ONLY, transactional |
| Week management — orchestration | **`ScheduleScreen.jsx:919–956`, inline** | `WeekSwitcher.jsx`, `WeekContextBar.jsx` (presentational), `DeleteWeekDialog.jsx` (does its own IO) | **No hook owner.** The one mutation cluster that was never extracted |
| Activity / group exclusions | `ActivitiesScreen.jsx`, `GroupsScreen.jsx` (toggle UI) → `repo.toggleActivityExclusion` / `toggleGroupExclusion` | `ExclusionConfirmDialog.jsx`; consumed by `resolveWeekCatalog` | Clean end-to-end |
| Import — parse, infer, preview | `src/screens/ImportScreen.jsx` + `src/ingest/*` | `xlsx` | All renderer-side |
| Import — commit | `electron/ops/ingest.js` | | Whitelist-gated, transactional, `appendOp`-only |
| Route choice at export time | `ExportChooserModal.jsx` | | Forces an explicit per-export choice; **never remembered** — this is a constitutional constraint, not a UX preference |

## Persistence responsibilities

| Responsibility | Owner | Contributors | Notes |
|---|---|---|---|
| Persistence — reads (schedule) | `src/data/scheduleRepository.js` | `localClient.list` → `main.js` `list` handler → plain SELECT | Reads do **not** go through the op log |
| Persistence — reads (all other entities) | **Each screen, directly via `localClient.list`** | `campScopedEntities.js` allowlists the table | No repository exists for these |
| Persistence — writes (domain) | `electron/ops/operations.js` — `appendOp`, `appendBulkReplaceOp` | called from `main.js`, `syncServer.js`, `syncClient.js` | **The sole legitimate write path.** Zero violations found |
| Op → row materialization | `electron/ops/projections.js` — `applyProjection`, `applyBulkReplaceProjection` | `PROJECTIONS` registry | Unregistered entity ⇒ silent discard |
| Engine-slot → DB-row mapping | `scheduleRepository.mapSlotToRow` | | Replaced three drifting copies |
| Slot normalization on read | `normalizeSlots` (via `scheduleRepository`) | `localDb.parseSlotFlags` is a documented duplicate for migration use | |
| Persistence — writes (device/auth-local) | `main.js` (raw SQL on `devices`), `localAuth.js` (`login_attempts`, `host_signing_key`) | | Deliberately outside the synced model |
| Migrations | `electron/db/localDb.js` `initSchema` | `schema.sql` | Forward-only; `schema_too_new` is a hard startup block |
| Database file location | `electron/db/userDataPath.js` | ADR 2026-07-28 | Dev and packaged use separate directories by design |
| Project file lifecycle | `main.js:1020–1266` | `electron/db/projectManager.js` (pure I/O parts) | Handler bodies not extracted; no `authorize()` |

## Sync responsibilities

| Responsibility | Owner | Contributors | Notes |
|---|---|---|---|
| Sync — outbound | `syncClient.js` — `write`, `writeBulkReplace`, `performWrite`, `flushQueue` | `pendingWrites.js` (durable queue) | Field writes queue offline; bulk replace does not |
| Sync — inbound (Host receiving) | `syncServer.js` message dispatch — `handleSubmitOp`, `handleSubmitBulkReplaceOp`, … | `authorize()` per message | Gated on the connection's own token |
| Sync — inbound (Client applying) | `syncClient.applyRemoteOp` (`:397–412`) | `applyProjection` | `ON CONFLICT(id) DO NOTHING` + project-only-if-inserted |
| Ordering / catch-up | `syncServer.sendMissedOps` (`:265–313`) | `devices.last_synced_seq`, `sendWithAck` | Watermark advances only past acked ops |
| First-pairing backfill | `syncServer.sendFullSyncIfFirstPairing` | Client's app-level `full_sync_applied` ack latches it | All-or-nothing; retries on failure |
| Host discovery | `electron/sync/discovery.js` | mDNS via `bonjour-service`; `toValidatedHost` shape-validates | Untrusted LAN input is validated |
| Advisory locking | `electron/sync/lockManager.js` | | Presence hints only — explicitly **not** exclusion |
| Rate limiting | `electron/sync/rateLimit.js` | applied at `login` (300ms) and `pairing_request` (5s) on the Host | Injectable clock |
| Conflict detection | `electron/ops/operations.js` — `detectConflict`, `detectBulkReplaceConflict` | called from `syncServer.js:575, 656` | Field-level, and `based_on_seq` for bulk |
| Conflict recording | `operations.recordConflict` | `conflicts` table | Best-effort; a persistence failure never blocks the reply |
| Conflict resolution | `main.js` `resolveConflict` handler → `syncClient.write` | `usePendingConflicts.js` (renderer, strips PINs at the fetch boundary), `ConflictsScreen.jsx` | |
| Push notifications to renderer | `main.js` — `wireOpApplied`, `wirePairingCallbacks`, `wireSyncStatus`, all `webContents.send` | `preload.js` `on*` bridges | Payloads sanitized before send |

## Security responsibilities

| Responsibility | Owner | Contributors | Notes |
|---|---|---|---|
| Authentication | `electron/auth/localAuth.js` — `attemptLogin`, `verifySessionToken` | `login_attempts` (lockout: 5 attempts / 30s) | scrypt + `timingSafeEqual` |
| Token minting | `localAuth.issueCampToken` / `issueLocalToken` | `host_signing_key` (Host-only, never replicated) | Type re-derived from local state, never caller-supplied |
| Authorization | `electron/auth/authorize.js` | `permissions.js` (matrix), `deriveWriteAction.js` | Re-queries role + device trust **every call**, no cache |
| Network trust boundary | `syncServer.handleAuthenticate` (`:335–338`) | | Rejects `local` tokens with close code 4402 |
| Device pairing | **Split** — `syncServer.js` (`pairing_request`/`approved`/`denied` messages), `syncClient.js` (secret storage), `main.js:449–533` (approve/deny/revoke, raw SQL) | `DeviceManagerScreen.jsx` | Three owners; the `main.js` half never earned its own module |
| Audit — security events | `electron/audit/auditLog.js` `recordAuditEvent` | called from `authorize.js`, `localAuth.js` | Local-only; deliberately not synced |
| Audit — domain history | `electron/ops/trash.js` `getEntityHistory` | sourced directly from `operations` | |
| Trash / restore | `electron/ops/trash.js` (list), `electron/ops/restore.js` (`restoreEntity`) | `pendingRestores.js` for offline intent | Allowlist-gated; `restore.test.js` fails on an unclassified new entity |

---

## "If I add Feature X, where should it live?"

Five concrete features, worked through against the matrix above.

### X1 — A third schedule route (e.g. "archived last year's schedule, read-only")

**Owner: `useRouteState.js` `ROUTES`, plus the `schedule_templates.kind` value set.**

The route abstraction already generalizes: `ROUTES` is an array, `EMPTY_BY_ROUTE` and `routeSetter` are parameterized over it, and all eight state atoms are objects keyed by route. Adding a route is mostly adding a `kind`.

What would need attention, and this is the honest cost:
- Every route-scoped write site enforces its own route safety — `useGeneration`'s explicit pinning (`:12–16`), `useSnapshots`' template-id check (`:120–123`). A third route means a third place each of these must be reasoned about, and **nothing tests that a new route-scoped feature added its guard**.
- `ExportChooserModal` currently offers a binary choice.
- `loadAll` loads all routes eagerly; a third route is a third full load per week change.
- Per-slot flag semantics are route-specific (`UNFILLABLE` generated-only, `OVERLAP` manual-only). A read-only route needs an explicit answer for each.

**Not** in `ScheduleScreen.jsx`. If adding a route requires editing the screen beyond a label, the route abstraction has leaked.

### X2 — Export a schedule to PDF

**Owner: a new `src/export/` module (pure), invoked from a hook, with the file write behind a new IPC channel.**

Layered as:
- *Pure layout computation* → `src/export/scheduleToPages.js`, alongside the engine in spirit: takes slots/groups/days/blocks, returns a page model. No React, no IO. Testable without Electron.
- *Orchestration* → a `useExport` hook, mirroring `useGeneration` — it holds the "which route" answer that `ExportChooserModal` produced, and must not remember it (constitutional).
- *File write* → a new `main.js` handler → `electron/ops/`-adjacent module. It is a read of existing data plus a filesystem write, so **no `appendOp`** — nothing is mutated. It should still go through `authorize()` with a `<entity>.read`-class action, unlike the existing project-lifecycle handlers.

The mistake to avoid: putting layout computation in a component because a component is where the visual result appears.

### X3 — A "recently changed" activity feed in the sidebar

**Owner: `electron/ops/trash.js` (read side) + a new `src/hooks/useActivityFeed.js`.**

The `operations` table already is this feed — it is field-level, attributed, and timestamped. `getEntityHistory` already reads it per entity; a feed is the same query without the entity filter.

Placement:
- The query belongs in `trash.js` (or a sibling `history.js` if `trash.js`'s scope starts to blur), exposed through a new `authorize()`-gated read channel.
- The renderer side belongs in `src/hooks/`, alongside `usePendingConflicts` — **not** in `Sidebar.jsx`, which already has the app's only direct `window.shoresh` access and should not accumulate more IO.

The trap: `listDeleted` is already a full grouped scan with no index (`trash.js:9–13`). A feed that polls makes an acknowledged scaling ceiling load-bearing. This feature is the one most likely to force the `operations` indexing question.

### X4 — Import from a Google Sheets export (a third file format)

**Owner: `src/ingest/`, behind the `pages` intermediate representation.**

The seam already exists — `pages` is what both current formats produce and what `extractEntities` consumes. A third format is a third producer.

The change worth making *while* adding it: `ImportScreen.jsx:73–86` is currently a hardcoded `if/else` on file extension. A third branch is the point at which a small registry (`extension → parser`) pays for itself. This is the natural, minimal evolution — not a plugin architecture.

Nothing in `electron/ops/ingest.js` should change. It receives approved names and validates against `INGESTIBLE_ENTITIES`; it is format-blind by construction, and that is the property that makes adding formats cheap.

### X5 — Per-group colour customization the director can set

**Owner: `groups` entity (persisted field) + `slotCellConstants.js` (fallback).**

- *Storage*: a `color` field on `groups`. This means adding it to `PROJECTIONS['groups'].fields` — **and this is exactly the case that has silently failed three times before**. An op writing an unregistered field on a registered entity throws (`operations.js:78–80`); an op on an unregistered entity is silently discarded. Registration is not optional and is not currently enforced by any test.
- *Editing UI*: `GroupsScreen.jsx`, alongside the existing field editors.
- *Rendering*: `slotCellConstants.js`, which already owns colour assignment via its `djb2` copy. The persisted colour becomes an override; the hash-derived colour stays as the fallback for groups without one.
- *Migration*: a v29 migration in `localDb.js`, following the existing sequential pattern — and if it uses a deferred-retry, the compound version guard (`localDb.js:1264–1271`).

The mistake to avoid: putting the colour in renderer-local state or `localStorage`. Anything the director sets is camp data, must sync, and therefore must be an op-logged entity field.

---

## Responsibilities with no clear owner

Three, stated so they are not mistaken for oversights in this document:

1. **"Resolve a drag-end into an action."** Split verbatim across two handlers in `ScheduleScreen.jsx`. C2 addresses it.
2. **Week CRUD orchestration.** Inline in the screen; every sibling cluster has a hook.
3. **"Is every writable entity registered in `PROJECTIONS`?"** No file owns this question. It has been answered wrongly three times.
