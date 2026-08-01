---
title: T29-elective-scheduling
document_type: ticket
status: parked
created: 2026-08-01
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs: []
archive_when: superseded by an approved specification
---

# T29 — Elective scheduling

**Status: parked.** Product owner, 2026-08-01: *"elective scheduling should also be on the list
for the future."* Recorded so it is not lost. **Not a design — no approach chosen.**

---

## What it is

Everything the engine does today places a **whole group** into a period. An elective is the
opposite: individual campers choose, and a period holds several activities running at once with
campers distributed across them.

## Why it is a different problem, not a bigger one

- **The unit of assignment changes.** `template_slots` is keyed to a group. An elective is keyed
  to a camper, and the app has no campers — `cohorts.capacity_source` has a
  `camper_headcount` option marked "coming soon", which is the nearest thing that exists.
- **Capacity becomes a constraint that can fail.** A bunk either fits in a period or does not.
  An elective has places, campers have preferences, and some preferences cannot be met — which
  means a result the director has to be shown and allowed to override, not just a schedule.
- **It interacts with the flag vocabulary.** "Underserved" and "Distribution" are about a group's
  week. An elective's failure modes are different: an over-subscribed activity, a camper who got
  none of their choices.

## Evidence it is already wanted

Both real camps show elective-shaped periods:

- Camp Mindy: **"Indoor Elective"** and **"Outdoor Elective"** appear as activities, which is a
  camp working around the absence of the feature by naming the period after it.
- Camp A: **"Chugim"**, the Hebrew for electives, appears as a single activity.

In both cases the camp has flattened a choice into one name because that is all the grid can
hold. That is the clearest statement of the requirement available.

## Questions nobody has answered

- Does the app need campers as records, or can electives work at group level (this bunk splits
  across these three activities) without them? The second is much smaller and may be enough.
- Is a camper's choice data the app stores, or an outcome the director enters after collecting
  choices on paper?
- Does the engine assign electives, or does it only hold what a human decided? Those are very
  different features and only one of them needs a solver.

## Next step when this is picked up

Brainstorm first — the "does it need campers" question changes the size of this by an order of
magnitude, and it should be settled before anything is specified.
