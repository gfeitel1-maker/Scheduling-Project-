# Shoresh — Platform State

_Last updated: 2026-07-20_

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite, plain inline-style objects (no CSS files/modules) |
| Desktop shell | Electron 43 (`electron/main.js`), contextBridge IPC via `electron/preload.js` |
| Local database | SQLite via `better-sqlite3`, one file per device, schema versioned in-app (`electron/db/schema.sql` + migration blocks in `electron/db/localDb.js`) |
| LAN sync | Custom `ws`-based protocol: one device runs a WebSocket host (`electron/sync/syncServer.js`), others connect as clients (`electron/sync/syncClient.js`); mDNS discovery via `bonjour-service` (`electron/sync/discovery.js`) |
| Legacy backend (being replaced) | `@supabase/supabase-js` still a dependency; `src/supabase.js` and RLS-based auth (`src/hooks/useSession.js` per CLAUDE.md) are the pre-rebuild architecture and are being superseded by the local-first Electron/SQLite stack described below — CLAUDE.md is stale on auth/data-flow |
| Repo | git@github.com:gfeitel1-maker/Scheduling-Project-.git (local clone at `Scheduling-Project-/`) |

**Architecture note:** the app is mid-migration from a Supabase (Postgres + Auth + RLS) cloud backend to a local-first design: each device has its own SQLite db, one device acts as a LAN "Host" (WebSocket server), others are "Clients" that sync over the LAN. Data isolation that used to be enforced by Postgres RLS is now enforced by the app being fundamentally single-camp-per-device-db (see Database Tables below) plus signed session tokens. New engineering work should target the Electron/SQLite path, not `src/supabase.js`.

---

## Navigation Model

Two nested state machines, no router:

1. **Device/session phase** — `src/hooks/useDeviceMode.js` derives a `phase` from local state (`error` → `loading` → `mode-select` → `bootstrap`/`join` → `login` → `session`). `src/App.jsx`'s top-level `App()` switches on `device.phase` to render one of: `ModeSelectScreen`, `CampBootstrapScreen` (Host: create a new camp), `JoinScreen` (Client: pick a discovered Host), `LoginScreen`, or the full `AppShell`.
2. **In-app screen** — once in a session, `AppShell` (`src/App.jsx`) holds a `screen` string in `useState`, looked up in the `SCREENS` map and passed down through `Shell` → `Sidebar` (`src/components/layout/`). `campId` and an `onNavigate` (`setScreen`) callback are threaded as props into every screen — no context, no router.

All Electron/SQLite calls from the renderer go through `window.shoresh.*` (see `electron/preload.js`), backed by IPC handlers in `electron/main.js`.

---

## Auth

Local, PIN-based, per-camp — not Supabase Auth (see architecture note above).

- Each camp has an HMAC-SHA256 **shared signing secret** (`camps.signing_secret`, hex-encoded 32 random bytes), generated once at camp bootstrap (`bootstrapCamp` in `electron/main.js`) and replicated to every device via full-sync. This lets any device — Host or Client — locally issue and verify session tokens offline once it has synced, without a shared per-device secret. (See [Camp Signing Secret](project_camp_signing_secret_fix.md) for the bug this fixed.)
- `electron/auth/localAuth.js`: `attemptLogin(db, {name, pin, deviceId})` does the PIN check (`scryptSync` against `pin_hash`/`pin_salt`) + lockout tracking (`LOGIN_MAX_ATTEMPTS`/`LOGIN_LOCKOUT_MS`), and `issueSessionToken`/`verifySessionToken(db, ...)` sign/verify tokens using the camp's `signing_secret` looked up per-call (not a per-process constant).
- **Two login paths**, unified through `attemptLogin` so behavior can't drift:
  - Local IPC `login` handler (`electron/main.js`) — Host's own login, and a Client's offline fallback (only works if that Client has synced before).
  - Unauthenticated WebSocket `login` message (`electron/sync/syncServer.js`) — lets a genuinely fresh Client (empty local db) verify its PIN against the Host directly, receive a token, then `authenticate` normally. This is the path used for every online Client login, not just the first.
- `useDeviceMode` derives `phase: 'login'` when there's a camp/host but no token yet; `phase: 'session'` once a token exists.

### Role-Based Behavior

