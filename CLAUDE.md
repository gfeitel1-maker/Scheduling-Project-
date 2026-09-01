# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Finding what governs your work

**[`docs/governance/GOVERNANCE_INDEX.md`](docs/governance/GOVERNANCE_INDEX.md) resolves which documents govern a given task.** Start there rather than inferring authority from whatever file you happened to open.

The highest authority is [`docs/governance/constitution/CONSTITUTION.md`](docs/governance/constitution/CONSTITUTION.md) — precedence order, the ten standing rules, human-approval gates, the agent roster, and the review loop. It is subordinate only to explicit current human instruction, and it overrides any personal `~/.claude/` defaults within this repository.

Three things worth knowing before you read anything else here:

- **This file and [PLATFORM_STATE.md](docs/current/PLATFORM_STATE.md) are descriptive, not authoritative.** They record what exists. Where they disagree with the code, the code is right and the document is stale — say so rather than reasoning from the stale text.
- **A standard is not overridden by code.** If the implementation contradicts a standard, that is a gap to report, not a licence to amend either one.
- **`docs/archive/**` and `legacy/**` are historical.** Several documents there describe the retired Supabase architecture accurately as of their date. They are never current instruction, however detailed they look.

## Commands

```bash
npm run dev            # Vite dev server at http://localhost:5200
npm run electron:dev   # Vite + Electron together (real app, local-first stack)
npm run electron:dev:fresh  # kills a stale Electron process first, then electron:dev
npm run build           # Production build
npm run electron:build  # Vite build + electron-builder (packaged app)
npm run lint            # ESLint
npm run test             # Run all Vitest tests
npm test -- src/path/to/file.test.js  # Run a single test file
npm run test:integration # Run the LAN-sync/ingest integration scenarios (test/integration/run.js)
npm run verify           # lint + test + test:integration + check:governance — the full gate (scripts/verify.js; prints a final ✅/❌ verdict line so the result survives `| tail` and can't false-green)
```

**`electron:dev:fresh` uses `pkill -x Electron`, which kills every Electron process owned by the
user, not just this project's** — a dev server for another Electron app will be killed too, without
warning. The packaged Shoresh app is unaffected (its process is named `Shoresh`, not `Electron`).
Accepted tradeoff for a convenience script a developer opts into by name; see T64.

**Dev and packaged builds use separate databases, deliberately.** `npm run electron:dev` reads
`~/Library/Application Support/shoresh-dev`; the installed app reads `.../shoresh`. Development work
therefore cannot touch a real camp's data. The sidebar footer shows a **DEV** badge whenever the
development database is loaded — if you do not see it, you are looking at the installed app's data.
Set explicitly in `electron/db/userDataPath.js`; see
[docs/adr/2026-07-28-explicit-userdata-directory.md](docs/adr/2026-07-28-explicit-userdata-directory.md).

After touching `electron/db/**` (better-sqlite3 is a native module), the binary ABI can drift between Node (used by Vitest) and Electron:

```bash
npx electron-rebuild -f -w better-sqlite3   # before npm run electron:dev
npm rebuild better-sqlite3                   # before npm run test
```

## Architecture

**This app has migrated from a Supabase (Postgres + Auth + RLS) cloud backend to a local-first design.** The active, current architecture is Electron + SQLite + LAN sync, described below. The legacy pre-rebuild Supabase path has been fully retired: it lives at `legacy/supabase/` for historical reference only, is not imported by any active code under `src/` or `electron/`, and `@supabase/supabase-js` is no longer a dependency of this project. `src/hooks/useSession.js` no longer exists. See "Legacy Supabase path" below for details.

**Local-first model** — each device runs its own SQLite db (`better-sqlite3`). One device acts as a LAN "Host" (WebSocket server, `electron/sync/syncServer.js`); other devices are "Clients" (`electron/sync/syncClient.js`) that discover the Host via mDNS (`electron/sync/discovery.js`) and sync over `ws://`. Data isolation is enforced by the app being single-camp-per-device-db (every `camps` lookup is `SELECT ... FROM camps LIMIT 1`), not by RLS.

**Renderer ↔ Electron IPC** — the renderer never touches SQLite directly. All calls go through `window.shoresh.*` (exposed via `contextBridge` in `electron/preload.js`), handled in `electron/main.js`. A representative set (see `electron/preload.js` for the full surface): `chooseMode`, `discoverHosts`, `login`, `createUser`, `bootstrapCamp`, `write`, `bulkReplace`, `list`, `verifySession`, `getCamp`, `listUsers`, `getDeviceId`, `resolveConflict`, `listPendingConflicts`, plus push events `onOpApplied`/`onOpConflict`.

