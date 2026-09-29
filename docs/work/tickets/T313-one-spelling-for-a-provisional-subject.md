---
title: "One spelling for a provisional subject, and one reader for the bytes"
document_type: ticket
status: open
created: 2026-09-29
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md]
related_tickets: [docs/work/tickets/T303-caller-declared-arrival-on-the-machine-path.md, docs/work/tickets/T299-identical-submissions-are-not-one-camper.md, docs/work/tickets/T305-a-whole-sheet-planner-grid-imports-through-the-panel.md]
archive_when: "provisional camper-subject identity is built in exactly ONE place; the CLI and the panel reach it through the same call shape; both doors read a workbook's bytes through the same reader, so one submission is one camper id whichever door it came through, asserted on camper rows in the database; and the CLI keeps both things that are genuinely its own — the content-derived arrival default and the boundary refusal of a malformed arrival_id"
---

# T313 — One spelling for a provisional subject, and one reader for the bytes

Found by an altitude review of the two import doors, then measured by execution before this ticket
was written. Every number below is from a run, not from reading.

## The fork

Provisional camper-subject identity — `{ displayName, externalId, arrivalId, source, attributed }` —
is built in two places:

- `scripts/preferenceSheetCli.js`, in a local `resolveSubject`, which calls `parsePreferenceSheet`
  directly and does not import `readPreferenceSheet`;
- `src/ingest/preferenceImport.js`, in `readPreferenceSheet`, which the director's panel uses.

The CLI file's own comment, a few lines above the divergence, names the cost: *"ONE RULE, shared with
the import screen … two rules fork one child into two subjects depending on which door their sheet
came through."* That comment is about the submission KEY, which **is** genuinely shared through
`submissionKeyFromRows`. The arrival half is the unshared one, and T303 widened the gap by adding a
caller-declared arrival with a content-derived default to the CLI's copy only.

## What the two doors actually disagree about

Measured on one identical planner grid through both doors:

| | CLI door | panel door |
|---|---|---|
| camper id | `camper1:…sub-5471…5.arr-1` | identical |
| `arrivalId` default | `?? importedRunId` | none |
| `skippedRows` | `[]` | `[{row 2, 'no camper name'}, {row 3, …}]` |
| residue `source` | `'filename'` | `'label'` |

The third row is a defect nobody had named. `readPreferenceSheet` passes `rows` positionally
alongside an EMPTY mapping for a whole-sheet grid, so every grid body row is skipped as "no camper
name" — and `ParseSummary` renders that count to the director as "2 row(s) skipped" on a file where
all six preferences landed. A residue item that is false is worse than one that is missing
(`src/ingest/preferenceSheet.js`, the UNREAD_TABLE_ABOVE_HEADER comment). The CLI's `[]` is right.

## The larger half: the two doors do not read the same bytes

The fork is not only in the subject object. It is one layer up, in the row readers, and this is where
the real damage is. The CLI sends every file — CSV included — through `readWorkbookSafely`. The panel
hand-splits CSV on `/\t|,/` after `.trim()`. Over the 32-file probe corpus, **7 files read
differently**, and they are the headline probes rather than curiosities:

- `P09-kind3-packed-cells.csv` and `P10-unordered-set-no-rank.csv` — the packed cell
  `"Archery, Ceramics, Woodworking"`, which is the entire point of those probes, becomes THREE
  columns through the panel, with literal `"` characters inside the activity labels. The panel's
  reader destroys the packed-cell feature before the parser ever sees it, so the director is never
  offered the `split_packed` resolution.
- `P17-kind3-spaced-rank-headers.csv` — a probe specifically about header padding (`"# 1"`, `"#2 "`,
  `" #3"`). The hand-split's `.trim()` erases the exact condition the probe exists to test.
- `P22`, `P23`, `P12`, `P13` — differ on preamble and menu rows.

`test/panelImportPath.test.js` did not catch any of this because its own `readRows` helper
deliberately replicates the panel's hand-split ("mirrors AssignmentPanel's own CSV branch … so this
exercises the panel's reading as well as its call shape"). A test that copies the reader under test
cannot see the reader being wrong.

Consequence for identity, which is what ties this half to the first: a quoted CSV yields
`sub-910a00c4…` through the CLI and `sub-9407a1e0…` through the panel. Same file, two camper ids —
this ticket's own defect class, displaced from the digest to the reader.

## What must NOT move down, and why

Two things stay at the CLI, and the reasoning is load-bearing rather than stylistic:

- **The content-derived default** (`arrivalId: declaredArrival ?? importedRunId`) is PATH POLICY.
  Only the CLI has file bytes to content-address, and the panel deliberately mints one arrival per
  file selection. `readPreferenceSheet` therefore gains **no** `defaultArrivalId` parameter: the CLI
  holds both values before the call and passes the resolved one, so the `??` rule never enters the
  shared module. (The altitude review suggested such a parameter; passing the resolved value is
  strictly simpler and keeps the policy where it belongs.)
- **The boundary refusal of a malformed `arrival_id`** belongs at the CLI/MCP boundary, because
  `runPreferenceSheetCli`'s contract is that it never throws past it.

## Success predicate

1. `resolveSubject` no longer exists; `readPreferenceSheet` is the only place a provisional subject
   is constructed, and the CLI calls it the way the panel does.
2. `readPreferenceSheet` gains no new parameters. `submissionKey` becomes optional, defaulting to
   `submissionKeyFromRows(rows)` — deriving the key from the rows the module was handed is the one
   rule, not path policy, and it removes the last way two doors could key on different row sets.
3. One reader for the bytes: `readWorkbookRows` in `src/utils/exportSanitize.js`, used by the CLI,
   the panel, and the panel's test.
4. A whole-sheet grid reports NO skipped rows through either door.
5. Both doors, given one submission and one arrival, land on ONE camper row — asserted on camper
   rows in the database, with a non-vacuity control showing two arrivals still give two rows.
6. `test/panelImportPath.test.js`, `test/callerDeclaredArrival.test.js` and
   `test/unattributedSubjectIdentity.test.js` stay green (42 tests, green before this work).
7. `npm run verify` green.

## Non-goals

- Changing what an arrival MEANS, or the identity order.
- Teaching `readPreferenceSheet` about workbooks. Tab selection, "tabs are never combined", and the
  `UNREAD_SHEET` residue stay in the CLI, which is the only door that sees more than one sheet.
- Moving `INDISTINGUISHABLE_SUBMISSION` out of the CLI: it is a fact about the DATABASE, which the
  pure module cannot read.
