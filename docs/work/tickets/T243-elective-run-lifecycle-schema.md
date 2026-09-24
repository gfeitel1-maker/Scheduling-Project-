---
title: T243-elective-run-lifecycle-schema
document_type: ticket
status: open
created: 2026-09-23
archive_when: the lifecycle migration (version claimed at merge time; v73 is contended) ships elective_run_outer_snapshots plus finalized_at/finalized_by, fresh-vs-migrated parity passes, and no code outside this ticket writes those columns
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md, docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md]
---

# T243 — elective run lifecycle schema (migration version claimed at merge time)

Data substrate for ADR 2026-09-23 decision (a): `elective_assignment_runs.finalized_at` /
`.finalized_by`, and the new `elective_run_outer_snapshots` table (now including its
`solver_generation` column, added in the ADR's Red-Hat-H2 revision), keyed by a deterministic
derived id `deriveElectiveRunOuterSnapshotId(run_id, camper_id, day_id, time_block_id)` following
the same discipline as `deriveElectiveAssignmentId`.

## Scope

- `electron/db/schema.sql`: the two new columns on `elective_assignment_runs`, and the new
  `elective_run_outer_snapshots` table **including its `solver_generation` column**, per the ADR's
  current DDL — check the ADR's schema block as of this ticket's last edit, not a cached copy; it
  changed once already during review.
- **Schema version — v73 IS ALREADY CONTENDED. Claim a number at merge time, not now.** Verified
  2026-09-23: a concurrent session (worktree `peaceful-keller-404ba9`, ticket
  `T234-relax-name-unique-constraints-schema-v73`) is also drafting a v73 migration, and this
  ticket's own number was renumbered from T234 to T243 for the same reason. `main` is at
  `CURRENT_SCHEMA_VERSION = 72` (`electron/db/localDb.js:30`). Treat "73" everywhere in this
  ticket as a placeholder. Immediately before merging, re-read `CURRENT_SCHEMA_VERSION` on current
  `main`, take the next free version, and renumber the migration pair and every reference to it
  rather than colliding — the same discipline T225 (ticket-number arbitration) already establishes
  for ticket numbers, applied here to schema versions.
- `CURRENT_SCHEMA_VERSION` bump with a matched `v<N>_up.js`/`v<N>_down.js` migration pair
  (`electron/db/migrations/`). Rollback is additive-only (no data loss on down — this is unlike
  v66's rollback, which destroyed preference data; document that difference in the migration file's
  header comment so a future reader doesn't assume all elective migrations are destructive).
- Registration parity for `elective_run_outer_snapshots`: `PROJECTIONS`, `MODELED_ENTITIES` (it
  must sync — a snapshot is part of what a final run's export means across devices),
  `DOMAIN_SNAPSHOT_ORDER`, `campScopedEntities.js`, `restore.js` (refuse, no setup UI — matches
  `elective_sets`' precedent), `undoReferences.js`, `slotOccupants.js` (does NOT occupy a slot — a
  snapshot is a read artifact, not a grid cell; confirm it is correctly excluded rather than
  silently omitted), `src/localClient.mock.js`, `electron/auth/permissions.js` (admin-only, same
  hand-written entry style as the other five elective entities per D9 — do NOT add it to
  `ENTITIES`).
- `deriveElectiveRunOuterSnapshotId` module, unit-tested for determinism (same inputs -> same id
  across two independent calls) and for collision-freedom against a differing single field.
- Genesis regeneration: per D13, still free (pre-production, owner-reconfirmed 2026-09-17 and
  unchanged since). Regenerate `GENESIS_B64`.

## Non-goals

Writing to these columns/table (that's T244). Any IPC surface (T244/T248).

## Test seam

Schema/migration change — **mandatory integration harness** per TESTING_STANDARD §"When the
integration harness is mandatory" (touches `electron/db/**` and `electron/ops/**`). Also:
`npx electron-rebuild -f -w better-sqlite3` before any Electron-side manual check;
`npm rebuild better-sqlite3` before `npm run test`.

Fresh-vs-migrated parity test extended to cover the new table's column order, per the ADR-2026-09-17
"Consequences" note that a wider table set makes this the larger risk, not a corner case.

## Dependencies

None — this is the first slice; everything else in this decomposition depends on it.
