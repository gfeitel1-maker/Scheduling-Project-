---
title: T198-machine-access-adapters
document_type: ticket
status: open
created: 2026-09-17
archive_when: CLI and MCP adapters ship and agree with the UI
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_specs: [docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md]
---

# T198 — Slice 6: CLI and MCP adapters

Thin adapters over the shared application service. The service owns validation, preview, commit,
solving and export. **Blocked on T197.**

## Surfaces

CLI: `electives preview --file --week --route --tier` (read-only, returns mapping needs and a
normalized preview) · `electives commit --run --mapping` (mutating, op-log, author identity) ·
`electives generate --run` (mutating) · `electives export --run --format json|xlsx` (read-only).

MCP: `preview_elective_preferences` (read-only) · `commit_elective_preferences` and
`generate_elective_assignments` (require `--allow-write` and `author_user_id`, structured errors) ·
`get_elective_assignment_run` and `export_elective_assignments` (read-only, versioned).

## Not on generic surfaces

`scripts/mcp/tools.js:31-40` `ENTITY_MAP` is currently clean of camper and elective entities and
**stays that way**. Purpose-built, camp-scoped tools returning only the fields the workflow needs —
never a generic entity dump of minors' records. Add a check that fails if a camper entity ever
appears in `ENTITY_MAP`, rather than relying on a reviewer remembering.

A model may help a director describe column mappings. It must never invent an identity, a choice,
or a capacity, and no business rule or solver constant is reachable through MCP.

## Exit condition

MCP, CLI and UI return equivalent run identity, assignments and findings for the same run.
Mutations are gated and attributed. Validation errors are structured, not prose. `schedule_state`
is overlay-aware (T193).
