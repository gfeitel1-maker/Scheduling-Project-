---
title: "idx_schedule_snapshots_template_id is absent on a fresh database's first open, and the 33 fresh-vs-migrated guards could not see it"
document_type: ticket
status: completed
created: 2026-09-16
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_tickets: []
related_adrs:
  - docs/adr/2026-09-16-index-survival-across-table-rebuilds.md
prior_dependencies: "None. Found incidentally on branch claude/t188-gate-tiering while building electron/db/testDbTemplate.js, when a schema-equivalence assertion there failed; that branch does not fix it."
archive_when: a brand-new database serves `SELECT * FROM schedule_snapshots WHERE template_id = ?` from idx_schedule_snapshots_template_id on its FIRST open, a pre-v53 and a pre-v59 database each still hold that index in the same open the rebuild runs in, and the whole-database first-open-vs-second-open index-set parity assertion is part of the suite — each pinned by a non-vacuous test
---

# T189 — An index does not survive the table rebuild that drops it

**Risk:** Low severity, notable class. Performance only (one table scan for one
launch); no stored data is wrong and no schema version changes. The reason it is
worth the loop is the guard gap behind it, not the index.
**Task class:** database / migration change at a schema-equivalence seam.

## Problem

`electron/db/schema.sql:866` declares:

```sql
CREATE INDEX IF NOT EXISTS idx_schedule_snapshots_template_id ON schedule_snapshots(template_id);
```

`initSchema()` execs `schema.sql` at the **start** of `openLocalDb()`, before the
migrations. Migrations v53 (`localDb.js:2164`) and v59 (`localDb.js:2363`) both
rebuild the table:

```
DROP TABLE schedule_snapshots;
ALTER TABLE schedule_snapshots_vNN RENAME TO schedule_snapshots;
```

`DROP TABLE` takes the table's indexes with it. `schema.sql` has already run for
that open, so nothing puts the index back until the next one.

Observed on a fresh file: 25 declared indexes on open #1, 26 from open #2 onward,
stable thereafter. `EXPLAIN QUERY PLAN` on open #1 gives `SCAN schedule_snapshots`;
on open #2, `SEARCH ... USING INDEX idx_schedule_snapshots_template_id`.

The `schema.sql` comment above the declaration argued the index was safe to put
there because `template_id` is `NOT NULL` from the table's original creation — a
correct answer to a *different* question (a pre-migration file missing a column).
It never considered a table a later migration drops.

## Why the existing guards missed it — the part worth reading

33 `electron/db/*.migration.test.js` files assert fresh-vs-migrated equivalence.
Ten of them do check indexes, via a per-table helper:

```
SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?
```

That helper is fine. It is also **opt-in per table**, and nobody passed
`schedule_snapshots` to it. The remaining 23 compare `PRAGMA table_info` and the
`type = 'table'` DDL text only — indexes are outside their frame entirely, and both
tests covering the rebuilding migrations (`retireOverlayStamp` for v53,
`dayOverridesRemoval` for v59) are in that group.

So the failure was not a blind spot in the checking method. It was a guard whose
completeness depended on someone remembering to enrol a table — which is why the
fix's guard is whole-database rather than one more per-table enrolment.

## Blast radius (verified, not assumed)

Tables rebuilt by a migration: `users`, `locations`, `camp_maps`,
`anchor_activities` (twice), `schedule_snapshots` (twice). Tables carrying a
declared index: `source_aliases`, `import_decisions`,
`open_reconciliation_decisions`, `operations`, `device_health_events`,
`projection_failures`, `conflicts`, `audit_events`, `template_slots`,
`schedule_snapshots`. The intersection is `schedule_snapshots` alone — one index,
two migration blocks. `idx_template_slots_template_id`, declared on the adjacent
line, is genuinely unaffected.

## What was done

Per `docs/adr/2026-09-16-index-survival-across-table-rebuilds.md`:

- **D1** — `SCHEDULE_SNAPSHOTS_TEMPLATE_ID_INDEX_DDL` exported from `localDb.js`,
  interpolated into the v53 and v59 blocks right after each `RENAME`, byte-identical
  to the `schema.sql` line (both-places DDL, the existing `LOCATIONS_DDL` /
  `SOURCE_ALIASES_DDL` discipline). `IF NOT EXISTS` keeps both blocks idempotent.
- **D2** — `electron/db/schemaIndexParity.migration.test.js`: whole-database
  declared-index parity between a fresh file's first and second open, plus a
  query-plan assertion for the concrete index, plus the same assertion on a pre-v53
  and a pre-v59 database within the single open the rebuild runs in.
- **D3** — no schema version bump; see the ADR for why none is needed.
- `schema.sql`'s comment corrected in place so the stale reasoning is not re-derived.

## Evidence

All four defect-detecting assertions were confirmed non-vacuous by reverting the
fix and observing them go red, then restored. The parity test additionally asserts
its own index set is non-empty and contains a known index, because two empty arrays
compare equal and a silently-broken `sqlite_master` query would otherwise leave the
guard permanently green.
