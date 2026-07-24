# Shoresh — Platform State

_Last updated: 2026-07-24_

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

1. **Device/session phase** — `src/hooks/useDeviceMode.js` derives a `phase` from local state (`error` → `loading` → `mode-select` → `bootstrap`/`join` → `login` → `session`). `src/App.jsx`'s top-level `App()` switches on `device.phase` to render one of: `ModeSelectScreen`, `CampBootstrapScreen` (Host: create a new camp), `JoinScreen` (Client: pick a discovered Host), `LoginScreen`, or the full `AppShell`.
2. **In-app screen** — once in a session, `AppShell` (`src/App.jsx`) holds a `screen` string in `useState`, looked up in the `SCREENS` map and passed down through `Shell` → `Sidebar` (`src/components/layout/`). `campId` and an `onNavigate` (`setScreen`) callback are threaded as props into every screen — no context, no router.

All Electron/SQLite calls from the renderer go through `window.shoresh.*` (see `electron/preload.js`), backed by IPC handlers in `electron/main.js`: `chooseMode`, `discoverHosts`, `login`, `createUser`, `bootstrapCamp`, `write`, `bulkReplace` (new, see below), `verifySession`, `getCamp`, `listUsers`, `list`, `getDeviceId`, `resolveConflict`, `listPendingConflicts`, plus push events `onOpApplied`/`onOpConflict`. `src/localClient.js` wraps every one of these (`write`, `bulkReplace`, `deleteEntity`, `list`, etc.) — screens must always go through `localClient`, never call `window.shoresh` directly.

