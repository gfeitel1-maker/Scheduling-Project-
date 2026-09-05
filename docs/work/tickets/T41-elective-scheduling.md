---
title: T41-elective-scheduling
document_type: ticket
status: in-progress
created: 2026-08-01
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs: []
archive_when: superseded by an approved specification
---

# T41 — Elective scheduling

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

- Camp Larkspur: **"Indoor Elective"** and **"Outdoor Elective"** appear as activities, which is a
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

## Progress (2026-08-20) — slice 1 (data shape + engine-skip) SHIPPED; initiative in-progress

Owner brainstorm (2026-08-20): **group-level (no campers), no solver (human decides, app holds it),
reusable elective sets (Ⓐ)**. An elective is a *kind of cell content* — a nullable
`template_slots.elective_set_id` pointing at a named `elective_sets` — inside the existing slot
machinery, not a parallel grid. The engine SKIPS elective cells like anchors. Design:
`docs/work/specs/2026-08-20-group-electives-design.md`.

**Slice 1 (data shape + engine-skip) SHIPPED**: schema v35 (`elective_sets` + `elective_set_activities`
+ `template_slots.elective_set_id`, op-log-synced/camp-scoped), full sync/permissions/migration/rollback/
mock registration, a `deleteElectiveSet` cascade primitive, and the engine exclusion of elective cells
from BOTH head-selection and span-tail collision (Red Hat caught the span-tail gap; fixed). Reviews:
Red Hat 5/5 (after fix), Security 5/5, Code Reviewer merge-ready. Full gate green (27/27 integration).

**Remaining slices (this ticket stays in-progress):** (2) elective-sets setup CRUD (create/edit named
sets + members); (3) authoring + render — place/clear an elective set in a cell on both routes, render
the set, and enforce the `elective_set_id`/`activity_id` mutual exclusion in the write path (documented
as deferred to this slice). Non-goals per owner: campers, per-camper rosters, choice data, solver.
