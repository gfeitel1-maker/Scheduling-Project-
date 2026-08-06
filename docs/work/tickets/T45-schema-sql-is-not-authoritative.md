---
title: T45-schema-sql-is-not-authoritative
document_type: ticket
status: closed
created: 2026-08-04
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_tickets: [docs/work/tickets/T42-mock-allowlist-drift-is-manual.md]
archive_when: resolved — schema.sql either matches the migrated schema or says plainly that it does not
---

# T45 — `schema.sql` does not describe the schema a running device actually has

**Risk:** Low to ship, medium to reason with. It is the file everyone opens first to learn the data
model, and it is wrong.
**Found:** Phase A (PROJECTIONS coverage guard), 2026-08-04, and again in Phase C while specifying
the `listByScope` indexes.

## What is wrong

`electron/db/schema.sql` holds the base `CREATE TABLE` statements and re-executes on every database
open. Columns added later by `electron/db/localDb.js`'s versioned migrations are **not** backported
into it. Confirmed instances:

- `template_slots` declares **6** columns in `schema.sql`. A migrated database has **10** —
  `flags`, `is_released`, `is_span_head` (migration v10) and `anchor_id`, `is_anchor` (v17) are
  absent from the file.
- Indexes are split across both files with no stated rule. `schema.sql` holds a few; migration v28
  in `localDb.js` holds the unique indexes on `week_activity_exclusions` and
  `week_group_exclusions`. Phase C's proposal asserted "only three indexes exist, none on
  `template_id`" and was wrong on the count precisely because it read only `schema.sql`.

## Why it matters

This has already caused concrete errors, twice:

1. Phase A's PROJECTIONS coverage guard was nearly built against `schema.sql` as its source of
   truth. Had it been, it would have flagged five correctly-registered fields as unregistered, or
   been "fixed" by deleting them from `PROJECTIONS` — which would have silently broken slot writes.
   The guard now reads `PRAGMA table_info` against a real migrated database instead.
2. Phase C's approved design contained a false factual claim about index coverage, traced directly
   to reading this file as authoritative.

Both were caught. The next one may not be. The file *looks* authoritative — it is named
`schema.sql`, it is the only file with `CREATE TABLE` in it, and nothing in it warns the reader.

## Scope

**In:** pick one of two resolutions and apply it fully.

- **(a) Backport** the migration-added columns and indexes into `schema.sql` so it describes the
  current shape. Requires care: `schema.sql` re-executes on every open, so anything added must be
  idempotent and safe on an existing populated database — this is exactly why
  `schedule_templates.kind`'s index had to live in a migration (see the note at `schema.sql:387`).
  That constraint may make full backport impossible for some entries, which is itself the answer.
- **(b) Document** it explicitly: a prominent header stating that `schema.sql` is the base schema
  only, that `localDb.js` migrations are the authority for current shape, and that the way to learn
  a table's real columns is `PRAGMA table_info` against a migrated database. Add a pointer at each
  table known to have drifted.

Recommendation: (b), plus backporting only what is genuinely safe under re-execution. A comment that
is true beats a file that pretends to be complete.

**Out:** changing any migration, or altering the shape of any table. This is a documentation/accuracy
ticket, not a schema change.

**Boundaries:** no data migration. No change to what a running device's schema actually is.

## Completion evidence

1. A reader opening `schema.sql` cannot mistake it for the current schema.
2. Every table whose live shape differs from its `CREATE TABLE` block is either corrected or flagged.
3. The rule for where a new index belongs (`schema.sql` vs a migration) is stated once, in writing.
4. `npm run test`, `npm run lint`, `npm run build` pass; no database shape changed.

## Closure note

Closed in commit `e523e8d` on branch `work/t45-schema-sql`. A 31-line header was added to `schema.sql` that explicitly identifies the file as base-schema-only, names `localDb.js` migrations as the authority for the current shape, documents the empirically derived index placement rule (schema.sql for columns present at table creation; migration block for columns added by ALTER TABLE), and directs readers to use `PRAGMA table_info` against a migrated db to see all live columns. Three tables confirmed to have drifted were flagged with inline drift comments: `template_slots` (5 migration-added columns across v10 and v17), `operations` (host_seq, v18), and `device_identity` (first_sync_completed_at, v22). No migration, table shape, or running device schema was changed.
