---
title: T51-mcp-cli-ingestion
document_type: ticket
status: in-progress
created: 2026-08-05
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs: []
archive_when: superseded by an approved specification
---

# T51 — MCP server and CLI for ingestion

**Status: open.** Parked until the ingestion work (T49) is declared production-ready. Recorded
so it is not lost. **Not a design — no approach chosen.**

---

## What it is

The current ingestion path is: drop a file into `.ingest-incoming/`, open the app, use the
ImportScreen UI, preview, commit. That path works for a director using the desktop app.

Two alternative entry points would serve different users and workflows:

### CLI

A command-line tool that accepts a file path and camp ID, runs the importer headlessly, and
either prints a preview or commits directly with a flag. Primary value:

- **Testing and development** — running ingestion without launching Electron or the full app.
  The ingest logic is pure enough (`src/ingest/`) that a CLI wrapper is thin.
- **Bulk or scripted imports** — a camp admin who manages multiple devices or years could
  trigger an import from a script rather than a GUI interaction.
- **Debugging** — surfacing the residual report (T36) in a terminal is easier than reading it
  in a modal.

### MCP server

An MCP server exposes the ingestion pipeline as a tool that an AI agent (Claude Code or
another model) can call. Primary value:

- **AI-assisted import** — an agent reads the file, calls the MCP tool, inspects the residual
  report, proposes how to resolve unmatched cells, and can iterate without human intervention.
- **Reduced director time-to-schedule** — instead of a director manually configuring 40 activities
  after import (T35), an agent that understands camp scheduling can propose sensible defaults and
  present them for approval.

---

## Open questions

- **Scope of the MCP surface.** Just ingestion, or also read access (list activities, list groups,
  get schedule state)? A narrow surface ships sooner; a broader one enables richer agent-assisted
  workflows.
- **Auth model.** The desktop app's auth is PIN + local token. An MCP server running as a
  sidecar or external process needs a different trust model — API key, socket with filesystem ACL,
  or something else.
- **Where does it run?** A sidecar launched by Electron, a standalone daemon, or a separate
  package? The local-first model means no cloud; the MCP server must run on the same machine as
  the database.
- **CLI packaging.** Same binary as Electron, separate npm package, or a shell script wrapping
  the existing JS? The `better-sqlite3` ABI constraint (native module, must match runtime) affects
  this: a CLI under Node has a different rebuild requirement than Electron.

---

## Relationship to T49

Do not design or implement this until T49 is closed. An MCP tool that wraps a broken ingestion
pipeline just automates the broken parts. Fix the pipeline first.

---

## Next step when picked up

Brainstorm on the open questions above. The CLI and MCP surfaces may be separate tickets once
the scope is settled.

## Progress (2026-08-20) — CLI SHIPPED; MCP server is the remaining scope

Owner (2026-08-20): CLI first (all three use cases), MCP as its own remaining scope here. **CLI shipped**:
`scripts/ingest.js` (thin arg-parser) over `scripts/ingestCli.js` `runIngestCli` — reuses the pure
headless core (buildPlan + commitIngest, like integration scenario 21), `--preview`/`--commit`/`--mode`/
`--author`/`--json`, T36 residuals in the terminal, exit-code discipline, direct-db-file trust model.
Design: `docs/work/specs/2026-08-20-ingestion-cli-design.md`. Reviews: Security 5/5, Code Reviewer
merge-ready. **Remaining (this ticket stays open/in-progress): the MCP server** — can wrap the CLI's
`--json` / the `runIngestCli` core; needs the auth-model + where-it-runs decisions from the ticket's
Open Questions. Follow-up worth filing if bulk/scripted use needs multi-Program targeting: a `--cohort` flag.
