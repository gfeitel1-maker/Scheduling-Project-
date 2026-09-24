---
title: "Derived duplicate flag on the eight relaxed screens that lack one"
document_type: ticket
status: open
created: 2026-09-23
archive_when: every one of the ten relaxed entities shows a derived, never-persisted duplicate marker on its own screen, clearing the moment the list stops holding two matching rows
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md]
related_adrs: [docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md]
related_tickets: [docs/work/tickets/T241-relax-name-unique-constraints-schema-v73.md]
---

# T239 — Derived duplicate flag on the eight remaining relaxed screens

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

1. Eight screens gain the marker: Events, Elective Sets, Groups, Cohorts, Tiers, Time Blocks, Schedule
   Weeks, Special Days. Locations and Activities already have it and are **not** touched.
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

Decide where the marker belongs **as part of this ticket**, alongside the eighth screen, with a proper
look at `ScheduleScreen` — not as a tail-end addition to a migration review. The candidate the owner
named as the plausible home is the week *picker* control (where a director chooses a week, so the
duplicate surfaces exactly when it could confuse someone) rather than the canvas itself.

Until then the gap is known and accepted. `archive_when` above already covers it: this ticket cannot
archive while any of the ten lacks a marker, so the decision cannot quietly become permanent.
