---
title: "Surface a stale anchor/regular duplicate in an already-generated schedule (ANCHOR_DUPLICATE finding)"
document_type: ticket
status: completed
created: 2026-09-16
task_class: scheduling-engine
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-09-16-anchor-duplicate-finding.md]
depends_on: "PR #443 (branch claude/cranky-sammet-61b062) — src/engine/anchorActivityLink.js; and gracious-thompson's T180 (anchor GROUP scope via anchorScope.js/resolveAnchorGroupIds — a DIFFERENT feature, shares only buildSchedule.js). AGREED MERGE ORDER (all three editors): #443 → gracious T180 → this (T182 lands last, absorbs the rebase)."
archive_when: computeFindings emits ANCHOR_DUPLICATE (generated route only) from the shared per-group anchor-exclusion helper, the finding renders in the rail + lights the duplicate slot, E2E tests cover the genuinely-stale-fires / freshly-generated-in-sync-does-not pair plus the week-closed-activity suppression case, and `npm run verify` is green
---

# T182 — Stale anchor/regular duplicate finding (ANCHOR_DUPLICATE)

**Closed 2026-09-18.** `archive_when` met. `ANCHOR_DUPLICATE` is emitted from
`src/engine/buildSchedule.js` via the shared per-group anchor-exclusion helper, keyed through
`src/screens/schedule/findingKey.js`, and rendered by `src/screens/ScheduleScreen.jsx`
(generated route only). The agreed merge order held: #443 → T180 → this.

Shipped as #445.

## Confirmed problem (do not re-litigate)
An anchor (`anchor_activities`) references its activity BY NAME. PR #443 makes an anchor's name
load-bearing for scheduling exclusion, resolved at BUILD time via `src/engine/anchorActivityLink.js`
and applied PER GROUP in `buildSchedule` Pass 1 (`anchoredActivityIdsByGroup`, scope order
`unit_id > is_all_groups > group_ids`).

A GENERATED schedule persists its `template_slots`. On ordinary screen load,
`useScheduleData.js` runs `recalcFindings` → `computeFindings` over the PERSISTED slots only — an
audit pass, NOT a placement/exclusion re-run, and it is not even passed `anchors`. So when a
director later re-keys an anchor's name (via `confirmAlias`/`confirmCompoundCellPattern` steering a
re-import, or a direct AnchorsScreen rename), the already-generated schedule keeps a phantom regular
slot that a fresh build would now EXCLUDE (the T62 double-placement class, e.g. Lunch as both its
fixed anchor and a regular slot). Nothing invalidates, regenerates, or flags it. CONFIRMED.

Manual route uses OVERLAP (derived at render); generated route uses UNFILLABLE. This staleness is
specific to the generated route's PERSISTED slots.

## Fix
Emit a new finding kind `ANCHOR_DUPLICATE` (severity `caution`) from `computeFindings` for each
non-anchor placed activity slot whose (group, activity) is anchored for that group by a live anchor.

**Anti-drift is the whole point of this ticket.** T62 silently placed nothing for a month because the
anchor→activity link was resolved in two places that drifted. `computeFindings` must decide "anchored
for this group" through the SAME code path as Pass 1 — not a re-spelling. Extract Pass 1's per-group
resolution into one shared pure helper and call it from both. See ADR
`docs/adr/2026-09-16-anchor-duplicate-finding.md`.

## Done
- [ ] Shared helper `anchoredActivityIdsByGroup(anchors, activities, groups, { days, weekId })` →
      `Map<groupId, Set<activityId>>`, extracted from `buildSchedule` Pass 1 and reused there (Pass 1
      behaviour unchanged, pinned by existing engine tests) and by `computeFindings`. Reuses
      `indexActivitiesByName`/`resolveAnchorActivityIds` from #443 — the key is NOT re-spelled a third
      time.
- [ ] `computeFindings({ slots, groups, activities, days, anchors })` emits
      `{ kind: 'ANCHOR_DUPLICATE', groupId, activityId, severity: 'caution', reason }` for each
      (group, activity) that has ≥1 non-anchor placed slot AND is anchored for that group. One finding
      per (group, activity) pair (aggregate shape, like UNDERSERVED). Absent/empty `anchors` → no such
      finding (safe default).
- [ ] Thread `anchors` into `recalcFindings` ctx + its `useScheduleData.js` call site (~L333) and the
      `ScheduleScreen.jsx` `recalcFindings` wrapper (L499). Also `useSnapshots.js` and
      `useGeneration.js` computeFindings calls — the manual blank-week `placeAnchors` case must NOT
      false-positive (it holds only anchor slots, no regular slots → no finding; verify).
- [ ] Rail + cell surfaces: `ANCHOR_DUPLICATE` flows through `activeFindings` → `findingsRows`
      unchanged; add its `KIND_COLOR` entry and make it discoverable consistent with existing
      vocabulary. `slotIdsForFinding`/`highlightMapForKind` already exclude anchors, so the highlight
      targets the REGULAR duplicate slot — confirm. NO banner.
- [ ] Copy: "also a fixed event this week — regenerate to clear." (director-facing; a Generate is the
      resolution — do NOT auto-regenerate, neither route is canonical).
