---
title: "Dependency Flow Map"
document_type: architecture-report
status: current
created: 2026-08-04
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
companions: [REPOSITORY_ARCHITECTURE_MAP.md, BOUNDARY_AUDIT.md, RESPONSIBILITY_MATRIX.md, TARGET_ARCHITECTURE.md]
---

# Dependency Flow Map

How information actually moves through Shoresh, workflow by workflow, naming the file and function at every layer. Descriptive of `main` as of 2026-08-04.

## The canonical stack

```
Screen  (src/screens/*.jsx)
  │
Hook    (src/screens/schedule/use*.js, src/hooks/use*.js)
  │
Repository  (src/data/scheduleRepository.js)
  │
localClient  (src/localClient.js)
  │
══ IPC seam ══  (electron/preload.js → window.shoresh.*)
  │
Handler  (electron/main.js — makeHandlers())
  │
Ops      (electron/ops/operations.js: appendOp / appendBulkReplaceOp
          electron/ops/projections.js: applyProjection)
  │
SQLite   (better-sqlite3)
```

Return traffic to the renderer takes a second path — not a return value but a push event: `syncClient` → `main.js` `wireOpApplied` → `webContents.send('shoresh:op-applied')` → `preload.onOpApplied` → `localClient.onOpApplied` → screen listener.

---

## Workflow 1 — Loading a schedule

Trigger: mount, or `weekId` change (`ScheduleScreen.jsx:427`), or a **remote** op arriving (`ScheduleScreen.jsx:446–453`).

| # | Layer | What happens |
|---|---|---|
| 1 | Screen | `loadAll()` — `ScheduleScreen.jsx:264–417`, a ~150-line async closure |
| 2 | Repository | `repo.loadSetupLists()` → groups, days, timeBlocks, activities, anchors, tiers, cohorts |
| 3 | localClient | `localClient.list(token, entity)` per entity, token read from `localStorage` |
| 4 | IPC | `window.shoresh.list` → `ipcRenderer.invoke('shoresh:list')` |
| 5 | Handler | `main.js` `list` handler → `authorize({action: '<entity>.read'})` |
| 6 | Read | direct `db.prepare(...).all()` against the allowlisted table (`campScopedEntities.js`) — **reads do not go through the op log** |
| 7 | Screen | `setGroups`, `setDays`, … filtered by `campId` and sorted |
| 8 | Repository | `repo.loadWeeks()`; if none exist, `repo.createWeek(...)` lazily mints "Week 1"; resolve `liveWeekId` |
| 9 | Repository | `repo.loadWeekExclusions(liveWeekId)` → `setActivityExclusions` / `setGroupExclusions` |
| 10 | Repository | `repo.loadTemplateData()` — **once, then split for both routes** |
| 11 | Screen | `for (const r of ROUTES)` (`ScheduleScreen.jsx:374–403`): resolve the template row and id, filter slots/overlays/snapshots by `template_id`, compute `statsFor` and `computeFindings` |
| 12 | Hook state | bulk-set through `useRouteState`: `setExistingTemplates`, `setTemplateIdByRoute`, `setSlotsByRoute`, `setOverlaysByRoute`, `setSnapshotsByRoute`, `setStatsByRoute`, `setFindingsByRoute`, `setDismissedByRoute` |

**Design note worth keeping**: step 10–12 load *both* routes on every load. This is what makes route switching instantaneous and non-destructive — switching is pure navigation over already-resident state, never a fetch. The cost is that every week change reloads two candidate schedules.

**Note on step 6**: a read is a plain SELECT. Only writes are op-logged. `computeFindings` and the `OVERLAP` derivation run in the renderer at render time and are never persisted.

---

## Workflow 2 — Saving a schedule (a slot write)

Example: `editSlotSave` in `useSlotMutations.js:56–107`.

