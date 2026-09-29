---
title: "One spelling for a provisional subject, and one reader for the bytes"
document_type: ticket
status: completed
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
2. `submissionKey` becomes optional, defaulting to `submissionKeyFromRows(rows)` — deriving the key
   from the rows the module was handed is the one rule, not path policy, and it removes the last way
   two doors could key on different row sets.

   **AMENDED mid-flight, and the amendment is the interesting part.** The original predicate said
   `readPreferenceSheet` gains NO new parameters, and that held until #644 landed on main while this
   was in flight. #644 added a step **1a** to the CLI's `resolveSubject`: a db probe asking whether
   this submission has already been imported and NAMED, returning that camper so a re-import lands
   on her instead of forking a second row. That step **cannot** move into the shared module —
   `readPreferenceSheet` is pure by contract, and a fact about what this camp has already stored is
   the CLI's to find, exactly as `INDISTINGUISHABLE_SUBMISSION` is.

   So the CLI keeps step 1a as `locateNamedCamper` (#644's probe, carried verbatim) and the shared
   module gains `camperId` and `externalId`: a camper the caller has already LOCATED, set alongside
   `camperName`. That is step 1 of the identity order expressed as an id rather than a name — the
   same kind of parameter as `camperName`, not policy. #644's own argument is why it must be an id:
   `deriveCamperId`'s `ext`/`name` arms read `external_id` and `display_name`, both ordinary
   admin-writable columns, so re-deriving an id for a row that already exists mints a second one the
   day an admin fixes a typo.

   The alternative — letting the CLI build the subject object for that one case, bypassing the shared
   module — was rejected: it reintroduces exactly the fork this ticket closes, for the case #644 just
   made subtle.
3. One reader for the bytes: `readWorkbookRows` in `src/utils/exportSanitize.js`, used by the CLI,
   the panel, and the panel's test.
4. A whole-sheet grid reports NO skipped rows through either door.
5. Both doors, given one submission and one arrival, land on ONE camper row — asserted on camper
   rows in the database, with a non-vacuity control showing two arrivals still give two rows.
6. `test/panelImportPath.test.js`, `test/callerDeclaredArrival.test.js` and
   `test/unattributedSubjectIdentity.test.js` stay green. The middle one grew from 18 tests to 35 on
   main while this was in flight (#644), and all 35 pass through the delegation — including the three
   that fork her if `camperId`/`externalId` are threaded wrong: a roster id attached after naming, a
   corrected spelling, and a roster id cleared after naming.
7. `npm run verify` green.

## Non-goals

- Changing what an arrival MEANS, or the identity order.
- Teaching `readPreferenceSheet` about workbooks. Tab selection, "tabs are never combined", and the
  `UNREAD_SHEET` residue stay in the CLI, which is the only door that sees more than one sheet.
- Moving `INDISTINGUISHABLE_SUBMISSION` out of the CLI: it is a fact about the DATABASE, which the
  pure module cannot read.

## Closed

Landed as [#651](https://github.com/gfeitel1-maker/Scheduling-Project-/pull/651), squashed to
`3f438f1c`. CI `verify` green on the merged head; the merge was audited BY CONTENT rather than by
ancestry, because a squash merge cannot be checked with `--is-ancestor`: `readWorkbookRows` is present
in all three of `src/utils/exportSanitize.js`, `scripts/preferenceSheetCli.js` and
`src/screens/elective/assignment/AssignmentPanel.jsx`, `locateNamedCamper` and `camperId` are on main,
and #644's `SUBMISSION_ALREADY_NAMED` survives at four occurrences in the CLI — the check that matters,
since this change deleted the function #644 had just extended.

Every predicate above is met. Evidence, all from execution:

- 197 tests green across the eight affected suites, including the 57-file corpus suite.
- The three named regression suites green, and `test/callerDeclaredArrival.test.js` at **35** tests
  rather than the 18 it had when this ticket was written — #644 grew it mid-flight, and all 35 pass
  through the delegation, including the three that fork a child if `camperId`/`externalId` are threaded
  wrong (a roster id attached after naming, a corrected spelling, a roster id cleared after naming).
- Each of the three fixes red-then-green: reverting the shared reader turns the quoted-cell tests red
  (two camper rows for one child, and no packed-cell decision offered); reverting the positional-rows
  fix turns the skipped-rows test red on both doors at once, which is itself the evidence the fix now
  lives in one place.
- The structural guard was confirmed to FIRE on the deleted hand-split line and not on a legitimate
  newline split, before being trusted green.

## What this cost, recorded because the next refactor across these files will pay it again

Five rebases. `main` gained eight commits during the work, four of them inside this change's own files
(#644, #646, #648 T312, #652). The near-miss worth naming: #644 added ~130 lines INSIDE the function
this ticket deletes. Resolving that conflict "in favour of mine" would have silently reverted a
shipped fix for a child appearing twice in the database. What avoided it was taking #644's version of
the file as the BASE and re-applying this change on top, rather than merging their work into this one —
and then running their tests, not just these.

Not done, deliberately: the panel still reads only the FIRST sheet of a workbook, so a director whose
preference table sits on tab 2 imports nothing while the CLI would classify every tab. Recorded in
Non-goals above; it is a separate director-facing defect, not part of this unification.
