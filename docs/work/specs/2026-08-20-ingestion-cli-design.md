---
title: 2026-08-20-ingestion-cli-design
document_type: spec
status: active
created: 2026-08-20
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, SECURITY.md]
archive_when: the ingestion CLI is implemented and merged, or superseded by an approved revision
related_tickets: [docs/work/tickets/T51-mcp-cli-ingestion.md]
---

# Ingestion CLI — design (T51, CLI surface)

## Context and owner decisions (2026-08-20 brainstorm)

T51 is two separable surfaces — a CLI and an MCP server — for the ingestion pipeline. Owner decisions:

- **CLI first.** Build the command-line surface first. The **MCP server stays its own future ticket**
  and can later wrap the same headless core the CLI exercises.
- **Serves all three use cases:** testing/dev/debug (run ingestion without launching Electron;
  surface the T36 residual report in a terminal), bulk/scripted imports, and — via `--json` — a
  machine-readable surface a future MCP/agent can build on.
- **Direct-db-file trust model** (see Security below).

T49 (finish ingestion) is effectively production-ready (T33/T34/T35 shipped; the T36 residual report
shipped), so the CLI wraps a working pipeline, not a broken one (the ticket's own precondition).

## What already exists (the CLI is pure harness — no logic fork)

Ingestion already runs headlessly under Node — integration scenario 21 (`21-ingest-prior-year.js`)
drives it directly, and the CLI reuses the identical entry points:

- **Parse:** `src/ingest/*` (the pure parser: `sheetGrid`/`textGrid`/`extractEntities` → a source model).
- **Plan:** `src/ingest/buildPlan.js` `buildPlan(source, existing, resolutions)`.
- **Commit:** `electron/ops/ingest.js` `commitIngest(db, {...})` / `commitPlan(db, plan, {...})` — the
  same host-only commit path the app's IPC handler calls.
- **DB:** `electron/db/localDb.js` `openLocalDb(path)` opens a SQLite db file directly.
- **Residuals:** the T36 residual report (`workbookToPages().residual`, `extractEntities().residual`).

The CLI adds **only** the harness: argument parsing, file reading, opening the target db, orchestrating
parse → report → (preview | commit), and terminal/JSON output. No ingestion logic is duplicated or
forked — a behavior change to ingestion is picked up by the CLI for free.

## Form and interface

A Node script at `scripts/ingest.js`, run under Node (with `better-sqlite3` built for Node — the same
ABI the test suite uses; documented in the script's header, consistent with the repo's ABI note). Not
a separate npm package or distributable binary in this slice (that's a packaging follow-on if ever
wanted).

```
node scripts/ingest.js <file> --db <path> [--preview | --commit] [--mode add|replace] [--author <userId>] [--json]
```

- `<file>` — the workbook/CSV/text schedule to ingest.
- `--db <path>` — the target SQLite db file (required; the CLI operates on a file directly).
- `--preview` (**default**) — parse the file, build the plan against the db's existing snapshot, and
  print: the reconciliation summary (created/updated/unchanged/conflicts counts) **and the T36
  residual report** ("N sheets/cells not recognised — here's what they contained"). **No writes.**
- `--commit` — run the host-only ingest commit against the db (`commitIngest`), then print the outcome
  (counts, any conflicts held). Exits non-zero if the commit fails.
- `--mode add|replace` (default `add`) — the existing ingest mode; `replace` triggers the same
  atomic teardown the app's Replace path uses (host-only, transactional).
- `--json` — emit the report/outcome as machine-readable JSON instead of human text (for scripts and a
  future MCP wrapper). Mutually informative with `--preview`/`--commit`.
- `--author <userId>` — attribute the committed ops to this user (so History/Trash can name who imported).
  Optional; a session-less CLI has no logged-in user, so it defaults to `null` (unattributed).

Exit codes: 0 on success (preview or commit), non-zero on a parse error, a missing/invalid db, or a
commit failure — so scripts can gate on it (the *gate-exit-code* discipline).

## Trust model (Security-relevant decision)

The CLI operates **directly on a SQLite db file** — whoever can run the script and read/write the db
file is trusted. It **bypasses the app's PIN/token auth by design**: it is not a networked surface and
it is not the app; it is a local operator acting as the single writer (the host). This mirrors how the
integration tests and any SQLite tool touch the db, and it matches the ingest pipeline's existing
**host-only** constraint (the CLI *is* a host operating on a host db file; there is no client mode).
The CLI must NOT:
- open a network socket, accept remote input, or expose the db to another process;
- mint or accept session tokens (there is no session — filesystem access is the boundary);
- be pointed at a db it doesn't have filesystem rights to (the OS enforces that).

Security should confirm this framing. The important invariant: the CLI adds **no new remote/network
attack surface** and reuses the same host-only commit path; it does not weaken the app's auth because
it is a separate, local, filesystem-trust-boundaried tool.

## Non-goals

- **The MCP server** — its own future ticket; it can wrap `--json` / the headless core.
- **A distributable binary / npm package / global install** — this slice is a repo script run via
  `node`. Packaging is a separate concern if a non-developer ever needs it.
- **Any change to the ingestion logic itself** — the CLI is harness-only; parser residuals (T36
  F1/F2/F3) stay deferred.
- **Auth/PIN for the CLI** — deliberately out (filesystem is the boundary).
- **S4b re-import staleness protection** — the CLI uses the fresh-import path (`workbookToPages`/`extractEntities`, like scenario 21), NOT the S4b `workbookToSource` `base_generation` staleness gate the reconciliation re-import path uses. Do not point the CLI (or a future MCP wrapper) at an S4b-exported enrichment workbook expecting that protection.

## Testing seams

- A test that runs the CLI's core against a **temp db** (mirroring scenario 21's setup): `--preview`
  on a fixture file prints the expected counts + residuals and writes nothing (assert the db is
  unchanged); `--commit` writes the expected rows (assert via a read-back).
- `--json` output shape is asserted (stable keys a script/MCP can rely on).
- Exit-code behavior: non-zero on a bad file / missing db / commit failure.
- The harness should be factored so its core (parse→plan→report→commit orchestration) is unit-testable
  without spawning a subprocess (a pure function the thin `scripts/ingest.js` arg-parser calls), so the
  tests exercise real logic, not a shelled-out process.

## Implementation note (governance)

Touches the host-only ingest commit path (reuse, not change) and introduces a new operator surface, so
the loop includes **Security** (confirm the direct-db-file trust model adds no remote surface and
doesn't weaken app auth) alongside **Maker (test-first) → Code Reviewer → Verifier → Grader**. No
schema change, no sync change — so Red Hat is not required unless the review surfaces a data-shape
concern.
