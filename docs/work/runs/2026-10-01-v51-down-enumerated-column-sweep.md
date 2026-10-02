---
task: v51_down rebuild carries forward later-added columns via rebuildTableCarryingColumns exclude set (board q-down-modules-enumerated-column-sweep)
document_type: run
date: 2026-10-01
round: 1
status: pass
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: []
related_specs: []
related_adrs: [docs/adr/2026-10-01-rebuild-migrations-carry-forward-later-columns.md]
selected_agents: [governor, maker, verifier, red-hat, code-reviewer, grader]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: extends an existing helper already governed by docs/adr/2026-10-01-rebuild-migrations-carry-forward-later-columns.md; organizer ruled the mechanism (option a). No new contract.
  - agent: designer
    reason: not-applicable
    note: no UI surface — a SQLite migration/rollback rebuild mechanism.
  - agent: tester
    reason: not-applicable
    note: no render cycle or user-facing behavior change; reachable only via a rollback.
  - agent: security
    reason: not-applicable
    note: no auth/secret/IPC/network/packaging surface; internal helper + schema migration. SQL identifier quoting reviewed by Code Reviewer/Red Hat.
deterministic_checks: [electron/db/rebuildTableCarryingColumns.test.js, electron/db/anchorKindSplit.migration.test.js, rollback-family vitest (electron/db/rollback/), electron/db/anchorRecurrence.migration.test.js, electron/db/recurrenceLevelRemoval.migration.test.js, electron/db/anchorEventLocation.migration.test.js, electron/db/anchorDivisionScope.migration.test.js, electron/db/localDb.migrations.test.js, npm run schema:check, npm run check:governance, npm run lint]
human_gates: []
archive_when: superseded when the enumerated-column-list rebuild class is swept from the remaining down-modules (none known in scope after v51/v73) or rebuildTableCarryingColumns is replaced
---

# Run record — v51_down enumerated-column sweep

- **Board item:** `q-down-modules-enumerated-column-sweep` (scoped to `electron/db/rollback/v51_down.js` only)
- **Branch:** `claude/board-down-modules-column-sweep` (off `origin/main`, base #723 `faf33f4f`)
- **Schema change:** none — fixes an existing rollback; CURRENT_SCHEMA_VERSION unchanged.

## What landed
`electron/db/rebuildTableCarryingColumns.js` gained an optional `exclude` set — live columns to drop
on purpose. Excluded names are stripped from the live-column view once, up front, before
`baseColumns`/`extras` and before the superset+attribute guard, so the excluded column's absence
reads as the intended drop it is instead of tripping the guard; every other live column (including a
later-added one) is still carried and still guarded. Omitted/empty `exclude` is byte-identical, so
the two original no-exclude call sites (v73 forward block + `v73_down.js`) are unchanged.

`electron/db/rollback/v51_down.js` now routes through the helper with `exclude: ['kind']` and
`tableConstraints: []` (dropping `kind` and its table-level CHECK) instead of a hand-enumerated
`INSERT ... SELECT`, so a column a migration added after v51's window is carried forward with its
data rather than silently dropped — the same defect class fixed on the v73 path (#721). The
`recurrence_level` special-case (`hasRecurrenceLevel` conditional) is removed — it is now an ordinary
carried extra. FK pragma OFF/ON moved outside the transaction into a try/finally (the v73_down
pattern the helper contract requires). `DELETE ... WHERE version >= 51`, the `{ recurringDiscarded }`
return (computed before the rebuild), and the direct-invocation block are preserved.

## Evidence
- v51_down characterization RED→GREEN: `anchorKindSplit.migration.test.js` simulates a column added
  after v51's window (`ALTER TABLE ... ADD COLUMN`), populates it, rolls back via `rollbackV77` then
  `rollbackV51`, and asserts the later column AND its data survive while `kind` is gone. RED against
  the old enumerated-list rollback (dropped the column), GREEN after.
- Helper RED→GREEN: `rebuildTableCarryingColumns.test.js` — `exclude` drops a named column while a
  different later-added column + its data survive; and the shape guard STILL throws on a genuine drop
  of a non-excluded column while an `exclude` set is present (exclude does not blind the guard).
- Maker focused runs: helper + anchorKindSplit + rollback family = 98/98; extended migration family
  (anchorRecurrence, recurrenceLevelRemoval, anchorEventLocation, anchorDivisionScope,
  localDb.migrations) = 96/96.
- Verifier: see verdict below.
- Grader: see verdict below.

## Review synthesis
- Red Hat (Resilience 4): `exclude`/guard interaction, no-exclude caller parity, FK pragma lifecycle,
  and data-carry fidelity all CONFIRMED-SAFE by code reading + live probing (incl. a non-vacuous
  red→green plant for "exclude doesn't blind the guard"). One HIGH is a **pre-existing** rollback-order
  landmine (running `v51_down` before `v77_down` on a live db rewinds `schema_migrations` while the
  schema stays current) — identical in the old code, not introduced here, and concerns `v77_down`
  (organizer-ruled out of scope). Recorded as an out-of-scope follow-up below. Two LOWs: FK-throw path
  on rollbackV51 untested (confirmed working by probe; v73_down shares the gap), recurrence_level
  NOT NULL/DEFAULT shape covered by the generic helper test.
- Code Reviewer: "Ready." One MEDIUM — the v51_down header cited the ADR in a way that implied the ADR
  documented the `exclude` mechanism, which it did not. RESOLVED here by a Governor-level addendum to
  `docs/adr/2026-10-01-rebuild-migrations-carry-forward-later-columns.md` documenting the `exclude`
  extension and v51_down use case, making the citation truthful. Two LOWs (unconditional FK toggle on
  the no-rebuild path — harmless no-op; minor comment duplication) — not blocking.

## Out-of-scope follow-up (flagged, not fixed here)
Pre-existing (Red Hat HIGH): `rollback/v51_down.js` (and the same shape in other `vNN_down.js` CLIs)
has no `hasTable`/ordering guard, so invoking it before `v77_down.js` on a current db silently rewinds
`schema_migrations >= 51` with the schema left fully current. `v77_down.js` already has a `hasTable`
helper to mirror. Out of this board item's scope (v51_down-only; v77_down ruled not-applicable) —
recommend a board line for a descending-rollback-order guard across the down CLIs.
