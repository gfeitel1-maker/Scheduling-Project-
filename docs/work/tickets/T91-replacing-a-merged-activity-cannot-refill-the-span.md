---
title: T91-replacing-a-merged-activity-cannot-refill-the-span
document_type: ticket
status: open
created: 2026-08-19
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md, docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
archive_when: the merged-cell refill path is fixed and covered by a test, or the merge/span model is redesigned
---

# T91 — After merging, replacing a merged activity from the palette cannot refill the span ("blob")

**Parked by the owner 2026-08-19 for later — not a current-sprint blocker.** Recorded now so it
isn't lost; diagnosis and fix are deferred.

## Symptom (owner report)

On the Schedule screen, once an activity has been **merged** across multiple time blocks (a
multi-block span — the "blob"), if you then **replace that merged activity by dragging a different
activity in from the palette on the left**, the span **cannot refill the blob** — the freed
multi-block region is left in a state it can't recover into a new merged occupancy.

## What this is about (orientation for whoever picks it up — verify against current code)

- A merged/spanned activity is a single activity occupying several contiguous time blocks. In the
  data model this is `template_slots` with `is_span_head` / span semantics (see `PLATFORM_STATE.md`
  §template_slots and `docs/adr/2026-08-06-schedule-canvas-visual-layer.md`).
- The palette (left) is `src/components/schedule/ActivityPalette.jsx`; drag-to-place / replace lives
  in `src/screens/ScheduleScreen.jsx` (DnD via `@dnd-kit/core`) and the placement helpers
  (`placeActivityManual` / the write-queue path — see the DnD FSM + write-serialization work).
- The bug is specifically the **replace-into-a-merged-span** path: replacing the span head with a
  palette activity appears to leave the previously-spanned blocks unable to be re-merged / refilled.

## Likely areas to investigate (not yet confirmed)

- The replace path may clear the span head but not the span-member slots (or vice versa), leaving
  orphaned/half-span state that the refill/merge logic then refuses.
- Interaction with the per-cell write queue and `is_span_head` bookkeeping.

## Definition of done (when un-parked)

- Replacing a merged activity from the palette leaves the region in a normal, re-fillable/re-mergeable
  state.
- A characterization test pins: merge N blocks → replace span head from palette → the freed blocks
  can be occupied and re-merged.

## Related

- T92 (manual generation can't merge yet) — sibling merge-model limitation, parked together.
