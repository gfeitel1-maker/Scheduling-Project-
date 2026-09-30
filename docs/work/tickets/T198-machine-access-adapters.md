---
title: T198-machine-access-adapters
document_type: ticket
status: completed
created: 2026-09-17
archive_when: CLI and MCP adapters ship and agree with the UI
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_specs: [docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md]
resolved_by: [8f6047cc]
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

## Closed (2026-09-30)

Adapters ship over **one** shared application service. The read logic that lived as a closure
inside `electron/main.js` is now `electron/ops/getElectiveRun.js` and
`electron/ops/getElectiveRunOuterSchedule.js`, moved verbatim — same SQL, same shared
generation predicate (ADR 2026-09-23 decision (a)), same returned shape — and the IPC handlers
shrink to validate → `requireAuthorized` → forward. No IPC channel, argument or return shape
changed; no stored schema changed. `electron/ops/electiveRunProjectionInput.js` is the single
assembly of the export document's input, and every machine surface funnels through it, so the
third assembly site that ADR 2026-09-23's MEDIUM-4 finding warned about does not exist.

**What ships.** MCP gains `get_elective_assignment_run` and `export_elective_assignments`
(`scripts/mcp/tools.js`, registered in `scripts/mcp/server.js`) — both read-only, camp-scoped,
purpose-built, returning only the workflow's fields. CLI gains `scripts/electivesCli.js` (core)
and `scripts/electives.js` (argv wrapper, the pattern of `scripts/ingestCli.js` +
`scripts/ingest.js`), with `preview` and `commit` a literal passthrough to
`runPreferenceSheetCli` — no second implementation — and `export --run --format json|xlsx`.
The xlsx path routes through `src/utils/exportSanitize.js`, now asserted through the CLI
itself rather than assumed.

**`ENTITY_MAP` stays clean, and it was already guarded.** The ticket asked for a check that
fails if a camper entity ever appears there; `scripts/mcp/entityMapExclusion.test.js` (T194)
already is that check, asserting by key, by resolved value, by name pattern against
`PARTICIPANT_ENTITIES`, with a positive control. It was confirmed rather than duplicated.
`schedule_state` was already overlay-aware (T193) — confirmed in `scripts/mcp/tools.js`, not
changed.

**The exit condition, and what proves it.** `electron/electiveAcceptanceSurfaces.integration.test.jsx`
previously pinned the ABSENCE of any elective-run read path on MCP/CLI, as T251's GAP-5. That
test is grown, not deleted: it now pins the new tool list and asserts a three-way deep-equal
between the MCP export, the CLI export, and the projection built from the real handlers — the
UI-equivalent read — with only `generated_at` excluded, recursively, because it is a fresh
wall-clock stamp on each call. `electron/electiveRunFinalizedProjectionParity.integration.test.jsx`
asserts the same equality for a **finalized** run, which is the state a real export is taken in
and the only state in which `getElectiveRunOuterSchedule` reads the immutable
`elective_run_outer_snapshots` rows; it also renames the underlying activity after finalization
and asserts all three surfaces still report the pre-rename name, which is the property T248's
snapshot exists to provide. Both assertions were observed RED under a planted divergence before
being accepted as green.

## Known limits

- **`generate` is an asserted gap, not a delivered surface.** `generate_elective_assignments`
  and `electives generate` are not built and are registered nowhere — not as a refusing verb,
  not in the CLI usage string. The reason is structural: no production module composes solver
  inputs from a database. That composition exists only inside `solve()` in
  `src/screens/elective/assignment/AssignmentPanel.jsx`, which is why the T251 suite drives a
  rendered React component to reach a solve at all (see the header of
  `electron/electiveAcceptancePanelDrive.jsx`). Building the verb today would mean either
  duplicating that composition — the exact drift this ticket exists to close — or spawning a
  renderer from a CLI process. Neither is a thin adapter over a shared service, because the
  service does not exist yet. Extracting it is its own architecturally significant piece of
  work and is not folded in here under scope pressure.
- **The UI's own export still assembles its input separately.**
  `src/screens/elective/run/FinalRunView.jsx`'s `exportFullReport()` passes
  `occurrences: templateOccurrences` (a screen prop derived from schedule-template slots) where
  the shared assembly passes the run's own `elective_occurrences` rows. This divergence
  pre-dates T198 and was deliberately not fixed — changing it is a UI-screen change this
  ticket's Surfaces section does not list. The parity assertion therefore proves MCP, CLI and
  the UI-equivalent **handler read** agree; it does not prove `FinalRunView`'s locally
  assembled input is identical.
