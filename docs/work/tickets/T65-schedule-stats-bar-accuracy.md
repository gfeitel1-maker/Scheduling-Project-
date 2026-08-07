---
title: T65-schedule-stats-bar-accuracy
document_type: ticket
status: completed
created: 2026-08-07
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T62-engine-schedules-anchor-activities-as-regular-slots.md]
related_adrs: []
archive_when: each of the four stat cards has a documented, tested definition that matches what it displays
---

# T65 — The schedule stats bar may be counting the wrong things

**Risk:** Medium — the numbers are what a director trusts to decide whether a schedule is done.
**Task class:** scheduling-engine.
**Phase 1 (read-only investigation) is COMPLETE — findings below.** Two of the three original
suspicions did not survive it, and two defects nobody suspected did.

---

## Phase 1 findings (2026-08-07, read-only)

### Headline: the engine's `stats` object is dead code

The original premise — "sourced from the `stats` object returned by `buildSchedule.js`" — **is
wrong.** Nothing outside the engine reads `openCount` / `filledCount` / `unfillableCount` /
`underservedCount` / `totalFlags`; grep across `src/**` excluding tests hits only
`buildSchedule.js:398-406` and `:519-526`.

All four cards are computed **in the renderer, from normalized DB rows.** The screen's `stats` is a
different two-key object `{ open, filled }` from `recalcStats()`
(`src/screens/schedule/useScheduleData.js:30-33`), wired in as `statsFor`
(`src/screens/ScheduleScreen.jsx:246`).

**Having two independent definitions of the same quantities is how they drifted.** Either wire the
engine's `stats` in or delete it; keeping both is the actual root cause here.

### What each card counts

| Card | Expression | Population | Anchors |
|---|---|---|---|
| **Placed** `390 of 525` | `ScheduleScreen.jsx:846` ← `useScheduleData.js:30-33`: `open` = non-anchor slots, `filled` = non-anchor slots with an `activity_id` | all groups/days/cohorts, current route+week | excluded (`is_anchor === false`) |
| **Unfillable** `135` | `ScheduleScreen.jsx:859, 403-405` — `flags.UNFILLABLE && !UNFILLABLE_dismissed`, camp-wide (`:393`) | same | excluded structurally |
| **Still needed** `0` | `ScheduleScreen.jsx:867` — `findings.filter(kind === 'UNDERSERVED').length` | every eligible group×activity pair with `min_per_week > 0` | anchor slots excluded from counts (`buildSchedule.js:455`) |
| **Spread across the week** `0` | `ScheduleScreen.jsx:874` — `findings.filter(kind === 'DISTRIBUTION').length` | gated on `prefer_before_day` AND `prefer_before_day_min` both set (`:482`) | excluded |

### Verdicts on the three original suspicions

**1. "Still needed = 0" — NOT A DEFECT (the reading was wrong), plus a separate label defect.**

The sidebar comparison that motivated this does not hold. `ActivityPalette.jsx:89,180` computes
`scheduledCount` over slots the caller pre-filters (`ScheduleScreen.jsx:934-936`) — in **group view
that is only the selected group**; it counts **span tails as separate placements** (no
`is_span_head` filter, unlike `buildSchedule.js:455`); and it lists **every activity including ones
the selected group is ineligible for**, which `computeFindings` correctly skips (`:463`).

Decisively: `showTargets={isManual}` (`:942`) means the "0 of 2 this week" line renders **only on
the manual route**, and the observed screen showed an Unfillable card, which renders only when
`!isManual` (`:857-864`). So the sidebar was showing `scheduledCount / max_per_week` (`:71-72`),
**not min**. The min-vs-placed comparison was never on screen.

**No code path forces this to 0.** Confirming or refuting the observed zero requires the actual camp
data — whether those six activities really have `min_per_week >= 1` and whether affected groups are
in their eligibility sets. Static reading does not support a defect claim.

**2. Unfillable includes anchor blocks — NOT A DEFECT (the reading was wrong).**

Anchor cells `continue` at `buildSchedule.js:158` before `openSlots.push` at `:170`, and
`UNFILLABLE` is stamped only while iterating `openSlots` (`:336-345`). Anchor rows carry
`flags = {}` and cannot satisfy the filter. The arithmetic refutes it too: **525 − 390 = 135** —
Unfillable is exactly the unfilled remainder of the same anchor-free set. The "15 × 9 = 135" was
coincidence; 15 × 9 × 5 would be 675, and both counters are week-wide, not Friday-only.

**3. "Placed" inflated by T62 — CONFIRMED, inherited from T62; this counter is faithful.**

The spurious slots persist as `type: 'activity'` with `is_anchor: '0'`
(`scheduleRepository.js:50`) and satisfy `recalcStats`'s `filled` predicate. The ~60 spurious
Lunch/Rest Hour slots **are inside the 390**. Fixing T62 will not simply subtract 60 — those blocks
free up and the placement rounds will refill some. Expect `filled` to fall by 0–60 and `Unfillable`
to rise by the same amount, with `open` (525) unchanged.

### Two defects found that were not suspected

- **`recalcStats`'s `open` counts `'unavailable'` slots.** The engine emits a third slot type
  (`buildSchedule.js:161`) for groups whose `availability` does not match a block's `part_of_day`.
  These persist with `is_anchor = '0'` and a null activity, so they **inflate the "of 525"
  denominator** as permanently-unfillable time. The engine's own `openCount` (`:398`) counts only
  `type === 'activity'` and excludes them. Latent today (525 = 15 × 7 × 5 exactly, so this camp has
  no availability-restricted groups) — **it fires the first time a camp uses `availability` other
  than `'all'`.**
