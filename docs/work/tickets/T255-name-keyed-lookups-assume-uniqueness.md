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

---

## Verification pass, 2026-09-24 — every finding checked against the tree

The sweep that produced the findings above ran pre-merge, so each one was re-checked against the
current tree by symbol name rather than by line number. Result: **nine of ten confirmed still live,
one reclassified, and the "Not verified" lead cleared as already safe.** Nothing was found already
fixed, but two findings turned out to be a different problem than described.

| # | Verdict | Correct answer, and why |
|---|---|---|
| 1 | Confirmed | **Refuse.** Import path, `unmapped` channel already exists. |
| 2 | Confirmed | **Refuse.** Same. |
| 3 | Confirmed | **Refuse.** The asymmetry is real: `groupByName` collects collisions, `activityByName` one line below does not. |
| 4 | Confirmed | **Refuse** via the per-row `warning` string the preview already renders; an ambiguous row then skips at commit. Note the exposure is narrower than the others — T81 made `locationIdByName` deliberately exact/case-sensitive/trim-only so preview and commit agree, so it needs two byte-identical trimmed names. v73 permits exactly that. |
| 5 | Confirmed | **Refuse** via the same per-row `warning`. The camp+cohort filter narrows the window but does not close it — v73 relaxed *within* a camp. |
| 6 | Confirmed | **Refuse**, with a third state alongside `unmatched`: `unmatchedByValue` reports names resolving to NOTHING, never a name resolving to the WRONG tier, which is the whole bug the module exists to prevent. Fall back to the existing never-unplaced rule rather than an arbitrary tier. |
| 7 | Confirmed, **reclassified** | Not a silent cross-device wrong bind — the commit side is *already* hardened (`seedNameMaps`, `electron/ops/ingest.js`, T252 lowest-id). It is a **capability gap**: the dropdown throws ids away before the `Set` dedups, so the higher-id division is unreachable and a director picking the visible option silently gets the lowest-id one. Fix by carrying the **id** as the option value — the dropdown is the one place a human can disambiguate. |
| 8 | Confirmed, low severity | **Deterministic lowest-id tie-break**, not refusal. These are interactive create-flows, and refusing would block a director mid-task over a condition `docs/adr/2026-08-15-locations-concurrent-create-collision.md` option (d) already accepts. `SpecialEventsScreen`'s copy should fold into `createLocationRecord` — it is a near-verbatim duplicate that will drift. |
| 9 | Confirmed — **CLOSED here, deferred by owner decision** to [T256](T256-locations-sheet-round-trip.md) | Neither. The gap PREDATES v73 and is a product question about whether Locations should round-trip at all. |
| 10 | Confirmed, **reclassified** | Not mis-binding. Post-migration creates use `crypto.randomUUID()`, not `deriveLocationId`, so a second same-named row has a random id and cannot collide with the derived one — `resolveVariant` keeps finding the right row. The real defect is **incompleteness** (a third same-named row is invisible to the gate) plus a redundancy: `listMigrationReviews` already SELECTs `location_id`, and `resolveVariant` re-derives it from the name anyway. Fix by using the stored id. No tie-break needed. |

### The "Not verified" lead is clear

`src/ingest/buildPlan.js` is **genuinely duplicate-safe**, not merely array-shaped. `already.get(key)`
returns a list per normalized key by explicit design (its own comment: "the old single-valued Map let
the last one silently overwrite the first, auto-picking an identity no human saw"). `matches.length > 1`
never auto-picks — it emits an `op: 'conflict'` with `reason: 'ambiguous_identity'` carrying every
candidate id for human resolution, and a director's prior pick is honoured only if `matches.find`
still locates that exact id. The alias tier is equally careful. One soft spot remains and is
host-supplied rather than in this file: the alias map itself
(`have.aliases?.[entity]?.get(normalizeName(name))`) is single-valued per normalized name, so if two
aliases normalize alike `listAliasMap` silently keeps one. Worth a look at `listAliasMap`; `buildPlan`
itself needs no change.

### Finding 9 — owner decision recorded 2026-09-24: deferred, nothing changed

**Ruling: do not touch the export or import side. Spun out as
[T256](T256-locations-sheet-round-trip.md), status `parked`. Finding 9 is CLOSED in this ticket.**

The owner's reasoning, which T256 carries as its premise: making Locations id-matched is a
coordinated change on **both** sides plus a shape change to workbooks directors already hold, and the
underlying gap — a capacity edit updates nothing, because the round-trip is create-or-skip rather than
diff-and-update — **predates v73**. It is a product question about whether Locations should round-trip
at all, and it does not belong bolted onto a collision-hardening program.

Deferring leaves no silent failure. `locations` already carries a duplicate marker **and** a merge
verb, which is more than the other nine relaxed entities get, so the v73 duplicate case is visibly
surfaced today.

The measurements behind the finding, and the three constraints for whenever it is built —
`shoresh_id` FIRST, a blank or unknown id means "create" never an error, and a name-keyed lowest-id
tie-break is the WORST of the three options rather than a cheap middle path — are all recorded in
T256 so nobody re-derives them or reaches for the tie-break later.

### Also in scope — `schedule_weeks`

Unchanged and still open. See the recorded owner decision in
[T239](T239-duplicate-flag-on-eight-remaining-screens.md): the marker's home is a design question
about `ScheduleScreen`, with the week *picker* the named candidate. T239 now archives on its nine
in-scope entities, so this item is carried here rather than there.

### Slice status

- **Slice A — MERGED** (PR #530, squash `da94ffc8`): findings 1, 2, 3 plus the `daysByName` spillover the sweep found in
  the same file. Shared `src/ingest/mapWithCollisions.js`; the refusal is structural (a colliding key
  is deleted from the map, so a caller that ignores the `ambiguous` set still cannot bind to a wrong
  row).
- **Slice B — IN REVIEW** (PR #531): findings 4, 5, 6 — shipped. All three are XLSX-import `reader.onload` handlers with
  the same per-row `warning` + preview-then-confirm structure, so they share one treatment. Two
  spillovers belong here: `ActivitiesScreen`'s unconditional `locationIdByName.set()` for a row created
  in the loop is the same create-time eviction bug T252 fixed in `electron/ops/ingest.js` and
  `src/localClient.mock.js`, left un-fixed here; and `tierMap`/`actMap` there use bare `.toLowerCase()`
  with no trim, so they fold differently than ingest's `tierIdByName`.
- **Slice C — not started:** findings 7, 8, 10. Needs an array-level lowest-id helper — `nameMap` in
  `electron/ops/materializeImportedVersion.js` is db-bound and cannot be reused directly, and the
  array-shaped equivalent is currently inlined in `src/localClient.mock.js` and
  `electron/ops/ingest.js`'s `seedNameMaps`. Extract one and have `nameMap` delegate to it.
- **Finding 9 — CLOSED, deferred by owner decision** to T256. Not a slice.
