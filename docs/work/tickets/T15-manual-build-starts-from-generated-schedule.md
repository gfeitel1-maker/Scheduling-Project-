---
title: T15-manual-build-starts-from-generated-schedule
document_type: ticket
status: in-progress
created: 2026-07-28
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_adrs: [docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
related_specs: [docs/work/specs/2026-07-28-separate-manual-and-generated-flows.md]
archive_when: resolved
---

> **IN PROGRESS on branch `feat/separate-manual-and-generated-flows`.**
> The framing below was written before the product owner settled the design, and the
> "decision this hangs on" section is now **superseded** — see *Resolution* at the end.
> Authority order: the accepted ADR governs, then the spec, then this ticket.

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

Superseded by the eleven director-confirmable predicates in the spec. Retained for the record:

1. Choosing to build manually presents an empty grid, with no generated placements.
2. No path into Manual Build destroys a generated schedule without an explicit confirmation.
3. Any generated schedule replaced this way is recoverable from Versions.
4. Editing a generated schedule by drag-and-drop in Group and Daily View still works.
5. Verified by using the real app under `npm run electron:dev`, not only by unit tests — the
   generate → manual → restore path crosses persistence.

---

## Resolution — product owner, 2026-07-28

**The framing above was too small.** This ticket assumed the fix was "make Manual Build start
blank", and that the hard part was deciding what to destroy. The product owner reframed it, and
the reframing removed the destruction question rather than answering it.

> "manual build tab stays visible - think of them as separate sections/philosophical routes to
> schedule building that have cross over ideas (frequencies, timing, numbers) but separate paths
> to produce something"

> "they are both true. any schedule, whether through build your own or generated by the engine
> and manually worked on can be valid ideas to export. that decision lives not with us but with
> the user"

### What is settled

- **Two coexisting routes, both always reachable.** The Manual Build tab stays visible at all
  times, including after generating. It is navigation, not a destructive mode switch.
- **Separate outputs.** Each route produces its own schedule. This is what makes an
  always-visible tab safe — nothing needs clearing, so §"The decision this hangs on" above is
  moot. My recommendation there (snapshot-then-clear behind a confirmation) is **withdrawn**:
  it solved a problem that a better design does not have.
- **No canonical schedule.** The app never designates one as active, real, or current, never
  auto-picks at export or on sync, and never forces the director to elect one. Where exactly one
  must be acted on, the director chooses at that moment.
- **Shared setup, shared vocabulary.** Frequencies, timing and numbers are one camp setup
  consulted by both routes. The flag vocabulary is shared so a director learns it once.
- **No `UNFILLABLE` on the manual grid.** An empty cell is "not filled yet". The director is
  never blocked — an overlapping placement is *accepted and flagged*, not rejected, which
  reverses today's `locationFull` behaviour at `ScheduleScreen.jsx:772-773`. This adds an
  **OVERLAP** flag to the taxonomy. Manual route: OVERLAP, UNDERSERVED, DISTRIBUTION.
- **Opening the manual grid reports under-target activities immediately** — an honest to-do
  list of what the week still owes the director, not a wall of errors.
- **A 2-block activity counts as one session**, fixing a live divergence found while writing
  the ADR.
- Route naming is "Manual" and "Generated" **provisionally**.

### What the ADR found that this ticket got wrong

Three of this ticket's and the spec's assumptions were contradicted by the code:

1. A `UNIQUE INDEX` on `schedule_templates(camp_id)` makes a second template per camp
   impossible today. Separate outputs therefore require a schema change and migration v23 —
   not the "nearly free" change the spec assumed.
2. The renderer still mints template ids with `crypto.randomUUID()` and selects with
   `.find()` — first match wins. That line would silently elect a canonical schedule the
   moment a second row exists. It is a prerequisite, not parallel work.
3. The audit-only findings path this ticket implied needed building **already exists** —
   `computeFindings()`, exported and pure. Nothing needs extracting.

See [the ADR](../../adr/2026-07-28-plural-candidate-schedules-per-camp.md) for the verified
evidence behind each.
