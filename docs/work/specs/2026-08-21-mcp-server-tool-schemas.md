---
title: W10 — MCP ingestion + read server (tool schemas)
document_type: spec
status: approved
created: 2026-08-21
archive_when: the MCP ingestion server is implemented and merged, or superseded by an approved revision
governing_docs: [docs/adr/2026-08-21-mcp-ingestion-server.md]
parent_spec: [docs/work/specs/camp-setup-ingestion-program.md]
---

# W10: MCP ingestion + read server — tool schemas

Companion to `docs/adr/2026-08-21-mcp-ingestion-server.md`. That ADR makes the
decisions; this file is the Maker-facing JSON Schema detail so the ADR itself
stays short.

## Server launch

```
node scripts/mcp/server.js --db /path/to/shoresh.sqlite [--allow-write] [--author-user-id <uuid>]
```

- `--db` (required): path to a SQLite file already bootstrapped by the app
  (has a `camps` row and a `devices` row). The server does not create or
  bootstrap a camp.
- `--allow-write` (optional, default off): enables `ingest_commit`. Without
  it, `ingest_commit` returns an error without touching the DB.
- `--author-user-id` (optional, default `null`): passed through to every
  `ingest_commit` call as `authorUserId`. Not accepted per-call from the
  client — process-launch-time only.

## Entity name mapping

```js
const ENTITY_MAP = {
  age_divisions: 'tiers',
  programs: 'cohorts',
  groups: 'groups',
  locations: 'locations',
  activities: 'activities',
  days_of_operation: 'days_of_operation',
  time_blocks: 'time_blocks',
  weeks: 'schedule_weeks',
}
```

Unknown friendly names return `{ ok: false, error: 'unknown entity: <name>' }`
before reaching `listEntities`.

## Tools

### `ingest_preview`

```json
{
  "name": "ingest_preview",
  "description": "Preview what importing a schedule file (Excel or text grid) would create or change in this camp's setup — Age Divisions, Programs, Groups, Locations, Activities, Days, Time Blocks. Makes no changes.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "file_path": { "type": "string", "description": "Absolute path to the file to import." },
      "mode": { "type": "string", "enum": ["add", "replace"], "default": "add" }
    },
    "required": ["file_path"]
  }
}
```
Handler: `runIngestCli({ file: file_path, dbPath, mode, action: 'preview' })`, return verbatim.

### `ingest_commit`

```json
{
  "name": "ingest_commit",
  "description": "Commit a schedule-file import into this camp's setup. Requires the server to have been launched with --allow-write; otherwise refuses.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "file_path": { "type": "string" },
      "mode": { "type": "string", "enum": ["add", "replace"], "default": "add" }
    },
    "required": ["file_path"]
  }
}
```
Handler:
```js
if (!allowWrite) return { ok: false, error: 'commit is disabled — relaunch the server with --allow-write to enable ingest_commit', exitCode: 1 }
return runIngestCli({ file: file_path, dbPath, mode, action: 'commit', authorUserId })
```

### `list_entities`

```json
{
  "name": "list_entities",
  "description": "List the rows of one setup entity for this camp: Age Divisions, Programs, Groups, Locations, Activities, Days of Operation, Time Blocks, or Weeks.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "entity": {
        "type": "string",
        "enum": ["age_divisions", "programs", "groups", "locations", "activities", "days_of_operation", "time_blocks", "weeks"]
      }
    },
    "required": ["entity"]
  }
}
```
Handler: map `entity` via `ENTITY_MAP`, then `{ ok: true, entity, rows: listEntities(db, dbEntity) }`.

### `setup_summary`

```json
{
  "name": "setup_summary",
  "description": "Row counts for every setup entity in this camp — a quick health check of what's been ingested so far.",
  "inputSchema": { "type": "object", "properties": {} }
}
```
Handler: for each key in `ENTITY_MAP`, `count = listEntities(db, dbEntity).length`; return `{ ok: true, counts: { age_divisions: n, ... } }`.

### `schedule_state`

```json
{
  "name": "schedule_state",
  "description": "Read one candidate schedule (Manual or Generated route) for one week of this camp: its template, placed slots/overlays, and computed findings/conflicts (re-runs the schedule engine over the stored placement — ADR Decision 8). A camp can have several weeks, each with its own template per route — pass week_id to pick one; if omitted and the camp has more than one week, this tool returns needs_week: true plus the list of weeks instead of guessing (ADR Decision 9).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "route": { "type": "string", "enum": ["manual", "generated"] },
      "week_id": { "type": "string", "description": "Optional. Required only when the camp has more than one week." }
    },
    "required": ["route"]
  }
}
```
`schedule_templates` resolves by **(week_id, kind)**, not `kind` alone — a camp
can have many `schedule_weeks` rows, each with its own template per route
(ADR Decision 9, correcting the original Decision 8 text). Handler week
resolution, mirroring `useScheduleData.js`'s `templateRowFor`:
- If `week_id` is given: resolve `schedule_templates` by `(week_id, kind === route)`.
- If `week_id` is omitted and the camp has exactly one `schedule_weeks` row: use that week.
- If `week_id` is omitted and multiple weeks exist: do not guess — return
  `{ ok: true, route, needs_week: true, weeks }` (the `schedule_weeks` rows,
  also listable via `list_entities` with `entity: 'weeks'`) so the caller can
  choose.

Once a week is resolved: `listEntities(db, 'template_slots')` and
`listEntities(db, 'template_overlays')` filtered to that template id. Per ADR
Decision 8, also assembles `buildSchedule`'s legacy-signature inputs from
this camp's setup rows (`electron/ops/scheduleEngineInputs.js`, a headless
extraction of the filter/sort/parse logic in `useScheduleData.js`'s
`load()`), passes every already-placed, non-anchor slot of the resolved
week's template in as `preplacedSlots` (so nothing already stored is moved),
and re-runs `buildSchedule(...)` to get fresh `findings`/`conflicts`.

Return shape, every populated response reports the resolved `week_id`:
`{ ok: true, route, week_id, template, slots, overlays, findings, conflicts }`,
or `{ ok: true, route, week_id, template: null, slots: [], overlays: [], findings: [], conflicts: [] }`
if that route has never been built for the resolved week, or
`{ ok: true, route, needs_week: true, weeks }` if `week_id` was omitted and
ambiguous.

## Result envelope

Every tool's raw JS return value is wrapped by `scripts/mcp/server.js` as:
```js
{ content: [{ type: 'text', text: JSON.stringify(result) }] }
```
per MCP SDK convention. `scripts/mcp/tools.js`'s exported functions return the
unwrapped `result` object directly — that's the test seam.

## Test seam

```js
import { ingestCommitTool } from './tools.js'
import { openLocalDb } from '../../electron/db/localDb.js'

const db = openLocalDb(tmpPath)
db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('c1', 'Test Camp')
db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'Host')
db.close()

const result = ingestCommitTool(
  { file_path: fixturePath, mode: 'add' },
  { dbPath: tmpPath, allowWrite: true, authorUserId: 'u1' }
)
expect(result.ok).toBe(true)
```
No stdio, no MCP client, no subprocess — same pattern as `scripts/ingestCli.test.js` and `test/integration/scenarios/21-ingest-prior-year.js`.