| # | Layer | What happens |
|---|---|---|
| 1 | Screen | user confirms in `EditModal`; `editSlotSave(...)` fires |
| 2 | Hook | locate the slot in the screen's `slots` (the overlap-flagged view) |
| 3 | Repository | `repo.writeSlotFields(slot.id, { activity_id, flags })` |
| 4 | Repository | `writeFields` loops the map into **one `localClient.write` per field** — a two-field edit is two ops |
| 5 | localClient | `localClient.write(token, entity, id, field, value)` |
| 6 | IPC | `window.shoresh.write` → `invoke('shoresh:write')` |
| 7 | Handler | `main.js` `write` handler → `deriveWriteAction(entity, field)` → `authorize({action})` |
| 8 | Sync client | `syncClient.write(...)`. On the Host (no `serverUrl`) this calls `appendOp` directly. On a Client it acquires an advisory lock, then sends `submit_op` — or persists to `pending_writes` and returns `{status:'queued'}` if offline |
| 9 | Ops | `appendOp(db, {entity, entity_id, field, value, author_user_id, device_id, client_write_id, ...})` — `operations.js:76–112`. Validates the field against `PROJECTIONS[entity].fields`; coerces the value (`coerceOpValue`: booleans → `'1'`/`'0'`, objects → JSON); inserts into `operations`; re-reads for `seq`; calls `applyProjection`. One transaction |
| 10 | Ops | `applyProjection(db, op)` — `projections.js:450–494`. Looks up the entity; `ensureExists` guarantees the row; `UPDATE <table> SET <field> = ? WHERE <key> = ?` |
| 11 | SQLite | `template_slots` row updated |
| 12 | Push | `syncServer` broadcasts `op_applied` to every other connected device; locally `main.js` `wireOpApplied` sends `shoresh:op-applied` to the renderer |
| 13 | Hook | back in `useSlotMutations`: optimistic `setSlots` (route-pinned), then `recalcStats`, `recalcFindings`, `pushUndo` with closures capturing the route-pinned setter |

**The optimistic patch happens after the write resolves, not before.** The write is awaited; local state is updated only on success. "Optimistic" here means "we patch local state rather than refetch," not "we render before confirming."

**Silent-failure surface**: if `entity` is not in `PROJECTIONS`, step 9 logs the op and step 10 discards it. The write returns success. Nothing changes on disk. See BOUNDARY_AUDIT.

---

## Workflow 3 — Dragging an activity

| # | Layer | What happens |
|---|---|---|
| 1 | Component | dnd-kit `PointerSensor` with `distance: 8` activation (so a click is still a click) fires `onDragEnd({active, over})` |
| 2 | Screen | `handleGroupDragEnd` (`ScheduleScreen.jsx:510–550`) or `handleDayDragEnd` (`:559–611`) — two near-duplicate handlers, one per view |
| 3 | Screen | branch on `active.data.current`: `.expandDrag` → `expandSlot`; `.paletteActivity` → `placeActivityManual`; otherwise (day view only) a slot swap → `swapSlots` |
| 4 | Hook | `placeActivityManual` (`useSlotMutations.js:262–336`) validates eligibility and `max_groups_per_slot`; sets the `UNFILLABLE` flag if the placement is ineligible **and** `route !== 'manual'` |
| 5 | Repository | `repo.writeSlotFields(...)` → same path as Workflow 2, steps 4–11 |
| 6 | Hook | optimistic `setSlots`, `recalcStats`, `recalcFindings`, `pushUndo` |
| 7 | Push (this device) | `shoresh:op-applied` arrives for the op **this device just wrote** |
| 8 | Screen | the T37 guard: `if (op.device_id !== localDeviceIdRef.current)` (`ScheduleScreen.jsx:446–453`). Local ops **skip `loadAll()`** entirely |
| 9 | Push (peer device) | on another device the same event arrives with a different `device_id`, the guard passes, and `loadAll()` runs — a full two-route reload |

**Why T37 matters here**: without the guard, every single drag triggered a complete `loadAll()` on the dragging device — reloading both routes' slots, overlays, snapshots, and setup lists — racing the optimistic patch that had just been applied. The visible symptom was flicker. The device id is captured once into `localDeviceIdRef` (`ScheduleScreen.jsx:441–443`) via a direct `localClient.getDeviceId()` call.

**Consequence to keep in view**: local ops now update state through exactly one path (the optimistic patch in the hook). If a future write path forgets to patch, the reload that used to paper over it no longer runs.

---

## Workflow 4 — Generating a schedule

`useGeneration.generate()` — `useGeneration.js:51–126`.

