---
title: "Manual-route week exclusions — design"
document_type: spec
status: active
created: 2026-08-16
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-08-15-camp-locations-entity.md, docs/adr/2026-07-28-schedule-flag-findings-reshape.md]
related_specs: [docs/work/specs/2026-07-28-schedule-flag-findings-reshape-design.md]
archive_when: this work is merged and Verifier PASS recorded
---

# Manual-route week exclusions — design

## Problem

Week-scoped exclusions (`week_activity_exclusions`, `week_group_exclusions`) —
"this activity / group does NOT run in this week" — are enforced **only on the
generate route**, via the `resolveWeekCatalog` pre-pass
(`src/engine/weekCatalog.js`, called from `src/screens/schedule/useGeneration.js`).
The **manual drag-drop route** (`src/screens/schedule/useSlotMutations.js`,
`src/utils/computeOverlaps.js`) consults **no** exclusions. So a director
hand-building a week can place an activity, or an activity for a group, into a
week where it is marked closed — with no warning and no marker.

This spec closes that gap for the two exclusion types that are **live on
`origin/main` today** (activity + group). The third type, location
(`week_location_exclusions`), is deliberately **out of scope** here — see §6.

## Non-goals / scope boundaries

1. **Location exclusions.** On `origin/main`, `week_location_exclusions` is only
   DB/sync/projection plumbing (schema v32). There is no availability UI to
   create one, `repo.loadWeekExclusions` does not return them, and
   `resolveWeekCatalog` does not filter on them — the generate route does not
   honor them either. The M5 slice
   (`claude/locations-m5-week-availability`, unmerged, not on origin) adds that.
   Inventing manual-route location semantics before M5 finalizes the generate
   semantics would fork/duplicate M5's work. This design is **structured so the
   location branch is a small addition** once M5 merges (§6).
2. ~~Generated-route post-generation edits.~~ **Now handled.** `WEEK_CLOSED`
   derives on **both** routes — a closed-week placement is equally wrong on
   either, and the generated candidate can acquire one after generation (a drag
   edit, or an activity/group marked closed after the week was built) that
   `resolveWeekCatalog` cannot catch up front. See §Approach. (`OVERLAP` stays
   manual-only — that is a genuine product stance about clashes, not an
   oversight.)
3. **Per-slot anchor flagging.** Anchor *cells* are skipped by the derived flag,
   exactly as `computeOverlaps` skips `s.is_anchor`. Instead, `placeAnchors` now
   runs the same `resolveWeekCatalog` pre-pass as `generate()`, so an excluded
   activity's anchor (or a fully-excluded group's) is never laid down in the
   first place — the consistent place to enforce it for structural cells.
4. **No schema change.** The exclusion tables already exist.
5. **No change to the write path.** `useSlotMutations.js` is not touched.

## Approach: a soft, derived flag (mirror OVERLAP)

A week-closure violation is surfaced as a new derived per-slot flag,
`WEEK_CLOSED`, with the **same lifecycle as `OVERLAP`**:

