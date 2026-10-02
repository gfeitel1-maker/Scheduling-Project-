---
title: "Table-rebuild migrations carry later-added columns forward from live table_info"
document_type: adr
status: accepted
authority: normative
implementation_state: implemented
date: 2026-10-01
task_class: architecture
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
amends:
  - docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md
related_adrs:
  - docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md
  - docs/adr/2026-08-15-camp-locations-entity.md
  - docs/adr/2026-09-16-index-survival-across-table-rebuilds.md
---

## Context

Migration v73 (T241, the merge-UNIQUE-collision ADR this amends) relaxes a name-`UNIQUE`
constraint on nine camp-scoped tables (`locations`, `activities`, `events`, `elective_sets`,
`groups`, `tiers`, `time_blocks`, `special_days`, `cohorts`) to a plain index, and its inverse
`rollback/v73_down.js` restores the `UNIQUE`. SQLite cannot drop or add a table-level constraint in
place, so both do it by the table-rebuild recipe: create a `<table>__rebuild` with the new
constraint shape, copy the rows, drop the original, rename.

Both sides enumerated an **explicit column list** in the `CREATE TABLE` and the `INSERT ... SELECT`.
That list froze at the column set each table had when the block was authored. Any column a **later**
migration added to one of the nine tables was therefore absent from the list, and the rebuild
silently dropped it:

- `activities.catalog_role` (added by v75) is lost whenever the v73 forward block re-fires on a
  post-v75 database. This happens on the ordinary reopen-after-rollback path: `rollback/v72_down.js`
  (or `v73_down.js`) rewinds `schema_migrations` into v73's `>= 72 && < 73` window, and reopening
  the app re-runs v73, which rebuilt `activities` without `catalog_role` and then let v75 re-add it
  as all-`NULL`. A camper's ingest classification was erased, silently, with no error or log line.

The characterization test `electron/db/rollback/v72_down.test.js` pinned this as a KNOWN GAP;
`electron/db/migrationDomainState.js` and `rollback/v72_down.js` carried comments describing the loss
as current behaviour.

## Decision

Introduce one helper, `electron/db/rebuildTableCarryingColumns.js`, used by **both** the v73 forward
block and `rollback/v73_down.js`:

- Derive the carried columns from the **live schema** (`PRAGMA table_info`), not a hardcoded list.
  Columns named in `baseColumns` are recreated verbatim; every other live column that is **not** a
  generated/virtual column (`PRAGMA table_xinfo` `hidden !== 0`) is reconstructed from its
  `table_info` (`"<name>" <type>[ NOT NULL][ DEFAULT <dflt_value>]`) and appended **after** the base
  columns in **live `cid` order** — which is the ALTER-append / migration order, and therefore
  reproduces a fresh install's column order (the column-order-trap parity the migration tests pin).
- Table-level constraints (the `UNIQUE(...)` the down path restores) are passed in `tableConstraints`
  and emitted after the columns, where a `CREATE TABLE` body requires them.
- A **superset + attribute invariant** runs inside the caller's transaction, immediately after the
  rebuild table is created and before the copy: re-read the actual `<table>__rebuild` columns and
  throw if any live, non-generated column is missing **or** reconstructed with a different
  `table_info`-visible shape (type, `NOT NULL`, or `DEFAULT`). The throw propagates out and aborts the
  transaction (the caller restores the FK pragma in its `finally`), so a stale carry list — or a
  wrong-type / lost-`NOT NULL` / wrong-`DEFAULT` reconstruction — fails loudly instead of corrupting
  data. Because `UNIQUE` (the only constraint these two call sites change) is table-level, a
  carried/base column's attributes are identical between the source and the rebuild on both the relax
  and restore paths, so any attribute divergence is always a real assembly bug. Reading the actual
  created table (rather than only the computed arrays) makes the invariant genuinely protective and
  lets it be exercised by planted-defect tests (a dropped column and a corrupted-attribute column).

The helper runs **inside** the caller's already-open transaction and does **not** touch
`PRAGMA foreign_keys` — the caller owns the OFF-before-BEGIN / ON-in-`finally` wrapper, unchanged.

## Alternatives rejected

- **C — DDL string surgery** (parse the existing `CREATE TABLE` SQL from `sqlite_master`, edit the
  constraint, re-execute): fragile text manipulation of SQL this project does not otherwise parse.
- **D — a verbatim ALTER-DDL registry** (store each table's canonical DDL and replay it): premature
  infrastructure for a two-call-site need.
- **One-line `catalog_role` hardcode** in both lists: fixes the one known instance, not the class —
  the next later-added column on any of the nine tables would silently repeat the defect.

## Consequences and future constraints

- The invariant verifies a carried column **survives with its `table_info`-visible shape** (type,
  `NOT NULL`, `DEFAULT`). It does **not** verify **column-level** `CHECK` / `FOREIGN KEY` / `COLLATE`,
  which `table_info` does not report — those remain the documented residual blind spot, and a carried
  column loses them (along with a non-constant `DEFAULT`). **No column on the nine tables has such a
  constraint today** (`activities.catalog_role`, the only later-added one, is plain nullable `TEXT`).
- A future **constrained** column on one of the nine tables must either be promoted into that table's
  `baseColumns` (so its full DDL is restated) or the helper upgraded to reconstruct column-level
  constraints. Its re-add ALTER guard must key on **constraint divergence**, not mere name presence,
  or a carried-but-unconstrained column would satisfy a name-only guard and never regain its
  constraint.
- Column-order-trap parity is preserved: extras are appended in live `cid` order and never sorted, so
  fresh-install and migrated column order stay byte-identical (verified by the fresh-vs-migrated
  `table_info` equality tests, e.g. `electron/db/anchorEventLocation.migration.test.js`).
- Generated/virtual columns are intentionally excluded from the rebuild (none exist on the nine
  tables); adding one to a rebuilt table would require revisiting this helper.

## Addendum (2026-10-01) — optional `exclude` for down-migrations that must drop a column

The same enumerated-column-list defect this ADR cures on the v73 path also lived on
`rollback/v51_down.js`, which recreates `anchor_activities` to drop `kind` and its table-level
`CHECK` (SQLite refuses `DROP COLUMN` on a `CHECK`-referenced column). Its hand-written
`INSERT ... SELECT` list silently dropped any column a migration added after v51's window (e.g.
`recurrence_level`, and any not-yet-imagined later column) when rolling back through v51.

To route v51_down through the one tested rebuild path, the helper gained an **optional `exclude`**
set — names of live columns to drop **on purpose**. Semantics: excluded names are removed from the
live-column view **once, up front**, before `baseColumns`/`extras` and before the superset+attribute
invariant run, so an excluded column's absence from the rebuilt table reads as the intended drop it
is rather than tripping the "would drop column(s)" guard. **Every other live column — including a
later-added one — is still carried and still guarded exactly as before.** Omitted or empty,
behavior is byte-identical, so the two original no-exclude call sites (the v73 forward block and
`rollback/v73_down.js`) are unchanged.

`rollback/v51_down.js` passes `exclude: ['kind']` with `tableConstraints: []` (dropping the CHECK),
`recurrence_level` now handled as an ordinary carried extra rather than a hand-rolled conditional.
No new schema version — this fixes an existing rollback. The guard's protection is unchanged for
non-excluded columns: a genuine stale-carry drop of any other live column still fails loudly (pinned
by a planted-defect test that drops a non-excluded column while an `exclude` set is present). The
column-level `CHECK` / `FOREIGN KEY` / `COLLATE` residual blind spot above is unchanged; the
excluded column is being dropped, not carried, so its own CHECK is intentionally gone with it.
