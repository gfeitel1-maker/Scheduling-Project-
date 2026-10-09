# Shoresh MCP server

A headless [MCP](https://modelcontextprotocol.io) server exposing Shoresh's ingestion +
read surface over stdio, so an MCP client (Claude Desktop / Claude Code) can drive a camp
database directly — no Electron, no renderer, no network port. Design: ADR
[`docs/adr/2026-08-21-mcp-ingestion-server.md`](../../docs/adr/2026-08-21-mcp-ingestion-server.md)
(W10). Plan: [`docs/work/plans/2026-09-01-machine-access.md`](../../docs/work/plans/2026-09-01-machine-access.md).

It talks to **one SQLite db file** (`--db`) — the same single-camp-per-file model the app
uses. It is **read-only by default**; every write verb refuses unless the server was
launched with `--allow-write`.

## Launch

```bash
npm run mcp -- --db /absolute/path/to/camp.sqlite
```

Options:

- `--db <path>` — **required**. Absolute path to the camp's SQLite file.
- `--allow-write` — enable the write verbs (`ingest_commit`, `preference_sheet_commit`,
  the projection-repair tools). Omit for a strictly read-only session.
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
| `preference_sheet_preview` | no | Dry-run a camper elective **preference sheet** (Excel/CSV) — the campers on it, the distinct elective choices they named, their ranked preferences, plus which columns were read as what, and why a commit would be refused. |
| `preference_sheet_commit` | **yes** (`--allow-write`) | Commit a preference sheet as one draft run. Refuses the whole sheet when two rows name the same camper with no camper id, or a camper holds a rank twice. |
| `list_unattributed_subjects` | no | List imported sheets whose camper isn't identified yet — the same "Needs your attention" list the director sees, with each entry's `subject_id` for `attribute_camper_subject`. |
| `attribute_camper_subject` | **yes** (`--allow-write`) | Name the camper behind an unattributed sheet, so its choices land on that camper's real identity and a later import of the same name converges onto it instead of forking a duplicate. |
| `camper_preferences` | no | One camper's elective choices, or every camper's — each row carries `edited_by_hand`, whether a person corrected it by hand rather than the imported sheet. |
| `set_camper_preference` | **yes** (`--allow-write`) | State or correct one camper's preference for one period without re-importing a file. Re-solve the run afterwards for the change to reach placements. |
| `remove_camper_preference` | **yes** (`--allow-write`) | Withdraw one preference a camper no longer wants, recorded as a person's decision so re-importing the same sheet won't put it back. |
| `list_entities` | no | Rows of one setup entity (Age Divisions, Programs, Groups, Locations, Activities, Days, Time Blocks, Weeks). |
| `setup_summary` | no | Row counts across every setup entity — a quick health check. |
| `schedule_state` | no | Read **and validate** one candidate schedule (Manual/Generated) for one week: template, placed slots, and **engine-computed findings/conflicts** (re-runs the pure engine over the stored placement, moving nothing). |
| `export_schedule` | no | One candidate schedule as a stable, versioned JSON document (`format_version` 2; a day replaced by a special day carries a `replaced` record) — the portable "move it anywhere" format: camp/week/route, the group/day/time-block axes, and one record per occupied cell. |
| `check_projection_health` | no | List this device's unresolved projection failures — an op-log write that logged durably but whose effect never materialized into a local table. Support/debugging use. |
| `repair_projection_entity` | **yes** (`--allow-write`) | Re-derive one entity's row from its full op-log history, clearing an unresolved projection failure once the blocking condition is gone. Support/debugging use. |
| `rebuild_projection_from_document` | **yes** (`--allow-write`) | Delete this device's SQLite projection and rebuild it from the synced Automerge document — the recovery procedure for a corrupted or suspect local database. Takes a pre-rebuild backup first. |
| `get_elective_assignment_run` | no | One elective assignment run by `run_id` — its identity, the placements (camper, occurrence, activity, rank, lock state), the run's occurrences, choices and stored preferences, and the run's findings: stale-generation count and over-capacity occurrences. |
| `export_elective_assignments` | no | That same run as a stable, versioned JSON document — child schedules, activity rosters, exceptions and summary. Built from the one shared assembly the app's own export uses, so the machine surface and the screen cannot disagree (T198). |

### Elective runs — and what is *not* here

`get_elective_assignment_run` and `export_elective_assignments` are read-only and take a
`run_id`. There is **no `generate` verb**: nothing here solves a run. That is a deliberate
gap, not an oversight — see the Known limits section of
[`docs/work/tickets/T198-machine-access-adapters.md`](../../docs/work/tickets/T198-machine-access-adapters.md).
Campers and elective entities are also deliberately absent from `list_entities` — the
participant domain is reachable only through purpose-built tools (`camper_preferences`,
`set_camper_preference`, `remove_camper_preference`, `list_unattributed_subjects`,
`attribute_camper_subject`, `get_elective_assignment_run`, `export_elective_assignments`),
never as a generic entity dump (guarded by `scripts/mcp/entityMapExclusion.test.js`).

### Validating a schedule

There is no separate "validate" tool — **`schedule_state` is the validate verb.** It re-runs
the same pure engine the Schedule screen uses, over the stored placement, and returns the
identical `findings`/`conflicts`. A schedule with an empty `findings` and `conflicts` array
is clean; entries describe exactly what the app would flag.

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