| # | Layer | What happens |
|---|---|---|
| 1 | Screen | director confirms in `ConfirmRegenModal` |
| 2 | Hook | `setGenerating(true)`, `resetUndoRedo()` |
| 3 | Hook | build **explicit generated-route setters** via `routeSetter` — not "the current route." Documented at `useGeneration.js:12–16` as a guard against a same-tick `setRoute` race |
| 4 | Engine | `resolveWeekCatalog({ groups, activities, anchors, weekId, activityExclusions, groupExclusions })` → the week's effective catalog |
| 5 | Screen state | compute `preplacedSlots` from locked activities |
| 6 | Engine | `buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors, campId, preplacedSlots })` → `{ slots, stats, findings }`. **Pure, synchronous, no IO** |
| 7 | Hook | `setGenFindings(result.findings)` |
| 8 | Repository | `ensureTemplateRow('generated')` — mints the `schedule_templates` row if absent |
| 9 | Hook | if slots already existed, auto-`saveSnapshot(null, true, 'generated')`. **Aborts the whole generation if the snapshot fails** (`useGeneration.js:96–104`) — the director's prior work is never destroyed to make room for a new proposal |
| 10 | Repository | `repo.replaceWeek(tid, result.slots)` → `localClient.bulkReplace` |
| 11 | Handler | `main.js` `bulkReplace` → `authorize({action: '<entity>.bulk_replace'})` (admin-only) |
| 12 | Ops | `appendBulkReplaceOp` — one op recording a scope-wide delete-and-reinsert, plus `detectBulkReplaceConflict` comparing the client's `based_on_seq` against the Host's current scope seq |
| 13 | Repository | `repo.reloadSlots(tid)` — read back what actually landed |
| 14 | Hook | `setGenSlots`, `setGenStats` |

**The important boundary**: the engine never learns that persistence exists. It receives plain arrays and returns plain arrays. Step 6 could run in a test with no Electron, no database, and no React — and does (`buildSchedule.test.js`).

**Route safety**: steps 3, 8, 10, and 14 are all pinned to `'generated'` by construction. Generating cannot touch the manual route even if the director switches routes mid-generation.

---

## Workflow 5 — Importing a camp

| # | Layer | What happens |
|---|---|---|
| 1 | Screen | `<input type="file" multiple>` (`ImportScreen.jsx:209–215`) → `readFiles(fileList)` (`:58–126`) |
| 2 | Renderer parse | `.xlsx/.xlsm/.xls` → `XLSX.read` + `sheet_to_json({raw:false})` → `workbookToPages` (`:74–83`). `.txt/.csv/.tsv` → `parseTextGrid(await file.text())` (`:85`). Both produce `pages` |
| 3 | Renderer infer | `extractEntities({ pages })` (`:95`) → a `proposal` with per-row confidence |
| 4 | Read | `localClient.list(entity)` per entity (`:98`) for duplicate detection, scoped to `activeCohort` for tier/time-block entities (`:102–104`) |
| 5 | Renderer preview | `buildPreview(proposal, existing)` (`:109`), `describePreview(preview)` (`:230`) |
| 6 | Director | every proposed row defaults checked except low-confidence ones (`:111–121`); `toggle(entity, name)` flips any row |
| 7 | Optional | in `replace` mode, a pre-delete loop of `localClient.deleteEntity` calls (`:146–153`) — note this is a *loop of individual ops*, not a transaction |
| 8 | Commit | `localClient.ingestCommit(approved, { groups: groupUnits }, activeCohort?.id ?? null)` (`:163`) — the single seam |
| 9 | IPC | `invoke('shoresh:ingest-commit')` |
| 10 | Handler | `main.js` `ingestCommit` → `authorize({action: 'groups.import'})` |
| 11 | Ops | `commitIngest` (`electron/ops/ingest.js`) — validates against `INGESTIBLE_ENTITIES` (`:23`), then `appendOp` per entity per field, **all inside one transaction** |
| 12 | SQLite | rows materialize via `applyProjection` |

**Where the trust boundary sits**: all parsing, inference, confidence scoring, and preview construction happen in the renderer. The main process receives only the approved name lists and re-validates them against its whitelist. It does not re-parse or re-infer. The whitelist is therefore the entire defence at this seam — which is the right shape, since the payload is a list of names, not a program.

**Asymmetry worth noting**: step 11 is transactional; step 7 is not. A replace-mode import that fails partway through the pre-delete loop leaves the camp with some entities deleted and none re-created.

---

## Workflow 6 — Synchronization

### Outbound (the device that wrote)

