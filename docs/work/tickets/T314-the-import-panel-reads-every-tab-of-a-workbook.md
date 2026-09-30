---
title: "The import panel reads every tab of a workbook, not just the first"
document_type: ticket
status: open
created: 2026-09-29
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md]
related_tickets: [docs/work/tickets/T313-one-spelling-for-a-provisional-subject.md]
archive_when: "a director importing a workbook whose camper preference table sits on any tab gets it read, with the tabs that were not read named back to them; the panel and the CLI classify tabs by ONE rule; and a second tab holding an offerings menu can no longer be imported as a phantom camper named after the file"
---

# T314 — The import panel reads every tab of a workbook, not just the first

Owner ruling 2026-09-29, verbatim, on finding this recorded as a T313 non-goal rather than fixed:

> "a director who has two tabs on an import won't get their thing read. that is fucking absurd. and
> should be a fix. it is this kind of shit that is killing me ... this is the stopping before the
> work is actually done piece we started with."

The criticism lands on the process, not only the code: T313 shared the row READER between the two
import doors and then left the panel reading `sheets[0]` while the CLI classified every tab. Half a
choke point.

## What a director hits, measured before this was written

`readSheetRows` in `src/screens/elective/assignment/AssignmentPanel.jsx` returns `sheets[0]?.rows`.
Three workbooks, one catalog, through the panel's path and then through the CLI's rule:

| workbook | panel today | the CLI's rule |
|---|---|---|
| offerings menu on tab 1, preference table on tab 2 | **1 camper named `book`** | 2 campers: Ari Feldspar, Noa Quartzite |
| notes on tab 1, preference table on tab 2 | **nothing — `parsed: null`** | 2 campers |
| preference table on tab 1, notes on tab 2 | 2 campers | 2 campers |

The first row is worse than the ticket title suggests and is the reason this is not merely an
inconvenience. A day × period grid on tab 1 — an offerings MENU, which is an ordinary thing to ship
beside a preference sheet — is read as one camper's own planner, so the import **succeeds**, creates
a phantom unattributed camper named after the FILE, and never touches the real table. Two real
children are silently not imported and a row that corresponds to nobody appears in the camp. The
second row is the owner's complaint as stated: the director is told "That file does not read as a
camper preference sheet" about a file that plainly does.

## Design

**No tab picker.** The workbook's shape is the camp's data, not this app's model
(`feedback_we_read_their_data_we_dont_choose_the_format`, owner: *"it does not matter what tool
someone uses"*). Asking the director which tab to read would be asking them to do the classification
this code already knows how to do. Classify, read, and say what was not read — which is what the CLI
has done since T285 slice D.

The rule is extracted, not copied. `selectPreferenceSheet({ sheets, catalog })` moves to
`src/ingest/preferenceImport.js` beside `readPreferenceSheet` — pure, no db, so the module's contract
holds — and returns the selected sheet, why it was selected, and the `UNREAD_SHEET` residue for every
tab that was not. The CLI's `candidates`/`chosen`/`gridSheet`/`unreadSheets` become calls to it, and
the panel gains the same behaviour by construction rather than by a second implementation. That is
the point: T313's lesson was that a second call shape is a second defect even when the transform is
shared, and a second SELECTION rule is the same thing one layer up.

**The director is told.** `UNREAD_SHEET` is already a residue kind and `ParseSummary` already renders
residue, so the tabs that were not read reach the director through the surface that exists. The panel
must thread it through `confirmMapping`'s re-parses, the way it already threads `rows`, `sourceLabel`,
`submissionKey` and `arrivalId` — a settled label re-parses, and a residue item that vanishes on the
second parse is worse than one that was never shown.

## Success predicate

1. A workbook whose preference table is on tab 2 imports that table, through the panel, asserted on
   camper rows in the database.
2. An offerings menu on tab 1 no longer produces a phantom camper named after the file.
3. A workbook whose table is on tab 1 is unchanged — the no-regression case.
4. The tabs that were not read are named back to the director, and survive a re-parse.
5. The panel and the CLI select a tab by ONE function; the CLI's existing residue text and behaviour
   are unchanged (`scripts/preferenceSheetCli.test.js`, `test/preferenceEtlResolve.test.js`).
6. Red-then-green on each of 1, 2 and 4, plus a planted wrong-sheet selection that the new tests catch.
7. `npm run verify` green.

## Non-goals

- Combining tabs. Nothing is ever concatenated; exactly one tab is read and the rest are reported.
  Two tabs of submissions are two imports, and merging them would be the one refusal the ADR names.
- Choosing between two tabs that BOTH map cleanly. The first wins and the rest are reported, exactly
  as the CLI already does — accept-and-report, not a merge, and not a question for the director.
