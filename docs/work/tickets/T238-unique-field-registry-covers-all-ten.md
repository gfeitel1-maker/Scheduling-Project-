---
title: "UNIQUE_FIELD_ENTITIES covers all ten relaxed tables, with composite scope support"
document_type: ticket
status: open
created: 2026-09-23
archive_when: all ten relaxed entities are registered for the local-write advisory pre-check, tiers and time_blocks scope their check by cohort_id as well as camp_id, and both registry-parity tests are green
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md, docs/superpowers/specs/2026-09-23-merge-unique-collision-design.md]
related_adrs: [docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md, docs/adr/2026-08-15-locations-concurrent-create-collision.md]
related_tickets: [docs/work/tickets/T241-relax-name-unique-constraints-schema-v73.md]
---

# T238 — `UNIQUE_FIELD_ENTITIES` covers all ten relaxed tables

## Why

Owner decision 6: the registry covers only 5 of the 10 relaxed tables. `groups`, `cohorts`, `tiers`,
`time_blocks`, `schedule_weeks` and `special_days` are unregistered, so a director typing a duplicate on
purpose gets nothing. Before v73 those six at least threw a raw `SQLITE_CONSTRAINT_UNIQUE`; after v73
the advisory pre-check is the **only** local nudge left, so leaving them out makes them quietly worse at
exactly the moment they stop erroring.

## Success predicate (observable)

1. All ten relaxed entities are registered in `UNIQUE_FIELD_ENTITIES`
   (`electron/ops/operations.js`), each with a comment saying why, in the style of the five already there.
2. **`tiers` and `time_blocks` are `UNIQUE(camp_id, cohort_id, name)`, not `UNIQUE(camp_id, name)`.**
   The registry's current shape carries a single `scopeColumn` and `detectUniqueFieldCollision` builds
   `WHERE camp_id = ? AND <field> = ? AND id != ?`. Registering these two as camp-scoped would reject a
   tier named "A" under cohort 1 because a tier named "A" exists under cohort 2 — a **false rejection of
   a legal record**, which is worse than the gap it closes. The registry entry shape widens to carry a
   scope column **list**, and `detectUniqueFieldCollision` builds one predicate per scope column, reading
   the extra scope value off the op's own record. Every existing single-scope entry keeps working
   unchanged.
3. A test plants exactly that case: two tiers named "A" under two different cohorts are both accepted,
   and two tiers named "A" under the SAME cohort are rejected with `{reason:'unique_field'}`.
4. **`UNIQUE_FIRST_FIELD` (`src/data/setupCrudRepository.js`) gains the same six entities.**
   `electron/uniqueFirstFieldRegistryParity.test.js` asserts every `UNIQUE_FIELD_ENTITIES` entity has a
   matching `UNIQUE_FIRST_FIELD` entry naming the same field — this test **hard-fails** otherwise. Neither
   the ADR nor the spec names this file; both name only `src/localClient.mock.js`. It is the one that
   actually breaks.
5. `src/localClient.mock.js`'s `UNIQUE_FIELD_ENTITIES` moves with the real registry so a dev-mode
   (`npm run dev`) reproduction of a duplicate rejection matches Electron.
   `electron/uniqueFieldEntitiesMockParity.test.js` stays green.
6. Registering an entity must not break `orderFieldsForCreate` — a create carrying a
   `UNIQUE_FIRST_FIELD` field must still work on all ten screens' add paths.

## Non-goals

Making the pre-check blocking. It is advisory and always was — Art. V is flag, never block. Registering
the four hard-set entities beyond `days_of_operation`, which is already there.