- **Derived at render time**, never persisted, on **both routes**. It is a pure
  function of (slots on screen + this week's exclusion rows), so it can never go
  stale and clears the instant the director moves the placement or re-opens the
  week. Because it is derived rather than stamped at write time, it covers every
  placement path — drag, click, paste, inline-create — with no change to the
  write handlers, and catches placements that predate the exclusion (an activity
  marked closed after the week was built).
- **Soft, never blocks.** The placement succeeds and is marked. A director
  building their own week is never blocked and never has a placement silently
  corrected (CONSTITUTION Art. V; the same posture `placeActivityManual` already
  documents for capacity clashes).
- **Non-dismissible.** Like OVERLAP, there is nothing to dismiss — it goes away
  by fixing the underlying condition.
- **Caution severity**, distinct hue/marker from OVERLAP so the two do not read
  alike (`slotCellConstants.js` deliberately separates severity from hue for
  exactly this "4th kind").

Rationale for derived-not-blocking-not-dismissible, three independent signals:
(1) constitutional posture — manual route never blocks/corrects;
(2) OVERLAP is the established precedent for a manual-route conflict marker and
is derived + non-dismissible;
(3) the condition is fully determined by slot content + exclusion rows, so a
live-derived representation is the only one that cannot drift.

## Components

### 1. `src/utils/computeWeekClosures.js` (new, pure)

Sibling to `computeOverlaps.js`.

```js
// activityExclusions / groupExclusions are exclusion rows; each row means the
// referenced entity does NOT run in `week_id`. Callers pass the rows already
// loaded for the current week (repo.loadWeekExclusions(weekId)); weekId is
// still accepted and re-filtered defensively, mirroring resolveWeekCatalog.
export function computeWeekClosures({
  slots, activities, groups, activityExclusions, groupExclusions, weekId,
}) // -> Map(slotId -> reason string)

export function withWeekClosureFlags(slots, args) // -> slots with flags.WEEK_CLOSED / WEEK_CLOSED_reason
```

Rules (mirroring `computeOverlaps`):

- Skip `s.is_anchor` and empty (`!s.activity_id`) slots.
- A slot is flagged if its `activity_id` is in the excluded-activity set **or**
  its `group_id` is in the excluded-group set. Both → reasons joined with `; `
  (same shape as OVERLAP's joined reasons).
- Reason text is director language, using entity names:
  - activity: `"<Activity> is marked closed this week"`
  - group: `"<Group> is marked closed this week"`
- Fast-path: if both exclusion sets are empty, return an empty Map (no
  allocation churn on the common case).
- `weekId`, when provided, filters the rows (`row.week_id === weekId`) before
  building the sets — defensive parity with `resolveWeekCatalog`.

### 2. `src/screens/ScheduleScreen.jsx`

- Apply the new decorator to `rawSlots` on **both routes**, then layer the
  manual-only `withOverlapFlags` on top for the manual route, in the same
  `useMemo` that builds `flagSlots`:
  ```js
  const withClosures = withWeekClosureFlags(rawSlots,
    { activities, groups, activityExclusions, groupExclusions, weekId })
  return route === 'manual'
    ? withOverlapFlags(withClosures, activities, locations)
    : withClosures
  ```
  (`activityExclusions`, `groupExclusions`, `weekId`, `groups` are all already
  in scope.) Add them to the `useMemo` dependency array.
- Add `WEEK_CLOSED` rows to `findingsRows`, mirroring `overlapSlots`, but NOT
  gated to the manual route (the flag derives on both):
  `weekClosedSlots = flagSlots.filter(s => s.flags?.WEEK_CLOSED)`,
  mapped to `{ kind: 'WEEK_CLOSED', severity: FLAG_SEVERITY.WEEK_CLOSED,
  reason: s.flags?.WEEK_CLOSED_reason, ... }`.
- `dismissFindingsRow`: `WEEK_CLOSED` is non-dismissible — extend the OVERLAP
  guard so `WEEK_CLOSED` also falls through without calling `dismissFinding`.
- `legendEntriesFor`: `WEEK_CLOSED` stays in BOTH routes' legends (only
  `UNFILLABLE`/`OVERLAP` are route-specific).

### 2b. `src/screens/schedule/useGeneration.js` (`placeAnchors`)

Run the same `resolveWeekCatalog` pre-pass `generate()` runs, and pass the
week-effective `groups`/`activities`/`anchors` to `buildSchedule` (and to the
post-load `computeFindings`), so the manual blank week never lays down an anchor
for a closed activity or a fully-excluded group.

### 3. `src/components/schedule/slotCellConstants.js`

- `FLAG_COLORS.WEEK_CLOSED` — a distinct caution-family hue (see §5).
- `FLAG_SEVERITY.WEEK_CLOSED = 'caution'`.
- A `WEEK_CLOSED_ENTRY` legend entry: `label: 'Closed this week'`, `shape: 'dot'`,
  `description: 'Marked not to run this week'`, added to `LEGEND_ENTRIES`.

### 4. `src/components/schedule/SlotCell.jsx`

- `const isWeekClosed = Boolean(flags.WEEK_CLOSED)`.
- Render a corner marker (dot) titled `flags.WEEK_CLOSED_reason`, in a corner
  that does not collide with OVERLAP / UNFILLABLE / outdoor. Add the matching
  `.flag--week-closed` rule in `src/components/schedule/scheduleGrid.css`
  (the scoped-exception stylesheet) for position, mirroring `.flag--overlap`.

## 5. Visual detail (adjustable)

The exact hue/glyph is the director's aesthetic call, like OVERLAP's color.
Proposed concrete starting value: reuse the caution family but a distinct token
from OVERLAP's `--accent` — e.g. `--secondary` (slate) as the `WEEK_CLOSED` dot
— so OVERLAP (bronze) and WEEK_CLOSED (slate) are separable by hue while both
stay out of the reserved red. Kept adjustable; the binding constraint is the
`slotCellConstants.test.js` separation invariant, not the exact value.

## 6. Forward-compat for location (fast-follow, after M5)

`computeWeekClosures` accumulates reasons per slot in a single loop; adding
location is a small, isolated addition once M5 lands:
- accept `locationExclusions` + resolve each slot's activity `location_id`;
- if the slot's location is in the excluded-location set, push a
  `"<Place> is marked closed this week"` reason.
The screen wiring (loader returning location rows, passing the array) mirrors
whatever shape M5 finalizes on the generate route — not invented here.

## 7. Testing (test-first at the placement seam)

The placement handlers are unchanged; the testable seam is "what the manual grid
derives from a placement".

1. **`src/utils/computeWeekClosures.test.js`** (pure, exhaustive):
   activity-excluded flags the slot; group-excluded flags the slot; both →
   joined reason; a row for a different `week_id` is ignored; anchor slots are
   skipped; empty slots are skipped; no-exclusions returns an empty Map;
   reason text carries the entity name.
2. **Grid integration tests** (real `ScheduleScreen` mount, both routes): a
   placed excluded activity renders the `WEEK_CLOSED` marker and keeps the
   placement — on the manual route AND the generated route; a control without
   the exclusion shows no marker. Plus `normalizeSlots` strips a persisted
   `WEEK_CLOSED`, `rowFlags` treats it as advisory, and `SlotCell` renders it.
3. **`placeAnchors` pre-pass** (`useGeneration.test.js`, real
   `resolveWeekCatalog`): a closed activity's anchor is suppressed from the
   inputs handed to `buildSchedule`; a no-exclusion control leaves them intact.

## 8. Success predicate

On **both** routes, for the current week's activity and group exclusions: every
filled non-anchor slot whose activity or group is marked closed this week shows a
soft `WEEK_CLOSED` marker and a findings-rail row; the marker clears when the
placement is moved off or the exclusion is lifted; placement is never blocked.
The manual blank week (`placeAnchors`) suppresses closed-activity / closed-group
anchors up front, matching `generate()`. The write path and schema are
unchanged. `npm run verify` passes.
