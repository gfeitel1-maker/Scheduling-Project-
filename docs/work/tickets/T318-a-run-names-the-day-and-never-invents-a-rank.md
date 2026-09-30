---
title: "A run names the day it means, and never tells staff a rank the camper did not give"
document_type: ticket
status: completed
created: 2026-09-29
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md, docs/adr/2026-09-17-individual-elective-scheduling.md]
related_tickets: [docs/work/tickets/T296-per-camper-elective-schedule-view.md, docs/work/tickets/T297-edit-a-campers-elective-preferences.md]
archive_when: "an over-capacity row on an elective run names the day and the period — on a freshly solved run and on a run reopened cold from the run list — and no surface a director or counsellor reads, on screen or on paper, before a run is committed or after, states an ordinal choice for a camper whose sheet was read as an unordered set"
---

# T318 — A run names the day it means, and never invents a rank

Three defects, all owner-ruled 2026-09-29, all recorded as known limits when T296 closed
(`docs/work/tickets/T296-per-camper-elective-schedule-view.md`, "Known limits at close"). They are
bundled because they sit on two adjacent seams of the same screens and the same copy module.

## (a) An over-capacity finding names the period but never the day

Owner: *"over capacity needs to show."*

`occurrenceLabel` in `src/screens/elective/run/runStateCopy.js` resolves a day with
`days.find(...).name`. `days_of_operation` stores its name in `label`, not `name`
(`electron/db/schema.sql`). So the day never resolves, and the label silently collapses to the time
block alone — a director is told a period without being told which day it is on.

The sibling projection `src/screens/elective/run/camperElectiveWeek.js` already reads
`label ?? name`, both ways, for the same catalog. This makes the two agree.

## (b) A reopened run shows over-capacity rows with no day or period at all

Owner: *"fix this."*

There are two occurrence sets on these screens, and the over-capacity rows label from the wrong one.
`templateOccurrences` is `AssignmentPanel`'s React state — the current template's set, and **empty**
for a run opened from the run list. `useRunState().occurrences` is the run's own persisted set and is
always present. `DraftRunView.jsx` and `FinalRunView.jsx` both pass the former, so on a reopened run
the over-capacity row degrades to a bare activity name.

Looking up the occurrence an assignment row already names is the sanctioned use of the persisted
list — `getElectiveRun`'s own comment says so, while warning that the same list is the union of every
generation and must not be read as the *current* set. The move dropdown does need the current set and
keeps `templateOccurrences`.

## (c) Staff are told a rank the camper never gave

Owner: *"campers wouldn't be shown this after, it is all in the director/staff hands now. so this
needs to be fixed."*

A camper whose sheet was read as an **unordered set** (`elective_preferences.rank_kind =
'unordered-set'`, v79, ADR 2026-09-27 §4.1/§13.3) still carries an integer `rank`, because the ETL
writes one — it is a tie among equals, not a ranking. Three surfaces read that integer and print an
ordinal:

- `camperElectiveWeek.js`'s `rankLabel` → "Second choice", rendered in `CamperWeekPanel.jsx`.
- `runStateCopy.js`'s `satisfactionSummary` → "…got a second choice…", rendered in `DraftRunView.jsx`.
- `src/screens/elective/export/exportRunSummary.js` → `counts_by_rank`, which reaches **paper** as a
  `Rank 2: N` row in the exported workbook's Summary sheet.

`rank_kind` lives on `elective_preferences`, not on the assignment row. It does not need to be
carried onto the assignment row to fix this: `getElectiveRun` already returns the run's preferences
including `rank_kind`, and T297 already built the assignment→preference join
(`preferenceIndex`/`preferenceIdFor`) that both these screens already trust for edit affordances.
So the kind is derived at display time from a join that already exists, and no schema change is
required. Architect confirmed this on evidence and refuted the T296-era note that claimed the column
had to move.

**The rule that makes fabrication impossible by construction:** an ordinal is shown only on positive
evidence of ordering — `rank_kind` exactly `'cell-choice'` or `'ordered-fallback'`. Every other case
— `'unordered-set'`, a null kind, or a preference row that cannot be joined at all — reads as the
non-ordinal word. Absence of evidence that ordering happened is not evidence of order, and the two
costs are not symmetric: the safe default costs a blander label on legacy or edited data, the unsafe
default is the defect the owner ruled must not exist.