| Feature | admin | staff |
|---|---|---|
| Camp setup, tiers, groups, time blocks, activities, anchors, day overrides | ✅ | (not yet audited — role gating for these screens lives client-side; no server-side role enforcement found beyond user creation) |
| Create users (`createUser` IPC) | ✅ | ❌ (admin-only, enforced in `electron/main.js`'s `createUserHandler`) |
| Schedule view/edit, conflict resolution | ✅ | ✅ |

`users.role` is a `CHECK (role IN ('admin', 'staff'))` column; this table should be re-verified against `electron/main.js` handlers as more role-gated features are added — it was not exhaustively audited while writing this doc.

---

## Screens

| Screen key | File | Notes |
|---|---|---|
| (mode-select, not in `SCREENS` map) | `src/screens/ModeSelectScreen.jsx` | Choose "Host a camp" vs "Join a camp" — pre-session |
| (bootstrap) | `src/screens/CampBootstrapScreen.jsx` | Host: create a new camp + admin user — pre-session |
| (join) | `src/screens/JoinScreen.jsx` | Client: pick a discovered Host from mDNS results — pre-session |
| (login) | `src/screens/LoginScreen.jsx` | Name + PIN entry — pre-session |
| `setup` | `src/screens/CampSetup.jsx` | Default/landing screen inside a session |
| `tiers` | `src/screens/TiersScreen.jsx` | |
| `groups` | `src/screens/GroupsScreen.jsx` | |
| `timeblocks` | `src/screens/TimeBlocksScreen.jsx` | |
| `activities` | `src/screens/ActivitiesScreen.jsx` | |
| `anchors` | `src/screens/AnchorsScreen.jsx` | |
| `cohorts` | `src/screens/CohortsScreen.jsx` | |
| `dayoverrides` | `src/screens/DayOverridesScreen.jsx` | |
| `schedule` | `src/screens/ScheduleScreen.jsx` | Most complex screen — DnD schedule builder, three views (group/day/activity), flags, locking, snapshots |
| `conflicts` | `src/screens/ConflictsScreen.jsx` | Only screen given extra props (`onNavigate`, `pendingConflicts`) beyond `campId` |

---

## Components

- `src/components/layout/Shell.jsx`, `Sidebar.jsx`, `TopBar.jsx` — app chrome, screen navigation, sidebar badge counts (e.g. pending conflicts)
- `src/components/CohortPicker.jsx` — cohort selection widget
- `src/components/schedule/` — schedule-builder-specific: `ActivityPalette`, `DisplacedPalette`, `ManualBuildView`, `ScheduleActivityView`, `ScheduleDayView`, `ScheduleGroupView`, `OverlayCell`, `SlotCell`, `EditModal`, `FieldTripDrawer`, `FlagDetailModal`, `ConfirmRegenModal`, `VersionsDropdown`, `StatBadge`

---

## Database Tables

(SQLite, one file per device — `electron/db/schema.sql`, schema v9 as of this writing)

- **camps** — `id, name, signing_secret`. Exactly one row expected per device db (single-camp-per-db assumption used throughout, e.g. `SELECT ... FROM camps LIMIT 1`).
- **users** — `id, camp_id, name, pin_hash, pin_salt, role('admin'|'staff')`. Unique on `(camp_id, name)`.
- **devices** — `id, name, last_seen_at, last_synced_at, last_synced_seq`. `last_synced_seq` is the op-log watermark used for reconnect catch-up (NULL = never watermarked, so a device's first connection doesn't get flooded with full history).
- **operations** — the op-log: `seq (autoincrement), id (unique), entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id, client_write_id`. `client_write_id` is a client-generated idempotency key so a retried `submit_op` doesn't mint a duplicate op.
- **conflicts** — durable record of every detected write conflict: `id, entity, entity_id, field, incoming_op, existing_op, existing_op_id, created_at, resolved_at`. A conflict counts as resolved when any op has `parent_op_id = existing_op_id`.
- **locks** — `entity, entity_id, field, holder_device_id, acquired_at` — field-level edit locks.
- **groups**, **tiers**, **activities** — camp-scoped config entities, each `camp_id`-keyed.
- **template_slots** — `id, template_id, group_id, activity_id, day_id, time_block_id`.
- **schema_migrations** — `version, applied_at` — versioned migration guard table.
- **device_identity** — `id, created_at` — this device's own persistent identity, independent of camp/login state (exists even on a totally fresh install).
- **pending_writes** — durable backing store for a Client's offline write queue (`pending_id, client_write_id, entity, entity_id, field, value, parent_op_id, created_at`), so a queued write survives an app restart before it's confirmed applied.

Legacy Supabase-era tables (`days_of_operation`, `schedule_templates`, `schedule_snapshots`, etc., referenced in `supabase/migrations/` and `src/App.jsx`'s `seedDays`) are part of the old cloud backend and not reflected in the SQLite schema above.

---

## Edge Functions / API Routes

None — no Supabase Edge Functions or HTTP API routes in the local-first architecture. All device-to-device communication is the custom WebSocket protocol in `electron/sync/syncServer.js` / `syncClient.js` (message types include `authenticate`, `login`, `acquire_lock`, `submit_op`, plus server→client `login_ok`/`login_failed`, `op_applied`, `op_conflict`, `full_sync`).

---

## Key Architectural Decisions

- **Shared per-camp signing secret over per-device secrets**: session tokens are HMAC-signed with one secret per camp, distributed to every device via full-sync, rather than each device having its own. Chosen because the alternative (per-process secret) made it impossible for a Client to verify its own tokens after receiving them from the Host — see [Camp Signing Secret Fix](project_camp_signing_secret_fix.md). Accepted tradeoff: a compromised device can forge tokens accepted by every other device in the camp — deemed acceptable under the project's "trusted camp LAN" threat model (same reasoning applied to plain `ws://` with no TLS, and to raw PINs sent for remote login).
- **Raw PIN sent over LAN for remote login**: a fresh Client verifies its PIN against the Host by sending it in plaintext over the WebSocket (`login` message), rather than a hash — necessary because the Host must run its own `scryptSync` check. Accepted under the same trusted-LAN threat model; flagged for revisit if camps ever share network with untrusted devices.
- **Unified login path**: both local (offline fallback) and remote (online, incl. first-ever login) logins go through one `attemptLogin(db, ...)` function, so lockout/verification logic can't drift between the two call sites.
- **Op-log + last-write-wins with explicit conflict table**: all mutations are appended as `operations` rows (entity/field-level), synced and replayed across devices; genuine conflicting writes are recorded in `conflicts` (not silently dropped) and must be explicitly resolved, with resolution ops linked via `parent_op_id`.
- **Single-camp-per-db assumption**: every `camps` lookup in the codebase does `SELECT ... FROM camps LIMIT 1` rather than filtering by an active-camp id — a device's SQLite file only ever holds one camp's data. This is a real constraint, not an oversight — changing it (e.g. to support multiple camps per device) would require auditing every one of these call sites.

---

## Home Screen Layout

Not role-differentiated at the top level — `setup` (`CampSetup.jsx`) is the fixed landing screen for any session regardless of `admin`/`staff` role. No per-role home screen variants found.

---

## Known Deferred Items

- **CLAUDE.md is stale**: it documents the pre-rebuild Supabase/RLS architecture (`useSession`, `src/supabase.js`, Postgres RLS) as if it's current. The actual auth/data model is the local-first Electron/SQLite system described in this file. CLAUDE.md should be updated or the Supabase path explicitly marked legacy.
- **Role enforcement is only partially audited**: only user-creation (`createUser`) is confirmed admin-gated server-side (`electron/main.js`). Other admin-oriented screens (tiers, groups, activities, etc.) have not been confirmed to have server-side role checks — see Role-Based Behavior table above.
- **Single-process test-harness limitation** (documented in `docs/superpowers/specs/2026-07-20-shared-camp-signing-secret-design.md`): Vitest runs Host/Client test actors in one OS process, so it cannot by itself distinguish some cross-process bugs from correct behavior — cross-process claims require live two-Electron-instance verification, not just the automated suite.
- No TLS anywhere in the sync protocol (`ws://`, not `wss://`) — explicitly accepted under the "trusted camp LAN" threat model, not a bug.

---

## Removed / Replaced

- **Per-process random session-signing secret** (`const sessionSecret = randomBytes(32)` at module load in `electron/auth/localAuth.js`) — replaced by the per-camp `signing_secret` stored in the `camps` table and looked up per-call. The old approach made cross-process token verification structurally impossible (a Client's own process had a different secret than the Host that issued its token).
- **Login gated purely on local data** — the original design required a Client to already have local `users`/`camps` rows to log in at all, which made first-ever login on a fresh device impossible (circular dependency: no token without login, no login without a prior sync, no prior sync without a token). Replaced by the unauthenticated WebSocket `login` message path described under Auth above.