| # | Layer | What happens |
|---|---|---|
| 1 | Ops | `appendOp` completes on the Client, or `syncClient.write` is called |
| 2 | Client | if connected: `acquire_lock {entity, entity_id, field}` → `lock_result {granted, holder_device_id?}` (advisory only — a denial is a UX hint, not a block), then `submit_op { op: {entity, entity_id, field, value, parent_op_id, client_write_id} }` |
| 3 | Client (offline) | persist to `pending_writes` *before* returning `{status:'queued'}` (`syncClient.js:980–1006`), so a crash cannot lose a write that already looked saved to the director |
| 4 | Server | `handleSubmitOp` — `if (!ws.deviceId) return`, then `authorize()` against the connection's own `ws.token` (never a message-body field; `syncServer.js:518–526`) |
| 5 | Server | `findOpByClientWriteId` short-circuit (`syncServer.js:567–573`) — a retry returns the *original* op rather than re-running conflict detection and spuriously self-conflicting |
| 6 | Server | `detectConflict`; on conflict, `recordConflict` into the `conflicts` table (best-effort, try/caught so a persistence failure never blocks the reply) then reply `op_conflict {incomingOp, existingOp}` |
| 7 | Server | otherwise `appendOp` on the Host db → `applyProjection` → broadcast `op_applied {op}` to every connected device |

### Inbound (every other device)

| # | Layer | What happens |
|---|---|---|
| 8 | Client | `applyRemoteOp` — `INSERT INTO operations ... ON CONFLICT(id) DO NOTHING`, and **projects only if the insert actually changed a row** (`syncClient.js:397–412`). A replayed op cannot overwrite with stale values |
| 9 | Client | `applyProjection(db, op)` on the local db |
| 10 | Main | `wireOpApplied` → `webContents.send('shoresh:op-applied', sanitizedOp)` (`main.js:147`) |
| 11 | Renderer | `localClient.onOpApplied` listener → `ScheduleScreen.jsx:448` → device-id guard passes (remote op) → `loadAll()` |

### Ordering and catch-up

- `operations.seq` is a Host-side autoincrement; each device's `devices.last_synced_seq` is its watermark on the Host.
- On reconnect, `sendMissedOps` (`syncServer.js:265–313`) replays `seq > last_synced_seq` in `ORDER BY seq ASC` via `sendWithAck`, which waits for the actual `ws.send()` completion callback rather than merely the absence of a synchronous throw (`syncServer.js:63–95`). The watermark advances only to the last **successfully acked** op, so a partial send never marks undelivered ops as delivered.
- First-ever `authenticate` sets the baseline `asOfSeq = currentMaxOpSeq(db)` computed once, before both `sendFullSyncIfFirstPairing` and `sendMissedOps` run, so the two agree on one instant (`syncServer.js:395–403`).
- First pairing ships a `full_sync` snapshot of `users`, `camps`, and every domain table, latched only after the Client's own app-level `full_sync_applied` ack. If the Client's apply transaction throws, no ack is sent, `last_synced_at` stays NULL, and the whole snapshot retries on the next reconnect.
- `schedule_snapshots` is deliberately excluded from the full-sync payload to avoid unbounded seasonal growth (`syncServer.js:22–24`). A device that pairs late never receives historical snapshots.

### Known divergence mode

`applyRemoteOp`'s `SQLITE_CONSTRAINT_FOREIGNKEY` catch on a DELETE (`syncClient.js:427–451`) logs and continues. The comment is explicit that this is deliberately *not* fixed by cascading locally — the device is knowingly left permanently out of step for that record rather than guessing at a cascade the Host did not perform.

---

## Workflow 7 — Version restore

`useSnapshots.restoreSnapshot()` — `useSnapshots.js:104–149`.

| # | Layer | What happens |
|---|---|---|
| 1 | Component | director picks a version in `VersionsDropdown` (presentational; emits `onRestore`) |
| 2 | Hook | `resetUndoRedo()` — the undo stack cannot span a restore |
| 3 | Repository | `repo.getSnapshot(id)` → the full row including its serialized payload |
| 4 | Hook | `parseSnapshotPayload` — guards against corrupt and legacy payload shapes |
| 5 | Hook | **route-ownership check**: `if (fullSnap.template_id !== templateId)` → refuse with a director-facing message (`useSnapshots.js:120–123`). A generated-route snapshot can never overwrite the manual route |
| 6 | Repository | `repo.restoreSnapshotRows(templateId, slots, overlays)` |
| 7 | localClient | `localClient.bulkReplace(token, 'template_slots', templateId, rows)`, and the same for overlays |
| 8 | Handler | `main.js` `bulkReplace` → `authorize({action: 'template_slots.bulk_replace'})` |
| 9 | Ops | `appendBulkReplaceOp` → `applyBulkReplaceProjection` — scope-wide delete and reinsert, one op recording the whole replacement |
| 10 | Repository | `repo.reloadSlots(templateId)` + `repo.reloadOverlays(templateId)` — read back the truth |
| 11 | Hook | `setSlots`, `setOverlays`, `recalcStats`, `setFindings`, `setDismissedFindingKeys` |

