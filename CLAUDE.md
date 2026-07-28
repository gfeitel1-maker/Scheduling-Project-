# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Finding what governs your work

**[`docs/governance/GOVERNANCE_INDEX.md`](docs/governance/GOVERNANCE_INDEX.md) resolves which documents govern a given task.** Start there rather than inferring authority from whatever file you happened to open.

The highest authority is [`docs/governance/constitution/CONSTITUTION.md`](docs/governance/constitution/CONSTITUTION.md) — precedence order, the ten standing rules, human-approval gates, the agent roster, and the review loop. It is subordinate only to explicit current human instruction, and it overrides any personal `~/.claude/` defaults within this repository.

Three things worth knowing before you read anything else here:

- **This file and [PLATFORM_STATE.md](PLATFORM_STATE.md) are descriptive, not authoritative.** They record what exists. Where they disagree with the code, the code is right and the document is stale — say so rather than reasoning from the stale text.
- **A standard is not overridden by code.** If the implementation contradicts a standard, that is a gap to report, not a licence to amend either one.
- **`docs/superpowers/**` and `legacy/**` are historical.** Several documents there describe the retired Supabase architecture accurately as of their date. They are never current instruction, however detailed they look.

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

**This app has migrated from a Supabase (Postgres + Auth + RLS) cloud backend to a local-first design.** The active, current architecture is Electron + SQLite + LAN sync, described below. The legacy pre-rebuild Supabase path has been fully retired: it lives at `legacy/supabase/` for historical reference only, is not imported by any active code under `src/` or `electron/`, and `@supabase/supabase-js` is no longer a dependency of this project. `src/hooks/useSession.js` no longer exists. See "Legacy Supabase path" below for details.

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

## Legacy Supabase path (pre-rebuild, fully retired)

The pre-rebuild Supabase backend has moved to `legacy/supabase/` and is fully retired — not just "don't extend it," but no longer imported anywhere in `src/` or `electron/`, and `@supabase/supabase-js` has been removed from `package.json`. An ESLint rule (`eslint.config.js`) bans any new `@supabase/*` import under `src/` or `electron/` to keep it from being reintroduced.

- `legacy/supabase/supabase.js` (previously `src/supabase.js`) held a single Supabase client instance.
- `legacy/supabase/migrations/` (previously `supabase/migrations/`) holds the old Postgres migrations, applied manually via the Supabase SQL editor, in filename order.
- RLS policies (via `get_my_camp_id()`) enforced tenant isolation in that era; local-first data isolation now works differently — see the local-first model above.
- `src/hooks/useSession.js` no longer exists (removed in an earlier phase).

See [legacy/supabase/README.md](legacy/supabase/README.md) for more, and [PLATFORM_STATE.md](PLATFORM_STATE.md) for what's actually active. Treat this section as historical context only.
