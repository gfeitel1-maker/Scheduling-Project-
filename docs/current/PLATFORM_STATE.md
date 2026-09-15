# Shoresh — Platform State

_Last updated: 2026-09-15_

This document is **descriptive, not authoritative**: it records what exists. Where it
disagrees with the code, the code is right and this document is stale. The governing
documents are resolved by `docs/governance/GOVERNANCE_INDEX.md`; the Architecture section
of the root `CLAUDE.md` is the shorter companion to this file and must not be contradicted
here.

It is also **not a changelog.** Per-ticket history lives in commits, ADRs under
`docs/adr/`, and tickets under `docs/work/`. This file describes the current shape only.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite (dev server on port 5200, `strictPort`) |
| Desktop shell | Electron (`electron/main.js`, `electron/preload.js`) |
| Local store | SQLite via `better-sqlite3` — one database per device |
| Source of truth | One shared **Automerge (CRDT) document per camp**; SQLite is its projection |
| Sync transport | **libp2p** — `@libp2p/tcp` + Noise (encryption and peer identity) + yamux (multiplexing), peers found by **mDNS**. LAN-only by design |
| Auth | Local, PIN-based, per-camp. Ed25519 `camp` tokens + HMAC `local` tokens, 24h |
| Cloud backend | **None.** The former Supabase backend is retired to `legacy/supabase/` |
| Repo | `git@github.com:gfeitel1-maker/Scheduling-Project-.git` |

There is **no server and no Host/Client sync topology** — devices are peers. One device
does hold the Host signing key (`host_signing_key`, never replicated), but that is an
*authority* role for minting credentials and admitting devices, not a data path.

**Transport boundary is load-bearing and enforced.** No relay, no DHT, no NAT traversal,
no WebRTC/WebSocket/WebTransport. `electron/sync/automerge/transportBoundary.guard.test.js`
fails `npm run verify` if an internet-transport package enters `package.json`, if
`electron/sync/automerge/transport.js` imports one, or if `DEFAULT_LISTEN` moves off
loopback. Nearly every security tradeoff in the app is acceptable *only* under the LAN
assumption. Note that `DEFAULT_LISTEN` is loopback but `electron/main.js` deliberately
overrides it to `/ip4/0.0.0.0/tcp/0` so the shipped app can actually sync on the LAN.

---

## Navigation Model

No router and no React context. Two layers:

1. **Device/session phase.** `src/hooks/useDeviceMode.js` derives a `phase`
   (`error` → `loading` → `mode-select` → `bootstrap`/`join` → `pairing_pending` →
   `pairing_denied` → `login` → `session`). `App()` in `src/App.jsx` switches on it to
   render `ModeSelectScreen`, `CampBootstrapScreen`, `JoinByCodeScreen`,
   `PairingPendingScreen` (which renders `pairing_denied` inline), `LoginScreen`, or the
   full `AppShell`.
2. **In-session screen.** `AppShell` holds a `screen` string in `useState`, looks it up in
   the `SCREENS` map in `src/App.jsx`, and renders it inside `Shell` → `Sidebar`
   (`src/components/layout/`). `campId`, `role`, and an `onNavigate` callback are threaded
   as props into every screen.

Sidebar destinations and their grouping live in `src/components/layout/navSections.js`,
organised by the root/tree metaphor: **Roots**, then *Germination* (Age Divisions, Groups,
Days, Time Blocks, Locations), *Sprouts* (Activities, Fixed Events, Recurring Events,
Electives, Special Events), *Plants* (Generated Schedule, Manual Build, Special Schedules,
Elective Schedules), then Camp, Re-import last year, Conflicts, Trash, LAN & Devices.
`src/screenKeys.js` is the shared key list, with guard tests
(`src/screenDestinationsExist.test.js`, `src/screenKeys.syncGuard.test.js`) that fail if a
nav destination has no screen behind it.

Landing is stage-aware: an empty camp lands on `seed`, any other camp lands on `roots`.

---

## Auth

