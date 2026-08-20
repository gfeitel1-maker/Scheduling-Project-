---
title: T92-manual-merge-discoverability
document_type: ticket
status: completed
created: 2026-08-19
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md, docs/adr/2026-08-06-schedule-canvas-visual-layer.md, docs/governance/standards/DESIGN_STANDARD.md]
archive_when: the manual merge/split affordance is discoverable (design-loop change shipped), or the owner accepts the current control
---

# T92 — Manual merge is hard to discover (re-scoped 2026-08-20)

**RE-SCOPED 2026-08-20 (Governor + owner).** The original premise — "the Manual Build route can't
merge yet" — is **stale**. Manual merge/split has existed since **2026-07-27** (commit `869e5ec`):
`expandSlot`/`splitSlot` in `useSlotMutations.js`, surfaced in `ManualBuildView.jsx` via a per-cell
`↕` button (`SlotCell.jsx`, tooltip "Let this activity run into the next period" / "Split this back
into two periods"). Verified against the current tree during the T91 work. So the capability is
present on both routes; what's missing is **discoverability**, not the feature.

This ticket is re-scoped to a **UI/UX affordance task** for the design loop: the merge control is a
small hover-only `↕` glyph with an ambiguous meaning — a director building by hand may never find it,
which is what read as "can't merge." Take it through Designer → Governor per the design loop; the
goal is a merge/span affordance a non-technical director discovers without being told.

## Original symptom (owner report — now understood as discoverability)

On the **Manual Build** schedule route, it appeared you **cannot merge** activities across time
blocks — a double-length swim spanning two blocks couldn't be created by hand. Root: the merge
affordance exists but is a subtle hover `↕` button, easily missed.

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

## Resolution (2026-08-20, SHIPPED — Red Hat 5/5, Code Reviewer merge-ready, gate green)

Design spec `docs/work/specs/2026-08-20-t92-manual-merge-discoverability.md`. The root cause was TWO
redundant hover-only merge affordances (a `↕` click button + a `.expand-handle` drag strip). Fix:
consolidate to ONE always-quietly-visible `.cell-action` button (idle opacity 0.55, clear chevron SVG
that rotates 90° for split, `aria-label`, focus-visible ring, a one-time localStorage-gated onboarding
pulse with reduced-motion fallback); delete the redundant `.expand-handle` + its `EXPAND_DRAG` drag-FSM
path. Merge still works via the button (`onMergeDown`→`expandSlot`, untouched). The other drag gestures
(place/replace/move) are intact — Red Hat confirmed the removal surgical (Resilience 5). Verified live
(idle chevron discoverable, hover, merge→split). Full `npm run verify` green (214 files, 25/25).
Follow-up **T102** filed (dev-mock is_span_head default fidelity). Pending owner sign-off — a saved
screenshot can be produced on request (the affordance was verified live).
