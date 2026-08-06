---
title: "T35 — Post-import activity rules: smart defaults and eligibility inference"
document_type: spec
status: draft-for-approval
created: 2026-08-06
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
related_tickets: [docs/work/tickets/T35-post-import-activity-configuration-at-scale.md]
archive_when: implemented and a real import produces a runnable generated schedule without manual per-activity editing
---

# T35 — Post-import activity rules: smart defaults and eligibility inference

## Problem statement

Right now a completed import puts a director in front of 30–60 unconfigured activities. Each one
needs `eligible_group_ids`, `min_per_week`, `max_per_week`, and `priority` set before
`buildSchedule` will do anything useful with it. Opening each activity individually to set these
is not a feasible workflow at scale. The consequence: directors skip configuration, the engine
generates a near-empty schedule, and the product feels broken rather than helpful.

**The goal is not zero post-import configuration — it is that a director gets a runnable generated
schedule immediately after import and only edits the exceptions, not every row.**

---

## What the parse already knows

`extractEntities.js` currently produces three signals that are passed downstream but not used to
configure activity rules:

| Signal | What it is | Where it lives |
|---|---|---|
| `activityPages` | Map: activity name → Set of page titles (group names) that had this activity | `extractEntities.js`, passed through but dropped before `commitIngest` |
| `seenCounts.activities` | Map: activity name → total cell appearances across all groups and days | Already in the preview result |
| `unitShare` | Map: activity name → max fraction of groups in any unit that did it | Already in the preview result |

These three signals together can answer, for every activity:
- **Which groups do it** (`activityPages`)
- **How often per week** (derived from `seenCounts` and the number of groups + days)
- **How broadly universal it is** (`unitShare`, signal for priority)

Nothing new needs to be parsed. The work is using what is already extracted.

---

## Proposed solution: infer then propose

A new pure function `inferActivityRules(entities, signals, groupIdByName, timeBlockCount)`
runs in the ingest pipeline between entity extraction and the preview. It returns one rule object
per activity:

```
{
  eligible_group_ids: [...],   // or null if "all groups"
  min_per_week: N,
  max_per_week: N,
  priority: 1 | 2 | 3,
  _inferred: true              // flag so the UI can mark these as proposals
}
```

The preview surface shows these rules alongside the entity names. The director can accept all,
edit any field inline, or clear a rule back to blank. What they accept or edit is what
`commitIngest` writes.

### Rule inference logic

**Eligibility (`eligible_group_ids`)**

Source: `activityPages[activityName]` — the set of group names that had this activity.

- Map group names → group IDs via the `groupIdByName` lookup (available once groups are
  proposed during the same preview build).
- If the activity appeared in every group (or every group in its dominant unit), set
  `eligible_group_ids = null` (engine reads null as "all groups eligible"). This avoids
  over-specifying universal activities.
- If the activity appeared in a strict subset, set `eligible_group_ids` to that subset's IDs.
- Minimum threshold: if fewer than 2 groups are matched and the overall appearance count is
  low, treat as ambiguous and set `eligible_group_ids = null` rather than guessing.

**Frequency (`min_per_week`, `max_per_week`)**

Source: `seenCounts.activities[activityName]` (raw cell count) ÷ number of eligible groups ÷
number of days.

```
appearances_per_group_per_week =
  seenCounts[name] / max(eligibleGroupCount, 1) / dayCount
```

- Round to the nearest integer, floor at 1.
- `min_per_week = appearances_per_group_per_week`
- `max_per_week = min_per_week + 1` (give the engine one slot of flexibility)
- Edge: if the computed value is 0 (activity appeared rarely, e.g. once across 20 groups),
  set `min_per_week = 1, max_per_week = 2` — a rare appearance is still a real activity,
  and a floor of 1 is the safest non-zero default.

**Priority**

Source: `unitShare[activityName]`.

| unitShare | Priority | Rationale |
|---|---|---|
| ≥ 0.8 | 1 (high) | Appears in most groups in its unit — a staple activity that must be placed |
| 0.4–0.79 | 2 (medium) | Appears in a meaningful fraction — fill if possible |
| < 0.4 | 3 (low) | Specialty or elective-shaped — placed last |

