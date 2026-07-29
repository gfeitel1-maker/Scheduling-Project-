# Shoresh — Platform State

_Last updated: 2026-07-26 (schema v20, 16 integration scenarios; schedule generation end-to-end verified)_

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite, plain inline-style objects (no CSS files/modules) |
| Desktop shell | Electron 43 (`electron/main.js`), contextBridge IPC via `electron/preload.js` |
| Local database | SQLite via `better-sqlite3`, one file per device, schema versioned in-app (`electron/db/schema.sql` + migration blocks in `electron/db/localDb.js`) |
| LAN sync | Custom `ws`-based protocol: one device runs a WebSocket host (`electron/sync/syncServer.js`), others connect as clients (`electron/sync/syncClient.js`); mDNS discovery via `bonjour-service` (`electron/sync/discovery.js`) |
| Legacy backend (fully retired) | `@supabase/supabase-js` is **no longer a dependency** (removed from `package.json`/`package-lock.json`, 2026-07-24). `src/supabase.js` and `supabase/migrations/` have moved to `legacy/supabase/` (with `legacy/supabase/README.md` explaining why they're kept). Zero active imports of Supabase remain anywhere under `src/` or `electron/` — confirmed by a fresh inventory re-run, and enforced going forward by an ESLint `no-restricted-imports` rule (`eslint.config.js`) banning any `@supabase/*` import under `src/**`/`electron/**`, proven to actually fire by `eslint.supabase-ban.test.js`. `App.jsx`'s `seedDays()` (the last live call site) was ported to `localClient`/local `days_of_operation` — see `src/utils/seedDays.js` — before this cleanup landed. |
| Repo | git@github.com:gfeitel1-maker/Scheduling-Project-.git (local clone at `Scheduling-Project-/`) |

**Architecture note:** the app's migration off Supabase (Postgres + Auth + RLS) to the local-first Electron/SQLite/LAN-sync design is **fully complete**, including retirement of the legacy backend itself (not just every screen). Each device has its own SQLite db; one device acts as a LAN "Host" (WebSocket server), others are "Clients" that sync over the LAN. Data isolation that used to be enforced by Postgres RLS is now enforced by the app being fundamentally single-camp-per-device-db (see Database Tables below) plus signed session tokens. New engineering work should target the Electron/SQLite path — `legacy/supabase/` is historical reference only, and the ESLint rule above blocks reintroducing it. The previously-CRITICAL `bulk_replace` cross-device seq bug (see Key Architectural Decisions) is now **fixed** — the Schedule screen's Regenerate flow no longer spuriously conflicts.

---

## Navigation Model

Two nested state machines, no router:

1. **Device/session phase** — `src/hooks/useDeviceMode.js` derives a `phase` from local state (`error` → `loading` → `mode-select` → `bootstrap`/`join` → `pairing_pending` → `pairing_denied` → `login` → `session`). `src/App.jsx`'s top-level `App()` switches on `device.phase` to render one of: `ModeSelectScreen`, `CampBootstrapScreen` (Host: create a new camp), `JoinScreen` (Client: pick a discovered Host), `PairingPendingScreen` (Client: waiting for admin approval), `LoginScreen`, or the full `AppShell`. `pairing_denied` renders an inline error state in `PairingPendingScreen`.
2. **In-app screen** — once in a session, `AppShell` (`src/App.jsx`) holds a `screen` string in `useState`, looked up in the `SCREENS` map and passed down through `Shell` → `Sidebar` (`src/components/layout/`). `campId` and an `onNavigate` (`setScreen`) callback are threaded as props into every screen — no context, no router.

All Electron/SQLite calls from the renderer go through `window.shoresh.*` (see `electron/preload.js`), backed by IPC handlers in `electron/main.js`: `chooseMode`, `discoverHosts`, `login`, `createUser`, `bootstrapCamp`, `write`, `bulkReplace` (new, see below), `verifySession`, `getCamp`, `listUsers`, `list`, `getDeviceId`, `resolveConflict`, `listPendingConflicts`, plus push events `onOpApplied`/`onOpConflict`. `src/localClient.js` wraps every one of these (`write`, `bulkReplace`, `deleteEntity`, `list`, etc.) — screens must always go through `localClient`, never call `window.shoresh` directly.

**`bulkReplace` IPC surface (new, added during Sub-plan E Task 3):** `shoresh:bulk-replace` — admin-gated (mirrors `write`'s auth shape plus a `role === 'admin'` check, since a bulk_replace is a wholesale delete+reinsert of a scope, more destructive than any ordinary field write). Routes to the already-built `bulk_replace` op-log primitive (`appendBulkReplaceOp`/`applyBulkReplaceProjection` in `electron/ops/operations.js`, built in Sub-plan A Task 3). `BULK_REPLACE_ENTITIES` registers `template_slots` (columns: `id, template_id, group_id, activity_id, day_id, time_block_id, anchor_id, is_anchor, is_span_head, flags`) and `template_overlays` (columns: `id, template_id, unit_id, day_id, from_block_order, to_block_order, label`), scoped by `template_id`.

---

## Auth

Local, PIN-based, per-camp — not Supabase Auth (see architecture note above).

### Token types (device trust model)

Two token types are minted, verified, and enforced separately — see `electron/auth/localAuth.js` and `docs/adr/2026-07-25-device-trust-revocation.md`.

**Camp token (`type: 'camp'`)** — issued exclusively by the Host using its Ed25519 private key (`host_signing_key` table, generated once at `bootstrapCamp()`). Payload: `{type, userId, deviceId, campId, iat, exp, jti}`, base64url-encoded JSON, signature appended as `{payload}.{sig}`. 24h TTL (`TOKEN_TTL_MS`). The Host's Ed25519 public key is stored as `camps.signing_public_key` (hex-encoded DER/SPKI) and replicated to Clients via full-sync — Clients can verify camp tokens but can never mint them (private key never leaves the Host). `syncServer.js`'s `handleAuthenticate` rejects any `local` token on the network path outright.

**Local token (`type: 'local'`)** — issued by the Client itself using its device-scoped HMAC-SHA256 secret (`devices.device_secret_identifier`, a 32-byte hex value minted by the Host at device pairing approval). Used only for offline Client sessions (local IPC path). Never accepted on the WS authentication path.

**Which token is issued** is re-derived from `host_signing_key`'s presence in the DB (`issueTokenForThisDevice`), never passed in by the caller — so callers can't get the routing wrong.

**Token verification** (`verifySessionToken(db, token)`): the `type` claim dispatches to Ed25519 verification (camp) or HMAC-SHA256 (local) only after parsing the payload — a tampered type claim doesn't reroute; it fails signature verification. `exp` is enforced (tokens past their TTL return null). Malformed tokens, unknown types, and missing DB rows all fail closed (return null).

**Renewal**: `renew_token` WS message — Host re-checks revocation status before issuing a fresh camp token; client schedules renewal at ~20h.

### Device pairing and revocation

- New Client sends a `pairing_request` WebSocket message; Host records it as a pending device.
- Admin approves in `DeviceManagerScreen.jsx` — Host mints a `device_secret_identifier` and sets `devices.authorized_at`.
- Revocation: admin revokes via Device Manager → Host sets `devices.revoked_at`, `revoked_by_user_id`, `revocation_reason`; live WS socket for the revoked device is closed immediately.
- `devices` table fields: `id, name, last_seen_at, last_synced_at, last_synced_seq, authorized_at, revoked_at, revoked_by_user_id, revocation_reason, device_secret_identifier`.
- `authorize()` checks device revocation status on every privileged call — a revocation takes effect on the very next call from an already-connected device.
- `useDeviceMode.js` pairing phases: `pairing_pending` (request sent, awaiting admin approval) and `pairing_denied` (request rejected).

### Login paths

- `electron/auth/localAuth.js`: `attemptLogin(db, {name, pin, deviceId})` does the PIN check (`scryptSync` against `pin_hash`/`pin_salt`) + lockout tracking (`LOGIN_MAX_ATTEMPTS = 5`, `LOGIN_LOCKOUT_MS = 30s`). Issues the appropriate token via `issueTokenForThisDevice`.
- **Two login paths**, unified through `attemptLogin` so behavior can't drift:
  - Local IPC `login` handler (`electron/main.js`) — Host's own login, and a Client's offline fallback.
  - Unauthenticated WebSocket `login` message (`electron/sync/syncServer.js`) — lets a genuinely fresh Client verify its PIN against the Host and receive a camp token before its first sync.
- `useDeviceMode` derives `phase: 'login'` when there's a camp/host but no token yet; `phase: 'session'` once a token exists.

### Role-Based Behavior — centralized authorization layer (Phase 2, 2026-07-25)

**Every** mutating IPC handler (`electron/main.js`) and every mutating WebSocket handler (`electron/sync/syncServer.js`) now calls `authorize({db, token, action, resourceId})` (`electron/auth/authorize.js`) before proceeding — role is re-derived fresh from the `users` table on every single call, never trusted from the token payload or cached on an open connection. This replaces the old state (four scattered inline `role !== 'admin'` checks, only user-creation confirmed gated, the WS layer entirely unchecked) with one central, unit-tested, default-deny primitive.

- **`authorize()`** (`electron/auth/authorize.js`): verifies the token (`verifySessionToken`), re-queries `users`/`devices` by the decoded ids, resolves current role, looks it up against the permission matrix. Never throws (a db-layer failure returns `{allowed:false, reason:'db_error'}`, a malformed `action` is rejected for every role including admin). Returns `{allowed:true, userId, deviceId, role}` or `{allowed:false, reason}`.
- **Permission matrix** (`electron/auth/permissions.js`): `PERMISSIONS.admin = ['*']`; `PERMISSIONS.staff` is an explicit array — `<entity>.read`/`<entity>.write` for every entity in the exported `ENTITIES` list (13 entities), plus `users.read`, `devices.read`, `conflicts.read`, `conflicts.resolve`. Staff does **not** get `<entity>.delete`, `<entity>.bulk_replace`, `camps.rename`, or `users.create` — admin-only, matching pre-existing behavior exactly (no regression, enforcement only).
- **Shared action-derivation** (`electron/auth/deriveWriteAction.js`): `deriveWriteAction({entity, field})` (3-way: `DELETE_FIELD` sentinel → `<entity>.delete`, `camps`+`name` → `camps.rename`, else → `<entity>.write`) and `deriveBulkReplaceAction(entity)` (→ `<entity>.bulk_replace`) are called identically by both `electron/main.js` (IPC: `write`, `bulk-replace`) and `electron/sync/syncServer.js` (WS: `submit_op`, `acquire_lock`, `submit_bulk_replace_op`) — a staff user cannot do via a direct WebSocket connection anything they're blocked from via the renderer/IPC path, or vice versa.
- **WS identity**: `authorize()` calls on the WS path use `ws.token`, set exactly once during the `authenticate` handshake from the already-verified token — never a client-claimed field inside a later message body (`msg.op.device_id` etc. are also server-overwritten with `ws.deviceId`, unchanged from before this phase).
- **Deliberately left unwrapped** (no session token available at these call sites — pre-login/handshake-establishing, not an oversight): IPC `login`, `verify-session`, `choose-mode`, `discover-hosts`, `bootstrap-camp`, `get-camp`; WS `authenticate`, `login`. `get-camp`'s query was narrowed to `SELECT id, name` (was `SELECT *`) during Phase 2 review — it had been unknowingly leaking `camps.signing_secret` (the HMAC key backing every session token) to any unauthenticated caller, which combined with staff-readable `listUsers`/`getDeviceId` would have let a compromised renderer script forge an admin token. Fixed before Phase 2 Task 2 was accepted; no renderer code depended on the dropped column.

| Feature | admin | staff |
|---|---|---|
| Camp setup, tiers, groups, time blocks, activities, anchors, day overrides, cohorts, templates — ordinary read/write | ✅ | ✅ (server-enforced via `<entity>.write`/`<entity>.read`, not just client-side button-hiding) |
| Delete any entity, bulk-replace (schedule regeneration/snapshot restore), rename camp | ✅ | ❌ (server-enforced, `<entity>.delete`/`<entity>.bulk_replace`/`camps.rename` absent from staff's matrix) |
| Create users (`createUser` IPC) | ✅ | ❌ (`users.create`, admin-only — same behavior as before Phase 2, now routed through `authorize()` instead of an inline check) |
| Schedule view/edit, conflict resolution | ✅ | ✅ |

`users.role` is a `CHECK (role IN ('admin', 'staff'))` column, re-queried fresh by `authorize()` on every privileged call — a role change (or a user/device deletion) takes effect on the very next call using an already-issued token, proven by a same-token role-flip test on both the IPC and WS paths (`electron/main.test.js`, `electron/sync/syncServer.test.js`).

---

## Screens

| Screen key | File | Notes |
|---|---|---|
| (mode-select, not in `SCREENS` map) | `src/screens/ModeSelectScreen.jsx` | Choose "Host a camp" vs "Join a camp" — pre-session |
| (bootstrap) | `src/screens/CampBootstrapScreen.jsx` | Host: create a new camp + admin user — pre-session |
| (join) | `src/screens/JoinScreen.jsx` | Client: pick a discovered Host from mDNS results — pre-session |
| (pairing_pending / pairing_denied) | `src/screens/PairingPendingScreen.jsx` | Client: waiting UX after sending a pairing request; also renders the denied state inline — pre-session |
| (login) | `src/screens/LoginScreen.jsx` | Name + PIN entry — pre-session |
| `setup` | `src/screens/CampSetup.jsx` | Default/landing screen inside a session |
| `tiers` | `src/screens/TiersScreen.jsx` | |
| `groups` | `src/screens/GroupsScreen.jsx` | |
| `days` | `src/screens/DaysScreen.jsx` | Days of Operation CRUD. Wired into `SCREENS`/`Sidebar` 2026-07-26 (previously existed but was unreachable — `TopBar` already reserved the `days` title). Rows auto-seeded Mon–Fri by `seedDays.js`; this screen edits them. |
| `timeblocks` | `src/screens/TimeBlocksScreen.jsx` | |
| `activities` | `src/screens/ActivitiesScreen.jsx` | |
| `anchors` | `src/screens/AnchorsScreen.jsx` | |
| `cohorts` | `src/screens/CohortsScreen.jsx` | |
| `dayoverrides` | `src/screens/DayOverridesScreen.jsx` | |
| `schedule` | `src/screens/ScheduleScreen.jsx` | Most complex screen — DnD schedule builder, **two coexisting ROUTES (Manual / Generated), each with its own candidate schedule**, three views each (group/day/activity), flags, locking, snapshots. A `route` state keys `slots`/`overlays`/`snapshots`/`stats`/`findings`; the manual route's grid is `ManualBuildView`. Neither route is the "real" schedule and the app never picks one — Export asks, every time, and does not remember. **Fully migrated off Supabase (Sub-plan E, Tasks 1-5, commits 855b248/db2c6f2/c687353/d324ed0/21f8a22)**: reads via `localClient.list`, single-slot writes via `writeFields`/`localClient.write`, bulk regen/snapshot-restore via `localClient.bulkReplace`, snapshot CRUD via `localClient.write` with JSON-text-column storage for the `slots`/`overlays` blobs (a scoped exception, not a precedent). See Key Architectural Decisions for the CRITICAL sync bug this migration's own verification surfaced. |
| `conflicts` | `src/screens/ConflictsScreen.jsx` | Write-conflict resolution with pre-resolution DB snapshot; only screen given extra props (`onNavigate`, `pendingConflicts`) beyond `campId` |
| `devices` | `src/screens/DeviceManagerScreen.jsx` | Admin: approve pairing requests, view paired devices, revoke device access — admin-only |

---

## Components

- `src/components/layout/Shell.jsx`, `Sidebar.jsx`, `TopBar.jsx` — app chrome, screen navigation, sidebar badge counts (e.g. pending conflicts)
- `src/components/CohortPicker.jsx` — cohort selection widget
- `src/components/schedule/` — schedule-builder-specific: `ActivityPalette`, `DisplacedPalette`, `ManualBuildView`, `ScheduleActivityView`, `ScheduleDayView`, `ScheduleGroupView`, `OverlayCell`, `SlotCell`, `EditModal`, `FieldTripDrawer`, `FlagDetailModal`, `ConfirmRegenModal`, `VersionsDropdown`, `StatBadge`

---

## Database Tables

(SQLite, one file per device — `electron/db/schema.sql`, schema v20 as of this writing)

- **camps** — `id, name, signing_public_key` (Ed25519 public key, hex-encoded DER/SPKI — replicated to all Clients so they can verify camp tokens). Exactly one row expected per device db (single-camp-per-db assumption used throughout, e.g. `SELECT ... FROM camps LIMIT 1`).
- **host_signing_key** — `id (always 1), public_key, private_key, created_at`. Host-only table; generated once at `bootstrapCamp()`. Never replicated. The private key never leaves the Host device.
- **users** — `id, camp_id, name, pin_hash, pin_salt, role('admin'|'staff')`. Unique on `(camp_id, name)`.
- **devices** — `id, name, last_seen_at, last_synced_at, last_synced_seq, pairing_status ('pending'|'authorized'), authorized_at, authorized_by_user_id, revoked_at, revoked_by_user_id, revocation_reason, device_secret_identifier`. `last_synced_seq` is the op-log watermark for reconnect catch-up. `pairing_status` defaults to `'pending'`; flips to `'authorized'` on admin approval. `device_secret_identifier` is the HMAC secret for local tokens, minted at pairing approval. `revoked_at`/`revoked_by_user_id`/`revocation_reason` are set at revocation; live WS socket is closed immediately. `authorize()` checks `authorized_at IS NOT NULL` on every privileged call — a device row without it is always denied.
- **audit_events** — `id, camp_id, actor_user_id, device_id, action, outcome, reason, metadata (JSON), created_at`. Written by `electron/audit/auditLog.js`. Captured events include: `auth.login` (allow/deny with reason), `auth.authorize` (deny only — action + role + reason logged, no PIN/token material), device pairing and revocation events.`
- **operations** — the op-log: `seq (autoincrement), id (unique), entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id, client_write_id`. `client_write_id` is a client-generated idempotency key so a retried `submit_op` doesn't mint a duplicate op.
- **conflicts** — durable record of every detected write conflict: `id, entity, entity_id, field, incoming_op, existing_op, existing_op_id, created_at, resolved_at`. A conflict counts as resolved when any op has `parent_op_id = existing_op_id`.
- **locks** — `entity, entity_id, field, holder_device_id, acquired_at` — field-level edit locks.
- **groups**, **tiers**, **activities** — camp-scoped config entities, each `camp_id`-keyed.
- **template_slots** — `id, template_id, group_id, activity_id, day_id, time_block_id, anchor_id, is_anchor, is_span_head, flags`. `anchor_id`/`is_anchor` added in schema migration v17 (Sub-plan E Task 3) — were referenced by `BULK_REPLACE_ENTITIES`'s intended column set but physically missing from SQLite until this migration.
- **template_overlays** — `id, template_id, unit_id, day_id, from_block_order, to_block_order, label`. Now a registered `bulk_replace` entity (Sub-plan E Task 3), alongside `template_slots`.
- **schedule_templates** — `id, camp_id, name, kind`. **A camp now holds up to TWO rows, one per schedule-building route** (`kind` = `'generated'` | `'manual'`), added by migration v23 (`CURRENT_SCHEMA_VERSION = 23`) together with `UNIQUE(camp_id, kind)` replacing v21's `UNIQUE(camp_id)`. Ids are derived, never minted: `deriveScheduleTemplateId(campId, kind)` (`electron/ops/scheduleTemplateId.js`) returns `schedule-template:${campId}` for the generated route — byte-identical to the pre-v23 one-argument form, which migration v21 still depends on — and `schedule-template:${campId}:manual` for the manual one. `kind` MUST be the first field written for a new row (write-ordering contract, documented at the `schedule_templates` entry in `electron/ops/projections.js`); written second, a manual row materialises as `'generated'`, collides, and is absorbed by `INSERT OR IGNORE`. Neither row is canonical — see `docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`. Legacy note: Local SQLite table (ported off Supabase in Sub-plan E Task 1/2). Was missing from `PROJECTIONS` (`electron/ops/projections.js`) until 2026-07-26 — ops were written to the op-log successfully but `applyProjection` silently no-op'd for every field, so the row never materialized. Fixed by adding the entry (commit `0ca1198`), same pattern as `groups`/`activities` etc. See Known Issues.
- **schedule_snapshots** — `id, template_id, name, is_auto, created_at, slots (TEXT/JSON), overlays (TEXT/JSON)`. `slots`/`overlays` are JSON-text columns — an explicitly scoped exception to this app's normal field-level op-log sync, not a pattern to reuse elsewhere (per the Sub-plan E design doc). Ported off Supabase in Sub-plan E Task 4. Gained a `PROJECTIONS` registry entry (`electron/ops/projections.js`) on 2026-07-24 — previously `ScheduleScreen.jsx`'s `writeFields()` calls to this entity silently never materialized the row (op-log write succeeded, but nothing projected it into the table); found and fixed while un-skipping the Sub-plan E Task 5 E2E regression test.
- **days_of_operation** — `id, camp_id, label, day_of_week, sort_order`. Default Monday-Friday rows are seeded on first camp mount by `src/utils/seedDays.js` (ported off Supabase 2026-07-24, previously `App.jsx`'s last live `supabase.from()` call site) — mirrors `ensureCohort.js`'s per-row completeness-check/repair pattern rather than a single "any row exists" flag, so a crash mid-seed self-repairs on the next mount instead of permanently under-seeding. No `UNIQUE` constraint exists on this table (unlike `cohorts`/`groups`/`time_blocks`) — two other files (`schema.sql`, `localDb.js`) have stale comments claiming otherwise, flagged as a follow-up cleanup, not yet fixed.
- **operations.host_seq** — new nullable column (schema migration v18, 2026-07-24). Persists the Host's canonical `seq` value on a Client's replicated copy of an op (`applyRemoteOp` in `syncClient.js`), fixing the `bulk_replace` cross-device seq bug — see Key Architectural Decisions.
- **schema_migrations** — `version, applied_at` — versioned migration guard table (currently v20). v19 added `audit_events`; v20 added device trust columns (`authorized_at`, `authorized_by_user_id`, `revoked_at`, `revoked_by_user_id`, `revocation_reason`, `device_secret_identifier`, `pairing_status`) to `devices`, the `host_signing_key` singleton table, and `camps.signing_public_key`.
- **device_identity** — `id, created_at` — this device's own persistent identity, independent of camp/login state (exists even on a totally fresh install).
- **pending_writes** — durable backing store for a Client's offline write queue (`pending_id, client_write_id, entity, entity_id, field, value, parent_op_id, created_at`), so a queued write survives an app restart before it's confirmed applied.

All tables above are local SQLite, read/written exclusively via `window.shoresh`/`localClient` IPC — no table is Supabase-backed anymore.

---

## Project Lifecycle

Managed by `electron/db/projectManager.js`. A "project" is a named SQLite file on disk.

**IPC surface** (exposed via `electron/preload.js`, handled in `electron/main.js`):

| IPC channel | Description |
|---|---|
| `shoresh:create-project` | Create a new SQLite db file at a chosen path, run schema migrations, bootstrap a camp |
| `shoresh:open-project` | Open an existing `.shoresh` db file |
| `shoresh:backup-project` | Write a timestamped backup copy of the current db |
| `shoresh:restore-project` | Replace the active db with a backup (pre-restore backup is automatically taken first) |
| `shoresh:export-project` | Export a copy to a user-chosen location |
| `shoresh:list-recent-projects` | Return the MRU list of recently opened project paths |
| `shoresh:open-recent-project` | Open a project from the recent list |
| `shoresh:get-current-project` | Return metadata (path, name) for the currently open project |

**Backup rotation**: maximum 10 backups kept per project; oldest are pruned automatically. Pre-migration and pre-restore backups are taken automatically before any destructive operation.

---

## Test Coverage

- **Vitest unit tests**: ~527+ tests across `electron/` and `src/` — auth, ops, projections, sync handlers, IPC handlers, schedule engine.
- **Integration test harness**: `test/integration/` — 16 separate-process scenarios driven by `node test/integration/run.js`. Each scenario spawns real Node child processes (not Electron, but using the same `electron/` modules) to verify cross-process behavior that single-process Vitest cannot distinguish from correct behavior. Scenarios cover: bootstrap, offline restart, idempotency, conflict detection, device revocation, seq catch-up, pairing reconnect, field-merge ordering, lock expiry, snapshot restore, schema migration, host crash mid-sync, corrupt payload rejection, clock skew, and role-change enforcement.

---

## Edge Functions / API Routes

None — no Supabase Edge Functions or HTTP API routes in the local-first architecture. All device-to-device communication is the custom WebSocket protocol in `electron/sync/syncServer.js` / `syncClient.js` (message types include `authenticate`, `login`, `acquire_lock`, `submit_op`, plus server→client `login_ok`/`login_failed`, `op_applied`, `op_conflict`, `full_sync`).

---

## Key Architectural Decisions

- **Ed25519 Host-only token minting**: camp tokens (used for network authentication) are signed with an Ed25519 private key that never leaves the Host. The public key (`camps.signing_public_key`, hex DER/SPKI) is distributed to Clients via full-sync so they can verify tokens but never mint them. Client offline sessions use per-device HMAC-SHA256 local tokens keyed to a `device_secret_identifier` minted by the Host at pairing. This replaced the original shared HMAC signing secret (`camps.signing_secret`) that was distributed to all devices — that earlier design meant any compromised device could forge tokens accepted by all others. See Auth section above for full details.
- **Raw PIN sent over LAN for remote login**: a fresh Client verifies its PIN against the Host by sending it in plaintext over the WebSocket (`login` message), rather than a hash — necessary because the Host must run its own `scryptSync` check. Accepted under the same trusted-LAN threat model; flagged for revisit if camps ever share network with untrusted devices.
- **Unified login path**: both local (offline fallback) and remote (online, incl. first-ever login) logins go through one `attemptLogin(db, ...)` function, so lockout/verification logic can't drift between the two call sites.
- **Op-log + last-write-wins with explicit conflict table**: all mutations are appended as `operations` rows (entity/field-level), synced and replayed across devices; genuine conflicting writes are recorded in `conflicts` (not silently dropped) and must be explicitly resolved, with resolution ops linked via `parent_op_id`.
- **Single-camp-per-db assumption**: every `camps` lookup in the codebase does `SELECT ... FROM camps LIMIT 1` rather than filtering by an active-camp id — a device's SQLite file only ever holds one camp's data. This is a real constraint, not an oversight — changing it (e.g. to support multiple camps per device) would require auditing every one of these call sites.
- **Centralized authorization layer** (Phase 2, 2026-07-24/25, 4 tasks, ADR at `docs/adr/2026-07-24-centralized-authorization-layer.md`): replaced four scattered inline `role !== 'admin'` checks (and a completely unchecked WS layer) with one central `authorize()` primitive re-deriving role from the DB on every call, a named permission matrix, and shared action-derivation logic reused identically by the IPC and WS transports. See Role-Based Behavior above for the full shape. Explicitly out of scope for this phase (deferred): device pairing/revocation, token expiration/lifetime, any change to the shared-camp-signing-secret token-minting model, raw PIN transmission changes, full audit-event-stream infrastructure (a single `console.warn` on a denied `authorize()` call is the only logging added).
- **`bulk_replace` op primitive**: a `{entity, scope_id, rows}`-shaped op that deletes all current rows in scope and inserts a new set, atomically, recorded in the op-log like any other op. Built in Sub-plan A Task 3 (`appendBulkReplaceOp`/`applyBulkReplaceProjection`/`validateBulkReplaceRows` in `electron/ops/operations.js`), extended with a renderer-facing IPC channel and a `template_overlays` registry entry in Sub-plan E Task 3. Used by `ScheduleScreen.jsx` for schedule regeneration and snapshot restore — the only consumer. As of Phase 2, admin-only via `<entity>.bulk_replace` on both the IPC and WS submission paths.
  - **FIXED 2026-07-24** (previously CRITICAL, found by Sub-plan E Task 5's end-to-end verification, `electron/sync/scheduleE2E.sync.test.js`, originally left as an honest `it.fails` regression test — now un-skipped and genuinely green): `applyRemoteOp` in `electron/sync/syncClient.js` inserted a received op without persisting its Host-assigned `seq` (`electron/db/schema.sql`: `seq INTEGER PRIMARY KEY AUTOINCREMENT`) — each device's local `operations.seq` was that device's own independent counter, not the Host's canonical one. `latestScopeOpSeq`/`detectBulkReplaceConflict` (`electron/ops/operations.js`) compared a client's locally-numbered `based_on_seq` directly against the Host's own seq counter as if they were the same numbering space, so the SECOND `bulk_replace` to the same scope from the same client (build a schedule, then click Regenerate) spuriously conflicted in essentially all real usage. **Fix** (full Architect + Maker + review cycle, ADR at `docs/adr/2026-07-24-bulk-replace-seq-fix.md`): added a nullable `operations.host_seq` column (schema v18); `applyRemoteOp` now persists the Host's real `op.seq` into it on insert; `latestScopeOpSeq` compares `MAX(COALESCE(host_seq, seq))` instead of raw `seq`, so Host-authored rows (host_seq always NULL, own seq already canonical) and Client-replicated rows (host_seq populated) share one numbering space. `isValidRemoteOp` now requires `op.seq` be a non-negative integer (fail-closed). Disclosed, accepted residual limitation: operations rows from before this migration have `host_seq = NULL`; if Client-authored, scope-seq comparison falls back to that row's own (possibly wrong) local seq until superseded — at most one spurious conflict per scope post-upgrade, then self-healing (mathematically bounded, verified by Red Hat review), no backfill migration needed.

---

## Home Screen Layout

Not role-differentiated at the top level — `setup` (`CampSetup.jsx`) is the fixed landing screen for any session regardless of `admin`/`staff` role. No per-role home screen variants found.

---

## Known Issues and Open Items

- **RESOLVED 2026-07-26 (Schedule generation end-to-end — three bugs).** "Generate Schedule" button appeared to do nothing (button stayed stuck on "Generating…" indefinitely). Three root causes found and fixed in commits `0ca1198` / `a03b1ee`:
  1. **`buildSchedule.js` — JSON-string arrays** (`src/engine/buildSchedule.js`): `eligible_tier_ids` and `eligible_group_ids` arrive from SQLite as JSON strings (e.g. `"[]"`), not parsed arrays. The engine compared string `.length === 2` against 0, so the "eligible for all groups" branch was never reached and every activity ended up with 0 eligible groups → 0 slots placed. Fixed by adding a `parseIds()` helper that JSON-parses string values before any eligibility check.
  2. **`projections.js` — `schedule_templates` missing from `PROJECTIONS`** (`electron/ops/projections.js`): `applyProjection` silently no-ops for unregistered entities. Template ops were appended to the op-log but the `schedule_templates` row never materialized — each `generate()` call found 0 rows, created a new UUID, orphaned all prior slots (120 orphaned `template_slots` accumulated across 6 template IDs before discovery). Fixed by adding the `schedule_templates` entry following the same pattern as every other entity.
  3. **`useDeviceMode.js` — `chooseHost()` didn't trigger `init()` re-run** (`src/hooks/useDeviceMode.js`): `init()` is gated on `initNonce` changes. `chooseHost()` set localStorage and React state but never incremented `initNonce`, so when the app started with no persisted mode, `chooseMode` IPC was never called, `syncClient` stayed `null`, and every subsequent `write` IPC threw "sync not initialized". Fixed by adding `setInitNonce((n) => n + 1)` to `chooseHost()`.
- **RESOLVED 2026-07-26 (Camp Setup local-dev blocker + DaysScreen wiring + sidebar grouping).** The reported "unsatisfiable Cohorts prerequisite with no reachable UI path" was a mis-diagnosis: `cohorts` is reachable in the sidebar as "Programs" (commit `68bc36d`) and `ensureCohort` auto-creates a "Main" cohort. A navigation audit (read-through + live walk at localhost:5200) found the real root cause was the **write-blind dev mock**: `src/localClient.mock.js`'s `write()` returned `{status:'applied'}` without persisting, and `list()` read a store `write` never populated — so in the only UI-testable environment (`npm run dev`, no Electron/`window.shoresh`) every create was a silent no-op and no entity (Program/Unit/Group/Time Block/Activity/Anchor) could ever be built. Fixes: (1) the mock now persists field-level writes, `bulkReplace`, and `__deleted__` deletes, and emulates the real `UNIQUE(...)` indexes so it faithfully reproduces the app's collision paths; (2) `DaysScreen.jsx` wired into `App.jsx` `SCREENS` + `Sidebar` (key `days`); (3) an `App.jsx` ref-guard makes the AppShell bootstrap effect (`seedDays`/`ensureCohort`) run once per camp, neutralizing React StrictMode's dev-mode double-invocation (which otherwise double-seeded Mon–Fri → 10 days, since `days_of_operation` has no UNIQUE constraint); (4) sidebar regrouped into labelled "Setup"/"Operations" sections with Conflicts moved to Operations; (5) friendlier CampSetup load-error banner with an inline Retry. Verified end-to-end live at localhost:5200: full Camp Setup → real Schedule grid. Note: all mock changes are dev-only (`window.shoresh` bypasses the mock entirely in Electron).
- **`days_of_operation` has no UNIQUE constraint** — `seedDays.js`'s repair logic works around this, but `electron/db/schema.sql` and `electron/db/localDb.js` have stale comments incorrectly claiming a UNIQUE constraint exists on this table. Low-severity documentation inconsistency, not yet fixed.
- **Two pre-existing flaky tests** under full-suite parallel load: `electron/sync/discovery.test.js` ("finds an advertised host on the LAN" — passes reliably in isolation) and `electron/sync/syncServer.test.js` ("throttles a burst of rapid login messages" — timing-sensitive under CPU contention). Neither is related to any recent change; both are out of scope until they become reliably reproducible.
- **No TLS on the sync connection** (`ws://`, not `wss://`) — explicitly accepted under the trusted-LAN threat model. See `SECURITY.md`.
- **ESLint's Supabase-import ban covers ES `import` only**, not CommonJS `require()` — narrow theoretical bypass in an `electron/**` file. The codebase is ESM-first; `require()` is currently confined to `electron/preload.js`. Low priority.
- **`.env` (gitignored)** contains a local Supabase demo JWT left over from the pre-rebuild setup. Not read by any active code; documented in `.env.example` as legacy/dead.

---

## Removed / Replaced

- **Per-process random session-signing secret** (`const sessionSecret = randomBytes(32)` at module load in `electron/auth/localAuth.js`) — replaced by the per-camp `signing_secret` stored in the `camps` table and looked up per-call. The old approach made cross-process token verification structurally impossible (a Client's own process had a different secret than the Host that issued its token).
- **Login gated purely on local data** — the original design required a Client to already have local `users`/`camps` rows to log in at all, which made first-ever login on a fresh device impossible (circular dependency: no token without login, no login without a prior sync, no prior sync without a token). Replaced by the unauthenticated WebSocket `login` message path described under Auth above.
- **`@supabase/supabase-js` dependency, `src/supabase.js`, `supabase/migrations/`** (removed/moved 2026-07-24) — the entire pre-rebuild Supabase backend. Moved to `legacy/supabase/` for historical reference; no longer a project dependency; reintroduction under `src/`/`electron/` is blocked by an ESLint rule. This closes out the renderer-migration-plus-hardening project that spanned Sub-plans A-E plus this final Phase 1 cleanup — every screen, the last bootstrap call site (`seedDays`), and the legacy files themselves are now off Supabase, and the sync layer's one known CRITICAL defect (`bulk_replace` cross-device seq bug) is fixed.