**Auth** — local, PIN-based, per-camp. `electron/auth/localAuth.js`'s `attemptLogin(db, {name, pin, deviceId})` does the PIN check (`scryptSync` + `timingSafeEqual`) and lockout tracking (5 attempts, 30s). Two token types: `camp` tokens are signed with the Host's Ed25519 private key, which lives only in `host_signing_key` on the Host and never replicates — Clients receive the public half via `camps.signing_public_key` and can verify but never mint. `local` tokens are HMAC-SHA256 keyed to that device's own `device_secret_identifier` (issued at pairing) and are accepted only for local IPC on that device; the Host's WebSocket server rejects them. Both expire in 24h. Two login paths — local IPC and an unauthenticated WebSocket `login` message (lets a fresh Client verify its PIN against the Host) — both route through `attemptLogin` so behavior can't drift. Every mutating IPC and WS handler goes through `authorize()` (`electron/auth/authorize.js`), which re-queries role and device trust on every call. See [SECURITY.md](SECURITY.md).

**Op-log sync** — all mutations are appended as rows to the `operations` table (entity/field-level, with `client_write_id` for idempotent retries) and replayed across devices. Genuine conflicting writes are recorded in the `conflicts` table (not silently dropped) and require explicit resolution via `resolveConflict`, linked by `parent_op_id`.

**Device/session state machine** — `src/hooks/useDeviceMode.js` derives a `phase` (`error` → `loading` → `mode-select` → `bootstrap`/`join` → `pairing_pending` → `pairing_denied` → `login` → `session`). `src/App.jsx`'s `App()` switches on `device.phase` to render `ModeSelectScreen`, `CampBootstrapScreen`, `JoinScreen`, `PairingPendingScreen` (also renders the `pairing_denied` state inline), `LoginScreen`, or the full `AppShell`.

**Screen routing (in-session)** — once `phase === 'session'`, `AppShell` (`src/App.jsx`) holds a `screen` string in `useState`, looked up in the `SCREENS` map and passed to `Shell` → `Sidebar` (`src/components/layout/`). `campId` and an `onNavigate` (`setScreen`) callback are threaded as props into every screen — no router, no context.

**Schedule engine** — `src/engine/buildSchedule.js` is a pure function with no React/IPC dependencies. Signature: `buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors, campId, preplacedSlots })` → `{ slots, conflicts, findings }`. Runs in three passes: resolve eligibility, place activities (high-priority round then low-priority), audit flags. Uses a seeded PRNG (DJB2 + Mulberry32) so identical inputs produce identical schedules. A multi-block activity counts as ONE session towards `min_per_week` and `prefer_before_day` goals — a double-length swim is one swim. Its behavior is pinned by `src/engine/buildSchedule.test.js` — the engine is the most heavily unit-tested module, though it is far from the only tested one (the repo has ~270 test files across `src/`, `electron/`, and `test/`).

**ScheduleScreen** — `src/screens/ScheduleScreen.jsx` is the most complex file. It owns the schedule state, DnD context (`@dnd-kit/core` with `distance: 8` activation constraint to coexist with click handlers), flag dismissal, activity locking, slot swapping, and snapshot management. Three views: group (one group across all days), day (all groups on one day), activity drilldown.

**Two routes, two candidate schedules** — a camp holds up to two schedules, one per building route: **Manual** (the director builds it themselves, the spreadsheet replacement) and **Generated** (the engine proposes one, the director edits it by drag-and-drop). They are separate `schedule_templates` rows distinguished by `kind`, share one camp setup, and coexist — switching between them is navigation, never destructive, never confirmed. **Neither is canonical.** Nothing in the app may designate one as the active/real/current schedule or pick one on the director's behalf; where exactly one is required (export), the director chooses at that moment and the choice is not remembered. `route` state in ScheduleScreen keys `slots`/`overlays`/`snapshots`/`stats`/`findings`. Per-slot flags differ by route — `UNFILLABLE` on generated only, `OVERLAP` (derived at render time, never persisted) on manual only — while the vocabulary is shared. See `docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`.

**Styling** — global design tokens live in CSS: `src/index.css` defines `--primary` and the whole token set. Component styles are inline React objects; shared constants live in `src/styles/shared.js`, imported as `import { S } from '../styles/shared'`, with component-specific styles as `const` objects at the bottom of each file. No CSS modules.

