---
title: "Derived duplicate flag on the nine in-scope relaxed entities"
document_type: ticket
status: completed
created: 2026-09-23
archive_when: each of the NINE in-scope relaxed entities shows a derived, never-persisted duplicate marker on its own screen, clearing the moment the list stops holding two matching rows; schedule_weeks is explicitly excluded by the recorded owner decision below and its marker is not a condition of archiving
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md]
related_adrs: [docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md]
related_tickets: [docs/work/tickets/T241-relax-name-unique-constraints-schema-v73.md]
---

# T239 — Derived duplicate flag on the nine in-scope relaxed entities

## Why

Success predicates 2 and 3 of the spec: each of two same-named rows carries a duplicate flag on the
owning screen on both devices, derived — not stored, not broadcast — and it clears when the director
renames or deletes one using controls that screen already has.

## The flag already exists and is shipped — reuse it, do not rebuild it

`src/screens/duplicateSiblings.js` exports `groupDuplicatesByName(rows, {near})` and
`duplicateSiblingsByIdFor(rows, options)`: a render-time, renderer-side derivation over the list the
screen has already fetched, normalized by `normalizeWordKey`, with its own test file. `LocationsScreen`
(exact matching, via `locationDuplicates.js`) and `ActivitiesScreen` (`{near:true}`) both already render a
marker off it.

**Consequences, which correct the ADR:**

- **No new IPC.** The ADR proposes a `GROUP BY camp_id, <field> HAVING COUNT(*) > 1` IPC read per screen.
  That is redundant, and worse: it would be a **second, divergent notion of "the same name"** alongside
  `normalizeWordKey` — precisely the drift `duplicateSiblings.js`'s own header says it was extracted to
  prevent. The derivation stays in the renderer.
- **`normalizeWordKey`, not `normalizeName`.** The spec names `normalizeName`; the shipped markers use
  `normalizeWordKey`. Match the shipped markers.
- ADR open question 3 (per-screen vs shared abstraction) is answered: the shared abstraction already
  exists and is tested. Use it.

## Success predicate (observable)

1. **Nine of the ten relaxed entities carry the marker.** Seven of the nine are in scope here — `events`,
   `elective_sets`, `groups`, `cohorts`, `tiers`, `time_blocks`, `special_days` — across **six** screens,
   because `SpecialEventsScreen` owns two of them (`events` and `special_days`) behind two separate
   sibling maps. `locations` and `activities` already had it and are **not** touched. ~~`schedule_weeks`~~
   is the tenth and is **excluded** — see "Owner decision, 2026-09-24" below.

   _Prior: this predicate read "Eight screens gain the marker: Events, Elective Sets, Groups, Cohorts,
   Tiers, Time Blocks, Schedule Weeks, Special Days". Two errors: it listed Schedule Weeks, contradicting
   the owner decision recorded at the foot of this ticket, and it counted screens as if `events` and
   `special_days` had one screen each. Nine entities, not ten; seven in scope across six screens._
2. Each uses `duplicateSiblingsByIdFor` with **exact** matching (the `near` heuristic is
   Activities-specific and tuned against real workbooks; do not spread it).
3. **Tiers and Time Blocks are cohort-scoped.** Their marker must group within a cohort, not across the
   whole camp, or it will flag two legitimately distinct same-named tiers. If the screen already renders
   one cohort at a time, passing that cohort's rows is sufficient — verify, do not assume.
4. The marker is **informational**: it names the sibling and says to rename or delete one. **No merge
   action** on these eight — reference-aware merge is a stated non-goal, and the merge verbs on Locations
   and Activities are pre-existing entity-specific features, not the pattern to copy.
5. Derived at render time from the fetched list. Nothing persisted, nothing broadcast, no new state. It
   clears on both devices the moment the document stops holding two such rows.
6. Never blocks a create. Art. V: flag, never block.
7. No banner. The flag lives in the per-row flag vocabulary.