**`bulkReplace` IPC surface (new, added during Sub-plan E Task 3):** `shoresh:bulk-replace` — admin-gated (mirrors `write`'s auth shape plus a `role === 'admin'` check, since a bulk_replace is a wholesale delete+reinsert of a scope, more destructive than any ordinary field write). Routes to the already-built `bulk_replace` op-log primitive (`appendBulkReplaceOp`/`applyBulkReplaceProjection` in `electron/ops/operations.js`, built in Sub-plan A Task 3). `BULK_REPLACE_ENTITIES` registers `template_slots` (columns: `id, template_id, group_id, activity_id, day_id, time_block_id, anchor_id, is_anchor, is_span_head, flags`) and `template_overlays` (columns: `id, template_id, unit_id, day_id, from_block_order, to_block_order, label`), scoped by `template_id`.

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
| `schedule` | `src/screens/ScheduleScreen.jsx` | Most complex screen — DnD schedule builder, three views (group/day/activity), flags, locking, snapshots. **Fully migrated off Supabase (Sub-plan E, Tasks 1-5, commits 855b248/db2c6f2/c687353/d324ed0/21f8a22)**: reads via `localClient.list`, single-slot writes via `writeFields`/`localClient.write`, bulk regen/snapshot-restore via `localClient.bulkReplace`, snapshot CRUD via `localClient.write` with JSON-text-column storage for the `slots`/`overlays` blobs (a scoped exception, not a precedent). See Key Architectural Decisions for the CRITICAL sync bug this migration's own verification surfaced. |
| `conflicts` | `src/screens/ConflictsScreen.jsx` | Only screen given extra props (`onNavigate`, `pendingConflicts`) beyond `campId` |

---

## Components

- `src/components/layout/Shell.jsx`, `Sidebar.jsx`, `TopBar.jsx` — app chrome, screen navigation, sidebar badge counts (e.g. pending conflicts)
- `src/components/CohortPicker.jsx` — cohort selection widget
- `src/components/schedule/` — schedule-builder-specific: `ActivityPalette`, `DisplacedPalette`, `ManualBuildView`, `ScheduleActivityView`, `ScheduleDayView`, `ScheduleGroupView`, `OverlayCell`, `SlotCell`, `EditModal`, `FieldTripDrawer`, `FlagDetailModal`, `ConfirmRegenModal`, `VersionsDropdown`, `StatBadge`

---

## Database Tables

(SQLite, one file per device — `electron/db/schema.sql`, schema v18 as of this writing)

- **camps** — `id, name, signing_secret`. Exactly one row expected per device db (single-camp-per-db assumption used throughout, e.g. `SELECT ... FROM camps LIMIT 1`).
- **users** — `id, camp_id, name, pin_hash, pin_salt, role('admin'|'staff')`. Unique on `(camp_id, name)`.
- **devices** — `id, name, last_seen_at, last_synced_at, last_synced_seq`. `last_synced_seq` is the op-log watermark used for reconnect catch-up (NULL = never watermarked, so a device's first connection doesn't get flooded with full history).
- **operations** — the op-log: `seq (autoincrement), id (unique), entity, entity_id, field, value, author_user_id, device_id, timestamp, parent_op_id, client_write_id`. `client_write_id` is a client-generated idempotency key so a retried `submit_op` doesn't mint a duplicate op.
- **conflicts** — durable record of every detected write conflict: `id, entity, entity_id, field, incoming_op, existing_op, existing_op_id, created_at, resolved_at`. A conflict counts as resolved when any op has `parent_op_id = existing_op_id`.
- **locks** — `entity, entity_id, field, holder_device_id, acquired_at` — field-level edit locks.
- **groups**, **tiers**, **activities** — camp-scoped config entities, each `camp_id`-keyed.
- **template_slots** — `id, template_id, group_id, activity_id, day_id, time_block_id, anchor_id, is_anchor, is_span_head, flags`. `anchor_id`/`is_anchor` added in schema migration v17 (Sub-plan E Task 3) — were referenced by `BULK_REPLACE_ENTITIES`'s intended column set but physically missing from SQLite until this migration.
- **template_overlays** — `id, template_id, unit_id, day_id, from_block_order, to_block_order, label`. Now a registered `bulk_replace` entity (Sub-plan E Task 3), alongside `template_slots`.
- **schedule_templates** — `id, camp_id, name`. Local SQLite table (ported off Supabase in Sub-plan E Task 1/2).
- **schedule_snapshots** — `id, template_id, name, is_auto, created_at, slots (TEXT/JSON), overlays (TEXT/JSON)`. `slots`/`overlays` are JSON-text columns — an explicitly scoped exception to this app's normal field-level op-log sync, not a pattern to reuse elsewhere (per the Sub-plan E design doc). Ported off Supabase in Sub-plan E Task 4. Gained a `PROJECTIONS` registry entry (`electron/ops/projections.js`) on 2026-07-24 — previously `ScheduleScreen.jsx`'s `writeFields()` calls to this entity silently never materialized the row (op-log write succeeded, but nothing projected it into the table); found and fixed while un-skipping the Sub-plan E Task 5 E2E regression test.
- **days_of_operation** — `id, camp_id, label, day_of_week, sort_order`. Default Monday-Friday rows are seeded on first camp mount by `src/utils/seedDays.js` (ported off Supabase 2026-07-24, previously `App.jsx`'s last live `supabase.from()` call site) — mirrors `ensureCohort.js`'s per-row completeness-check/repair pattern rather than a single "any row exists" flag, so a crash mid-seed self-repairs on the next mount instead of permanently under-seeding. No `UNIQUE` constraint exists on this table (unlike `cohorts`/`groups`/`time_blocks`) — two other files (`schema.sql`, `localDb.js`) have stale comments claiming otherwise, flagged as a follow-up cleanup, not yet fixed.
- **operations.host_seq** — new nullable column (schema migration v18, 2026-07-24). Persists the Host's canonical `seq` value on a Client's replicated copy of an op (`applyRemoteOp` in `syncClient.js`), fixing the `bulk_replace` cross-device seq bug — see Key Architectural Decisions.
- **schema_migrations** — `version, applied_at` — versioned migration guard table (currently v18).
- **device_identity** — `id, created_at` — this device's own persistent identity, independent of camp/login state (exists even on a totally fresh install).
- **pending_writes** — durable backing store for a Client's offline write queue (`pending_id, client_write_id, entity, entity_id, field, value, parent_op_id, created_at`), so a queued write survives an app restart before it's confirmed applied.

All tables above are local SQLite, read/written exclusively via `window.shoresh`/`localClient` IPC — no table is Supabase-backed anymore.

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
- **`bulk_replace` op primitive**: a `{entity, scope_id, rows}`-shaped op that deletes all current rows in scope and inserts a new set, atomically, recorded in the op-log like any other op. Built in Sub-plan A Task 3 (`appendBulkReplaceOp`/`applyBulkReplaceProjection`/`validateBulkReplaceRows` in `electron/ops/operations.js`), extended with a renderer-facing IPC channel and a `template_overlays` registry entry in Sub-plan E Task 3. Used by `ScheduleScreen.jsx` for schedule regeneration and snapshot restore — the only consumer.
  - **FIXED 2026-07-24** (previously CRITICAL, found by Sub-plan E Task 5's end-to-end verification, `electron/sync/scheduleE2E.sync.test.js`, originally left as an honest `it.fails` regression test — now un-skipped and genuinely green): `applyRemoteOp` in `electron/sync/syncClient.js` inserted a received op without persisting its Host-assigned `seq` (`electron/db/schema.sql`: `seq INTEGER PRIMARY KEY AUTOINCREMENT`) — each device's local `operations.seq` was that device's own independent counter, not the Host's canonical one. `latestScopeOpSeq`/`detectBulkReplaceConflict` (`electron/ops/operations.js`) compared a client's locally-numbered `based_on_seq` directly against the Host's own seq counter as if they were the same numbering space, so the SECOND `bulk_replace` to the same scope from the same client (build a schedule, then click Regenerate) spuriously conflicted in essentially all real usage. **Fix** (full Architect + Maker + review cycle, ADR at `docs/adr/2026-07-24-bulk-replace-seq-fix.md`): added a nullable `operations.host_seq` column (schema v18); `applyRemoteOp` now persists the Host's real `op.seq` into it on insert; `latestScopeOpSeq` compares `MAX(COALESCE(host_seq, seq))` instead of raw `seq`, so Host-authored rows (host_seq always NULL, own seq already canonical) and Client-replicated rows (host_seq populated) share one numbering space. `isValidRemoteOp` now requires `op.seq` be a non-negative integer (fail-closed). Disclosed, accepted residual limitation: operations rows from before this migration have `host_seq = NULL`; if Client-authored, scope-seq comparison falls back to that row's own (possibly wrong) local seq until superseded — at most one spurious conflict per scope post-upgrade, then self-healing (mathematically bounded, verified by Red Hat review), no backfill migration needed.

---

## Home Screen Layout

Not role-differentiated at the top level — `setup` (`CampSetup.jsx`) is the fixed landing screen for any session regardless of `admin`/`staff` role. No per-role home screen variants found.

---

## Known Deferred Items

- **Role enforcement is only partially audited**: only user-creation (`createUser`) is confirmed admin-gated server-side (`electron/main.js`). Other admin-oriented screens (tiers, groups, activities, etc.) have not been confirmed to have server-side role checks — see Role-Based Behavior table above.
- **Single-process test-harness limitation** (documented in `docs/superpowers/specs/2026-07-20-shared-camp-signing-secret-design.md`): Vitest runs Host/Client test actors in one OS process, so it cannot by itself distinguish some cross-process bugs from correct behavior — cross-process claims require live two-Electron-instance verification, not just the automated suite.
- No TLS anywhere in the sync protocol (`ws://`, not `wss://`) — explicitly accepted under the "trusted camp LAN" threat model, not a bug.
- **Local dev environment cannot complete Camp Setup**: confirmed across multiple Tester rounds (Sub-plan E Tasks 2-5, and again 2026-07-24) — the Units screen has an unsatisfiable "Cohorts" prerequisite with no reachable UI path in the sidebar, so Groups/Time Blocks/Activities can never be configured and the Schedule screen can never show a real schedule grid in this environment. Root cause not diagnosed (out of scope for the tasks that hit it). Separately, `DaysScreen.jsx` exists but is not wired into `App.jsx`'s `SCREENS` map or `Sidebar` navigation — confirmed pre-existing, unrelated to the 2026-07-24 `seedDays` port, no live UI path to it either. Both are worth a dedicated navigation-audit task.
- **`days_of_operation` has no UNIQUE constraint**, unlike `cohorts`/`groups`/`time_blocks` — `seedDays.js`'s repair logic works around this, but two other files (`electron/db/schema.sql`, `electron/db/localDb.js`) have stale comments incorrectly claiming a UNIQUE constraint exists on this table. Flagged 2026-07-24, not yet fixed — low-severity documentation landmine.
- **ESLint's Supabase-import ban only catches ES `import` syntax**, not CommonJS `require(...)` — narrow, plausible-not-confirmed bypass in an `electron/**` file using `require()` (the codebase is ESM-first; `require()` is currently confined to `electron/preload.js`). Flagged 2026-07-24 as a follow-up, not urgent.
- **`.env` (gitignored, untracked)** still contains a local Supabase demo `service_role` JWT (`iss: supabase-demo`, `127.0.0.1:54321` — not a real secret) left over from the pre-rebuild setup. Not tracked, not read by any active code, left alone per Security review (2026-07-24) — `.env.example` now documents these vars as legacy/dead.
- Two pre-existing, unrelated flaky tests observed repeatedly under full-suite (`npm run test`) parallel load during 2026-07-24's work: `electron/sync/discovery.test.js` (mDNS "finds an advertised host on the LAN" — passes reliably in isolation) and `electron/sync/syncServer.test.js` ("throttles a burst of rapid login messages" — timing-sensitive under CPU contention). Neither is caused by or related to any change made 2026-07-24; not fixed, out of scope each time they surfaced.

---

## Removed / Replaced

- **Per-process random session-signing secret** (`const sessionSecret = randomBytes(32)` at module load in `electron/auth/localAuth.js`) — replaced by the per-camp `signing_secret` stored in the `camps` table and looked up per-call. The old approach made cross-process token verification structurally impossible (a Client's own process had a different secret than the Host that issued its token).
- **Login gated purely on local data** — the original design required a Client to already have local `users`/`camps` rows to log in at all, which made first-ever login on a fresh device impossible (circular dependency: no token without login, no login without a prior sync, no prior sync without a token). Replaced by the unauthenticated WebSocket `login` message path described under Auth above.
- **`@supabase/supabase-js` dependency, `src/supabase.js`, `supabase/migrations/`** (removed/moved 2026-07-24) — the entire pre-rebuild Supabase backend. Moved to `legacy/supabase/` for historical reference; no longer a project dependency; reintroduction under `src/`/`electron/` is blocked by an ESLint rule. This closes out the renderer-migration-plus-hardening project that spanned Sub-plans A-E plus this final Phase 1 cleanup — every screen, the last bootstrap call site (`seedDays`), and the legacy files themselves are now off Supabase, and the sync layer's one known CRITICAL defect (`bulk_replace` cross-device seq bug) is fixed.
