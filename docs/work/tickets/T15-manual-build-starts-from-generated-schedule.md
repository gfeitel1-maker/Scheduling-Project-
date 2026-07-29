---
title: T15-manual-build-starts-from-generated-schedule
document_type: ticket
status: completed
created: 2026-07-28
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_adrs: [docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
related_specs: [docs/work/specs/2026-07-28-separate-manual-and-generated-flows.md]
archive_when: resolved
---

> **RESOLVED 2026-07-29.** Manual and generated are now two coexisting routes, each with its
> own week, reachable from the left sidebar. Neither is canonical.
> The framing below was written before the product owner settled the design, and the
> "decision this hangs on" section is **superseded** — see *Resolution* and *Verification*
> at the end. Authority order: the accepted ADR governs, then the spec, then this ticket.

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

---

## Verification — 2026-07-29

**Gates, run on the branch:** 42 test files, 733 passed, 2 skipped. Lint 0 errors, 11
pre-existing `react-hooks/exhaustive-deps` warnings. Build clean.

**The blocking defect and how it was found.** The first implementation shipped a migration
(v23) that left a real camp unable to generate a schedule at all — the button appeared to do
nothing. It was found by the product owner *using the app*, not by any review or test, and it
would have reached a real camp. Recorded here because the pattern is now four for four in this
project: every significant defect this month came from running the thing.

The failure was invisible by construction. `INSERT OR IGNORE` absorbed the `UNIQUE(camp_id,
kind)` violation and reported no error; `template_slots` has no foreign key, so the orphaned
slots were accepted; and the one constraint that *would* have thrown — the overlay foreign key
— never fired, because the call that reaches it replaces an empty array and therefore writes
nothing. Three independent guards, all bypassed. `electron/ops/projections.js` now throws a
typed `SCHEDULE_TEMPLATE_KIND_CONFLICT` rather than silently returning.

**A wrong diagnosis, recorded because the correction is the useful part.** The first analysis —
including in the brief that dispatched the fix — held that migration v21 never re-keyed existing
templates, so every camp predating this branch was broken. That is false. v21 *does* re-key, by
insert-copy → repoint children → delete-old. The database proves it:

| | |
|---|---|
| v21 applied | `2026-07-28T16:34:06Z` |
| random-UUID template created (ops 83/84) | `2026-07-28T22:51:38Z` |

Six hours *after*. The real cause is that **v21's re-key is a one-shot data fix and the writer
was never fixed alongside it**, so any template minted afterwards by a pre-slice-2 renderer
carries a random UUID no migration will ever normalise. The affected population is therefore
camps whose template was created *after* v21 but before this branch — and nothing can determine
which side of that line a given installation falls on. The fix had to be correct for both ids
without inspecting either.

**Why resolution, not a second re-key.** A re-key is not idempotent against a durable op log.
Operations 83/84 carry `entity_id = '48485127-…'` permanently; replaying them on any peer, or on
this device after re-pairing, faithfully recreates the old id — which then collides under
`UNIQUE(camp_id, kind)` against the row the re-key just created. Re-keying also rewrites a
primary key that `template_slots`, `template_overlays`, `schedule_snapshots` and the op log all
reference, and would need a "rename entity" sync primitive that does not exist. Resolution by
`(camp_id, kind)` touches no stored row.

**Proven on the database that was actually broken.** After the fix, the dev camp:

```
schema v24
48485127-57b0-42d9-…        kind=generated   50 slots, 20 activities   <- original row, preserved
schedule-template:…:manual  kind=manual      50 slots,  2 activities
```

Generation resolves to and writes to the pre-existing row. Nothing was re-keyed or deleted. The
orphaned slot set from the failed generate remains in place, unadopted — v24 adopts only where
there is provably nothing to lose, and here the surviving row held a real week.

**Director's-eye check.** Both routes are reachable from the sidebar, switching is navigation
with no warning or confirmation, each keeps its own week across switches, and a clashing manual
placement is accepted and marked rather than refused. Two independent checks — a tester in the
running app and the source — confirm the manual route offers no generate control, so the
product owner's report of one did not reproduce.

## Follow-on, not part of this ticket

- **The two routes do not yet share vocabulary.** Manual reports `STILL NEEDED` and `SPREAD
  ACROSS THE WEEK`; generated reports `UNDERSERVED` and `DISTRIBUTION` for the same concepts.
  A shared flag vocabulary exists so a director learns it once; today they would learn it twice.
  Folded into [T18](T18-copy-pass-and-grid-card-colours.md).
- On test data the generated route showed 21 of 40 slots unfillable. Likely an artifact of five
  near-identical activities each capped at one group, but worth a look with a realistic camp
  before judging how that route feels.
- [T17](T17-dead-colorindex-encodes-wrong-convention.md) remains open and untouched by this work.
