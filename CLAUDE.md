# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

For a fuller picture of screens, tables, and architectural decisions, see [PLATFORM_STATE.md](PLATFORM_STATE.md) — keep both in sync when structural things change.

## Commands

```bash
npm run dev            # Vite dev server at http://localhost:5200
npm run electron:dev   # Vite + Electron together (real app, local-first stack)
npm run build           # Production build
npm run electron:build  # Vite build + electron-builder (packaged app)
npm run lint            # ESLint
npm run test             # Run all Vitest tests
npm test -- src/path/to/file.test.js  # Run a single test file
```

After touching `electron/db/**` (better-sqlite3 is a native module), the binary ABI can drift between Node (used by Vitest) and Electron:

```bash
npx electron-rebuild -f -w better-sqlite3   # before npm run electron:dev
npm rebuild better-sqlite3                   # before npm run test
```

## Architecture

**This app is mid-migration from a Supabase (Postgres + Auth + RLS) cloud backend to a local-first design.** The active, current architecture is Electron + SQLite + LAN sync, described below. `src/supabase.js` and `src/hooks/useSession.js` are the legacy pre-rebuild path — do not build new features on them; target the Electron/SQLite path instead.

**Local-first model** — each device runs its own SQLite db (`better-sqlite3`). One device acts as a LAN "Host" (WebSocket server, `electron/sync/syncServer.js`); other devices are "Clients" (`electron/sync/syncClient.js`) that discover the Host via mDNS (`electron/sync/discovery.js`) and sync over `ws://`. Data isolation is enforced by the app being single-camp-per-device-db (every `camps` lookup is `SELECT ... FROM camps LIMIT 1`), not by RLS.

**Renderer ↔ Electron IPC** — the renderer never touches SQLite directly. All calls go through `window.shoresh.*` (exposed via `contextBridge` in `electron/preload.js`), handled in `electron/main.js`: `chooseMode`, `discoverHosts`, `login`, `createUser`, `bootstrapCamp`, `write`, `verifySession`, `getCamp`, `listUsers`, `getDeviceId`, `resolveConflict`, `listPendingConflicts`, plus push events `onOpApplied`/`onOpConflict`.

**Auth** — local, PIN-based, per-camp. `electron/auth/localAuth.js`'s `attemptLogin(db, {name, pin, deviceId})` does the PIN check (`scryptSync`) and lockout tracking; `issueSessionToken`/`verifySessionToken(db, ...)` sign/verify tokens using a shared per-camp HMAC secret (`camps.signing_secret`, generated at bootstrap, distributed to every device via full-sync). Two login paths — local IPC (Host, or a Client's offline fallback) and an unauthenticated WebSocket `login` message (lets a genuinely fresh Client verify its PIN against the Host and get its first token) — both route through `attemptLogin` so behavior can't drift.

**Op-log sync** — all mutations are appended as rows to the `operations` table (entity/field-level, with `client_write_id` for idempotent retries) and replayed across devices. Genuine conflicting writes are recorded in the `conflicts` table (not silently dropped) and require explicit resolution via `resolveConflict`, linked by `parent_op_id`.

**Device/session state machine** — `src/hooks/useDeviceMode.js` derives a `phase` (`error` → `loading` → `mode-select` → `bootstrap`/`join` → `login` → `session`). `src/App.jsx`'s `App()` switches on `device.phase` to render `ModeSelectScreen`, `CampBootstrapScreen`, `JoinScreen`, `LoginScreen`, or the full `AppShell`.

**Screen routing (in-session)** — once `phase === 'session'`, `AppShell` (`src/App.jsx`) holds a `screen` string in `useState`, looked up in the `SCREENS` map and passed to `Shell` → `Sidebar` (`src/components/layout/`). `campId` and an `onNavigate` (`setScreen`) callback are threaded as props into every screen — no router, no context.

**Schedule engine** — `src/engine/buildSchedule.js` is a pure function with no React/IPC dependencies. Signature: `buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors, campId, preplacedSlots })` → `{ slots, stats }`. Runs in three passes: resolve eligibility, place activities (high-priority round then low-priority), audit flags. Uses a seeded PRNG (DJB2 + Mulberry32) so identical inputs produce identical schedules. This is the only file with unit tests (`src/engine/buildSchedule.test.js`).

**ScheduleScreen** — `src/screens/ScheduleScreen.jsx` is the most complex file. It owns the schedule state, DnD context (`@dnd-kit/core` with `distance: 8` activation constraint to coexist with click handlers), flag dismissal, activity locking, slot swapping, and snapshot management. Three views: group (one group across all days), day (all groups on one day), activity drilldown.

**Styling** — all styles are inline React objects. Shared constants live in `src/styles/shared.js` and are imported as `import { S } from '../styles/shared'`. Component-specific styles are defined as `const` objects at the bottom of each file. No CSS files, no CSS modules.

**Native module ABI** — `better-sqlite3` must be rebuilt when switching between running under Node (Vitest) and Electron; see Commands above. Symptoms of a mismatch: native module load errors or crashes on startup.

## Legacy Supabase path (pre-rebuild, do not extend)

`src/supabase.js` holds a single Supabase client instance; `src/hooks/useSession.js` wraps Supabase auth state (`useSession()` → `{ session, campId, loading }`, `resolveCampId(session)`). RLS policies (via `get_my_camp_id()`) enforced tenant isolation. `supabase/migrations/` is applied manually via the Supabase SQL editor, in filename order; the service role key is never used in the frontend.

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Treat this section as historical context, not the path new work should extend — see [PLATFORM_STATE.md](PLATFORM_STATE.md) for what's actually active.
