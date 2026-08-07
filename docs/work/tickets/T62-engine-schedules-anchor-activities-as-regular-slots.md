---
title: T62-engine-schedules-anchor-activities-as-regular-slots
document_type: ticket
status: open
created: 2026-08-07
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T63-anchor-group-ids-parsing-belongs-at-the-boundary.md]
related_adrs: []
archive_when: an activity referenced by an anchor never appears as a regular slot, covered by a unit test
---

# T62 — The engine places anchor activities a second time as regular slots

**Risk:** Medium — touches `src/engine/buildSchedule.js`, the pure scheduling engine.
**Task class:** scheduling-engine. `buildSchedule.test.js` is a mandatory gate
(`GOVERNANCE_INDEX.md` §3–8).

---

## Problem

The activity-placement passes do not exclude activities that are already covered by
`anchor_activities`. An activity like Lunch or Rest Hour carries `min_per_week = 2` like any other
activity, so the engine treats it as schedulable and places it twice per group per week **on top of
its anchor slots**.

Observed: the Activity View drilldown shows 30 regular Lunch slots placed across the week. All 30
are wrong. Every one of them also consumes a block that a real activity should have had, so the
damage is not only the duplicate — it displaces correct placements and distorts the
`min_per_week` / `prefer_before_day` audit in pass 3.

The anchor is the scheduling of that activity. There is no case in which the engine should place it
again as a regular slot.

## Scope

**In:**

1. In `src/engine/buildSchedule.js`, before the activity-placement passes, collect a `Set` of every
   `activity_id` present in the `anchors` input array.
2. Filter those IDs out of the schedulable-activity set so neither the high-priority nor the
   low-priority round can place them.
3. The exclusion is derived from the `anchors` input, not from a flag on the activity row — an
   activity is excluded because an anchor references it, and for no other reason.

**Out:**

- Any change to anchor placement itself (pass 1), to span handling, or to scope resolution
  (`unit_id` / `is_all_groups` / `group_ids`).
- The `group_ids` parsing guard — that is **T63** and lands first.
- Changing `min_per_week` data on any activity. The fix is engine-side; the data is not wrong.
- Any change to flag taxonomy or placement priority (human gate — do not cross it).

## Testing

Test-first. `src/engine/buildSchedule.test.js` is mandatory for this task class.

- [ ] Given an anchor referencing activity X, X appears in **no** regular slot in the output —
      only in anchor slots.
- [ ] An activity **not** referenced by any anchor is still placed normally (the filter is narrow).
- [ ] Determinism holds: identical inputs still produce identical schedules (the seeded PRNG
      contract must not be perturbed in a way that is unaccounted for). If removing activities from
      the pool changes previously-recorded expected output, say so explicitly rather than silently
      updating fixtures.

## Acceptance

- [ ] New unit test in `src/engine/buildSchedule.test.js` fails before the change, passes after
- [ ] `npm run test`, `npm run lint` pass
- [ ] `src/engine/buildSchedule.js` remains a pure function — no React, no IPC, no I/O

## Dependencies

- **T63** should land first so this ticket edits an engine that already has the boundary parsing
  removed, and the two diffs stay separable.
