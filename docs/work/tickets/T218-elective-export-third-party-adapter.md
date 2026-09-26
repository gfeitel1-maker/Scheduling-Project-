---
title: T218-elective-export-third-party-adapter
document_type: ticket
status: closed
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

## Closed (2026-09-26)

Closed by owner ruling, not by completion. Status is `closed`, not `completed` — the
`archive_when` above ("a third-party export adapter ... is designed or explicitly rejected") is
discharged by the **explicit rejection** half, not by a design being delivered. Nothing was built.

The owner's words:

> "it does not matter what tool someone uses."

and, on source data shapes generally:

> "it shouldn't matter. we keep going over this. we are reading someone's data. we are not choosing ho they import it. i don't know why we keep going round and round about this"

**What that decides.** This ticket's premise was a per-third-party adapter — identify the product,
learn its documented export contract, write a boundary that speaks it. The owner rejects
tool-specific coupling outright. The source format is the camp's, not ours; we read what arrives
and normalize it. "Which tool does the camp use" is a mis-typed question, not an open decision, and
this ticket cannot be reshaped around it.

**What already makes this true in code** (the reason the close is "overtaken", not merely
"declined"). The preference-sheet ingest path — the surface this ticket's own de-gating section
narrowed to — is already mapping-driven rather than format-driven:

- `src/ingest/preferenceSheet.js:9-18` states the property directly: a new export format is a
  mapping, not a code change.
- `src/ingest/preferenceSheet.js:38` `inferPreferenceMapping(header)` proposes a column layout from
  whatever header arrived; `:63` carries nullable fields and an `unmapped` remainder.
- `src/ingest/preferenceSheet.js:77` `parsePreferenceSheet(rows, { campId, mapping })` parses
  *under* the mapping — the layout is an argument, not a constant.
- The director corrects the proposal in-app at
  `src/screens/elective/assignment/MappingCorrector.jsx:41`, wired at
  `src/screens/elective/assignment/AssignmentPanel.jsx:527`.

That is the adapter boundary this ticket asked for, already built and already tool-agnostic. An
adapter named after a vendor would be a step backwards from it.

**One gap named honestly, so the close does not read wider than it is.** The *offering-grid* ingest
path is not mapping-driven the way the preference path is: axis labels are matched to existing
entities by name with no remap seam
(`src/ingest/electiveSetPopulate.js:140-161`, refusal at `:103-104`), and orientation is inferred
heuristically with a refuse-whole-sheet outcome when not confident
(`src/ingest/parseGridSchedule.js:196-197`, `:344`). That is a real capability gap, but it is not
this ticket's gap — it is the grid surface, and it is recorded against T219 and handed to the owner
separately. Closing T218 does not close it.
