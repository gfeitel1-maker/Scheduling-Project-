---
title: W10 — MCP server for Shoresh ingestion + read surface
document_type: adr
status: accepted
date: 2026-08-21
authority: subordinate-to-constitution
implementation_state: implemented (2026-09-01; scripts/mcp/{server,tools}.js + tests, launchable via `npm run mcp`)
accepted_by: product owner (2026-08-21)
---

# W10: an MCP server exposing Shoresh's ingestion + read surface

## Context

Shoresh's ingestion core (`scripts/ingestCli.js:76` `runIngestCli`) already runs headless — no Electron, no IPC, no auth — as the CLI's proven pattern: `openLocalDb -> parseTextGrid/workbookToPages -> extractEntities -> commitIngest` (`electron/ops/ingest.js:555`/`:639`). We want an agent (Claude Desktop/Code) to drive the same import + read a camp's setup state directly, without going through the renderer. The owner chose (brainstorm, pre-ADR): scope = ingestion + read only (no full write, no schedule mutation); consumer = local-dev-first, don't foreclose a future camp-director case; transport = stdio, client-launched, no network port; packaging = standalone Node entry depending only on the headless core, no Electron; trust = default read-only, writes gated behind an explicit `--allow-write` flag.

Those four choices are fixed inputs to this ADR, not reopened here. What remained undecided, and what this ADR resolves: the exact tool set and schemas; where the read seam lives and how `electron/main.js`'s `list` handler stops duplicating it; how a headless commit gets `author_user_id`/`device_id` without inventing new identity machinery; the ABI and dependency implications; and the test seam.

### Candidates considered for the read seam (the one open design question)

1. **MCP calls `list()` via a spawned Electron/IPC round-trip.** Rejected — contradicts the owner's "no Electron dependency" packaging decision outright; would also require minting a session token headlessly, reintroducing the auth machinery the CLI deliberately stays outside of.
2. **MCP duplicates `list()`'s inline SQL in its own module.** Rejected — `electron/main.js:932`'s `list()` is already a 27-line pass-through over `DIRECT_CAMP_ENTITIES`/`PARENT_SCOPED_ENTITIES` (`electron/ops/campScopedEntities.js`); a second copy is exactly the drift `commitIngest`'s single-committer discipline elsewhere in this codebase exists to prevent.
3. **Extract a headless `listEntities(db, entity)` shared by both `main.js`'s `list()` and the MCP.** Chosen — matches the codebase's existing seam pattern (`commitIngest`/`commitPlan` as the single write path; this becomes the single read path), and it's a mechanical extraction of code that is already auth-agnostic (the SQL itself never touches `token`).

## Decision

Build the MCP server as a new headless Node entry point under `scripts/mcp/`, and extract the DB-facing half of `list()` into a shared module both `electron/main.js` and the MCP import.

### 1. Tool set

All tool names and descriptions use canonical W1 vocabulary (Age Division, Program, Location, Group), never internal table names, in their *descriptions*; the wire-level `entity` argument accepts the friendly name and the server maps it to the DB table.

| Tool | Args | Behavior |
|---|---|---|
| `ingest_preview` | `{ file_path: string, mode?: 'add'\|'replace' }` | Calls `runIngestCli({ file, dbPath, mode, action: 'preview' })`. Always available, read-only (dry run only). |
| `ingest_commit` | `{ file_path: string, mode?: 'add'\|'replace' }` | Calls `runIngestCli({ file, dbPath, mode, action: 'commit', authorUserId })`. Refuses immediately, before touching the DB, unless the server was launched with `--allow-write`. |
| `list_entities` | `{ entity: 'age_divisions'\|'programs'\|'groups'\|'locations'\|'activities'\|'days_of_operation'\|'time_blocks' }` | Calls the new `listEntities(db, dbEntity)` seam after mapping the friendly name. |
| `setup_summary` | `{}` | Calls `listEntities` for each of the six ingestible entities plus `locations`, returns `{ [entity]: count }`. Pure composition over `list_entities` — no new query. |
| `schedule_state` | `{ route: 'manual'\|'generated' }` | Reads `schedule_templates` filtered by `kind = route`, plus that template's `template_slots`/`template_overlays`. **PLUS (owner decision 2026-08-21): re-runs the schedule engine to include computed flags/conflicts** — see Decision 8. |