## Non-goals

Touching Locations or Activities. A merge verb. Spreading `near` matching. New chrome.

## Owner decision, 2026-09-24 — `schedule_weeks` is deliberately unmarked

`schedule_weeks` is one of the ten relaxed entities but has **no** duplicate marker, and that is a
decision rather than an omission. Weeks are authored inside `src/screens/ScheduleScreen.jsx`, which
is under the standing owner rule to protect the grid's restraint, so adding a marker there is a design
question about that screen rather than a mechanical extension of the pattern used on the other nine.

Two further reasons it is the safest of the ten to leave unmarked: a week is chosen from a list rather
than resolved by name anywhere in the engine, and `schedule_weeks` was the single plain-named-index
case in the v73 relax (never an inline `UNIQUE`), so nothing about its rebuild is load-bearing here.

Where the marker belongs is a **design question about `ScheduleScreen`**, to be answered on its own and
not folded into the mechanical extension this ticket covers. The candidate the owner named as the
plausible home is the week *picker* control (where a director chooses a week, so the duplicate surfaces
exactly when it could confuse someone) rather than the canvas itself.

The decision stands, and the exclusion is deliberate rather than an oversight.

**How this stays visible without making the ticket unarchivable.** The original wording said
`archive_when` "already covers it: this ticket cannot archive while any of the ten lacks a marker". That
was wrong, and it is corrected above: since the owner decision means the tenth marker may never be
built, that phrasing made this ticket **permanently unarchivable** even after all nine in-scope markers
shipped — a status-drift check would then trip on work that is in fact complete. `archive_when` now
counts the nine. The `schedule_weeks` design question is carried instead by
[T255](T255-name-keyed-lookups-assume-uniqueness.md)'s "Also in scope" section, which is open, so the
decision cannot quietly become permanent by being forgotten — only by being made again, deliberately.

## What shipped

All nine in-scope entities render the marker, verified against the tree on 2026-09-24:

| Entity | Screen | Marker |
|---|---|---|
| `locations` | `src/screens/LocationsScreen.jsx` | pre-existing, via `locationDuplicates.js` (merge verb) |
| `activities` | `src/screens/ActivitiesScreen.jsx` | pre-existing, `{near:true}` (merge verb) |
| `events` | `src/screens/SpecialEventsScreen.jsx` | `duplicateEventSiblings` → `DuplicateNameDot` |
| `special_days` | `src/screens/SpecialEventsScreen.jsx` | `duplicateDaySiblings` → `DuplicateNameDot` |
| `elective_sets` | `src/screens/ElectivesScreen.jsx` | `duplicateSetSiblings` → `DuplicateNameDot` |
| `groups` | `src/screens/GroupsScreen.jsx` | `duplicateGroupSiblings` → `DuplicateNameDot` |
| `cohorts` | `src/screens/CohortsScreen.jsx` | `duplicateCohortSiblings` → `DuplicateNameDot` |
| `tiers` | `src/screens/TiersScreen.jsx` | `duplicateTierSiblings` → `DuplicateNameDot` |
| `time_blocks` | `src/screens/TimeBlocksScreen.jsx` | `duplicateBlockSiblings` → `DuplicateNameDot` |
| ~~`schedule_weeks`~~ | `src/screens/ScheduleScreen.jsx` | **deliberately absent** — owner decision below |

Predicate 3 (cohort scoping) is satisfied structurally rather than by a scoping argument passed to the
derivation: `TiersScreen` and `TimeBlocksScreen` both filter their fetched rows to
`camp_id === campId && cohort_id === <active cohort>` before `setState`, and the memo derives over that
already-scoped state. Two same-named tiers in different cohorts are never in the same list, so they
cannot be grouped.

Predicate 4 is satisfied by `src/components/setup/DuplicateNameDot.jsx`, which passes no `actions` to
`ProvenanceDot` and therefore renders no footer at all — there is no merge verb to accidentally reach.
