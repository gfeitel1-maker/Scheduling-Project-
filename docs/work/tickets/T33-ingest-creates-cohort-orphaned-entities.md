---
title: T33-ingest-creates-cohort-orphaned-entities
document_type: ticket
status: closed
created: 2026-08-02
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
archive_when: an import files its units/groups under the active Program and the group→unit tie is visible in the UI
---

# T33 — An import creates units/groups the director cannot see, so units never tie to groups

**Raised:** 2026-08-02, product owner — "it is not picking up units and tying them to groups."

## Root cause (diagnosed, deterministic)

The tie is written correctly but both ends are **orphaned from the active Program (cohort)**, so
the UI filters them out and the link is invisible.

- The app scopes setup entities to the active cohort. `TiersScreen.jsx:128` lists only tiers where
  `t.cohort_id === activeCohort.id`; groups and the other cohort-scoped entities are the same
  (`schema.sql` UNIQUE(camp_id, cohort_id, name) at lines 153 and 306; tiers carry `cohort_id` too).
- `commitIngest`'s `fieldsFor` (`electron/ops/ingest.js:43`) writes tiers as `{camp_id, name,
  sort_order}` and groups as `{camp_id, name, availability}` — **no `cohort_id` on either**. So every
  imported unit/group lands with `cohort_id = NULL`.
- `ImportScreen.jsx` never loads `useCohorts`/`activeCohort`, so it has no cohort id to pass.
- Net: the group→unit `tier_id` link IS set (`ingest.js:126`), but a NULL-cohort tier and group are
  both filtered out of the active Program's view, so to the director "units aren't tying to groups."

This affects **every** import, not only the new Shemesh/unlabeled family — it was missed because the
ingest was verified at the `commitIngest` level (which writes `tier_id`) but never end-to-end through
the cohort-scoped setup screens.

## Success predicate (observable)

After importing, the proposed units and groups appear under the director's **active Program**, and
each group shows filed under its inferred unit — visible in the Units/Groups screens without the
director doing anything.

## Likely change surface (for Architect/Maker, not yet scoped)

- Thread the active cohort id from `ImportScreen` into `localClient.ingestCommit` → `commitIngest`.
- Set `cohort_id` in `fieldsFor` for every cohort-scoped ingested entity (tiers, groups, and any of
  time_blocks/activities that carry cohort_id — confirm against `schema.sql`).
- Reuse the existing-unit lookup already in `commitIngest` (it seeds `tierIdByName` from current
  tiers) so a second import under the same Program reuses, not duplicates.
- Duplicate detection in `preview.js` must match **within the active cohort**, or a re-import into a
  different Program wrongly skips.

## Governance

Database/sync row: ADR + migration/rollback assessment + mandatory integration test. No schema change
expected (columns already exist) — a projection/write fix, so likely an addendum to ADR 2026-08-01
rather than a new ADR. Confirm before implementing.

## Closure note

Fixed in commits `d9f34dc` and `4436e42` (already on main). The fix threads `activeCohort.id` from `ImportScreen` through `localClient.ingestCommit` and the IPC handler into `commitIngest`, where `fieldsFor` sets `cohort_id` on tiers and time_blocks (groups and activities are camp-scoped and need none). The existing-unit dedup in `tierIdByName` is cohort-scoped so a "Rimon" in Session 2 no longer matches a "Rimon" being imported into Main. 31/31 ingest tests pass, lint clean. Verified by the Maker on 2026-08-06.
