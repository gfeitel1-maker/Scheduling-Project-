---
title: "Shared anchor-exclusion helper for the ANCHOR_DUPLICATE finding (T182)"
document_type: adr
authority: normative
status: accepted
implementation_state: not_started
date: 2026-09-16
program: engine-data-seam
affects:
  - src/engine/buildSchedule.js
  - src/engine/anchorActivityLink.js
  - src/screens/schedule/useScheduleData.js
  - src/screens/ScheduleScreen.jsx
  - src/screens/schedule/useGeneration.js
  - src/screens/schedule/useSnapshots.js
---

# Shared anchor-exclusion helper for the ANCHOR_DUPLICATE finding (T182)

**Status: ACCEPTED 2026-09-16.** Implements T182 (`docs/work/tickets/T182-stale-anchor-duplicate-finding.md`), building on PR #443 (`src/engine/anchorActivityLink.js`).

## Problem
A GENERATED schedule persists its `template_slots`. `computeFindings` (`src/engine/buildSchedule.js`)
runs as an audit pass over those persisted slots — it does not re-run placement/exclusion. It is not
even passed `anchors` today. When a director re-keys an anchor's name after a schedule was generated,
Pass 1's `anchoredActivityIdsByGroup` (built at generation time, keyed by name via
`anchorActivityLink.js`, scoped per group) would now exclude a different activity than the one
actually excluded when the persisted slots were built — but nothing re-checks that against the
persisted slots. The stale regular slot sits on screen unflagged (the T62 double-placement class).

T62 already failed once from exactly this shape: the anchor→activity link was resolved in two places
that quietly drifted (`buildSchedule` Pass 1 vs. a test fixture that hand-built an `activity_id` no
real row carries). The fix here must not create a second occasion for the same drift — Pass 1's
per-group exclusion set and the finding's "is this (group, activity) anchored" check must be the same
computation, not two spellings of it.

## Decision: extract `anchoredActivityIdsByGroup` into `src/engine/buildSchedule.js`, exported

**Extraction boundary.** Lift Pass 1's block (`buildSchedule.js` L119–177: the week filter, the
`indexActivitiesByName`/`resolveAnchorActivityIds` name-resolution loop, and the
`unit_id > is_all_groups > group_ids` scope-resolution loop) into one pure exported function:

```js
export function anchoredActivityIdsByGroup(anchors, activities, groups, { days, weekId = null } = {})
  → Map<groupId, Set<activityId>>
```

Pass 1 calls it and keeps building `anchorLookup` (the day/block placement map) from the same filtered
`anchors` list, unchanged in behavior — pinned by the existing engine test suite. `computeFindings`
calls the identical function. Two call sites, one implementation: this is the anti-drift property the
ticket asks for, achieved by making the shared computation impossible to skip rather than by comment
or convention.

**Where it lives: `buildSchedule.js`, not `anchorActivityLink.js`.**
`anchorActivityLink.js`'s stated job (its own header comment) is narrower and more primitive: resolving
one anchor's *name* to catalog activity ids (`resolveAnchorActivityIds`), with no knowledge of groups,
day/week scoping, or the `unit_id`/`is_all_groups`/`group_ids` scope-resolution order. The per-group
Map is a second, higher-level computation that *uses* that link — it belongs next to Pass 1, whose
logic it literally is being extracted from, and next to `computeFindings`, its other caller, both of
which already live in `buildSchedule.js`. Moving it into `anchorActivityLink.js` would make that module
know about `groups`/`days`/`weekId`/scope order — a second responsibility bolted onto a module whose
whole value is being the one small place name-resolution happens. `buildSchedule.js` already exports
`computeFindings` alongside the default `buildSchedule` export, so a second named export is not a new
pattern for this file.
Confidence: high.

**Week scoping: the helper filters, callers pass unfiltered `anchors` + explicit `weekId`.**
Correcting the ticket's lean — verified in `src/screens/schedule/useScheduleData.js` L171 and L189:
`setupLists.anchors` is loaded **camp-wide, not week-filtered**; the week filter
(`schedule_week_id == null || schedule_week_id === weekId`) happens only inside Pass 1 today. So the
helper must accept `weekId` and do that filter itself (exactly the line it was extracted from) — it
cannot treat its `anchors` input as pre-scoped. Every call site already has a `weekId` in scope to pass
through:
- `useScheduleData.js` — `liveWeekId` is in scope at the L333 call site (defined L199, used through the
  `for (const r of routes)` loop starting L275).
- `ScheduleScreen.jsx` — component-level `weekId` state is in scope at the L499 `recalcFindings`
  wrapper.
- `useGeneration.js` — already threads `weekId` (used in its own `buildSchedule(...)` calls).
- `useSnapshots.js` — does not currently receive `weekId`; it must be added to its param list (passed
  from `ScheduleScreen.jsx`, which has it) alongside the `anchors` it will also need to receive (it
  does not receive `anchors` today either — both must be threaded through its call in
  `restoreSnapshot`).

`computeFindings` gains `anchors` and `weekId` as **optional** parameters: absent/empty `anchors` (or
`weekId` when not yet resolved) → no `ANCHOR_DUPLICATE` findings, matching the ticket's "safe default"
requirement and keeping every non-generated-route caller of `computeFindings` that doesn't thread these
through (if any remain after the four listed call sites are updated) inert rather than broken.

