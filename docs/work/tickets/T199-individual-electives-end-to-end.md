---
title: T199-individual-electives-end-to-end
document_type: ticket
status: open
created: 2026-09-17
archive_when: the acceptance fixture passes and the behaviour is folded into PLATFORM_STATE
governing_docs: [docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_specs: [docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md]
---

# T199 — Slice 7: end-to-end release

The integrated director flow, the acceptance fixture, visual and accessibility QA, and current
docs. **Blocked on T198.**

## Director flow

| State | Primary action | Must be visible |
|---|---|---|
| No run | Choose week, route, division; start import | Route is explicit and never remembered as canonical |
| Import preview | Map and resolve | Row count, matched/unmatched campers, groups, occurrences, activities, duplicate ranks |
| Ready to generate | Generate | Offering capacities, demand, locked seats, blocking outer conflicts |
| Draft | Move/lock camper; regenerate | Rank received, capacity remaining, unassigned reasons, satisfaction summary |
| Final | Export or start a revision | Read-only run identity, source file, route/week/division, finalized timestamp and author |

Staleness discovered at the Generate click must offer "re-derive and regenerate" in place, not only
a block (ADR D6) — the common trigger is a single director editing the grid and coming back.

**Every screen in this flow is admin-only (ADR D9).** No part of the director workflow is
staff-visible; staff receive the exported artifact. Verify no screen was drafted as staff-reachable
and that none appears in staff navigation.

Per repo convention: no banners. State that needs surfacing belongs in the findings vocabulary.

## Release preconditions

- **At-rest encryption — HARD BLOCK (ADR D8).** At-rest encryption is implemented but inert
  (`SHORESH_AT_REST_ENCRYPTION` defaults off; `docStore.js` takes a cipher that is `null` by
  default). This feature may be built, tested and demonstrated against **fixture data only**. It
  may **NOT** be used with a real camp's camper data until the owner records a dated acceptance.
  This is a visible gate: it must be stated at the feature's own entry point in the app, not only
  in documentation. Shipping the flow without that statement fails this ticket.
- **Delete copy (ADR D10).** A real Delete is permitted. Its copy must state the cost honestly — a
  full purge requires a coordinated rebuild that invalidates every device's document and forces
  re-pairing, and cannot reach a copy already taken off-device. Copy that implies one click erases
  the record everywhere does not ship. The procedure itself is T200.

## Exit condition

The acceptance fixture in the spec §6 passes with no manual database edits, under `electron:dev`
(not the `:5200` dev mock — this involves persistence and sync). The full gate is green. Completion
is not claimed on a solver unit test, a skipped migration, or mocked-away sync.
