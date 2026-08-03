---
title: "Schedule weeks become a first-class entity (Slice 1)"
document_type: adr
authority: normative
status: accepted
date: 2026-08-02
supersedes: []
implementation_state: in-progress
---

# ADR: Schedule weeks become a first-class entity (Slice 1)

## Context

A camp today holds up to two schedules — one Manual, one Generated — scoped
directly to the camp: `schedule_templates` has `UNIQUE(camp_id, kind)`
(migration v23, `docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`).
Directors run multiple actual weeks of programming (Week 1, Week 2, ...) but
the app has nowhere to put that: every camp is implicitly one week.

This is Slice 1 of a multi-week feature. It introduces the `schedule_weeks`
table and re-scopes the manual/generated uniqueness rule from per-camp to
per-week. It deliberately does NOT touch groups, activities, or any other
camp-wide setup entity, and does not add duplicate/delete/per-week-activities
— those are later slices.

## Decision

**Weeks are first-class, camp-scoped rows; the manual/generated pair scopes
to a week, not to the camp.**

- New table `schedule_weeks(id, camp_id, name, sort_order, is_archived)`,
  `UNIQUE(camp_id, name)`, synced exactly like `groups`/`tiers` (added to
  `DIRECT_CAMP_ENTITIES`, no other sync code).
- `schedule_templates` gains `week_id`. The uniqueness rule moves from
  `UNIQUE(camp_id, kind)` to `UNIQUE(week_id, kind)`.
- `template_slots` / `template_overlays` / `schedule_snapshots` are
  unchanged — they already reach the camp only transitively through
  `template_id -> schedule_templates`, so they now reach the week the same
  way, for free.
- Migration (forward-only, additive): create one `schedule_weeks` row per
  existing camp, named "Week 1"; add `schedule_templates.week_id`; point
  every existing `schedule_templates` row at that camp's Week 1 row; swap the
  unique index. Nothing is deleted. An older app build that doesn't know
  about `week_id` still reads/writes `schedule_templates` rows fine (the
  column is additive and nullable pre-migration); it just can't see multiple
  weeks — this is the rollback story.
- `schedule_weeks.id` is **deterministically derived** from `camp_id` for the
  migration-created "Week 1" row specifically — `schedule-week:${campId}:1`
  — for the same reason `deriveScheduleTemplateId` is deterministic: the
  migration runs independently on every device in the fleet, and two devices
  migrating the same camp without coordination must agree on the row's id or
  the week forks. Weeks created later by a director's explicit "New Week"
  action use `crypto.randomUUID()` like any other user-created row (there is
  no independent-device-mint race for those — one director, one click, one
  op-log entry that replicates).
- `deriveScheduleTemplateId`'s first argument changes meaning at every call
  site from `campId` to `weekId` (the function itself is untouched — it is
  generic over "the id of the thing this template pair belongs to"). This is
  the direct consequence of the uniqueness scope moving from camp to week:
  the same reasoning that required a deterministic id keyed to the camp now
  requires it keyed to the week.
- The route-resolution helpers in `ScheduleScreen.jsx`
  (`templateRowFor`, `resolveTemplateId`, `ensureTemplateRow`) and the
  fallback id in `useRouteState.js` (`templateIdFor`) change their filter/derive
  key from `campId` to the currently-selected `weekId`. Everything downstream
  of template-id resolution — `bulkReplace(templateId, ...)`, slot/overlay/
  snapshot loading filtered by `template_id` — is untouched, because it was
  already scoped by template id, never by camp id directly. This is what
  makes "rebuild only touches the current week+kind" fall out of the existing
  mechanism rather than requiring new scoping code.

## Candidates considered

