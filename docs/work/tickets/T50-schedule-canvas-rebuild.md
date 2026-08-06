---
title: T50-schedule-canvas-rebuild
document_type: ticket
status: open
created: 2026-08-05
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
archive_when: superseded by an approved specification
---

# T50 — Schedule screen canvas rebuild

**Status: open.** The schedule canvas is functional but static. This ticket is the entry point
for a design-led conversation before any implementation.

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

## Next step

**A design conversation with the product owner before any specification.** The questions to answer:

1. What does a director do in the first 30 seconds of opening the schedule? What should they see?
2. What manipulation model fits a director's mental model — drag, click-to-cycle, type a name, something else?
3. What does "done for the week" look like visually? What signals completion vs. attention-needed?
4. Is there a view that doesn't exist yet that would be more useful than improving the current one?

Bring real screenshots and the sample camp schedules to that conversation. The Tester agent's
camp-director perspective is useful input here — invoke it before writing a spec.

---

## Acceptance (for this ticket — the conversation phase)

- [ ] Design conversation completed with product owner
- [ ] At least three distinct canvas directions explored (brainstorm first, per constitution)
- [ ] One direction chosen and recorded as a specification in `docs/work/specs/`
- [ ] Specification reviewed by Architect for feasibility against current route-state and DnD architecture
- [ ] Implementation ticket(s) broken out from the spec
