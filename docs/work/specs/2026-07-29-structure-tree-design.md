---
title: "Structure tree (Programs → Units → Groups) — design"
document_type: spec
status: active
created: 2026-07-29
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: []
archive_when: the trial decision (§6) is recorded and this work is merged
---

# Structure tree (Programs → Units → Groups) — design

One screen showing the camp's org chart as an org chart, instead of three flat
tables that make the director reconstruct it by cross-reference.

**This ships as a trial, alongside the existing screens.** See §6.

## 1. The hierarchy is real and already in the schema

```
cohorts        (Programs)   id, camp_id, name
  └─ tiers     (Units)      id, camp_id, name, sort_order, cohort_id → cohorts.id
       └─ groups (Groups)   id, camp_id, name, tier_id, availability
```

Verified in `electron/db/schema.sql:132-163`. The parent links exist; the UI
just never draws them. `GroupsScreen` reduces a group's entire position in the
camp to a `<select>` (`GroupsScreen.jsx:34-37`) and renders a missing parent as
a bare `—` (`:27`), which is how an orphaned group becomes invisible.

Note the two levels are not symmetric: `tiers.cohort_id` participates in
`UNIQUE(camp_id, cohort_id, name)` — unit names are unique *within a program* —
while `groups` are camp-unique by name (`UNIQUE(camp_id, name)`). The tree must
respect both, and its inline-add validation differs by level accordingly.

## 2. Screen

New sidebar item **Structure**, first in the Setup section.

```
▾ Machaneh Aleph                        3 units · 14 groups
   ▾ Unit A                                       6 groups
        Bunk 1              full day
        Bunk 2              full day
        Bunk 3              mornings only
      + Add group
   ▾ Unit B                                       8 groups
        …
   + Add unit
▾ Machaneh Bet                          2 units · 9 groups
   …
+ Add program

⚠ Unassigned                                      2 groups
     Bunk 12             full day        → assign to a unit
     Bunk 14             mornings only   → assign to a unit
```

**Interactions**

- **Expand/collapse** per node; state persisted per device in `localStorage`
  (`shoresh-structure-expanded`), same rationale as table toolbar state — a
  view preference, never synced.
- **Inline add** at each level via the `+ Add …` affordance on the parent, so
  the new child's parent is implied by position rather than chosen from a
  dropdown.
- **Inline rename** on double-click.
- **Drag to reparent** — a group onto a unit, a unit onto a program. Uses
  `@dnd-kit/core` with the same `distance: 8` activation constraint
  ScheduleScreen already uses to coexist with click handlers. A drop writes a
  single field (`tier_id` or `cohort_id`) through the ordinary `write` path.
- **Roll-up counts** on every node.
- **Unassigned section**, always rendered when non-empty, never collapsed by
  default. This is the feature: orphans stop being invisible.

Units order by `sort_order` then name; groups and programs by name. Reordering
units by drag writes `sort_order`; the other two levels have no persisted order
to write.

## 3. What the tree must cover before it can replace anything

The three screens edit fields the tree must not silently drop:

| Field | Owner | Tree treatment |
|---|---|---|
| `cohorts.name` | Programs | inline rename |
| `tiers.name` | Units | inline rename |
| `tiers.sort_order` | Units | drag to reorder |
| `tiers.cohort_id` | Units | drag to reparent |
| `groups.name` | Groups | inline rename |
| `groups.tier_id` | Groups | drag to reparent |
| `groups.availability` | Groups | inline enum control on the row |

Delete at every level, matching the existing admin-only rule and routed through
the same `deleteEntity` path. With the trash/history work in place, a delete
here is recoverable and its confirm copy says so.

That table is the completeness checklist for the §6 decision. Anything it
misses is a blocker to retiring the flat screens, not a nice-to-have.

## 4. Reparenting validation

- Renaming a unit into a name already used **within its target program** is
  rejected with the existing duplicate-name error copy (`GroupsScreen.jsx:164`
  is the precedent).
- Dragging a unit into a program where its name already exists is rejected at
  drop time with an inline reason, not a modal — the drop simply does not take
  and the row springs back.
- Reparenting never cascades to `groups`: a group's `tier_id` is unchanged when
  its unit moves programs, because the group's parent has not changed.
- Reparenting a unit whose groups become ineligible for activities scoped to
  the old program is **allowed and flagged**, not blocked. The tree is not the
  place to enforce scheduling consequences; the schedule's own findings already
  report them and blocking here would strand the director mid-reorganization.

## 5. Composition with the other two specs

- The **Unassigned** section is an `EntityTable` with `decorate` returning
  `'warning'` — the tree does not hand-roll a table. This *is* a build-order
  dependency: Structure should follow the entity-table work. If it must land
  first, Unassigned renders as a plain list and is converted afterwards.
- Delete confirmations depend on the trash work for their "can be restored"
  copy. Not a build-order dependency — if Structure lands first, the confirms
  keep the current permanent-delete wording until trash lands.

## 6. Trial framing and the decision point

Per the decision to test separately, Structure ships **alongside**
`CohortsScreen`, `TiersScreen`, and `GroupsScreen`. All four are reachable.

This is deliberately the ambiguity the two-schedule model avoids — two ways to
do one thing — and it is accepted only because it is **time-boxed and has a
stated exit**. It must not become permanent by default.

**Decision point:** after one director has used Structure for a full setup pass
on a real camp. Retire the three flat screens if all hold:

1. Every field in §3's table is editable in the tree.
2. The director completed a full program/unit/group setup without falling back
   to the flat screens.
3. No orphan was created that the tree failed to surface.
4. Drag-to-reparent is reliable enough that the director trusts it — measured
   by observation, not by asking.

If they hold, retiring the three screens removes roughly 1,300 lines
(`CohortsScreen` 333 + `TiersScreen` 508 + `GroupsScreen` 474). If they do not,
the outcome is recorded in an ADR and Structure either gets another iteration
or is withdrawn. **"Leave both indefinitely" is not one of the outcomes.**

Record the result in `docs/adr/` either way.

## 7. Testing

`src/screens/StructureScreen.test.jsx`, plus a pure tree-builder module
(`src/screens/structureTree.js`) so the shape logic is testable without React:

- builds the three-level tree from flat `cohorts`/`tiers`/`groups` arrays
- a group with a null `tier_id` lands in Unassigned
- a group whose `tier_id` points at a deleted unit lands in Unassigned (not
  dropped, not crashed)
- a unit with a null `cohort_id` renders as an unassigned unit, not swallowed
- roll-up counts include descendants at both levels
- units sort by `sort_order` then name; ties are stable
- reparent writes exactly one field op, and the correct one per level
- a rename colliding within the target program is rejected and writes nothing
- a rename colliding in a *different* program is allowed (unit names are
  program-scoped, not camp-scoped)

## 8. Non-goals

- No new schema. Every write is an existing column.
- No fourth level.
- No multi-select or bulk reparent in the first cut.
- No merging of programs or units.
- Retiring the three flat screens is out of scope here — it is the §6 decision,
  and gets its own ticket.
