---
title: "Should the Locations sheet round-trip at all, and if so by id"
document_type: ticket
status: parked
created: 2026-09-24
archive_when: the owner has decided whether Locations round-trips — either the sheet becomes id-matched and updatable on BOTH the export and import sides, or the decision is recorded that it stays create-or-skip and this ticket closes as wont-fix
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_tickets: [docs/work/tickets/T255-name-keyed-lookups-assume-uniqueness.md]
---

# T256 — Should the Locations sheet round-trip at all

## Status: PARKED by owner decision, 2026-09-24

This is spun out of [T255](T255-name-keyed-lookups-assume-uniqueness.md) finding 9, which is closed
there as deferred-by-decision. **Nothing is to be changed until the product question below is
answered.** The owner ruled explicitly that no code change happens now.

## The owner's reasoning, which is the premise of this ticket

Making Locations id-matched is **a coordinated change on both sides plus a shape change to workbooks
directors already hold**. And the underlying gap — that a capacity edit updates nothing, because the
round-trip is create-or-skip rather than diff-and-update — **predates v73**. It is a product question
about whether Locations should round-trip at all, and it does not belong bolted onto a
collision-hardening program.

The v73 duplicate case is **visibly surfaced today** regardless: `locations` already carries a
duplicate marker and a merge verb (`src/screens/locationDuplicates.js`,
`src/screens/LocationsScreen.jsx`), which is more than the other nine relaxed entities get. So
deferring this leaves no silent failure — it leaves a known, marked one.

## What was measured, so the next person does not re-derive it

- The id column is `shoresh_id` (`ID_COLUMN`, `src/utils/exportWorkbook.js`) and is prepended to
  every sheet in `SHEET_LAYOUT` — all six ingestible entities (`Programs`, `Age Divisions`, `Groups`,
  `Days`, `Time Blocks`, `Activities`).
- **Locations is excluded deliberately**, with a rationale stated in that file: it sits outside
  `SHEET_LAYOUT`, is not part of the id-matched baseline-diff re-import, and "matching that shape
  exactly means the round-trip needs no new parser".
- **The import side does not read an id.** `parseLocationsSheetRows`
  (`src/utils/importLocationsSheet.js`) touches only `name`, `capacity` and `kind` and returns no id.
  Its caller in `src/screens/LocationsScreen.jsx` is name-keyed and name-deduped
  (`duplicateCheck` compares lowercased names).
- **So the round-trip is create-or-skip, not diff-and-update.** Two same-named locations re-import as
  one create plus one skip, and a capacity edit never updates the right row because nothing updates
  at all. Adding the export column alone would be **inert**.

## Constraints to carry forward, for whenever this is built

1. **`shoresh_id` goes FIRST**, matching every other sheet. Not appended.
2. **A blank or unknown id means "create", never an error.** A director will hand-add rows.
3. **A name-keyed lowest-id tie-break here is the WORST of the three options** — worse than doing
   nothing. It would let a director's capacity edit land silently on the wrong location with no
   trace, which is the exact failure shape T255 exists to remove. Nobody should reach for it as a
   cheap middle path.

## Known Excel-format risk, if it goes ahead

Low but real, and it runs the opposite way to the obvious worry. `sheet_to_json` is header-keyed, so
an extra `shoresh_id` column is ignored by the current parser and older workbooks without it keep
parsing. The break risk is that `LocationsScreen`'s own `downloadTemplate` also emits a `Locations`
sheet, `src/utils/exportWorkbook.test.js` pins that header as exactly `['name','capacity','kind']`,
and a director copy-pasting rows between an old and a new workbook would shift values under
mismatched headers.

## Non-goals

Reference-aware merge. Re-opening the v73 relaxation. Changing the Locations duplicate marker or its
merge verb, which already work.
