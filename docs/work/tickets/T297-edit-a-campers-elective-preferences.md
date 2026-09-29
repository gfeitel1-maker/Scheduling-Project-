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

## The provenance decision, 2026-09-28

**A re-import PRESERVES a director's correction and REPORTS it. It never overwrites one, and never
preserves one silently.**

Four behaviours were available and only one is allowed:

| | Why not |
|---|---|
| Overwrite it | A director's decision discarded without being told — the defect class this program exists to remove. |
| Preserve it silently | The same loss in the other direction: the import reports success while quietly declining to apply the file, and it surfaces later as "didn't I fix that?" |
| Refuse the whole file | One edited row blocking two hundred good ones. |
| **Preserve it and report it** | What `ingest.js` already does for hand-edited entity fields under Policy A. The house rule, not a new one. |

The report is a `PREFERENCE_EDIT_HELD` finding, **one per held row** naming the camper — a count
answers a different question than the one a director is asking (T232's argument for per-value
findings).

What this deliberately does **not** decide is what the director should then be able to *do* about the
disagreement. That is the whole-file merge strategy this ticket is explicitly not. All it owes is that
the row is distinguishable and the disagreement is visible, so that question can be answered later
without data having already been lost.

**No new mechanism and no schema version.** The marker is the existing `source:'human'` op stamp read
back through `isHumanOwned` (ADR 2026-09-09), and a withdrawal is an explicit `source:'human'`
`DELETE_FIELD` op, following `ingest.js`'s `rejectedSlotKeys` — where an import teardown's null-source
delete is excluded by a `===` check.

Two findings worth recording because both were confirmed by execution rather than inspection:

1. **The marker meant nothing for this table.** `commitElectiveRun` left `source` unset, `appendOp`
   defaults it to null, and `isHumanOwned` decodes null as HUMAN — so **every imported preference read
   back as a director's hand edit**. Stamping the import `source:'import'` is what makes the marker
   mean anything; a marker true of every row protects nothing.
2. **Two gates are needed, not one.** Changing a cell's choice writes the new row under the `occ` arm
   of `deriveElectivePreferenceId` and tombstones the imported `at`-arm (coordinate) row. Those are
   DIFFERENT ids, so a field-level provenance gate never sees a collision — the re-import happily
   re-creates the old row and the cell holds two rank-1 choices again. The tombstone gate is the
   load-bearing one.

## Known limit at close

**A run opened cold from the run list can be edited but not re-solved in that session.** The
"Solve again" control appears only when `AssignmentPanel` supplies `onRegenerate`, which it withholds
for a run reopened from the list because that session has derived no template occurrences to solve
against. This is T250's pre-existing gap (the same one that makes `danglingFindings` session-scoped),
not something this work introduced — but it does bound the `archive_when`'s "and re-solve" clause to
the session in which the sheet was imported, so **this ticket stays open.** Closing it means giving a
cold-opened run its own occurrence derivation, which is T250's follow-up rather than this ticket's.

Everything else in the `archive_when` is discharged: change/add/remove for a cell or whole-run, through
`authorize()` and the op log with `describeWriteFailure` on every call, an edited row distinguishable
in provenance, and `src/screens/elective/run/preferenceEditToResolve.test.jsx` driving the real
affordance and asserting the changed placement.
