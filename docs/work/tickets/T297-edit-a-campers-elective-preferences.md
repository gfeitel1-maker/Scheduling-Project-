---
title: "A camper's elective preferences can be changed without re-importing a file"
document_type: ticket
status: open
created: 2026-09-28
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-09-26-per-cell-elective-preferences.md, docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md]
related_tickets: [docs/work/tickets/T296-per-camper-elective-schedule-view.md, docs/work/tickets/T265-minimum-headcount-to-run.md]
archive_when: "a director can change, add or remove one camper's elective preference for a given cell (or whole-run) from within the app and re-solve without re-importing a file; the edit is written through the same authorize()/op-log path as every other mutation with failures surfaced via describeWriteFailure; an edited preference is distinguishable in provenance from an imported one so a later re-import does not silently overwrite a human's correction; and a test drives the real path from edit to re-solve and asserts the changed placement"
---

# T297 — A camper's elective preferences can be changed without re-importing a file

## The gap, verified 2026-09-28

There is **no edit path for a preference**. A repo-wide search for a write, update or delete route
touching `elective_preferences` from the screens or the IPC surface returns nothing. Preferences
enter through import and are read-only thereafter.

So a camper changing their mind — or a director spotting a mistake in a row — has exactly one
remedy: correct the source file and import it again. And since T285 keys a submission by its content
hash, a corrected file is a **different submission**, producing a new run rather than amending the
existing one.

That is coherent behaviour, not a bug. It is also not a workflow a camp can actually run on: the
director's real loop is *look at what happened → change something → re-solve*, and the middle step
does not exist.

## The hard part is provenance, not the write

This repo has already solved a version of this once and the lesson is recorded: activity rules
hand-edited by a director are protected from being clobbered by a later re-import via a
`_humanFields` marker (see the activity-rule provenance work). The same hazard applies here and is
worse, because preferences are imported in bulk and routinely re-imported.

So the question this ticket must answer is not "how do we write the row" but **"what happens to a
human's correction when the file is imported again?"** A silent overwrite would be the same class of
defect T278 exists to eliminate — a director's decision discarded without being told.

## Non-goals

- Not a bulk editor. One camper, one preference, deliberately.
- Not a re-import merge strategy for whole files. That is a larger question; this ticket only has to
  ensure an edited row is *distinguishable* so that question can be answered later without data
  already having been lost.
- Not the per-camper view itself (T296), though the two will want to sit together.

## Notes for whoever takes this

- Every mutating handler goes through `authorize()` in `electron/auth/authorize.js`, which re-queries
  role and device trust per call. Every failure surfaces via `describeWriteFailure` — a bare catch is
  review-blocking.
- Schema v79 gives a preference a `rank_kind` and a coordinate as the child wrote it. An edit needs to
  be explicit about which of those it is changing: the activity, the rank, or the cell.
- Standing ruling: the director confirms, the app does not decide. An edit is a director's statement
  and must never be inferred from anything.
- Worth checking whether the MCP surface (`preference_sheet_preview` / `preference_sheet_commit`, and
  the attribution tools added in T285) should carry the edit too — the owner's standing interest is
  that an agent can drive this software, not only a person at a screen.
