---
title: "Name-keyed lookups across ingest, screens and export still assume a name identifies one row"
document_type: ticket
status: open
created: 2026-09-24
archive_when: every name-keyed map or find() resolving one of the ten v73-relaxed entities either applies the lowest-id tie-break or surfaces the ambiguity to the director, rather than silently binding to an arbitrary row
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md]
related_adrs: [docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md]
related_tickets: [docs/work/tickets/T252-name-id-map-deterministic-tiebreak.md, docs/work/tickets/T241-relax-name-unique-constraints-schema-v73.md]
---

# T255 — Name-keyed lookups that still assume uniqueness

## Why

Schema v73 relaxed the name-UNIQUE constraint on ten tables, so two rows in one camp can now
legitimately share a name (they arrive from a cross-device merge). T252 gave six name→id resolution
sites a deterministic lowest-id tie-break — but **both the spec (§D, "three sites") and the ADR
("five sites, not three") understated the real surface.** A post-implementation sweep of `src/`,
`electron/` and `scripts/` found roughly a dozen more.

These are not regressions in the strict sense: before v73 a duplicate could not exist, so each of
these was safe. Relaxing the constraint is what makes them reachable. **The common failure shape is
the dangerous one: the lookup SUCCEEDS, just against the wrong row, so nothing is reported as
unresolved and the director sees a clean run.**

## Findings, highest consequence first

1. `src/ingest/electiveSetPopulate.js:130` — `timeBlocksByName` last-write-wins (`time_blocks`). An
   elective grid row binds to the wrong block. `specialDayPlan.js` handles exactly this shape by
   collecting the ambiguity and refusing; that is the right model here.
2. `src/ingest/eventGridPopulate.js:66` — `locationsByKey` last-write-wins (`locations`). Imported
   event slots bind to an arbitrary "Pool", and the engine's capacity checks then run against the
   wrong capacity. No `unmapped` row is produced.
3. `src/ingest/specialDayPlan.js:57` — `activityByName` last-write-wins (`activities`). The sibling
   `groupByName` block directly above (43-56) DOES collect collisions into `ambiguousColumnNames`
   and block the plan; the activity map got no such treatment. Reads as an oversight, not a
   decision, given the file's own stated "an ambiguous name resolves to NOTHING rather than a guess".
4. `src/screens/ActivitiesScreen.jsx:862` (`tierMap`), `:863` (`actMap`), `:969` (`locationIdByName`,
   the write path) — an imported activity attaches to an arbitrary same-named division or location
   with no preview warning. The long comment above `:969` reasons carefully about CREATE determinism
   while assuming the read side is unambiguous; that assumption is what v73 broke.
5. `src/screens/AnchorsScreen.jsx:539` (`blockMap`), `:545` (`tierMap`) and
   `src/screens/GroupsScreen.jsx:406` (`tierMap`) — anchors drive the whole shape of a day, so an
   imported anchor landing on an arbitrary same-named block is high-visibility.
6. `src/screens/elective/assignment/buildAttendance.js:34` — `tierIdByNameKey`. Campers silently
   attend the other same-named division's electives; `unmatchedByValue` reports unmatched names but
   never a WRONG match.
7. `src/screens/ImportScreen.jsx:2011-2035` — the tier dropdown dedups by name via a `Set` and
   carries a NAME forward, so a director physically cannot route a group to the higher-id division.
8. `src/lib/locationDedup.js:15` and `src/screens/SpecialEventsScreen.jsx:374` — create-time
   `.find()` dedupe by name returns the first in array order, which can shift on a rename or a
   peer's insert, so the same typed name binds differently on different devices.
9. `src/utils/exportWorkbook.js:207-216` — the Locations sheet alone carries no `shoresh_id` column,
   so two same-named locations export as indistinguishable lines and a bulk Excel edit loses one
   row's changes on re-import.
10. `src/screens/locationMigrationReview.js:27-32` with `src/screens/LocationsScreen.jsx:76,96` —
    `resolveVariant` recovers a row from its name via the deterministic id derivation, so a second
    row with that name is invisible to the merge-review gate. Lowest confidence of the set; depends
    on migration-journal contents that were not fully traced.

## Also in scope

`schedule_weeks` is relaxed by v73 but has **no duplicate marker** (T239 shipped the other seven of
eight screens). Weeks are authored inside `ScheduleScreen.jsx`, which is under a standing owner rule
to protect the grid's restraint, so where that marker belongs is a design question, not a wiring one.

## Not verified

The sweep covered production code only, not test fixtures that may encode name-uniqueness
assumptions. A map built in one file and read far away under a different name is the hardest shape
to find by grep; `src/ingest/buildPlan.js:399-401,693-733` keys on `normalizeName` and its
`already.get(...)` returns an ARRAY, which looks deliberate but was read quickly. Running
`graphify affected` on the ten entities' name-lookup sites would close this more reliably than grep.

## Non-goals

Reference-aware merge. Making the advisory local-write pre-check blocking. Re-opening the v73
relaxation itself.
