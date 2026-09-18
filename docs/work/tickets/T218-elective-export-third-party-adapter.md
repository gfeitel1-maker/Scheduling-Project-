---
title: T218-elective-export-third-party-adapter
document_type: ticket
status: open
created: 2026-09-18
archive_when: a third-party export adapter for elective offerings/preferences is designed or explicitly rejected
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
---

# T218 — third-party export adapter (design-stage)

Spun off from T195's rescoping: the real path a camp's elective preference data travels is an
**unseen third-party export** — not a hand-authored spreadsheet this repo has ever seen the shape of.
T195 (offering-grid import) and any future preference/assignment import both eventually need to speak
to whatever that third-party's export format actually is, but that format is unknown here — no real
artifact has entered this repo, and none should (see T195's parking commit and the draft ADR
amendment under `docs/work/specs/`).

## Scope (design-stage only — no code yet)

- Identify which third-party product(s) camps actually use for elective sign-up, once the owner is
  able to name one without exposing a real camp's data.
- Determine whether that product offers a documented export format (CSV column contract, API, other)
  or only ad-hoc spreadsheets a director hand-edits before import.
- Design an adapter boundary that keeps this repo's importer logic (parseGridSchedule /
  parseGridScheduleMenu / populateElectiveGrid) decoupled from any one third party's format —
  the adapter's job is producing the SAME normalized shape those consumers already accept, not a new
  write path.

## Non-goals (until scoped)

Writing any adapter code before the target format is confirmed; assuming the format looks like a
grid at all — a global 1-25 ranked list or a chosen-schedule-plus-alternates planner (T195's finding)
may export as a flat per-camper table, not a grid.

## Exit condition

Either a concrete third-party format is identified and specified well enough to start an
implementation ticket, or the owner explicitly defers this indefinitely with a recorded reason.

## De-gated by owner ruling, 2026-09-18

**This ticket no longer blocks anything.** The owner's direction: assume camps can supply a camper id
on the sheet, and do not wait for a real third-party export before building.

Two consequences worth stating plainly, because "de-gated" is not "solved":

1. **The camper-id assumption is now load-bearing.** `deriveCamperId`'s name-fallback path still
   exists and is still correct for a paper form, but the design is now built expecting the external
   id to be there. Where it is absent, a camp with same-name campers will be **blocked at import**
   by `commitElectiveRun` — correctly, and by design, but the failure lands on the director rather
   than on us. On a fabricated 100-camper sheet, 13% of rows collided by name alone.
2. **The mapping layer is what makes this safe to assume.** `inferPreferenceMapping` proposes a
   column layout and the director corrects it, so an unseen export shape is a mapping rather than a
   code change. That property is the reason the assumption is affordable — if the parser ever
   hardcodes a layout, this ticket becomes blocking again.

Kept OPEN rather than closed: the real export format is still unknown, and the first real import is
still where that gets learned. It is no longer a prerequisite for building.