- **"Still needed" counts pairs, not sessions.** A group needing 2 with 0 placed yields **one**
  finding, not two. The label reads as a session count. Copy is a product-judgement gate.

### Lower-priority notes

- Per-cohort `stats` aggregation (`:509-526`) is doubly unexercised: `useGeneration.js:77` uses the
  flat signature so `normalizeInput` synthesizes one cohort, and no UI reads `stats` anyway.
- If it were used, `underservedCount` would be wrong — de-duplicated within a cohort by a `Set`
  (`:401`) then plainly summed across cohorts (`:524`), so a pair in two cohorts double-counts. It
  also disagrees in kind with `totalFlags` (`:402`), which sums un-deduplicated row counts.
- `stats: cohorts.length === 1 ? allStats[0] : { ...combined, per_cohort: allStats }` (`:530`) — the
  single-cohort branch omits `per_cohort`, so any consumer reading it breaks on the common path.

---

## Phase 2 — scope

**In:**

1. **Exclude `'unavailable'` slots from `recalcStats`'s `open`** (`useScheduleData.js:30-33`), so the
   Placed denominator is placeable time only. Unit test with an availability-restricted group.
2. **Resolve the duplicate definition.** Either wire the engine's `stats` into the renderer or delete
   it. Do not leave two. Recommend deleting the engine's `stats` — the renderer must recompute from
   DB rows anyway after every op, so the engine copy can only ever go stale. Confirm before acting.
3. **Re-read all four counts against a real generated schedule after T62 lands**, and record the
   before/after numbers.

**Out / escalate rather than decide:**

- **Relabelling "Still needed."** The count is defensible; the label is not. Copy is a
  product-judgement gate — raise the wording, do not choose it.
- The per-cohort aggregation bugs. Real, but unreachable today. Report; ticket separately.
- Redesigning the stats bar or adding stats.
- The T62 fix itself.

---

## Phase 2 outcome (2026-08-07)

### Correction to Phase 1's proposed fix #1

Phase 1 proposed filtering `recalcStats` on `type === 'unavailable'`. **That alone is a no-op.**
`type` is not a `template_slots` column — `mapSlotToRow` (`src/data/scheduleRepository.js:36-53`)
persists only id/template_id/group_id/day_id/time_block_id/activity_id/anchor_id/is_anchor/
is_span_head/flags, and `normalizeSlots` adds nothing. Every `recalcStats` caller is fed DB-loaded
rows, on which `s.type` is always `undefined`.

Verified that an unavailable row is already behaviorally identical to no row at all:
`decideCell` (`gridGeometry.js`) returns `{kind:'empty'}` one line *before* the `cellType =
'unavailable'` expression, making that branch — and `SlotCell.jsx:178`'s `type === 'unavailable'`
branch — unreachable; `isSwapTarget` (`dragHandlers.js`) rejects it either way. Its only live
effect was inflating the denominator.

**Fix as shipped:** `replaceWeek` drops `type === 'unavailable'` engine slots before writing.
`restoreSnapshotRows` deliberately left unfiltered (snapshot slots carry `is_anchor`, not `type`).
A defensive guard remains in `recalcStats` for raw-engine-slot callers, documented as not the fix.

**The fix is prospective.** A camp that generated before this change keeps its stale rows until
the next Generate (`bulkReplace` replaces the whole template scope, so one regenerate cleans it).
Restoring a pre-fix snapshot reintroduces them. Neither is a regression; both are now documented
at `useScheduleData.js:recalcStats`.

### Acceptance

- [x] `'unavailable'` slots excluded from the Placed denominator, with a failing-then-passing test
      (`scheduleRepository.test.js`, `useScheduleData.test.js`, `buildSchedule.test.js`)
- [x] Exactly one definition of these quantities exists — engine `stats` deleted
      (`buildSchedule` output is now `{ slots, conflicts, findings }`); grep for
      `openCount|filledCount|unfillableCount|underservedCount|totalFlags|per_cohort` across
      `src/` + `electron/` returns nothing
- [ ] **NOT DONE — all four counts re-read after T62, before/after numbers recorded.** Requires a
      real camp database under `npm run electron:dev`; no agent in this loop had access to one, and
      no numbers were fabricated. **Human step:** open the Generated route on a real camp, record
      Placed / Unfillable / Still needed / Spread, and compare against the pre-T62 reading
      (`390 of 525`, `135`, `0`, `0`). Phase 1 predicted `open` holds at 525, `filled` falls by
      0–60, and `Unfillable` rises by the same amount.
- [x] `npm run test` (1739 passed, 1 skipped), `npm run lint` (0 errors) pass

### Escalated, not decided (per Phase 2 "Out")

- **"Still needed" label.** Counts (group × activity) pairs, not sessions — a group needing 2 with
  0 placed yields one finding. The count is defensible; the label is not. Product-judgement gate:
  wording raised, not chosen.
- **Per-cohort aggregation bugs** (`underservedCount` double-counting across cohorts, the
  `per_cohort` omission on the single-cohort branch). Moot — that code is now deleted. If
  multi-cohort stats are ever reintroduced, do not restore this shape.
- **Dead render branches.** `gridGeometry.js`'s `cellType = 'unavailable'` and `SlotCell.jsx:178`
  are unreachable. Separate cleanup ticket: delete them, or wire unavailable cells up to render
  distinctly (the state is always re-derivable from `group.availability` vs `block.part_of_day`).
- **Dropping onto an unavailable cell is permitted**, and was before this change — the row's `type`
  was never load-bearing at the render boundary. Pre-existing gap, not introduced here. Ticket
  separately if blocking those drops is a real product requirement.

## Dependencies

- **T62** must land first — the Placed and Unfillable figures both move when it does.