1. **Weeks as first-class rows, templates gain `week_id`, uniqueness moves to
   `(week_id, kind)`.** (Chosen — this is the spec's Model A.) Matches the
   existing fresh-schema-vs-migrated-column pattern exactly (`kind` in v23),
   reuses `DIRECT_CAMP_ENTITIES` sync with zero new sync code, and the
   bulkReplace scoping guarantee is inherited for free because slots/overlays/
   snapshots already key off `template_id`, not `camp_id`.
2. **Encode the week as a `schedule_templates.week_label` TEXT column instead
   of a separate table**, with `UNIQUE(camp_id, week_label, kind)`. Rejected:
   no place to hang `sort_order`/`is_archived`/rename-without-losing-history;
   archiving a week would mean bulk-rewriting every template row's label
   string, and duplicate-a-week (a named future slice) has no anchor row to
   copy from. Fails the spec's explicit requirement for a `schedule_weeks`
   table.
3. **Keep `UNIQUE(camp_id, kind)` and add a `week_id` filter only at the
   query layer (no schema uniqueness change)**, treating "one manual +
   one generated per camp, tagged by week" as an application-level
   convention. Rejected: it does not actually prevent two generated rows for
   the same week, which is the entire integrity guarantee slice 1 exists to
   provide, and it would silently allow the exact fork bug `docs/adr/
   2026-07-28-plural-candidate-schedules-per-camp.md` was written to close,
   one level up.
4. **Store week selection as global renderer state (module-level, not React
   state) instead of a screen-level `weekId` alongside `route`.** Rejected as
   a trap: `useRouteState`/`useGeneration`/`useSnapshots` already take
   `campId`/`route` as hook inputs and re-derive on change; a week is
   symmetrically "a second axis alongside route," not a different kind of
   state, and module-level state would break the existing op-applied reload
   effect's dependency tracking for no benefit.

Traps flagged and avoided: adding a `current_week_id` column on `camps`
(implies one canonical week, contradicting "switching weeks is pure
navigation, nothing designated as active" — same principle as the two-route
ADR); a `PARENT_SCOPED_ENTITIES` entry for `schedule_weeks` (wrong — it is
camp-scoped directly, not reached through a parent, so it belongs in
`DIRECT_CAMP_ENTITIES` alongside `groups`/`tiers`, matching how
`schedule_templates` itself is already direct-camp-scoped, not parent-scoped).

## Consequences

- The two-route model (manual/generated, neither canonical) is preserved
  exactly, just re-scoped one level down — from camp to week. No route
  vocabulary or flag semantics change.
- Rebuilding the generated schedule for the selected week cannot affect any
  other week's slots, because it can only ever resolve and `bulkReplace`
  the `template_id` belonging to `(selectedWeekId, 'generated')`.
- A pre-Slice-1 install upgrading picks up exactly one week ("Week 1") per
  camp holding both of that camp's existing schedules — a no-op from the
  director's point of view until they use the new switcher.
- Setup entities (groups/activities/days/etc.) remain camp-wide and shared
  across weeks in this slice, as scoped. Per-week variance is explicitly
  deferred.
- `deriveScheduleTemplateId`'s call-site semantics (campId → weekId) is a
  documentation/comment update at minimum in every file that references it;
  Maker must update the header comments in `electron/ops/scheduleTemplateId.js`
  and `ScheduleScreen.jsx`'s `templateRowFor` doc comment, not just the code,
  since those comments are the load-bearing explanation the next reader
  relies on (matching this codebase's existing documentation density).

## Rollback

Migration is additive-only and forward-only per project convention (no down
migration file is written for schema-adding migrations, consistent with
v23-v26). Rollback means running an older app build against a migrated db:
`week_id` is a column the old build's queries don't reference, so old-build
reads/writes of `schedule_templates` by `(camp_id, kind)` continue to work
UNLESS a camp has been given a second week by the new build — in which case
the old build's `(camp_id, kind)` query will ambiguously match more than one
row (one per week) and must pick one, which is a known and accepted
limitation of running an old build after adopting the new feature, not a
migration defect. This mirrors how v23's rollback story already treats
"an old build after a camp gets its second route."
