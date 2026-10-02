---
task: v73 rebuild carries forward later-added columns on rollback-reopen (board i-v73-rebuild-drops-later-columns-on-rollback-reopen)
document_type: run
date: 2026-10-01
round: 2
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: []
related_specs: []
related_adrs: [docs/adr/2026-10-01-rebuild-migrations-carry-forward-later-columns.md]
selected_agents: [governor, architect, maker, verifier, red-hat, code-reviewer, grader]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: no UI surface — a SQLite migration/rollback rebuild mechanism.
  - agent: tester
    reason: not-applicable
    note: no render cycle or user-facing behavior change; reachable only via a rollback.
  - agent: security
    reason: not-applicable
    note: no auth/secret/IPC/network/packaging surface; internal helper + schema migration. SQL identifier quoting reviewed by Code Reviewer/Red Hat.
deterministic_checks: [electron/db/rebuildTableCarryingColumns.test.js, electron/db/rollback/v72_down.test.js, electron/db/rollback/v73_down.test.js, electron/db/electiveRunOuterCellKind.migration.test.js, electron/db/migrationWriteTrace.test.js, schema-family vitest, npm run check:governance, npm run lint]
human_gates: []
archive_when: superseded when the same enumerated-column-list class is swept from v51_down.js/v64_down.js/v77_down.js onto rebuildTableCarryingColumns and no hardcoded-list rebuild remains
---

# Run record — v73 rebuild carries forward later-added columns

- **Board item:** `i-v73-rebuild-drops-later-columns-on-rollback-reopen`
- **Branch:** `claude/board-v73-rebuild-preserves-later-columns` (off `main`, base #717 `dadb5e71`)
- **Schema change:** none — fixes an existing migration's rebuild; CURRENT_SCHEMA_VERSION stays 86.

## What landed
`electron/db/rebuildTableCarryingColumns.js`: a shared helper that rebuilds a table from live
`PRAGMA table_info` (the columns that actually exist) with a superset backstop, so the v73 nine-table
rebuild — forward block in `localDb.js` and `v73_down.js` — no longer drops a column a LATER migration
added (v75 `activities.catalog_role`, v76 `cell_kind`). A db rolled back into v73's guard window and
reopened keeps those columns AND their data. A per-column shape guard (type/notnull/default) refuses a
corrupting carry-forward. FK pragma OFF/ON recipe and index recreation preserved.

## Evidence
- Characterization test FLIPPED: `electron/db/rollback/v72_down.test.js` now asserts `catalog_role`
  value survives rollback-reopen (was asserting the all-NULL loss); non-vacuous (pinned_event survives).
- `electron/db/rollback/v73_down.test.js` — v73_down-alone reachability.
- `electron/db/electiveRunOuterCellKind.migration.test.js` — folded-in v76 cell_kind replay vs a pre-v76 db.
- `electron/db/rebuildTableCarryingColumns.test.js` — the helper, incl. planted-attribute-corruption red→green.
- Verifier: schema family 527 tests (20 files) + rollback 67 tests (15 files) + check:governance (exit 0, 1 non-blocking advisory) + ESLint — all green.
- Grader: PASS, overall 4.25 (spec 4 / maintainability 4 / resilience 4 / test-quality 5), lowest 4, Verifier PASS, no blocking.

## Doc corrections (stale claims fixed)
- `electron/db/migrationDomainState.js` — the "straight SELECT * copy" comment (rebuilds are enumerated/dynamic, not SELECT *).
- `electron/db/localDb.js` comment + `docs/current/PLATFORM_STATE.md` schema_migrations bullet — the two "v72 has no rollback module" claims (`v72_down.js` exists).

## Out-of-scope follow-up (flagged, not fixed here)
`v51_down.js`, `v64_down.js`, `v77_down.js` carry the same enumerated-column-list class; now that
`rebuildTableCarryingColumns` exists they can be swept onto it. Recorded as a board line.

## Provenance note
The Governor loop parked after Grader PASS without committing/pushing. Per the organizer's standing
takeover rule, the primary session confirmed the working tree still held every v73 edit, wrote this run
record, re-ran check:governance + the schema/rollback family (green), committed the explicit paths,
pushed, and opened the PR. CI is the gate of record.
