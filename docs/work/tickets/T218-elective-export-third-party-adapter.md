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