## Not in scope

The solver. Auth, IPC shape, schema. `exportChildSchedule` (it carries no rank at all). The
`templateOccurrences` residual inside the export input, which cannot fabricate a rank — an unbindable
preference falls to the whole-run join arm or to the safe default.

## (d) The pre-commit preview fabricated the same ordinal — closed in round 2

Found by Red Hat while reviewing (a)–(c), and closed here rather than recorded: the same defect on the
same class, one screen earlier. The `NOT_TOP_CHOICE` flag was emitted from `rank > 1` alone, at both of
`src/engine/buildElectiveAssignments.js`'s emission sites (tier 2's `rankAt` path and tier 1's
linked-choice `choiceRankMinOverMembers` path), and rendered as "Not top choice (got #N)" by
`src/screens/elective/assignment/AssignmentPreview.jsx` and again by
`src/screens/elective/assignment/exportElectiveRun.js`. So a director previewing a solve saw the
fabricated ordinal before the run existed to be read the honest way.

The flag is now gated on the same positive-evidence rule as the display surfaces, applied to the
`rank_kind` of the row that **won the rank fold** — not the last row seen, and not OR-ed across rows.
The fold stores `{rank, kind}` so the kind travels with the winning rank.

**The tie rule took two attempts, and the first was wrong.** Governor's initial ruling was that a tie
between rows of *differing kinds* collapses to no-evidence. That is right for an ordered-vs-unordered
tie and wrong for ordered-vs-ordered: `cell-choice` and `ordered-fallback` are **both** positive
evidence and differ only as strings, so the first version also suppressed a real ordinal. Red Hat
found it and traced it to the tier-1 linked-choice path, where `choiceBestOverMembers` seeds the fold
from a camper's whole-run fallback row and folds cell-scoped rows into it. The rule now collapses to
no-evidence **only when the two sides disagree about whether ordering happened**, which is the only
question the gate asks; an ordered-vs-unordered tie still collapses, which is what keeps fabrication
impossible.

That two-live-row state is **reachable from real parser output, not merely defensive.**
`inferPreferenceMapping` builds `ranked[]` from header parsing, and a day/period-scoped header
("Monday Period 3 - 1st Choice") yields a coordinate while a plain header ("2nd Choice") yields none;
both feed the same `rankColumns`, with nothing requiring a sheet to be one shape or the other. The
dedup key is `camper_id\0scope\0labelKey` with `scope = occurrence_id ?? coordinateKey(coordinate)`,
and `coordinateKey(null)` is `''` — so a whole-run row and a cell-scoped row for the same camper and
activity never collide and both survive. It needs a mixed-format sheet naming one activity at the same
rank in both sections: unusual, not invalid.

The single predicate and the three `rank_kind` values now live in `src/engine/rankKind.js`, a
dependency-free module imported by the engine, by `src/ingest/preferenceSheet.js` (the ETL that writes
the column) and by the four readers. It replaced four copies of the predicate — one of them negated,
in `satisfactionSummary` — and three copies of the string values, one of them on a persisted-write
path. A typo now propagates to every consumer at once and fails safe, therefore silently, so
`rankKind.test.js` pins the three exact strings as well as the predicate's six cases.

**This is a flag-emission gate, not a placement change.** `rankAt` and `choiceRankMinOverMembers` feed
the cost matrices, so their numeric returns are untouched and the kind is read through parallel
readers over the same fold. A test pins the identity: the same inputs produce the same assignments,
compared on everything but `flags`, against a literal expected array hand-derived from the cost matrix
rather than from the function itself.

The message keeps its embedded ordinal, because it can now only appear where an ordinal is real.

## Not in scope

The solver's placement behaviour (this ticket gates a flag; it does not move a camper). Auth, IPC
shape, schema. `exportChildSchedule` (it carries no rank at all). The
`templateOccurrences` residual inside the export input, which cannot fabricate a rank — an unbindable
preference falls to the whole-run join arm or to the safe default. De-duplicating the two copies of the
`NOT_TOP_CHOICE` message literal, which are now both correct.
