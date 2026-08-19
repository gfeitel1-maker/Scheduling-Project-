---
title: T92-manual-generation-cannot-merge
document_type: ticket
status: open
created: 2026-08-19
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md, docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
archive_when: the manual route supports merging/spanning activities, or the merge model is redesigned
---

# T92 — Manual generation (Manual Build route) can't merge yet

**Parked by the owner 2026-08-19 for later — not a current-sprint blocker.** Recorded now so it
isn't lost; diagnosis and fix are deferred.

## Symptom (owner report)

On the **Manual Build** schedule route, you **cannot merge** activities across time blocks yet — the
merge/span capability that exists (or is expected) on the schedule grid isn't available when building
manually. So a multi-block activity (e.g. a double-length swim spanning two blocks) can't be created
by hand on the manual route.

## What this is about (orientation for whoever picks it up — verify against current code)

- Two schedule-building routes coexist (Manual / Generated), each its own candidate schedule — see
  `docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`. Manual route grid =
  `src/components/schedule/ManualBuildView.jsx`; the generated route is engine-produced
  (`src/engine/buildSchedule.js`).
- Merging/spanning = one activity occupying contiguous blocks (`template_slots` `is_span_head` /
  span semantics). The engine (generated route) understands multi-block activities
  (`span_blocks` on activities; a multi-block activity counts as ONE session — see
  `buildSchedule.js`). The **manual** route apparently lacks the interaction/write path to create a
  span by hand.

## Likely areas to investigate (not yet confirmed)

- Whether `ManualBuildView` exposes any merge gesture, and whether `placeActivityManual` / the manual
  write path can write `is_span_head` + span-member slots.
- Parity with the generated route's span handling; the DnD placement model on the manual grid.

## Definition of done (when un-parked)

- A director can create a merged/spanned (multi-block) activity by hand on the Manual Build route.
- Behavior matches the span semantics the generated route and engine already use (one session towards
  min/prefer goals).
- A test pins manual span creation + that it round-trips through the op-log like a generated span.

## Related

- T91 (replacing a merged activity can't refill the span) — sibling merge-model limitation, parked
  together.
