---
title: T194-participant-data-substrate
document_type: ticket
status: open
created: 2026-09-17
archive_when: the five entities ship with full registry parity
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_specs: [docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md]
---

# T194 — Slice 2: the participant data substrate

Seven synced entities at schema **v66** (`CURRENT_SCHEMA_VERSION = 65`, `electron/db/localDb.js:25`):
`campers`, `elective_assignment_runs`, `elective_occurrences`, `elective_choices`,
`elective_choice_offerings`, `elective_preferences`, `elective_assignments`. Fields in the spec §2.

The two choice entities are present from the start per ADR D12 — linked multi-period choices are
modeled up front, not retrofitted into a shipped assignment table.

**Blocked on T192.**

## Hard requirements

**Derived ids (ADR D4).** `elective_assignments` ids are a deterministic hash of
`(run_id, camper_id, occurrence_id)`; `elective_preferences` of
`(run_id, camper_id, occurrence_id, activity_id)`; `elective_occurrences` of
`(run_id, elective_set_id, day_id, time_block_id, tier_id)`. This is not an optimization —
`UNIQUE_FIELD_ENTITIES` (`electron/ops/operations.js`) expresses only single-column uniqueness and
cannot enforce these composites, so without derived ids two devices produce two rows with different
ids that merge silently with no conflict recorded.

**Permissions: the whole domain is admin-only (ADR D9).** Staff consume the *exported artifact*,
not the entities — no non-admin role has any in-app read path to any of the seven.
`electron/auth/permissions.js:74` derives staff read **and** write by flatMapping every entity in
`ENTITIES`, with no per-entity opt-in, so registering these there would grant staff both over a
surface no staff member is meant to touch. All seven follow the `camp_maps` precedent (`:112-121`):
kept out of `ENTITIES`, hand-written admin-only entries. Per-record history and Trash on them are
admin-only too (they are staff-readable for every other entity, `permissions.js:104-111`).

A test must assert the **negative** — staff hold no `campers.read`, no `campers.write`, no
`elective_preferences.read`, no `elective_assignments.read` — because the parity test guards
omission, not over-grant.

**Genesis regeneration (ADR D13).** Adding `MODELED_ENTITIES` forces regenerating the frozen
`GENESIS_B64` blob (`electron/automerge/campDocument.js:169-279`), invalidating every existing
`.automerge` file. **The owner confirmed on 2026-09-17 that the project is pre-production and no
real camp document exists**, so this is free. Record that assumption and date in the migration
notes; do not re-litigate it, and do not let it be inherited silently if it ever stops holding.

**Capacity representation (ADR D3).** Capacity becomes a two-part value — an explicit "no limit"
mode, or a number. `0` then means a real closed offering; negative and non-integer remain invalid.
Survey existing `elective_set_activities.camper_headcount` rows and **report** what is found;
do not rewrite. State the mapping the migration applies so every existing row has a defined meaning
rather than an inferred intent. The authoring UI must make "no limit" and "closed" visually
unmistakable.

**Column order.** `template_slots.elective_set_id` is a v35 migration-added column absent from the
fresh `CREATE TABLE` (`electron/db/schema.sql:509-531`). The fresh-vs-migrated test must compare
column **order**, not just the column set.

**Rollback.** `electron/db/rollback/v66_down.js`, following the `v35_down.js` convention. It
destroys imported preference data. Say so in the rollback plan.

**Derived-id note.** `elective_choices` and `elective_choice_offerings` take derived ids on the same
grounds as the others — a linked choice created independently on two devices must converge to one
row, not two.

**`SECURITY.md` is amended in this change** with the at-rest-encryption precondition (ADR D8) and a
pointer to the purge procedure and its limits (ADR D10, T202).

## Registry parity — the exit condition

