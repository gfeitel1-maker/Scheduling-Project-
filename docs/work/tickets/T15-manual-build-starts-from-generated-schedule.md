---
title: T15-manual-build-starts-from-generated-schedule
document_type: ticket
status: open
created: 2026-07-28
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
archive_when: resolved
---

# T15 — "Manual Build" shows the generated schedule instead of a blank grid

**Risk:** Medium. The fix touches what happens to an existing schedule, so a careless
implementation can destroy a director's generated week.
**Found:** 2026-07-28, product owner.

---

## The problem

Building a schedule yourself and editing a generated one are two different intentions. The
app currently serves both from one surface, so choosing "I want to build this myself" hands
you the machine's answer already filled in.

Product owner, verbatim:

> why would going that route (i.e. you want to completely build the schedule) involve the
> generated one? manual edits to the generated schedule is a different idea entirely.

## Where it comes from

Two entry points collapse into a single view:

1. **The "Build Manually" button** ([`ScheduleScreen.jsx:1503`](../../../src/screens/ScheduleScreen.jsx)),
   offered when no schedule exists. It creates the slot rows, applies anchors, then sets
   `view='manual'`. This is the "build it myself" intent.
2. **The "Manual Build" tab** ([`ScheduleScreen.jsx:1409`](../../../src/screens/ScheduleScreen.jsx)),
   present in the view toggle whenever `hasSchedule` is true — including immediately after
   generating. Selecting it renders `ManualBuildView` against the same `slots` state every
   other view reads.

So after a generation, "Manual Build" is a third view of the generated schedule. Nothing is
blank about it.

Note that `ManualBuildView` already renders dashed `EmptyDropCell` drop targets for empty
slots, so the blank-grid affordance exists and works. The defect is *which slots reach it*,
not how they render.

## The decision this hangs on

**What happens to the generated schedule when a director chooses to build manually?**

This must be settled before implementation, because the naive fix — clearing the slots when
entering Manual Build — is destructive and silent, which Article V forbids ("the engine
surfaces conflicts; it never resolves them silently", "the director stays in control").

Recommended shape, for approval:

- Manual Build becomes a **from-scratch surface**: entering it presents an empty grid.
- **The generated schedule is never silently discarded.** Before clearing, auto-save it as a
  named version, so Versions can restore it — the mechanism already exists and is proven
  (verified 2026-07-28: snapshots record a real payload).
- Entering Manual Build over an existing schedule is a **confirmed** action, naming what will
  happen in a director's words, not "slots will be cleared".
- **Editing a generated schedule keeps its existing home** — drag-and-drop in Group and Daily
  View, which works today. It does not need Manual Build, and Manual Build should stop
  advertising itself as the place to do it.

Open question for the product owner: should the "Manual Build" tab remain visible at all once
a schedule has been generated, or should manual building be reachable only from the
no-schedule state and from an explicit "start over manually" action? Leaving the tab in place
invites the same confusion in a different costume.

## Completion evidence

1. Choosing to build manually presents an empty grid, with no generated placements.
2. No path into Manual Build destroys a generated schedule without an explicit confirmation.
3. Any generated schedule replaced this way is recoverable from Versions.
4. Editing a generated schedule by drag-and-drop in Group and Daily View still works.
5. Verified by using the real app under `npm run electron:dev`, not only by unit tests — the
   generate → manual → restore path crosses persistence.