- **Local and PIN-based, per camp.** `electron/auth/localAuth.js`'s
  `attemptLogin(db, {name, pin, deviceId})` does the PIN check (`scryptSync` +
  `timingSafeEqual`) and lockout tracking (5 attempts, 30s).
- **Two token types, both 24h.** `camp` tokens are signed with the Host's Ed25519 private
  key (`host_signing_key`, never replicated); other devices receive the public half via
  `camps.signing_public_key` and can verify but never mint. `local` tokens are HMAC-SHA256
  keyed to that device's own device secret and are valid only for local IPC on that device.
- **Both login paths converge.** Local IPC and the libp2p auth handshake that lets a fresh
  device verify its PIN against the Host (`electron/sync/automerge/authGate.js`,
  `electron/sync/automerge/mutualAuth.js`) both route through `attemptLogin`, and share one
  admission decision in `electron/auth/connectionAuth.js` so the two transports cannot
  drift.
- **Every mutating IPC and peer write goes through `authorize()`**
  (`electron/auth/authorize.js`), which re-queries role and device trust on each call
  against the matrix in `electron/auth/permissions.js`. Lookup is **default-deny**.
- **Host-signed credentials.** Credential fields (`role`, `pin_hash`, `pin_salt`) carry a
  Host Ed25519 signature in `users.auth_sig` (`electron/auth/authSignature.js`) over
  `{id, role, pin_hash, pin_salt, cred_version}`, where `cred_version` is a monotonic
  per-user counter. On the merge path the projector applies a credential change only if the
  signature verifies **and** `cred_version` is not older than the local row's; a device
  with no `signing_public_key` skips such changes rather than trusting them. A compromised
  paired device therefore cannot forge a role, escalate itself, or replay an old credential
  tuple.
- **Device trust.** Joining is by join code (`electron/sync/joinCode.js`,
  `electron/sync/automerge/joinSession.js`), then explicit approve/deny on the Host
  (`electron/auth/deviceTrust.js`, `DeviceManagerScreen`).
- Threat model, accepted tradeoffs, and known gaps: `SECURITY.md` and
  `docs/current/CRDT_SECURITY_GAPS.md`.

### Role-Based Behavior

Two roles: `admin` (the director) and `staff`.

| Area | admin | staff |
|---|---|---|
| Read/write ordinary camp entities (groups, tiers, activities, days, time blocks, locations, events, electives, special days, schedule templates/weeks/slots/snapshots) | ✅ | ✅ |
| Delete / bulk-replace those entities | ✅ | ❌ (default-deny) |
| Users, camps, devices, conflicts | ✅ | ❌ |
| Promote a user to `admin` | ✅ via `electron/ops/promoteToAdmin.js` only | ❌ |

`PERMISSIONS.admin` is the wildcard `['*']` — an unconditional grant, which is why
cracking a director PIN buys every admin-gated action. Known and recorded, not solved here.
PIN floors are enforced at one chokepoint inside `createUser`: `admin` ≥ 6 digits,
`staff` ≥ 4, digits only. The generic `write()` path refuses
`entity:'users' field:'role' value:'admin'`; `promoteToAdmin.js` writes `role`, `pin_hash`
and `pin_salt` atomically with a fresh admin-floor PIN.

---

## Screens

Pre-session screens (selected by `device.phase`):

| Screen | File | Notes |
|---|---|---|
| — | `src/screens/ModeSelectScreen.jsx` | Start a new camp or join an existing one |
| — | `src/screens/CampBootstrapScreen.jsx` | Create the camp + first director |
| — | `src/screens/JoinByCodeScreen.jsx` | Join by code; finds the Host, requests pairing |
| — | `src/screens/PairingPendingScreen.jsx` | Waiting for approval; renders `pairing_denied` inline |
| — | `src/screens/LoginScreen.jsx` | Name + PIN |

In-session screens, keyed as in the `SCREENS` map:

