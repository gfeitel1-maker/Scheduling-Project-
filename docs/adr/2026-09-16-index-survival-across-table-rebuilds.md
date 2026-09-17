---
title: "An index on a table any migration rebuilds is declared in two places, and index parity between a fresh database's first and second open is a guarded invariant"
document_type: adr
authority: normative
status: accepted
date: 2026-09-16
supersedes: []
implementation_state: shipped
affects: [docs/governance/standards/TESTING_STANDARD.md]
related_adrs: []
related_tickets:
  - docs/work/tickets/T189-index-lost-across-schedule-snapshots-rebuild.md
---

# Index survival across table rebuilds

## Context

`initSchema()` execs `electron/db/schema.sql` at the **start** of every
`openLocalDb()`, and only then runs the numbered migration blocks. The comment at
the head of `schema.sql` reasons from that ordering: every statement there is
`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, so re-execution on an
already-migrated file is harmless and any declared object is self-healing.

That reasoning has a hole, and it is specifically about **order**, not idempotency.
A migration that rebuilds a table the SQLite way —

```
CREATE TABLE x_vNN (...);
INSERT INTO x_vNN SELECT ... FROM x;
DROP TABLE x;
ALTER TABLE x_vNN RENAME TO x;
```

— destroys that table's indexes along with the table. `schema.sql` has already run
for this open, so its `CREATE INDEX IF NOT EXISTS` does not re-fire. The index is
simply absent for the remainder of the open, and reappears on the *next* open.

This shipped. `idx_schedule_snapshots_template_id` is declared at
`electron/db/schema.sql:866`; migrations v53 and v59 each rebuild
`schedule_snapshots`. Every fresh database therefore ran its first session without
that index, and so did every database upgrading across v53 or v59, for the life of
both migrations. A fresh file has 25 declared indexes on open #1 and 26 from open
#2 onward.

The impact is performance only — a table scan on `schedule_snapshots` for the
duration of one launch — and no stored data is wrong. What makes it worth an ADR
is the class: this is a fresh-vs-migrated schema divergence, which
`docs/governance/standards/TESTING_STANDARD.md` §1 names as "the failure mode that
does not surface until a user's data is already in the drifted shape."

### Why 33 fresh-vs-migrated guards did not catch it

Twelve of the 33 `electron/db/*.migration.test.js` files do check indexes. Eleven
use a helper shaped like

```
SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?
```

— adequate, but **scoped to one named table and opted into by hand**, and no test
passed `schedule_snapshots`. The twelfth, `exclusionTables.migration.test.js:71`,
queries `sqlite_master` unfiltered but then asserts only `.toContain()` for two
known index names, so it is opt-in by a different mechanism and would not have
caught this either. The remaining 21 compare `PRAGMA table_info` and the
`type = 'table'` DDL text only, so indexes are outside their frame entirely. Both
migrations that rebuild the table (`v53` → `retireOverlayStamp.migration.test.js`,
`v59` → `dayOverridesRemoval.migration.test.js`) are in that last group.

So the guard was not structurally blind. Its coverage was per-table enrolment, and
this table was never enrolled — a guard whose completeness depends on someone
remembering.

## Decision

**D1 — An index on a table that any migration rebuilds is declared in two places,
byte-identically.** The canonical text lives as an exported constant in
`localDb.js` (`SCHEDULE_SNAPSHOTS_TEMPLATE_ID_INDEX_DDL`), is interpolated into
each rebuilding migration block immediately after its `RENAME`, and is duplicated
verbatim in `schema.sql`. This is the same both-places-DDL discipline already used
for `LOCATIONS_DDL`, `SOURCE_ALIASES_DDL`, and `COMPOUND_CELL_DECISIONS_DDL`, and a
test asserts the constant's text appears in `schema.sql`.

`IF NOT EXISTS` makes the re-creation a no-op whenever the index survived, so the
migration blocks stay idempotent and re-runnable.

**D2 — Index parity between a fresh database's first open and its second is a
guarded invariant, asserted whole-database.** A new guard
(`electron/db/schemaIndexParity.migration.test.js`) compares the full
`sqlite_master` declared-index set across two opens of one new file. It is
deliberately *not* per-table: the enrolment gap in D1's "Context" is the thing
being closed, so no future table needs to be remembered. It carries an explicit
non-vacuity assertion (the set is non-empty and contains a known index), because
two empty arrays compare equal and a silently-broken query would otherwise leave
the guard green forever.

**D3 — No schema version bump.** The defect is confined to the single open in which
a rebuild runs; from the next open onward `schema.sql` restores the index, so no
database on disk is left in a wrong persistent state. Adding the DDL inside the
existing v53 and v59 blocks is therefore sufficient: it changes the outcome only
for files that have not yet applied those migrations, and files that already
applied them already have the index.

## Consequences

- A future migration that rebuilds an indexed table must re-create that table's
  indexes in the same block. D2's guard fails if it does not, naming the missing
  index — this is the mechanism, not a convention to remember.
- `schema.sql`'s head comment about re-execution being self-healing is now
  qualified in place, at the `idx_*_template_id` declarations, so the next reader
  does not re-derive the wrong rule from it.
- `idx_template_slots_template_id`, declared on the adjacent line, needed no twin:
  `template_slots` is not rebuilt by any migration. The intersection of
  *rebuilt tables* (`users`, `locations`, `camp_maps`, `anchor_activities`,
  `schedule_snapshots`) with *tables carrying a declared index* was verified to be
  `schedule_snapshots` alone, so this was a one-index blast radius.

## Rollback

Revert the commit. The two migration blocks lose their `CREATE INDEX IF NOT
EXISTS` line and the behaviour returns to the pre-fix state — the index missing for
one open. No schema version changed, no table shape changed, no data moved, so
there is nothing to undo on databases that opened under the fixed code: they hold
exactly the index `schema.sql` would have given them anyway. `rollback/v53_down.js`
and `rollback/v59_down.js` are unaffected and were exercised by the new guard.
