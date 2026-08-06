---
title: T50-schedule-canvas-rebuild
document_type: ticket
status: parent
created: 2026-08-05
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md, docs/adr/2026-08-06-schedule-canvas-visual-layer.md]
related_specs: [docs/work/specs/2026-08-06-schedule-canvas-redesign.md]
related_tickets: [docs/work/tickets/T52-activity-colors-tokenization.md, docs/work/tickets/T53-grid-track-and-placement-modules.md, docs/work/tickets/T54-group-view-css-grid-conversion.md, docs/work/tickets/T55-collapse-a-period.md, docs/work/tickets/T56-convert-remaining-schedule-views.md, docs/work/tickets/T57-drag-fsm-and-closest-edge-modules.md, docs/work/tickets/T58-drag-fsm-cutover.md, docs/work/tickets/T59-schedule-grid-keyboard-navigation.md, docs/work/tickets/T60-schedule-grid-cleanup-and-doc-correction.md]
archive_when: T53–T60 are all closed
---

# T50 — Schedule screen canvas rebuild

**Status: parent ticket.** The design phase is **complete**. The direction is settled in
`docs/work/specs/2026-08-06-schedule-canvas-redesign.md` (approved) and
`docs/adr/2026-08-06-schedule-canvas-visual-layer.md`. **This ticket is no longer an open design
question and no code is written against it directly** — the implementation lives in T53–T60,
listed below.

The problem statement and non-goals below are preserved as the historical record of why the work
was commissioned.

---

## Problem statement

The current grid renders correctly but does not behave like a scheduling tool a director reaches
for willingly. Known friction points (preliminary — not exhaustive until the design conversation
happens):

- **Nothing communicates utilisation at a glance.** A director scanning the week has no fast
  read of which groups are under-scheduled, which blocks are empty, or how close the schedule
  is to the camp's own rules — without opening the findings rail.
- **Drag-and-drop is the only way to edit.** Precise placement across many slots is tedious on a
  dense grid. Other manipulation models (click-to-assign, multi-select, fill-a-pattern) don't exist.
- **The grid is fixed-geometry.** The number of columns and rows is determined by the data; the
  director cannot zoom, collapse quiet periods, or focus on a single group's day.
- **Flags and findings compete for space.** The flag vocabulary (UNFILLABLE, UNDERSERVED,
  DISTRIBUTION, OVERLAP) is correct but presented in a way that doesn't guide action — a director
  sees a red cell but may not know what to do next.
- **Switching between views resets context.** Changing from group view to day view loses selection
  state; navigating to another screen and back reloads.

---

## What this ticket is NOT

- Not a full redesign — the data model and engine are correct and are not up for reconsideration here.
- Not a license to change the two-route model or route-state design (those are settled ADRs).
- Not an implementation ticket — no code is written until a specification is approved.

---

## Outcome of the design phase

**Decision: CSS Grid replaces the HTML `<table>` + `rowSpan` as the schedule grid's rendering
primitive.** Merged cells become `grid-row: span N`. A canvas ambient layer was proposed in an
earlier draft and is **rejected and withdrawn** — measurement showed there was no performance
problem to solve (60 drag frames cost 2.9 / 4.0 / 4.6 ms across three working mockups); the real
problems were structural. Absolute positioning was also rejected: its boxes cannot size to their
content, which clipped 3 cells in the mockup the grid clipped 0.

Recorded in full in the ADR and spec. Do not relitigate the direction in the child tickets.

---

## Broken-out implementation tickets

| Ticket | Title | Spec step |
|---|---|---|
| **T53** | Pure grid-track and grid-placement modules (`gridTracks.js`, `gridPlacement.js`) | Step 1a |
| **T54** | Convert `ScheduleGroupView` to CSS Grid, add `scheduleGrid.css`, verify `display: contents` | Step 2 |
| **T55** | Collapse a period | Step 3 |
| **T56** | Convert `ScheduleDayView`, `ManualBuildView`, `ScheduleActivityView` | Step 4 |
| **T57** | `dragFSM.js` and `closestEdge.js` — pure modules, exhaustively tested | Step 1b |
| **T58** | Drag cutover: FSM, container droppable, static drop indicators | Step 5 |
| **T59** | Keyboard grid navigation and accessible cell names | §8 (had no step) |
| **T60** | Retire table-era style constants; correct the styling convention in the docs | Step 6 |

Also split out of T50, not part of the rendering migration:

| Ticket | Title |
|---|---|
| **T52** | `ACTIVITY_COLORS` tokenization — the last hardcoded colour in the schedule components |

**Dependency order:**

```
T53 ──> T54 ──> T55 ──> T56 ──┬──> T59 ──┐
                              │          ├──> T60
T57 ──────────────────────────┴──> T58 ──┘

T52 — independent, any time (must not overlap T54/T56: it would make their
      visual-parity predicates untestable)
```

T53 and T57 have no dependencies and may be worked in parallel. Every ticket is independently
shippable and the app is never broken between them — T54 introduces a transitional `renderAs` prop
on the shared `SlotCell`/`OverlayCell` so the un-converted views keep rendering tables, and T56
deletes it.

---

## Acceptance (for this ticket — the design phase)

- [x] Design conversation completed with product owner
- [x] At least three distinct canvas directions explored (brainstorm first, per constitution) —
      two full ADHD runs plus four empirical research agents; the survey and the rejected
      alternatives are recorded in spec §1 and the ADR's alternatives table
- [x] One direction chosen and recorded as a specification in `docs/work/specs/` —
      `2026-08-06-schedule-canvas-redesign.md`
- [x] Specification reviewed by Architect for feasibility against current route-state and DnD
      architecture — ADR `2026-08-06-schedule-canvas-visual-layer.md`
- [x] Implementation ticket(s) broken out from the spec — T53–T60 above

**This ticket closes when T53–T60 close.** It is not itself implemented.

---

## Where this work lives, and where it goes

**Worktree: `../shoresh-canvas`, branch `work/t50-schedule-canvas`.** Everything for T50 —
spec, ADR, T52–T60, and all implementation — belongs here. Do not write T50 work into
`~/dev/shoresh`; that worktree carries other branches' in-flight work and this mistake has already
cost one cleanup pass (2026-08-06).

**Integration: this branch merges back to `~/dev/shoresh` when the work is done.** Product owner
decision, 2026-08-06. Merge back once T53–T60 are closed, not per-ticket.

**Known, accepted pollution.** An early superseded draft of the spec — the canvas-ambient-layer
version, before empirical research selected CSS Grid — was committed onto `work/t35-activity-rules`
by mistake and still sits there. The product owner has accepted this and will resolve it separately.
It is **not** the governing document. The authoritative spec is the copy in this worktree,
`status: approved`.