## Aggregate shape: `{ kind: 'ANCHOR_DUPLICATE', groupId, activityId, severity: 'caution', reason }`
Confirmed correct, recommended as specified in the ticket — this is not a close call. Reasons:
- `findingHighlight.js`'s `slotIdsForFinding` already derives slot ids from exactly this shape
  (`!s.is_anchor && s.activity_id && s.group_id === finding.groupId && s.activity_id ===
  finding.activityId`) — it was written generically for aggregate findings and needs zero changes.
  It already excludes anchor slots, which is exactly the "target the regular slot, not the anchor"
  requirement.
- `highlightMapForKind` and the `activeFindings` → `findingsRows` → rail pipeline (`ScheduleScreen.jsx`
  ~L562–668) are keyed by `kind` and iterate `{groupId, activityId}` shapes generically; a third
  aggregate kind (after UNDERSERVED/DISTRIBUTION) is additive, not a new code path.
- Dismissal keying (`groupId|activityId|kind`) already matches this shape with no change.
- A per-slot shape would require a fourth finding shape, a fourth branch in `slotIdsForFinding`/
  `highlightMapForKind`, and duplicates the WORK `anchoredActivityIdsByGroup` already does (excluding
  by group+activity, not by individual slot) — it would re-introduce per-slot bookkeeping the shared
  helper exists specifically to avoid.
Confidence: high.

## What must NOT leak from Pass 1 into the finding
The finding is a group-level, day-agnostic check, matching `anchoredActivityIdsByGroup`'s own
granularity (it discards day scoping when building the exclusion Set — an anchor scoped to a day still
excludes the activity for that group all week, matching T62's premise, quoted in `buildSchedule.js`
L128–129). Two Pass-1 details are placement mechanics that must stay in Pass 1 and never surface in
`computeFindings`:
- **Span-block tails.** Pass 1's `anchorLookup` marks tail blocks (`spanBlocks > 1`) separately from
  the head for grid placement. The finding only needs the per-group *exclusion Set*
  (`anchoredActivityIdsByGroup`'s return value) — span geometry is irrelevant to "is this activity
  anchored for this group," so the extracted helper returns only the Map, never `anchorLookup`.
- **`anchorLookup`'s day/block keys.** Not part of the extracted function's return value at all — it
  stays a Pass-1-local structure, built in Pass 1 using the *same* filtered `anchors` and
  `activitiesByName` the helper also uses, but not inside the extracted function.

The manual blank-week case (`placeAnchors` in `useGeneration.js`, anchors-only) is unaffected by
construction: `computeFindings`'s new check only fires when a *non-anchor* placed slot's
`(group_id, activity_id)` appears in the exclusion Map, and a blank week holds only anchor slots
(`s.is_anchor === true`, already excluded from `activitySlots` at `buildSchedule.js` L624) — so the
count of matching non-anchor slots is always zero. No special-casing needed in `computeFindings`
itself; this should still be asserted by a test (ticket item (c)), since it is an emergent property of
the two filters interacting, not a hard-coded rule.

## Files/modules affected
- `src/engine/buildSchedule.js` — extract and export `anchoredActivityIdsByGroup`; Pass 1 calls it;
  `computeFindings` gains `anchors`/`weekId` params and the new finding emission.
- `src/screens/schedule/useScheduleData.js` — thread `anchors: anc` and `weekId: liveWeekId` into the
  `recalcFindings` ctx at L333 (and the `recalcFindings` pure export's signature).
- `src/screens/ScheduleScreen.jsx` — thread `anchors`/`weekId` into the `recalcFindings` wrapper (L499).
- `src/screens/schedule/useGeneration.js` — thread `anchors`/`weekId` into its two `computeFindings`
  calls (L223 and the `placeAnchors` path).
- `src/screens/schedule/useSnapshots.js` — add `anchors` and `weekId` to the hook's param list; thread
  into the L171 `computeFindings` call.
- `src/screens/schedule/findingHighlight.js` — no code change; confirmed already compatible.
- Add `ANCHOR_DUPLICATE` to the `KIND_COLOR`/severity vocabulary wherever UNDERSERVED/DISTRIBUTION are
  enumerated for the rail (Maker locates via grep on `UNDERSERVED`).

## Reused vs. new
**Reused:** `indexActivitiesByName`/`resolveAnchorActivityIds` (#443, unchanged), the aggregate finding
shape and its full render/dismiss/highlight pipeline (zero new code there), Pass 1's scope-resolution
and week-filter logic (moved, not rewritten).
**New:** the extracted `anchoredActivityIdsByGroup` export itself, the `ANCHOR_DUPLICATE` emission loop
in `computeFindings`, and threading `anchors`/`weekId` through four call sites that don't carry them
today.

## ADR required: yes
This is an ADR because it changes an existing contract three other modules already call —
`computeFindings({ slots, groups, activities, days })` gains required-for-full-behavior parameters
(`anchors`, `weekId`), and a new pure function is promoted to a named export of `buildSchedule.js` that
Pass 1 itself now depends on. The extraction boundary (which file owns the per-group exclusion Map) is
exactly the kind of decision that caused T62's silent drift when left implicit — recording it durably
is the point.

## Open questions for Governor
1. **`useSnapshots.js` currently receives neither `anchors` nor `weekId`.** Confirm it should receive
   both as new hook params (sourced from `ScheduleScreen.jsx`, which already holds both) rather than,
   e.g., reading them from `routeState` — I did not find `weekId` on `routeState` and recommend passing
   it as a plain prop like the hook's existing `groups`/`activities`/`days` params, for consistency.
2. **Vocabulary/discoverability copy** ("also a fixed event this week — regenerate to clear") and the
   `KIND_COLOR` entry are product/copy decisions, not architectural ones — left to Maker/Designer per
   the ticket, not specified further here.