There is **one scoped exception**: `src/components/schedule/scheduleGrid.css`, covering the schedule grid container, cell interaction pseudo-states (`:hover`, `:focus-within`), and cell data-attribute states. The reason: pseudo-classes and attribute selectors do not exist in inline styles, and on a dense repeated element their absence is otherwise paid for with React state and re-renders across up to 480 cells. **The boundary is `src/components/schedule/` and does not extend beyond it** — adding a second stylesheet, or converting another component to CSS, is the drift this exception is scoped to prevent. Per-cell computed geometry (`gridRow`, `gridColumn`) and data-derived colours stay inline on the element that computes them.

A **new** ephemeral cell state is therefore added as a data attribute plus a rule in `scheduleGrid.css`, not as React state (see the ADR's "Future constraints", `docs/adr/2026-08-06-schedule-canvas-visual-layer.md`).

**Native module ABI** — `better-sqlite3` must be rebuilt when switching between running under Node (Vitest) and Electron; see Commands above. Symptoms of a mismatch: native module load errors or crashes on startup.

## Legacy Supabase path (pre-rebuild, fully retired)

The pre-rebuild Supabase backend has moved to `legacy/supabase/` and is fully retired — not just "don't extend it," but no longer imported anywhere in `src/` or `electron/`, and `@supabase/supabase-js` has been removed from `package.json`. An ESLint rule (`eslint.config.js`) bans any new `@supabase/*` import under `src/` or `electron/` to keep it from being reintroduced.

- `legacy/supabase/supabase.js` (previously `src/supabase.js`) held a single Supabase client instance.
- `legacy/supabase/migrations/` (previously `supabase/migrations/`) holds the old Postgres migrations, applied manually via the Supabase SQL editor, in filename order.
- RLS policies (via `get_my_camp_id()`) enforced tenant isolation in that era; local-first data isolation now works differently — see the local-first model above.
- `src/hooks/useSession.js` no longer exists (removed in an earlier phase).

See [legacy/supabase/README.md](legacy/supabase/README.md) for more, and [PLATFORM_STATE.md](docs/current/PLATFORM_STATE.md) for what's actually active. Treat this section as historical context only.

## graphify (codebase knowledge graph)

A graphify knowledge graph of this repo lives in `graphify-out/` **in the main checkout only** (git-ignored, never committed). It maps the code — functions, files, calls, and cross-references — plus the ADRs and governance docs, into something queryable. Use it to *locate* and to check *blast radius*; it is a map, not an authority.

**Reaching the graph from a worktree.** The graph and the `graphify` MCP server exist only in the main checkout (`~/dev/shoresh`); worktrees under `.claude/worktrees/` do **not** have their own copy, and there is no value in building one — the graph reflects committed `main`, so a single shared graph is correct. From a worktree, pass the absolute path to every command: `--graph ~/dev/shoresh/graphify-out/graph.json` (the `graphify affected`/`query`/`explain`/`god-nodes` examples below all accept it). The bare-path examples below assume you are in the main checkout.

**When to reach for it**
- Before changing a shared or load-bearing symbol, get the downstream impact: `graphify affected "<symbolName>"`. This is more reliable than eyeballing imports and is the expected pre-change check for structural edits.
- To answer "how does X work / what connects to Y", query it first: `graphify query "<question>"` — it cites `file:line`, which you then open.
- `graphify god-nodes` surfaces the most-connected symbols — useful for scoping a review.

**Honesty rules (these are the point, not decoration)**
- The graph is a **map, not an oracle.** It narrows where to look; the code settles what is true. Never assert a graph claim you have not confirmed in the file.
- Edges are labelled `EXTRACTED` (pulled straight from code — trustworthy) or `INFERRED` (an LLM guess — may be wrong). Treat `INFERRED` as a lead to verify, never as fact.
- Carry the `source_location` (`file:line`) through any answer that cites the graph, so the next reader — human or agent — can click and check.

**Freshness — know whether you're looking at current code**
- Code stays fresh automatically: a post-commit hook (main checkout) re-extracts changed code files after every commit. Free, no LLM.
- The graph is built from committed `main`. It does **not** reflect uncommitted or worktree-branch work — if you are reasoning about unmerged changes, say so and read the files directly.
- The **doc/ADR layer does not auto-update** (that pass costs tokens). The hook only *reminds* when docs change. Refresh it deliberately by re-running `/graphify` in the main checkout; until then, treat the graph's doc/ADR nodes as possibly behind the latest commits.

See [docs/adr/2026-07-28-first-pairing-domain-sync-and-template-identity.md](docs/adr/2026-07-28-first-pairing-domain-sync-and-template-identity.md) for an example of the kind of load-bearing seam the graph is good at surfacing (`deriveScheduleTemplateId`, the highest-betweenness node).