| Screen key | File | Notes |
|---|---|---|
| `roots` | `src/screens/RootsHomeScreen.jsx` | The calm home base — what Shoresh knows about this camp. No verdict banner |
| `seed` | `src/screens/SeedScreen.jsx` | First-run landing for a camp with no setup data; unreachable once setup data exists |
| `camp` | `src/screens/CampScreen.jsx` | Camp-level settings |
| `import` | `src/screens/ImportScreen.jsx` | Spreadsheet ingestion; hosts the reconciliation flow |
| `cohorts` | `src/screens/CohortsScreen.jsx` | Cohorts |
| `tiers` | `src/screens/TiersScreen.jsx` | Age Divisions |
| `groups` | `src/screens/GroupsScreen.jsx` | Groups (week-scoped) |
| `days` | `src/screens/DaysScreen.jsx` | Days of operation |
| `timeblocks` | `src/screens/TimeBlocksScreen.jsx` | Periods |
| `activities` | `src/screens/ActivitiesScreen.jsx` | Activity catalog + rules (week-scoped) |
| `locations` | `src/screens/LocationsScreen.jsx` | Locations, list-only (no spatial layer) |
| `anchors` / `fixedevents` | `src/screens/AnchorsScreen.jsx` | **One screen, two nav keys**, split by a fixed `kind` prop (`recurring` / `fixed`) |
| `electives` | `src/screens/ElectivesScreen.jsx` | Elective sets (setup side) |
| `specialevents` | `src/screens/SpecialEventsScreen.jsx` | One create/manage hub for special events and days |
| `schedule`, `schedule:manual`, `schedule:generated` | `src/screens/ScheduleScreen.jsx` | **One screen, three keys.** `schedule` is a neutral entry point that designates nothing |
| `schedule:special` | `src/screens/SpecialSchedulesScreen.jsx` | Schedule-side build picker (a picker, not a route) |
| `schedule:electives` | `src/screens/ScheduleElectivesScreen.jsx` | Schedule-side elective-set builder |
| `conflicts` | `src/screens/ConflictsScreen.jsx` | Pending CRDT conflicts awaiting explicit resolution |
| `trash` | `src/screens/TrashScreen.jsx` | Soft-deleted records and restore |
| `devices` | `src/screens/DeviceManagerScreen.jsx` | LAN & Devices — pairing requests, approve/deny/revoke |

`src/screens/ReconciliationScreen.jsx` is a real screen but has **no nav key**: it is
rendered by `ImportScreen` (`mode="import"`) as the reconcile-a-file flow.

---

## Components

Shared, top level of `src/components/`: `ActivityPicker`, `CohortPicker`,
`LocationPicker`, `CapacityStepper`, `ConfirmDangerDialog`, `DeleteRecordDialog`,
`RecordHistory`, `ScheduleDoor`, `AuthWatermark`, plus `src/components/icons/`.

By cluster:

- **`src/components/layout/`** — `Shell.jsx`, `Sidebar.jsx`, `TopBar.jsx`, plus
  `navSections.js` (destinations) and `sidebarState.js`.
- **`src/components/schedule/`** — the grid and its chrome: `SlotCell`, `EmptyCell`,
  `CellInlineEditor`, `ActivityPalette`, `ManualBuildView`, `ScheduleGroupView`,
  `ScheduleDayView`, `ScheduleActivityView`, `FindingsRail`, `WeekSwitcher`,
  `WeekContextBar`, `VersionsDropdown`, `ExportChooserModal`, `DeleteWeekDialog`,
  `ExclusionConfirmDialog`, `ConfirmRegenModal`, `ScheduleSkeleton`, `StatBadge`,
  `ErrorBanner`, `IndeterminateBar`, plus keyboard navigation (`useGridKeyboardNav.js`,
  `gridNavigation.js`) and constants (`slotCellConstants.js`, `cellLabel.js`).
- **`src/components/setup/`** — `SetupScreenShell.jsx` (the shared setup screen frame),
  `InlineAddRow.jsx`, `ImportModal.jsx`, `ProvenanceDot.jsx`.
