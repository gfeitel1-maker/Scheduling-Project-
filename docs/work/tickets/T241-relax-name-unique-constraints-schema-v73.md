---
title: "Relax ten name-UNIQUE constraints so the projection mirrors the document (schema v73)"
document_type: ticket
status: completed
created: 2026-09-23
archive_when: a fresh install and a v0-through-v73 migrated database produce identical PRAGMA table_info and index_list for all ten relaxed tables, and two document records sharing a name both project with zero projection_failures rows
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md, docs/superpowers/specs/2026-09-23-merge-unique-collision-design.md]
related_adrs: [docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md]
related_tickets: [docs/work/tickets/T205-days-of-operation-uniqueness-and-dedup-migration.md]
---

# T241 — Relax ten name-UNIQUE constraints (schema v73)

## Why

`UNIQUE(camp_id, name)` on a director-typed name is not enforcing an invariant a replicated document
can hold — it is discarding a peer's record to preserve one. `projector.js`'s `upsertRow` SAVEPOINT
catches the colliding row, writes it to `projection_failures`, and `console.error`s. The peer's edit
is gone with no director signal. See the ADR for the full argument; it is not re-litigated here.

## Scope

Ten tables become non-unique on their name key: `locations`, `activities`, `events`, `elective_sets`,
`groups`, `cohorts`, `tiers`, `time_blocks`, `schedule_weeks`, `special_days`.

Four constraints stay HARD and are **out of scope for this ticket**: `users(camp_id,name)`,
`days_of_operation(camp_id,day_of_week)`, `schedule_templates(camp_id,kind)`, `camp_maps(camp_id,kind)`.

## Success predicate (observable)

1. `CURRENT_SCHEMA_VERSION` is 73 (re-verify against `main` immediately before implementing — v71/v72
   are already claimed and the number may have moved again).
2. The v73 migration guard is `getSchemaVersion(db) >= 72 && getSchemaVersion(db) < 73`. A bare
   `< 73` is a defect.
3. Nine of the ten tables are **rebuilt** to drop the inline `UNIQUE(...)` clause (an inline
   table-level UNIQUE compiles to a `sqlite_autoindex_*` that `DROP INDEX` cannot touch);
   `schedule_weeks` is the one plain named-index swap. `electron/db/schema.sql`'s `CREATE TABLE` text
   must lose the inline clause too, or a fresh install keeps the constraint while a migrated db
   relaxes.
4. **Fresh-vs-migrated equivalence test** (load-bearing, write this FIRST): one db built by
   `schema.sql` alone, one by every migration v0→v73 in sequence; assert identical
   `PRAGMA table_info(<t>)` and `PRAGMA index_list(<t>)` for all ten tables. This test passing is the
   precondition for any rebuild body being considered done.
5. Each rebuilt table keeps every foreign key, trigger, and secondary index it had. `cohort_id` scoping
   on `tiers`/`time_blocks` survives: their replacement plain index is on `(camp_id, cohort_id, name)`,
   not `(camp_id, name)`.
6. `conflicts` gains `entity_ids TEXT NULL` and `kind TEXT NOT NULL DEFAULT 'scalar'` in the same
   migration, with every existing row backfilled to `'scalar'`.
7. `v73_down` **refuses** and names every offending table, colliding value, and row id across all ten
   tables in a single error — not the first table it hits, and never a silent dedup.
8. Two document records sharing a name project as two SQLite rows with **zero** `projection_failures`
   rows for either.

## Non-goals

Any change to T205's v70 migration, its deterministic day ids, or its registry entry. The hard set.
The duplicate flag UI (T239). The typed conflict (T235).

## Notes for the implementer

- The table-rebuild precedent closest to this shape is the **v50 `camp_maps` rebuild**
  (`electron/db/localDb.js` ~line 1979), which relaxed `UNIQUE(camp_id)` to `UNIQUE(camp_id, kind)` by
  exactly this recipe — a nearer model than the v51/v65 CHECK-growth rebuilds the ADR cited.
- `CAMP_MAPS_DDL` (`localDb.js` ~3253) is a deliberate byte-identical duplicate of schema.sql's
  `camp_maps` block. `camp_maps` is in the hard set and must NOT change, but check whether any of the
  ten relaxed tables has a similar exported-DDL twin before editing schema.sql.
- Six of the nine rebuilt tables also carry a separately-named unique index from an earlier migration
  (`locations`, `activities`, `groups`, `cohorts`, `tiers`, `time_blocks`); `events`, `elective_sets`
  and `special_days` relied on the inline clause alone. Both enforcement sites must go.