**On a Client device**, step 9 becomes a `submit_bulk_replace_op` carrying `based_on_seq`; the Host compares it against the current scope seq and can reply `op_conflict`. Note that unlike field writes, `writeBulkReplace` does **not** queue when offline (`syncClient.js:1008–1018`) — it fails with `{status:'not_authenticated'}`. A restore attempted while disconnected simply does not happen.

**On the restore semantics**: step 9 is a replacement, not a merge. The snapshot is the new truth for that template's scope. This is why step 2 resets undo — there is no coherent way to undo across a scope replacement using per-field inverse closures.

---

## Appendix — IPC channel inventory

Every `ipcMain.handle` channel, from `HANDLER_CHANNELS` (`main.js:909–940`) and the separately-registered project-lifecycle block (`main.js:1020–1266`).

| Channel | Mutates | `authorize()` | via `appendOp` |
|---|---|---|---|
| `choose-mode` | yes (`devices`) | no — pre-session | no |
| `discover-hosts` | no | no — pre-session | — |
| `login` | yes (`devices`, `login_attempts`) | no — pre-session | no |
| `create-user` | yes | yes (`users.create`) | yes |
| `bootstrap-camp` | yes | no — only legal at zero camps | partly (user via appendOp; `camps` raw) |
| `write` | yes | yes (derived) | yes |
| `bulk-replace` | yes | yes (`<entity>.bulk_replace`, admin) | yes (`appendBulkReplaceOp`) |
| `verify-session` | no | n/a — is the check | — |
| `get-camp` | no | no — pre-auth by design | — |
| `list-users` | no | yes (`users.read`) | — |
| `list` | no | yes (`<entity>.read`) | — |
| `get-device-id` | no | yes (`devices.read`) | — |
| `get-sync-status` | no | no | — |
| `ingest-commit` | yes | yes (`groups.import`) | yes |
| `resolve-conflict` | yes | yes (`conflicts.resolve`) | yes |
| `list-conflicts` | no | yes (`conflicts.read`) | — |
| `list-deleted` | no | yes (`trash.read`) | — |
| `list-pending-restores` | no | yes (`trash.read`) | — |
| `get-entity-history` | no | yes (`<entity>.read`) | — |
| `restore-entity` | yes | yes (`<entity>.restore`) | yes |
| `preview-delete` | no | yes (`<entity>.delete`) | — |
| `delete-record` | yes | yes (`<entity>.delete`) | yes |
| `get-device-pairing-status` | no | **no** | — |
| `list-pending-pairing-requests` | no | yes (`devices.read`) | — |
| `list-devices` | no | yes (`devices.read`) | — |
| `approve-device` | yes | yes (`devices.approve`) | no — raw UPDATE |
| `deny-device` | yes | yes (`devices.approve`) | no — raw UPDATE |
| `revoke-device` | yes | yes (`devices.revoke`) | no — raw UPDATE |
| `duplicate-week` | yes | yes (`schedule_weeks.write`) | yes |
| `delete-week` | yes | yes (`schedule_weeks.write`) | yes |
| `get-current-project` | no | **no** | — |
| `create-project` | yes (new db file) | **no** | — |
| `open-project` | swaps db | **no** | — |
| `export-project` | no | **no** | — |
| `backup-project` | no | **no** | — |
| `restore-project` | yes (overwrites db) | **no** | — |
| `list-recent-projects` | no | **no** | — |
| `open-recent-project` | swaps db | **no** | — |

The pre-session exemptions (`choose-mode`, `discover-hosts`, `login`, `bootstrap-camp`, `get-camp`) each carry an inline comment justifying why no token can exist yet. The project-lifecycle block does not carry an equivalent justification — see BOUNDARY_AUDIT.

**Push events**: `op-applied` (`main.js:147`), `op-conflict` (`:152`), `full-sync-applied` (`:163`), `pairing-approved` (`:172`), `pairing-denied` (`:178`), `token-renewed` (`:184`), `pairing-request` (`:268`), `sync-status-changed` (`:242`).

**Seam wrapping gap**: `preload.js` exposes all 8 project-lifecycle methods plus `onFullSyncApplied`, but `src/localClient.js` wraps none of them. Any caller of those necessarily reaches `window.shoresh` directly — which exactly one file does (`Sidebar.jsx:133–143`).
