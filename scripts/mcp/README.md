# Shoresh MCP server

A headless [MCP](https://modelcontextprotocol.io) server exposing Shoresh's ingestion +
read surface over stdio, so an MCP client (Claude Desktop / Claude Code) can drive a camp
database directly — no Electron, no renderer, no network port. Design: ADR
[`docs/adr/2026-08-21-mcp-ingestion-server.md`](../../docs/adr/2026-08-21-mcp-ingestion-server.md)
(W10). Plan: [`docs/work/plans/2026-09-01-machine-access.md`](../../docs/work/plans/2026-09-01-machine-access.md).

It talks to **one SQLite db file** (`--db`) — the same single-camp-per-file model the app
uses. It is **read-only by default**; the one write verb (`ingest_commit`) refuses unless
the server was launched with `--allow-write`.

## Launch

```bash
npm run mcp -- --db /absolute/path/to/camp.sqlite
```

Options:

- `--db <path>` — **required**. Absolute path to the camp's SQLite file.
- `--allow-write` — enable `ingest_commit`. Omit for a strictly read-only session.
- `--author-user-id <uuid>` — provenance stamp for committed ops (write sessions only).

`npm run mcp` runs a `premcp` step (`ensure-abi.js node`) first, so the native
`better-sqlite3` binary is built for **Node** before launch.

### ABI note

This runs under Node, not Electron. `better-sqlite3` is a native module and its binary must
match the runtime. If `electron:dev` ran most recently, rebuild for Node first:

```bash
npm rebuild better-sqlite3
```

(The `premcp` hook does this check for you; the manual command is the fix if it reports a
mismatch. Running `electron:dev` again later will need `electron-rebuild` — see the repo
`CLAUDE.md` ABI note.)

### Which db file?

The app stores its db under a per-build user-data directory (`electron/db/userDataPath.js`):
dev uses `~/Library/Application Support/shoresh-dev`, the packaged app uses
`~/Library/Application Support/shoresh`. A camp exported/opened as a standalone project is
whatever `.shoresh` path was chosen. Point `--db` at the exact file you want to inspect.

## Tools

| Tool | Write? | Purpose |
|---|---|---|
| `ingest_preview` | no | Dry-run an Excel/text-grid import — what it *would* create/change. |
| `ingest_commit` | **yes** (`--allow-write`) | Commit an import into the camp's setup. |
| `list_entities` | no | Rows of one setup entity (Age Divisions, Programs, Groups, Locations, Activities, Days, Time Blocks, Weeks). |
| `setup_summary` | no | Row counts across every setup entity — a quick health check. |
| `schedule_state` | no | One candidate schedule (Manual/Generated) for one week: template, placed slots, and **engine-computed findings/conflicts** (re-runs the pure engine over the stored placement, moving nothing). |

Tool descriptions use canonical vocabulary (Age Division, Program, Location, Group) — never
internal table names. Multi-week camps: `schedule_state` returns `needs_week: true` + the
week list when `week_id` is omitted and more than one week exists.

## Connecting a Claude client

The server is **client-launched over stdio** — the client spawns it; there is no long-running
daemon and no port. Add an entry like this to your MCP client config (exact file and paths
filled in per machine):

```json
{
  "mcpServers": {
    "shoresh": {
      "command": "npm",
      "args": [
        "--prefix", "/absolute/path/to/shoresh",
        "run", "mcp", "--",
        "--db", "/absolute/path/to/camp.sqlite"
      ]
    }
  }
}
```

For a read-only session omit `--allow-write` (as above). To allow committed imports, append
`"--allow-write"` (and optionally `"--author-user-id", "<uuid>"`) to `args`.