Every one of these, verified by test where a test exists: `electron/db/schema.sql`; the v66
migration and `v66_down.js`; `electron/ops/projections.js` `PROJECTIONS`;
`electron/ops/campScopedEntities.js` (`DIRECT_CAMP_ENTITIES` / `PARENT_SCOPED_ENTITIES`);
`DOMAIN_SNAPSHOT_ORDER` in foreign-key-safe order; `electron/automerge/campDocument.js`
`MODELED_ENTITIES` + genesis; `electron/auth/permissions.js`; `electron/ops/restore.js:54` (where
`elective_sets` currently reads `'refused: no setup UI yet'` — decide deliberately, and per D9
history and Trash on the three PII entities are admin-only); `electron/ops/undoReferences.js`;
`electron/ops/slotOccupants.js:74`; `deleteRecord.js` / `deleteElectiveSet.js` / `deleteWeek.js`;
`src/ingest/existingSnapshot.js:71`; `src/localClient.mock.js`; `src/data/setupCrudRepository.js`;
`src/data/scheduleRepository.js`; `src/components/layout/navSections.js`;
`src/components/reconciliation/domainRollup.js` and `src/ingest/reconciliationReport.js`;
`scripts/mcp/tools.js` `ENTITY_MAP` (**exclusion** is the decision here — see T198).

Plus: fresh and migrated schemas equivalent; two-device sync retains rows; projection rebuild
retains rows; the integration harness is **mandatory** for this task class.

---

## Migration and release notes (recorded at implementation, 2026-09-17)

### Genesis regeneration — a RELEASE NOTE, not a footnote

**Every existing `.automerge` file is invalidated, and every paired device must re-pair.**
`GENESIS_B64` (`electron/automerge/campDocument.js`) was regenerated to add the seven collections;
the pinned head moved from `931e7c0f…` to `821dd7cc…`. `sharesGenesis()` and `syncNode.js` refuse
and **drop** a document that does not share genesis, so an old file does not corrupt a new one — it
simply **stops syncing, silently**, until someone notices.

Accepted because **the owner confirmed on 2026-09-17 that the project is pre-production and no real
camp document exists**. That assumption is recorded here with its date so it is not inherited
silently if it ever stops holding. A future regeneration would not be free.

The regeneration recipe was **verified before use**: it reproduces the PREVIOUS genesis byte for
byte and its pinned head. `A.from(shape)` is not reproducible (random actor id + a timestamp), so
both are pinned — `A.init({ actor })` then `A.change(d, { time }, …)`, reusing the original actor
`25a5dd896740165864744b9515f73f45` and time `1788919636` so the only input that differs from the
last regeneration is the entity list.

### Rollback plan — and why a rollback is NOT a purge

`electron/db/rollback/v66_down.js` drops the seven tables in reverse FK order and removes the two
capacity columns, reporting the discarded camper / preference / assignment counts **before**
destroying them.

**It destroys imported preference data** in the projection. It does **not** erase it: the op-log and
the Automerge document are untouched by a rollback, so those records still exist off-projection. A
rollback **reduces the PII footprint on disk and is not an erasure** — a director who runs one has
not deleted a child's record. The purge path is ADR D10 / **T202**.

One piece of good news: `camper_headcount` is untouched, so authored capacity is re-derivable and
is not lost by the rollback.

### D3 capacity survey — reported, not rewritten

Surveyed 2026-09-17 across both live databases and 41 backups, opened `?immutable=1`:
**`elective_set_activities` holds zero rows anywhere, and `camper_headcount` has never held a
value.** The only non-null `12` in the tree is a synthetic migration fixture. Corroborated by the
code: the sole offering-creating path wrote `camper_headcount: null` unconditionally. Nothing was
rewritten; no `UPDATE` was issued against any database. The backfill is therefore provably a no-op
on every database that exists, and is written anyway because it cannot see a database it has not
been shown.

**Mapping correction.** The design stated that a negative or non-integer legacy value should be
"preserved as-is" in `capacity_limit`. That is **not executable**: the backfill is an `UPDATE`, and
SQLite *does* enforce CHECK constraints on UPDATE (only `ALTER TABLE ADD COLUMN` skips
re-validation), so writing `-3` would abort the entire migration. The implemented mapping preserves
the **finding** instead — `('limited', NULL)` is exactly `INVALID_CAPACITY` (spec §3), which is the
outcome the design wanted — and the original number is not lost, because `camper_headcount` still
holds it for diagnosis.