- **`src/components/reconciliation/`** — `reconciliationCards.jsx`, `RootMap.jsx`,
  `RootMapPanel.jsx`, `RosterList.jsx`, `ReconstructionMoment.jsx`, `rootsBanner.jsx`,
  `postImportBanner.jsx`, plus the pure models beside them (`selectionModel.js`,
  `domainRollup.js`, `groupIdenticalDecisions.js`, `rootMapLayout.js`, `rootMapNav.js`).

**Styling** — design tokens in `src/index.css`; component styles are inline React objects
with shared constants in `src/styles/shared.js`. No CSS modules. The **one** stylesheet
exception is `src/components/schedule/scheduleGrid.css`, scoped to the schedule grid's
pseudo-states and data-attribute states; a new ephemeral cell state is added there as a
data attribute, not as React state.

---

## Database Tables

SQLite is the **projection** of the Automerge document, not the source of truth. The base
schema is `electron/db/schema.sql`; incremental migrations live in
`electron/db/localDb.js` with down-migrations in `electron/db/rollback/`.

**`CURRENT_SCHEMA_VERSION = 61`** (`electron/db/localDb.js`) — read it there rather than trusting this number.

Described by cluster rather than column-by-column — read `electron/db/schema.sql` for the
authoritative column lists.

- **Identity and access** — `camps` (always `SELECT ... FROM camps LIMIT 1`: one camp per
  device db, which is how data isolation is enforced), `users` (including `auth_sig`,
  `cred_version`), `devices`, `device_identity`, `host_signing_key` (Host-only, never
  replicated), `login_attempts`.
- **Camp structure** — `cohorts`, `tiers`, `groups`, `days_of_operation`, `time_blocks`,
  `locations`, `activities`, `anchor_activities`.
- **Events and electives** — `events`, `event_groups`, `event_time_blocks`, `event_slots`,
  `special_days`, `special_day_time_blocks`, `special_day_slots`, `elective_sets`,
  `elective_set_activities`.
- **Schedules** — `schedule_templates` (two rows per camp, distinguished by `kind`:
  manual and generated), `schedule_weeks`, `template_slots`, `schedule_snapshots`,
  and the week exclusion tables `week_activity_exclusions`, `week_group_exclusions`,
  `week_location_exclusions`.
- **Local history, writes, and conflicts** — `operations` (**local history ledger only —
  no longer the sync mechanism**; `client_write_id` still makes retries idempotent),
  `pending_writes`, `pending_restores`, `conflicts`, `projection_failures`, `locks`,
  `audit_events`.
- **Ingestion and reconciliation (several deliberately host-local, not replicated)** —
  `source_aliases`, `open_reconciliation_decisions`, `compound_cell_decisions`,
  `declined_two_row_splits`, `location_word_decisions`, `location_migration_reviews`,
  `import_evidence`.
- **Dormant** — `camp_maps` (the spatial/map layer was removed; the columns remain).
- **Bookkeeping** — `schema_migrations`.

Which tables replicate and which are host-local is documented in
`docs/current/WHERE_DATA_LIVES.md`.

---

## Edge Functions / API Routes

**(none.)** There is no cloud backend and no HTTP API. The two machine-facing surfaces are:

| Surface | Trigger | Purpose |
|---|---|---|
| Renderer IPC | `window.shoresh.*` from React | The renderer's only way to reach data |
| MCP / CLI | External agent or terminal | Read-only inspection plus ingest and projection-repair commands |

**Renderer ↔ Electron IPC** — the renderer never touches SQLite. Everything goes through
`window.shoresh.*`, exposed by `contextBridge` in `electron/preload.js` and handled in
`electron/main.js`. The surface is large (~90 channels): **read `electron/preload.js` for
the real list** rather than trusting any summary — a hand-copied list is exactly what rots.
Clusters, with representative members:

- **Session and camp** — `chooseMode`, `login`, `verifySession`, `bootstrapCamp`,
  `createUser`, `promoteToAdmin`, `getCamp`, `campHasSetupData`, `listUsers`.