- [ ] Tests: (a) generate → re-key anchor name (or mismatched anchors+slots fixture) → reload →
      ANCHOR_DUPLICATE appears on the regular slot, not the anchor; (b) a correctly-generated
      (non-stale) schedule produces NONE; (c) manual blank week (anchors only) produces NONE;
      (d) group-scope: an anchor scoped to Group A does not flag Group B's legitimate regular slot.
- [ ] `npm run verify` green.

## Round-2 revisions (reviewer-confirmed, this branch)
- **Generated-route scoping (Code Reviewer MEDIUM + Red Hat HIGH):** `ANCHOR_DUPLICATE` fired on BOTH
  routes; its "regenerate to clear it" copy is meaningless on the manual route (which has no regenerate,
  and already surfaces an anchor+regular clash as OVERLAP at render). FIX: emit only on the GENERATED
  route — gate emission at the generated-route call sites (pass `anchors`/`weekId` only when the route
  is generated; manual/blank-week/snapshot-of-manual paths pass neither → safe default → no finding).
- **weekCatalog false-positive (Red Hat MEDIUM):** an activity week-closed via
  `activityExclusions`/`groupExclusions`/`locationExclusions` whose all-weeks anchor is NOT closed was
  reported as a live duplicate. FIX: `computeFindings` applies the same week-effective suppression as
  generation (`resolveWeekCatalog`/weekCatalog) so a week-closed activity is not flagged. Test the case.
- **Tests prove the CLAIM, not an adjacent property (Red Hat):** (a) an E2E test that runs REAL
  `buildSchedule` to produce generated slots, then re-keys the anchor name (or supplies post-rekey
  anchors), then asserts `ANCHOR_DUPLICATE` fires; (b) replace the "manual blank week → none" test (which
  only re-proved "non-stale → none") with a genuinely-stale-fires / freshly-generated-in-sync-does-not
  pair.

## Rebase-time follow-up (DO NOT build now — target file is not on our base yet)
All "which groups does this anchor cover?" resolution in the finding path is already isolated behind
ONE internal seam: `anchorCoveredGroupIds(anchor, liveGroups)` in `src/engine/buildSchedule.js` (called
only by `anchoredActivityIdsByGroup`; no direct `anchor.group_ids` read exists anywhere else in the
finding). Its body today implements the T180-author-locked contract minus the `unit_ids` rule that does
not yet exist on main: order `unit_id > is_all_groups > group_ids`, empty/absent falling through, live
group list passed at evaluation time, returns group IDs.

After gracious-thompson's T180 lands (before us, per merge order), division scope moves to a `unit_ids`
list ranking above `unit_id`, and division-scoped anchors carry an EMPTY `group_ids` by design — so a
direct column read silently goes stale. There are TWO scope readers in the finding path to swap (found
in the round-2 review — the finding's coverage step is not the only reader):
  1. `anchorCoveredGroupIds` in `src/engine/buildSchedule.js` (the finding's coverage step). Replace its
     entire body with `return resolveAnchorGroupIds(anchor, liveGroups)` (import from `./anchorScope.js`)
     — a true one-line swap.
  2. `resolveWeekCatalog` in `src/engine/weekCatalog.js` (its group-exclusion suppression rule reads
     `anchor.group_ids` directly, ignoring `unit_id`). `computeFindings` calls this, so it is part of the
     finding path. It is a pre-existing SHARED function (generation calls it too), which is WHY the
     finding stays consistent with a fresh build today — but post-T180 its suppression scope must resolve
     via `resolveAnchorGroupIds` too, or division-scoped anchors go unsuppressed. Coordinate this change
     with the weekCatalog owner; it is out of T182's scope to refactor a shared engine function here.
NOTE: preserve the load-bearing DO-NOT-INLINE one-liner at gracious's `buildSchedule.js` Pass-1
placement call site — that is their placement seam, distinct from ours. This is the anti-drift extension
of the same principle this ticket already applies.

## Known residuals (round-2 review, deliberately out of scope — not defects in this change)
- **Route-scoping is enforced by convention across call sites, not by an engine guard.** `computeFindings`
  takes no `route` param; each of the four call sites (useScheduleData load loop, ScheduleScreen
  recalcFindings, useSnapshots restore, useGeneration manual path) gates by threading `anchors`/`weekId`
  only on the generated route, backstopped by computeFindings' safe default (absent anchors → no finding).
  Verified correct at all four sites. A hook-level regression test asserting the manual route never
  surfaces ANCHOR_DUPLICATE even with a matching anchor/regular pair would make this durable; the engine
  safe-default test + the E2E build tests cover the claim today. Follow-up, non-blocking.
- **`dismissedFindingKeys` is not reset on regenerate** (only on snapshot restore), and the key is
  content-addressed (`groupId|activityId|kind`) with no generation component. A dismissed ANCHOR_DUPLICATE
  can therefore mask a genuinely recurring one after a later regenerate. This is a PRE-EXISTING pattern
  shared by all finding kinds (UNDERSERVED/DISTRIBUTION/UNFILLABLE), not introduced here — but
  ANCHOR_DUPLICATE's "regenerate to clear it" workflow makes the dismiss→regenerate→recur cycle its
  primary path, enlarging the blast radius. Product decision required (is a dismissal week/generation
  scoped?); logged for a separate ticket.

## Merge order
#443 (`claude/cranky-sammet-61b062`) → gracious-thompson T180 → this branch (T182).