Friendly→DB entity map (owned by the MCP layer, not `electron/ops/read.js`, since it's a presentation concern):
```
age_divisions -> tiers
programs      -> cohorts
groups        -> groups
locations     -> locations
activities    -> activities
days_of_operation -> days_of_operation
time_blocks   -> time_blocks
```

### 2. The headless read seam

New file `electron/ops/read.js`:

```js
export function listEntities(db, entity) {
  if (!DIRECT_CAMP_ENTITIES.has(entity) && !PARENT_SCOPED_ENTITIES[entity]) {
    throw new Error(`Unrecognized entity: ${entity}`)
  }
  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  if (!camp) return []
  if (DIRECT_CAMP_ENTITIES.has(entity)) {
    return db.prepare(`SELECT * FROM ${entity} WHERE camp_id = ?`).all(camp.id)
  }
  const { table, parentTable, parentKey } = PARENT_SCOPED_ENTITIES[entity]
  return db.prepare(
    `SELECT t.* FROM ${table} t JOIN ${parentTable} p ON p.id = t.${parentKey} WHERE p.camp_id = ?`
  ).all(camp.id)
}
```

This is the exact body currently inline in `electron/main.js:932`'s `list()`, moved verbatim (entity-name validation included — it stays a hard whitelist against the same frozen registries in `campScopedEntities.js`, never caller-built SQL). `electron/main.js`'s `list(token, entity)` is edited to keep its `token`/`requireAuthorized(db, { token, action: `${entity}.read` })` gate exactly as-is, then delegate: `return listEntities(db, entity)`. Auth stays in `main.js`; the query logic moves out. This is a pure extraction — no behavior change on the IPC path, provable by the existing IPC-level tests continuing to pass unmodified.

The MCP's `list_entities`/`setup_summary`/`schedule_state` tools call `listEntities(db, entity)` directly, with no token and no `requireAuthorized` call — same posture as `commitIngest` today (finding 4 below): the filesystem/db-path is the trust boundary for a local stdio process, not a session token.

### 3. Identity for `ingest_commit`

`commitIngest` takes no token and performs no signature check (confirmed: `electron/ops/ingest.js:555`'s signature has no `token` param, and `scripts/ingestCli.js`'s header comment states this explicitly — "it never opens a network socket, never mints/accepts a session token, and never touches auth"). The Ed25519 `host_signing_key` machinery is sync/pairing-only and never gates `commitIngest`/`commitPlan`.

The MCP server supplies the two required values the same way the CLI would if it accepted them as flags, not a new mechanism:

- `device_id`: `SELECT id FROM devices LIMIT 1` against the target db, exactly as `scripts/ingestCli.js:112` already does. If no row exists (a fresh db never opened by the real app, or bootstrapped only via a bare `openLocalDb` call with no `bootstrapCamp`), `ingest_commit` returns `{ ok: false, error: 'db has no device registered yet — open it in the app once, or bootstrap it, before committing' }`. The MCP does **not** insert a devices row itself; minting device identity is the app's job, not the MCP's, per the ingestion CLI's own trust model.
- `author_user_id`: passed once at server launch as `--author-user-id <id>` (a CLI arg in the client's stdio launch config, e.g. `"args": ["scripts/mcp/server.js", "--db", "...", "--author-user-id", "..."]`), defaulting to `null` if omitted — identical semantics to `runIngestCli`'s `authorUserId: null` default. No per-call identity is accepted from the MCP client; the process-level launch config is the only place identity is asserted, keeping the trust boundary at "who can edit this client's config file," consistent with the filesystem-is-the-boundary model.

### 4. ABI

The MCP server runs under Node (it is a standalone script, not an Electron process) — same runtime as Vitest and `scripts/ingestCli.js`. It therefore needs the **Node**-built `better-sqlite3` binary, not the Electron-built one. Document in the MCP's own README/comment: run `npm rebuild better-sqlite3` before starting the MCP server if the ABI currently loaded is Electron's (i.e., if `electron:dev` ran most recently). This is the existing `ensure-abi.js`/Commands-section pattern, not a new gotcha — the MCP just becomes a third consumer of the same rebuild step alongside Vitest and the CLI.

### 5. New dependency

`@modelcontextprotocol/sdk` (v1.30.0, MIT, Anthropic/MCP-maintained). **OWNER DECISION 2026-08-21: accepted, installed under `devDependencies` only** — after reviewing that its 17-dep tree (express/hono/jose/cors/pkce-challenge/eventsource/…) exists for HTTP/SSE transport we never use (stdio only). Placing it in `devDependencies` makes it unambiguous that it is not part of the app's production dependency resolution and never ships in `electron-builder`'s `files`. The unused HTTP transitive deps are accepted audit surface in dev tooling only. Maker: `npm install --save-dev @modelcontextprotocol/sdk`.

### 9. `schedule_state` week resolution (correction 2026-08-21, Code Reviewer HIGH)

The original Decision 8 said "filter `schedule_templates` by `kind = route`" — that omitted the **week** dimension. `schedule_templates` resolves by **(week_id, kind)** (`useScheduleData.js` `templateRowFor`); a camp has many `schedule_weeks`, each with its own template per route, so kind-alone returns an arbitrary week. Owner decision (2026-08-21): `schedule_state` takes an **optional `week_id`**. Resolution: if `week_id` given, use (week_id, kind); if omitted and the camp has exactly one `schedule_weeks` row, use it; if omitted and multiple weeks exist, DO NOT guess — return `{ ok: true, weeks: [{id, ...}], needs_week: true }` so the agent picks. Every populated response reports the `week_id` actually resolved. Additionally, expose `schedule_weeks` as a listable entity (friendly name `weeks`) in `ENTITY_MAP`/`list_entities`/`setup_summary` so an agent can enumerate week ids. Tests must include a multi-week camp.

### 8. `schedule_state` computed flags/conflicts (owner decision 2026-08-21)

`schedule_state` does NOT stop at stored templates/slots. Per owner decision, it re-runs the pure schedule engine `buildSchedule(...)` (`src/engine/buildSchedule.js`) and returns its `findings`/`conflicts` alongside the stored slots, so an agent sees unfillable slots and distribution gaps the same way the renderer does. Implication (recorded because it widens the dependency graph): **the MCP now depends on `src/engine/buildSchedule.js`** and on whatever assembles that engine's inputs (`{ groups, tiers, days, timeBlocks, activities, anchors, campId, preplacedSlots }`) from the DB. Maker MUST reuse the renderer's existing input-assembly path (find where the ScheduleScreen/scheduleRepository builds `buildSchedule` inputs) rather than hand-assembling a second time — if no headless assembler exists, extract one as a shared seam (same discipline as `listEntities`), do not duplicate. This keeps determinism identical to the app (same seeded PRNG, same inputs → same findings). `buildSchedule` is pure (no React/IPC), so it is directly callable headlessly.

### 6. Result shape and write-gate enforcement

Read tools return `{ ok: true, entity, rows }` or `{ ok: false, error }`. `ingest_preview`/`ingest_commit` return `runIngestCli`'s existing shape verbatim (`{ ok, action, mode, file, db, error, summary, conflicts, residual, exitCode }`) — no new shape invented, so the tool is a thin adapter over an already-depth-tested interface. Every response is wrapped in the MCP SDK's standard `content: [{ type: 'text', text: JSON.stringify(result) }]` envelope, per MCP protocol convention — the JSON payload inside is what callers reason about.

Write gate: the server reads `--allow-write` once at startup into a module-level `const ALLOW_WRITE = process.argv.includes('--allow-write')`. `ingest_commit`'s handler checks `if (!ALLOW_WRITE) return { ok: false, error: 'commit is disabled — relaunch the server with --allow-write to enable ingest_commit', exitCode: 1 }` as its first statement, before `runIngestCli` is ever called with `action: 'commit'`. `ingest_preview` and all read tools ignore the flag entirely (always available) — read-only is the default, not an opt-in.

### 7. Test seam

`scripts/mcp/server.js` only wires the MCP SDK's stdio transport to handler functions; it contains no logic. The handler functions themselves live in `scripts/mcp/tools.js`, exported as plain functions taking `(args, { dbPath, allowWrite, authorUserId })` and returning the JS result object (pre-JSON-stringify, pre-MCP-envelope). Tests (`scripts/mcp/tools.test.js`) call these directly against a temp db built the same way `test/integration/scenarios/21-ingest-prior-year.js` already does — `openLocalDb(tmpPath)`, manually insert `camps`/`devices`/`users` rows, then call e.g. `ingestCommitTool({ file_path }, { dbPath: tmpPath, allowWrite: true, authorUserId: 'u1' })` — no live MCP client, no stdio, no subprocess. This mirrors `runIngestCli`'s own test seam exactly (`scripts/ingestCli.test.js`).

## Non-goals

- **Networked transport.** stdio only. A future director-facing MCP over the LAN (with the app's existing token/ACL model) is a distinct follow-up, not built here.
- **Token/ACL auth for the MCP itself.** The trust boundary is the filesystem (who can point `--db` at a real db) and the launch config (`--allow-write`, `--author-user-id`), not a session token — matching the CLI's existing stated trust model.
- **Electron-sidecar packaging.** `scripts/mcp/` depends only on `electron/ops/*` and `electron/db/localDb.js` (both already Electron-free — they're plain Node/better-sqlite3 modules imported by Electron, not vice versa) and `src/ingest/*`, so a later Electron-sidecar repackaging is a wrapper around this same core, not a rewrite. Not built now.
- **Any setup-mutation tool beyond ingestion.** No `create_activity`, no `update_group`, no schedule-slot writes. The only write path exposed is `ingest_commit`, gated as above. Owner explicitly rejected full-write scope in the brainstorm.

## Files/modules affected

- New: `scripts/mcp/server.js` — stdio transport wiring, argv parsing (`--db`, `--allow-write`, `--author-user-id`), no logic.
- New: `scripts/mcp/tools.js` — pure, directly-testable tool handlers (`ingestPreviewTool`, `ingestCommitTool`, `listEntitiesTool`, `setupSummaryTool`, `scheduleStateTool`), plus the friendly→DB entity name map.
- New: `scripts/mcp/tools.test.js`.
- New: `electron/ops/read.js` — `listEntities(db, entity)`, extracted verbatim from `electron/main.js`'s `list()`.
- Changed: `electron/main.js` — `list(token, entity)` keeps its auth check, delegates the query to `listEntities(db, entity)`.
- Changed: `package.json` — add `@modelcontextprotocol/sdk`.
- New: `docs/work/specs/2026-08-21-mcp-server-tool-schemas.md` — full JSON schemas for each tool (Maker-facing detail; kept out of this ADR to keep the decision record short-lived-readable).

## Reused vs. new

Reused, unchanged: `runIngestCli` (`scripts/ingestCli.js:76`), `commitIngest`/`commitPlan` (`electron/ops/ingest.js`), `openLocalDb` (`electron/db/localDb.js`), `DIRECT_CAMP_ENTITIES`/`PARENT_SCOPED_ENTITIES` (`electron/ops/campScopedEntities.js`), the devices-row/author-id identity model the CLI already established.

New: `electron/ops/read.js` (a genuine extraction — `list()`'s SQL previously had no seam a non-IPC caller could reach), the friendly-entity-name mapping (MCP presentation concern, doesn't belong in the DB-facing module), and the stdio tool-handler layer itself.

## ADR required: yes

This introduces a new integration surface (a second class of consumer reading and writing this app's DB, alongside the renderer/IPC and the sync protocol), a new shared module boundary (`electron/ops/read.js`) that `electron/main.js` now depends on, and a documented, non-obvious trust-model trade-off (stdio + filesystem-as-boundary + no per-call auth, deliberately not the app's existing token model). Reversing "no auth on MCP reads/writes" after external tooling exists against these tool names would be a breaking change to that tooling, not a local refactor — this is exactly the kind of decision the ADR bar exists to pin down before Maker builds it.

## Open questions — RESOLVED by owner (2026-08-21)

1. `schedule_state` scope → **compute flags/conflicts** (re-run `buildSchedule`). See Decision 8.
2. `@modelcontextprotocol/sdk` → **accepted, devDependencies only.** See Decision 5.
3. Spec granularity → **one spec file per MCP surface** confirmed (Governor's call).

## Original open questions (for the record)

1. **`schedule_state`'s scope.** This ADR limits it to `schedule_templates` + slots/overlays for one route, read-only — confirm that's the intended read surface, versus also wanting flags/conflicts (`buildSchedule`'s `findings`) surfaced. Those aren't stored, they're computed at render time in the renderer — exposing them headlessly would mean either re-running `buildSchedule` inside the MCP (new logic dependency) or leaving them out. Recommend leaving them out for v1; flagging as a product-scope call, not a technical one.
2. **`@modelcontextprotocol/sdk` acceptance.** Recommend accepting (see decision 5) — needs the owner's nod per the standing "explain tradeoffs, recommend one, don't make me choose blind" workflow default, even though it's Governor's call to fold into the Maker brief.
3. **Where `docs/work/specs/2026-08-21-mcp-ingestion-server.md`'s JSON Schema detail should live relative to future MCP additions** — this ADR assumes one spec file per MCP surface addition (matching this project's existing spec-per-feature convention); confirm that's still the right granularity now that this is the first MCP surface in the repo.