- **Data read/write** — `write`, `bulkReplace`, `list`, `listByScope`, `deleteRecord`,
  `previewDelete`, `listDeleted`, `restoreEntity`, `getEntityHistory`, `mergeLocation`.
- **Joining and device trust** — `getJoinCode`, `setJoinWindow`, `joinStart`,
  `joinFindHost`, `joinRequestPairing`, `joinAwaitPairingDecision`, `joinLogin`,
  `joinAwaitData`, `joinCancel`, `approveDevice`, `denyDevice`, `listDevices`,
  `revokeDevice`, `getDevicePairingStatus`.
- **Sync status and conflicts** — `getSyncEngine`, `getSyncStatus`, `latestOpSeq`,
  `resolveConflict`, `listPendingConflicts`.
- **Ingestion and reconciliation** — `ingestCommit`, `ingestReconcile`, `ingestUndo`,
  `confirmAlias`, `recordDeclinedSplit`, `listDeclinedSplitNames`,
  `listCompoundCellDecisions`, `listOpenReconciliationDecisions`, `listImportEvidence`.
- **Schedule-object lifecycle** — `duplicateWeek`, `deleteWeek`, `deleteElectiveSet`,
  `deleteSpecialDay`, `deleteEvent`, `listDurableElectiveSets`.
- **Projects (camp files)** — `createProject`, `openProject`, `exportProject`,
  `backupProject`, `restoreProject`, `listRecentProjects`, `openRecentProject`,
  `getCurrentProject`.
- **Push events** — `onOpApplied`, `onOpConflict`, `onOpRejected`, `onFullSyncApplied`,
  `onSyncStatusChanged`, `onPairingRequest`, `onPairingApproved`, `onPairingDenied`,
  `onTokenRenewed`, `onAuthRejected`.

IPC/preload parity is guarded by `electron/ipcSurfaceParity.test.js`.

---

## Key Architectural Decisions

Only the non-obvious things — the ones that would surprise a new engineer.

- **The Automerge document is the source of truth; SQLite is a projection.**
  `electron/automerge/projector.js` projects the document into the tables the app queries.
  The document shape lives in `electron/automerge/campDocument.js`, storage in
  `electron/sync/automerge/docStore.js` / `liveDoc.js`. A support command
  (`electron/automerge/rebuildSupportCommand.js`) can rebuild SQLite from the document —
  note that a rebuild also loses anything host-local, signing keys included.
- **Records are stored flat.** Each field is its own document key, never a nested
  `doc[entity][id]` object. That flattening closed a whole class of concurrency defects.
  Always go through `readRecord`/`recordKey`.
- **Some tables are deliberately host-local and never replicate** — reconciliation
  decisions, aliases, and the signing key. See `docs/current/WHERE_DATA_LIVES.md`.
- **The LAN-only transport boundary is a security premise, not an implementation detail.**
  It is what makes PIN-in-first-message, device-side role enforcement, and small-peer rate
  limits acceptable. Guarded by a test that fails the gate.
- **The `operations` table is history, not sync.** Automerge is the sync mechanism.
  `operations` is retained for entity history, undo, and audit.
- **Two candidate schedules, neither canonical.** A camp holds up to two schedules, one
  per building route — **Manual** (the director builds it; the spreadsheet replacement)
  and **Generated** (the engine proposes; the director drags to edit). They are separate
  `schedule_templates` rows sharing one camp setup, and they coexist: switching is
  navigation, never destructive, never confirmed. Nothing in the app may designate one as
  the camp's real schedule. Where exactly one is required (export) the director chooses at
  that moment, and the choice is not remembered. Per-slot flags differ by route —
  `UNFILLABLE` on generated only, `OVERLAP` (derived at render time, never persisted) on
  manual only — while the flag vocabulary is shared.
