# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Finding what governs your work

**[`docs/governance/GOVERNANCE_INDEX.md`](docs/governance/GOVERNANCE_INDEX.md) resolves which documents govern a given task.** Start there rather than inferring authority from whatever file you happened to open.

The highest authority is [`docs/governance/constitution/CONSTITUTION.md`](docs/governance/constitution/CONSTITUTION.md) — precedence order, the ten standing rules, human-approval gates, the agent roster, and the review loop. It is subordinate only to explicit current human instruction, and it overrides any personal `~/.claude/` defaults within this repository.

Three things worth knowing before you read anything else here:

- **This file and [PLATFORM_STATE.md](docs/current/PLATFORM_STATE.md) are descriptive, not authoritative.** They record what exists. Where they disagree with the code, the code is right and the document is stale — say so rather than reasoning from the stale text.
  One narrow slice of that staleness is now mechanical rather than a matter of noticing: `npm run check:governance` fails the build when a **descriptive** doc (this file, `docs/current/**`) names a repo path that does not exist, so a deleted or moved file cannot quietly go on being described here. It catches deleted paths only — a file that still exists but now *behaves* differently will still pass, and so does a claim written as a bare filename or partial path, which is checked for existence somewhere rather than at the location the sentence implies. Write the full path from the repo root when you want the claim actually checked. Everything past that remains on you. If a sentence names something in order to say it is **gone**, mark the line historical rather than deleting the sentence: strike the name through, open the line with `_Prior:`, or wrap the section in `<!-- doc-refs:historical -->` … `<!-- /doc-refs:historical -->`. Whole-file historical layers — ADRs, tickets, handoffs, `docs/archive/**` — are out of scope by design.
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
npm test -- <path/to/file.test.js>    # Run a single test file
npm run test:integration # Run the sync/ingest integration scenarios (test/integration/run.automerge.js)
npm run verify           # the full gate: agents:check + check:governance + build + security + test:integration + lint + test (scripts/verify.js). Ordered CHEAPEST-FIRST and short-circuits, so a 1.2s governance failure is reported in seconds instead of behind ~17 minutes of tests — same six gates, sooner. Prints a final ✅/❌ verdict line so the result survives `| tail` and can't false-green
```

**The gate also runs in CI** (`.github/workflows/gate.yml`) on every pull request and on push to
`main`, on a Linux runner — the suite needs no Electron, no display, and no multicast, so it is
fully portable. **CI is the gate of record for merging** — a red CI run blocks a merge whatever a local run said,
because the runner is a clean machine and a green local gate cannot separate "correct" from
"configured like the author's machine". A local `npm run verify` is still valid evidence and is what
`scripts/gate.sh` stamps, but you are **no longer expected to run the full local gate before
pushing**; CI runs it anyway, on a quieter machine, in about half the time. See
`docs/governance/standards/TESTING_STANDARD.md` §1.

**Only one local gate runs at a time.** `npm run verify` takes a machine-wide lock
(`scripts/gateLock.js`) keyed to the repository, so a second one waits and names the holder instead
of both thrashing a 4-core machine. `SHORESH_VERIFY_NO_LOCK=1` bypasses it.

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

**A git worktree needs its own `npm ci`.** A worktree under `.claude/worktrees/` often has a
`node_modules` holding nothing but a Vite cache, and Node then resolves every package by walking UP
to the main checkout's `node_modules` — which sits at whatever commit the MAIN checkout has checked
out, not your branch's. If your branch changes a dependency version, a gate run in that worktree
silently exercises the OLD version while the tree under test declares the new one: a green that
describes neither tree. Run `npm ci` in the worktree itself, and confirm the resolved version rather
than trusting that the install reported success.

Note that the obvious probe fails misleadingly for some modern packages: `require('libp2p/package.json')`
throws `ERR_PACKAGE_PATH_NOT_EXPORTED`, because libp2p 3.x's `exports` map does not expose
`./package.json`. That is the exports map talking, not a broken install. Read the file directly:

```bash
node -p "JSON.parse(require('fs').readFileSync('./node_modules/libp2p/package.json','utf8')).version"
```

## Architecture

**This app has migrated from a Supabase (Postgres + Auth + RLS) cloud backend to a local-first design.** The active, current architecture is Electron + an Automerge (CRDT) document replicated peer-to-peer over libp2p, with SQLite as a local projection of that document. The legacy pre-rebuild Supabase path has been fully retired: it lives at `legacy/supabase/` for historical reference only, is not imported by any active code under `src/` or `electron/`, and `@supabase/supabase-js` is no longer a dependency of this project. `src/hooks/useSession.js` no longer exists. See "Legacy Supabase path" below for details.

**Local-first model** — a camp's data lives in an **Automerge document**, and that document is the source of truth replicated between devices. Each device also runs its own SQLite db (`better-sqlite3`), which is a **projection** of the document, not the master copy — screens and the engine read SQLite because it is convenient to query, but a write goes to the document first and the projection follows. Replication is peer-to-peer over **libp2p** (`electron/sync/automerge/`), on Noise-encrypted, mutually authenticated connections; there is no Host process serving a socket and no `ws://`. A device joins a camp by typing the **camp code** its director reads off an existing device. Data isolation is enforced by the app being single-camp-per-device-db (every `camps` lookup is `SELECT ... FROM camps LIMIT 1`), not by RLS.