This matches how camp directors think about schedule priority: swimming for all senior bunks is
non-negotiable; ceramics for one specialty unit is a nice-to-have.

---

## Preview UI changes

The existing import preview (`ImportScreen.jsx`) shows proposed entities in lists. After this
work it also shows inferred rules for activities.

**Proposed treatment:**

- Activity proposals expand to show a compact rule summary: `2×/wk · Yeladim, Bogrim · Priority 1`
- Fields with inferred values show a subtle "inferred" marker (e.g. a small `~` prefix or a
  lighter text weight) so directors know which to trust vs. which to verify.
- Directors can edit any field inline in the preview — the same edit model as the existing
  keep-vs-replace choice, not a modal-per-activity.
- A "clear all inferred rules" action resets all activities to blank, for directors who prefer to
  configure from scratch.
- "Commit import" writes whatever is showing in the preview — edited or inferred, same code path.

**What does NOT change:**

- The commit is still atomic. Partial imports remain impossible.
- The director still explicitly confirms before anything is written.
- Activities that cannot be mapped (ambiguous names, welded parser artifacts) still appear but
  with blank rules and no inferred marker — the director must configure them or delete them.

---

## What the engine requires to generate a schedule

For `buildSchedule` to produce a non-empty result, each activity needs:
- `min_per_week >= 1` (otherwise it is skipped)
- At least one eligible group (null = all groups, which is valid)

`priority` and `max_per_week` affect quality but not whether the engine runs. So the minimum
viable outcome is: after import, every activity has `min_per_week >= 1` and a sensible eligibility
set. Smart defaults achieve this even if every inferred value is wrong — a director who generates
and sees "nothing was placed" knows they need to edit, and they're editing a generated schedule,
not blank forms.

---

## What this does NOT do

- Does not infer `prefer_before_day` or anchoring — these require judgement the grid does not
  encode.
- Does not infer block duration / multi-block spans. Assumes one time block per session (the
  current default). A director who needs double-length sessions edits that field individually.
- Does not change the commit model — still atomic, still director-confirmed.
- Does not replace the per-activity edit screens that already exist. Those remain for post-import
  refinement.

---

## Sequencing

- **Requires T33 closed first** — eligibility inference maps activity → group names → group IDs.
  If groups are not visible (T33 bug), the group ID lookup returns empty and eligibility falls back
  to null (all groups), which is still a valid default. So this can be built before T33 but the
  eligibility inference is only meaningful after T33 lands. T33 is already closed.
- **Independent of T36** — parser edge cases affect which activities are proposed, not how rules
  are inferred for the ones that are.

---

## Implementation surface

| Layer | Change |
|---|---|
| `src/ingest/extractEntities.js` | Thread `activityPages` through to the preview result (it may already be there — confirm) |
| `src/ingest/activityRules.js` (new) | Pure function `inferActivityRules(entities, signals, groupIdByName, dayCount)` → rule map |
| `src/ingest/activityRules.test.js` (new) | Unit tests: correct frequency formula, eligibility subset vs. null, priority thresholds |
| `src/screens/ImportScreen.jsx` | Pass inferred rules into preview; render compact rule summary per activity; inline edit |
| `electron/ops/ingest.js` — `commitIngest` | Accept and write rule fields alongside entity name fields |
| `electron/ops/projections.js` — `PROJECTIONS['activities']` | Add any new fields written by import to the registered field list |

---

## Acceptance criteria

1. After importing a real camp schedule, `buildSchedule` generates a non-empty result without the
   director opening a single activity.
2. Activities that appeared in a strict group subset have inferred `eligible_group_ids` matching
   those groups, marked as inferred in the preview.
3. Activities that appeared universally have `eligible_group_ids = null`.
4. `min_per_week` and `max_per_week` are non-zero for every proposed activity.
5. A director can edit any inferred field inline before committing.
6. Clearing inferred rules and committing produces activities with blank rules (same behavior as
   before this work).
7. `npm run test`, `npm run lint`, `npm run build` pass.
8. Tested end-to-end against at least one real camp file from `.ingest-incoming/` (never committed).
