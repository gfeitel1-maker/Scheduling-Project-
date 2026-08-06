---
title: "Inferred activity scheduling rules at ingest"
document_type: adr
authority: normative
status: accepted
date: 2026-08-06
supersedes: []
implementation_state: complete
affects: [docs/work/specs/T35-post-import-activity-rules.md, docs/work/tickets/T35-post-import-activity-configuration-at-scale.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md, docs/adr/2026-08-03-ingesting-recurring-fixed-events.md]
---

# Inferred activity scheduling rules at ingest

Resolves the design questions behind [T35](../work/specs/T35-post-import-activity-rules.md).
Records two decisions made during implementation, both required to make the spec buildable against
the actual data model.

---

## Decision 1 — rules travel as group NAMES, resolved to IDs at commit

The spec's proposed signature, `inferActivityRules(..., groupIdByName, ...)`, assumes group IDs
exist at preview time. They do not: proposed groups have no IDs until `commitIngest` mints them with
`randomUUID()` inside its transaction (`electron/ops/ingest.js`). `inferActivityRules`
(`src/ingest/activityRules.js`) therefore returns `eligible_group_names: string[] | null` (`null` =
all groups), not `eligible_group_ids`. `ImportScreen` sends rules to `commitIngest` keyed by
activity name, carrying group names. `commitIngest` resolves names to IDs using the
`groupIdByName` map it already builds and extends as it creates rows — `groups` runs before
`activities` in `INGESTIBLE_ENTITIES`, so the map is fully populated by the time the activities loop
resolves rules. This mirrors the precedent already set by recurring fixed events
(2026-08-03-ingesting-recurring-fixed-events.md), which resolve block/day/group names the same way.

A group name that fails to resolve (the director unticked that group in the same preview) is
dropped from the list. If every name for an activity fails to resolve, no `eligible_group_ids` is
written at all — the field is left absent, which the read boundary
(`src/utils/normalizeActivityEligibility.js`) treats as "no restriction" (all groups), not
"restricted to nothing."

## Decision 2 — `eligible_group_ids` is a JSON-stringified array, never `'[]'`

The activities table stores `eligible_group_ids` as `JSON.stringify([...])`, with `NULL`/absent
meaning "no restriction" (`electron/db/schema.sql`, `src/utils/normalizeActivityEligibility.js`).
`'[]'` is a two-character truthy string that the read boundary parses as "restricted to nothing" —
a distinct, previously-hit bug class in this codebase. `commitIngest` therefore only ever writes the
field when at least one group name resolved; it is never written as `'[]'`.

---

## Decision 3 (round 2 ruling) — `priority` is two-valued end to end, not converted at a boundary

Round 1 flagged, but did not resolve, a conflict between the spec's three-level `priority`
(1/2/3, "High/Medium/Low") and the actual `activities.priority` contract: `ActivitiesScreen.jsx`
writes and displays only `'high'`/`'low'`, and `buildSchedule.js`'s `runRound` (lines ~318-320) runs
exactly two rounds and only ever filters for `priority === 'high'` or `priority === 'low'`. A third
value is not degraded gracefully — it is silently unplaceable in either round, which would have
defeated T35's own acceptance criterion 1 ("`buildSchedule` generates a non-empty result").

Round 1's implementation kept three levels internally and converted at the `ImportScreen.jsx`
commit boundary (`1` → `'high'`, `2`/`3` → `'low'`). Round 2 ruling (product owner via Governor):
**the spec's 1/2/3 is wrong, not the data model** — extending `buildSchedule`'s two-round contract
to a third tier is out of scope for T35. `inferActivityRules` now returns `priority: 'high' | 'low'`
directly (`unitShare >= 0.8` → `'high'`, otherwise `'low'`), the preview `<select>` offers exactly
those two options, and no conversion happens anywhere — a value the engine can't read is never
produced in the first place, not translated at a later boundary. `commitIngest` additionally
validates at the write boundary (`priority === 'high' || priority === 'low'`, else the field is
dropped) rather than trusting the caller, per round 2 Fix 4.

The spec's own rationale for the three tiers — "swimming for all senior bunks is non-negotiable;
ceramics for one specialty unit is a nice-to-have" — describes exactly two categories, so the
collapse loses no information the spec's own reasoning depended on.