Two devices editing *different* fields of the same record both keep their edits; two editing the *same* field surface an explicit `conflicts` row for a human to resolve (`resolveConflict`) rather than one side silently winning. **Do not reason about sync from the `operations` table** — see "Op log" below. For which facts live in the document versus SQLite, [docs/current/WHERE_DATA_LIVES.md](docs/current/WHERE_DATA_LIVES.md) is the authority.

**Renderer ↔ Electron IPC** — the renderer never touches SQLite directly. All calls go through `window.shoresh.*` (exposed via `contextBridge` in `electron/preload.js`), handled in `electron/main.js`. The surface is large and moves constantly, so it is **not restated here**: read the `contextBridge` block in `electron/preload.js`, which is the list. The shape worth knowing before you read it is that calls fall into a few families — reads (`list`, `listByScope`, `getCamp`), writes (`write`, `bulkReplace`, `deleteRecord`, `restoreEntity`), session and pairing (`login`, `verifySession`, `joinStart`, `approveDevice`), and `on*` push events the main process emits at the renderer.

**Auth** — local, PIN-based, per-camp; there is no account server. The two invariants to hold while working, rather than the mechanism: **every** PIN check funnels through `attemptLogin` in `electron/auth/localAuth.js` (one implementation, so lockout and timing behaviour cannot drift between entry points), and **every** mutating handler goes through `authorize()` in `electron/auth/authorize.js`, which re-queries role and device trust on each call rather than trusting anything cached in a session. Token types, key custody, scrypt parameters and lockout numbers are specified in **[SECURITY.md](SECURITY.md)** — that is the authority, and this file deliberately does not repeat them.

**Op log — local history, not sync.** Mutations are still appended to the `operations` table (entity/field-level, `client_write_id` for idempotent retries), and a merge arriving from another device also writes rows there. But since the Stage 6 cutover the table is a **device-local history ledger**: it backs Trash, Restore, entity history and ingest-undo. It is **not** the replication mechanism and is not replayed across devices — Automerge is. Code that treats `operations` as the way data reaches another device is reasoning about an architecture this app no longer has.

**Device/session state machine** — `src/hooks/useDeviceMode.js` derives a `phase` (`error` → `loading` → `mode-select` → `bootstrap`/`join` → `login` → `session`). `src/App.jsx`'s `App()` switches on `device.phase` to render `ModeSelectScreen`, `CampBootstrapScreen`, `JoinByCodeScreen`, `LoginScreen`, or the full `AppShell`. _Prior: there were also `pairing_pending` and `pairing_denied` phases rendering a ~~PairingPendingScreen~~; both were orphaned by the Stage 6c cutover (they were gated on a stored host address nothing has written since) and are gone — pairing is awaited inside `src/screens/JoinByCodeScreen.jsx` via `joinAwaitPairingDecision`._

**Screen routing (in-session)** — once `phase === 'session'`, `AppShell` (`src/App.jsx`) holds a `screen` string in `useState`, looked up in the `SCREENS` map and passed to `Shell` → `Sidebar` (`src/components/layout/`). `campId` and an `onNavigate` (`setScreen`) callback are threaded as props into every screen — no router, no context.

**Schedule engine** — `src/engine/buildSchedule.js` is a pure function with no React/IPC dependencies. Signature: `buildSchedule({ groups, tiers, days, timeBlocks, activities, anchors, campId, preplacedSlots })` → `{ slots, conflicts, findings }`. Runs in three passes: resolve eligibility, place activities (high-priority round then low-priority), audit flags. Uses a seeded PRNG (DJB2 + Mulberry32) so identical inputs produce identical schedules. A multi-block activity counts as ONE session towards `min_per_week` and `prefer_before_day` goals — a double-length swim is one swim. Its behavior is pinned by `src/engine/buildSchedule.test.js` — the most heavily unit-tested module in the repo, though far from the only tested one.

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
- **Two things it does not see**, learned by deleting the WS layer in Stage 6c. Methods on a returned object literal (`syncClient.loginRemote`) may not be indexed at all — and a call to a method that no longer exists is invisible to ESLint too, so only a gate catches it. Source files read as STRINGS (`readFileSync('../sync/syncClient.js')`, as several registry and migration tests do) are not import edges and will not appear. Run `graphify affected` for the dependency edges, then a `grep -a` pass for string references, then the gate: three different blind spots, none sufficient alone.
- Carry the `source_location` (`file:line`) through any answer that cites the graph, so the next reader — human or agent — can click and check.

**Freshness — know whether you're looking at current code**
- Code stays fresh automatically: a post-commit hook (main checkout) re-extracts changed code files after every commit. Free, no LLM.
- The graph is built from committed `main`. It does **not** reflect uncommitted or worktree-branch work — if you are reasoning about unmerged changes, say so and read the files directly.
- The **doc/ADR layer does not auto-update** (that pass costs tokens). The hook only *reminds* when docs change. Refresh it deliberately by re-running `/graphify` in the main checkout; until then, treat the graph's doc/ADR nodes as possibly behind the latest commits.

See [docs/adr/2026-07-28-first-pairing-domain-sync-and-template-identity.md](docs/adr/2026-07-28-first-pairing-domain-sync-and-template-identity.md) for an example of the kind of load-bearing seam the graph is good at surfacing (`deriveScheduleTemplateId`, the highest-betweenness node).
