---
title: T243-v74-held-behind-v73-handoff
document_type: handoff
status: active
created: 2026-09-24
task: docs/work/tickets/T243-elective-run-lifecycle-schema.md
archive_when: T243 has merged at schema v74 on top of the v73 table-rebuild migration, with a full `npm run verify` green against the rebased tree
worktree: .claude/worktrees/agent-afd6619b261f85984  (branch: worktree-agent-afd6619b261f85984)
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md]
---

# T243 at schema v74 — the hold is RELEASED; this records what the ordering bought

**RESOLVED 2026-09-24.** v73 merged (`c7750c86`, #527); T243 is rebased onto it at v74 and the two
known-red tests below are green. Kept as the record of WHY the ordering existed and what the
post-rebase re-verification actually found, because "we rebased and it was fine" is not evidence.

## Why it is held

Two streams needed a schema version at the same time. The other one — the merge-path UNIQUE
collision program — **rebuilds fifteen tables** to relax ten name-UNIQUE constraints. T243 only
adds two nullable columns and one new table. The owner ruled that the more invasive change lands
first, at v73, and T243 follows at v74.

The ordering is not cosmetic. This repo has a hard invariant (`electron/db/migrationDomainState.test.js`,
"covers 1..CURRENT_SCHEMA_VERSION with no gaps") that **every schema version from 1 to CURRENT must
be classified**. Gapped schema versions are not supported. So v74 cannot be green until v73 exists.

## The two expected reds — both now GREEN after the rebase, exactly as predicted

1. `electron/db/migrationDomainState.test.js` > "covers 1..CURRENT_SCHEMA_VERSION with no gaps" —
   fails `expected [ 73 ] to deeply equal []`. Version 74 **is** classified here (added to
   `SCHEMA_ONLY_MIGRATIONS`). 73 is deliberately **not**: it is not this ticket's to classify and
   arrives with the other stream's PR. Earlier this failed with `[73, 74]`; the narrowing to `[73]`
   is the proof that T243's own classification landed.

2. `electron/db/electiveRunLifecycle.migration.test.js` — two cases fail `expected 72 to be 74`.
   Root cause is the same missing v73, surfaced differently: `freshDb()` runs `initSchema` from 0,
   and `schema_migrations`'s version *marker* can only reach 73 by running a v73 block that does
   not exist in this tree. Structurally the fresh db is already correct — `schema.sql`'s definitions
   are unconditional, so the new table and columns exist regardless. Only the marker lags.

**Do not fabricate a v73 block to make these green.** That re-litigates a settled boundary and
would collide with the real v73 on merge.

## Post-rebase checklist — DONE, with what it found

The v73 session found two migration defects that would each have shipped a **corrupting** migration
behind a green gate. Both were found by *writing a fresh-vs-migrated equivalence test* rather than
reasoning about whether one was needed:

- `PRAGMA foreign_keys=OFF` is a **no-op inside `db.transaction()`** — a rebuild relying on it does
  not actually have FKs off.
- `INSERT INTO x_v73 SELECT * FROM x` copies **by position, not by name** — on a database that
  reached the current version through accumulated `ALTER`s rather than a fresh `CREATE`, the column
  order differs and a column is silently misplaced.

Both are invisible to a schema-version check and to a fresh-install-only test.

After rebasing onto merged v73:

1. **Re-ran the whole gate** after the rebase — the pre-rebase green was NOT carried forward,
   because fifteen tables were rebuilt underneath this branch.
2. **Proved fresh == migrated once BOTH v73 and v74 have applied.** Done, and it is the part worth
   reading: `electron/db/electiveRunLifecycle.migration.test.js` gained a `v72->v74 composition`
   block that rolls a database genuinely back to v72, seeds real rows in the tables v73 rebuilds
   (`activities`, `elective_sets`, `elective_assignment_runs`), then runs the REAL v73 rebuild and
   v74 in one forward pass. Crucially it asserts **column-by-column value fidelity**, not only
   shape. That distinction was proven non-vacuous by deliberately swapping `min_per_week`/
   `max_per_week` in v73's rebuild SELECT list: **only the value assertion failed; the shape
   comparison still passed.** A shape-only equivalence test would have shipped that defect.
   (Perturbation reverted and verified reverted by diffing `localDb.js` against `origin/main`.)
   Original requirement, for the record: The composition of two migrations
   is a better place for divergence to hide than either one alone. This is the exact test shape that
   caught the two defects above.
3. **Confirm `elective_assignment_runs` survived the v73 rebuild intact** before v74's `ALTER`s run
   against it.
4. **Re-verify the guard** is still `getSchemaVersion(db) >= 73 && getSchemaVersion(db) < 74`
   (`electron/db/localDb.js:3079`), the `.toBe(N)` schema-version tripwires in the sibling
   `.migration.test.js` files, and that 73 is now classified **by the other stream**, not by us.

### One premise in the original checklist does NOT hold — verified, not assumed

It was flagged that T243 "adds a new FK dependent on `activities`, a table v73 has just proven
rebuild-prone." **`elective_run_outer_snapshots` has zero foreign keys** — verified directly against
`electron/db/schema.sql` and against the ADR's own DDL block, which also declares none. Its
`activity_id` is a soft reference, which is why `electron/ops/mergeActivity.js:55` carries the
`// no FK` comment. So there is no FK to re-resolve against a rebuilt `activities`. Step 2 above
still applies on its own merits; this specific FK concern does not.

## What T243 actually ships

Schema only. **Nothing writes any of it** — T244+ builds the write path.

- `elective_assignment_runs.finalized_at` / `.finalized_by`.
- New modeled entity `elective_run_outer_snapshots`: per (run, camper, day, time_block), the
  non-elective cell a camper occupies. Denormalized `activity_name`/`location_name` so a finalized
  run stays exportable after the template is edited or the activity deleted, plus a
  `solver_generation` marker so a regeneration merging in from another device after finalize is
  *detectable* rather than silently exported.
- Derived id `deriveElectiveRunOuterSnapshotId(run_id, camper_id, day_id, time_block_id)`;
  `day_id`/`time_block_id` are `NOT NULL` because a row without them has no derivable identity.
- Full registry parity, `GENESIS_B64` regenerated (8th).

### Two additions that were NOT in the ticket and are load-bearing

Both were found by reading the guards rather than the ticket, and both are erasure/PII requirements:

- **`PARTICIPANT_ENTITIES`** (`electron/ops/participantEntities.js`). The table carries `camper_id`
  and a named child's schedule. Membership makes it admin-only, audit-PII-guarded, unrestorable and
  MCP-excluded.
- **The camper-purge dependent-delete list** (`electron/automerge/purgeSupportCommand.js`). Without
  it a purged camper's denormalized schedule survives as orphan rows keyed by a purged id.

### `mergeActivity.js` — decided, implemented, green

`elective_run_outer_snapshots.activity_id` is re-pointed on an activity merge, while the
denormalized `activity_name` is deliberately **left untouched**. The ADR's byte-stability guarantee
is about the text a finalized export displays, not about the id; re-pointing keeps the soft
reference resolvable instead of dangling, while the frozen name still records what was actually
scheduled. Covered by its own behavioural test (`electron/ops/mergeActivity.test.js:138`),
written test-first — 17/17 green. This item is **independent of the v73 ordering and is done.**

## Two escalations that must not get lost in the renumber

1. **The contiguity invariant makes schema work a serialized resource.** Two streams cannot both
   hold a version, and the loser pays a full renumber-plus-regate cycle. This whole handoff is the
   cost of that. It deserves its own ticket.
2. **The review panel passed work the full gate then failed.** Four reviewers scored T243 4–5 across
   every dimension — including one asked *explicitly* whether anything assumes schema-version
   contiguity, which cleared it. The gate then failed on exactly that, plus an unhandled
   `activity_id` referrer. This is precisely what `CONSTITUTION.md`'s "never treat a reviewer score
   as proof when required gates fail" exists for, observed live.