- **The schedule engine is pure.** `src/engine/buildSchedule.js` has no React or IPC
  dependency: `buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors,
  campId, preplacedSlots })` → `{ slots, conflicts, findings }`, in three passes (resolve
  eligibility, place high- then low-priority, audit flags), with a seeded PRNG so identical
  inputs give identical schedules. A multi-block activity counts as **one** session toward
  `min_per_week` and `prefer_before_day` — a double-length swim is one swim.
- **No banners for state that needs surfacing.** State belongs in the per-slot flag
  vocabulary, not in page chrome.
- **Dev and packaged builds use separate databases, deliberately** — `shoresh-dev` vs
  `shoresh`, set in `electron/db/userDataPath.js`. A **DEV** badge in the sidebar footer is
  the tell.
- **`better-sqlite3` is native**, so its ABI drifts between Node (Vitest) and Electron;
  rebuild when switching. See Commands in the root `CLAUDE.md`.
- **The gate is `npm run verify`** (`scripts/verify.js`): lint + agents:check + test +
  test:integration + security + check:governance, printing a final verdict line so a
  piped tail cannot false-green.

---

## Home Screen Layout

There is one in-session home screen, not one per role: **Roots**
(`src/screens/RootsHomeScreen.jsx`). It is the honest "what does Shoresh know about this
camp" surface — census/structure counts and chips summarising each domain, with row
actions that navigate into the relevant setup or schedule screen. There is no readiness
verdict banner on it.

The one exception is stage, not role: a camp with no setup data lands on `seed`
(`src/screens/SeedScreen.jsx`) instead, and that screen is unreachable once setup data
exists.

---

## Known Deferred Items

- **`admin` is an unconditional wildcard** in `electron/auth/permissions.js`. The PIN-length
  floor raises the offline guessing cost but does nothing about blast radius. Known owner
  follow-up.
- **Persistent per-device identity binding** for session tokens is an accepted ADR that is
  not yet implemented — tokens remain bearer-shaped.
- **Cross-network sync is demonstrated but not shipped.** A parked spike on the branch
  `claude/shoresh-future-architecture-364e03` (`experiments/future-arch/`) held a direct
  hole-punched libp2p connection between two machines on different networks carrying live
  Automerge edits. It is **not** current behavior, and the LAN limit is a current gate, not
  a permanent property of the design.
- **`camp_maps` is dormant** — the table survives, the spatial layer does not.
- Remaining CRDT-era security gaps are tracked in `docs/current/CRDT_SECURITY_GAPS.md`.

---

## Removed / Replaced

- **The WebSocket Host/Client sync layer is gone** (~14k lines). `electron/sync/syncServer.js`
  and `electron/sync/syncClient.js` no longer exist; libp2p + Automerge replaced them, and
  the op log was retired *as a sync mechanism* while the `operations` table stayed on as
  local history.
- **The Supabase backend is fully retired** to `legacy/supabase/`: not imported anywhere
  under `src/` or `electron/`, `@supabase/supabase-js` removed from `package.json`, and an
  ESLint rule in `eslint.config.js` bans reintroducing any `@supabase/*` import.
  `src/hooks/useSession.js` no longer exists. Postgres RLS (`get_my_camp_id()`) enforced
  tenant isolation in that era; isolation is now single-camp-per-device-db.
- **Setup Readiness (the readiness hub) is retired.** Roots is the in-session landing
  screen, and there is no verdict banner on it. `src/engine/readiness.js` still computes
  readiness for other consumers.
- **The separate Events and Special Days screens were unified** into one
  `SpecialEventsScreen`; Fixed and Recurring events were un-conflated into two nav keys
  over a single `AnchorsScreen`.
- **The day-overrides and day-map surfaces were removed** (the screens and their
  coordinate/occupancy helpers are gone; removal migrations remain as tests).
- **The spatial/facility map layer was removed** from Locations, which is now list-only.
  A separate animated pixel-world map project lives outside this repo.
- **Sidebar setup counts were removed** from the sidebar (the hook still exists for screens
  that need the numbers).
- **The schedule edit modal was replaced** by drag-first placement with inline cell entry.
