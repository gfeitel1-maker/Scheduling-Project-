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
  the record everywhere does not ship. The procedure itself is T202.

## Exit condition

The acceptance fixture in the spec §6 passes with no manual database edits, under `electron:dev`
(not the `:5200` dev mock — this involves persistence and sync). The full gate is green. Completion
is not claimed on a solver unit test, a skipped migration, or mocked-away sync.

## Blocked — 2026-09-30

The T251 acceptance fixture is built and asserted, and driving it under `electron:dev` showed this
ticket's exit condition is not met: there is no Finalize control, no reachable regenerate control, no
Delete control (so the D10 copy has nowhere to live), and the same-name refusal is screen-reader-only
when the camp has two candidate schedules. The D8 disclosure passes. See
[docs/work/tickets/T251-t199-acceptance-fixture.md](T251-t199-acceptance-fixture.md) and
[docs/work/runs/2026-09-30-t251-t199-acceptance-fixture.md](../runs/2026-09-30-t251-t199-acceptance-fixture.md).

## Walk 2026-09-30 — real app, screen access granted

The board worker drove the real `electron:dev` app by hand (19:10-20:16, owner's screen grant)
against the T251 acceptance camp — the first director's-eye pass through this ticket's own flow
table rather than through a jsdom-rendered component. A first capture attempt via shell
`screencapture` produced 24 copies of the desktop wallpaper (no screen-recording permission on this
machine); that evidence was deleted before anything was written, and the walk was re-captured via
the Chrome DevTools Protocol against an Electron instance relaunched with
`--remote-debugging-port=9222`, which writes real renderer pixels. 16 new frames live at
`docs/work/evidence/T251/`.

**The director flow table's every row is now reachable**: no run -> import preview -> ready to
generate -> draft (move/lock/regenerate) -> final (export or start a revision), on both the Manual
and Generated routes. The D8 at-rest-encryption disclosure (release precondition) is present at
every entry tested, including a return to the run list and back. Spec §6 condition 11 ("JSON,
XLSX, UI, CLI and MCP agree") is now met by T198 (#665).

**This ticket's exit condition is still not met**, and status stays `open` under the owner's rule
that a director-facing defect at an owned seam is a reason the work is not finished (subject to the
owner's override) — the walk found four such defects, filed on the board as
`i-write-ipc-freezes-app-after-commit-and-finalize`,
`i-final-run-always-reads-out-of-date-since-v76`,
`i-same-name-sheet-solves-silently-dropping-a-camper`, and
`i-bundle-tier-not-covered-wall-and-raw-codes`. See
[docs/work/tickets/T251-t199-acceptance-fixture.md](T251-t199-acceptance-fixture.md)'s own walk
section for each defect's detail and evidence frames, and
[docs/work/runs/2026-09-30-t251-electron-dev-walk-director-flow.md](../runs/2026-09-30-t251-electron-dev-walk-director-flow.md)
for the full narrative. Spec §6 condition 4 (no camper violates eligibility) remains an asserted
gap, untouched by this walk; reduced motion remains unverified (DevTools emulation could not be
driven in this pass).
