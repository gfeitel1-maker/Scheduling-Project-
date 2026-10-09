---
ticket: T353
document_type: ticket
title: Camper Excel export that re-imports through the preference-sheet import to update campers
status: open
created: 2026-10-09
archive_when: "a Download campers control exports a workbook whose sheet re-imports through the existing preference-sheet import and commit path; a red-first round-trip test on a real templated DB proves an edited field changes with no duplicate and no lost camper; DIRECTOR_GUIDE end-of-season section describes export, edit, re-import, then clear; npm run verify green in CI"
task_class: ui-ux-design
parent: ""
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_prs: []
related_tickets: []
---

# T353 — camper export that round-trips through the preference import

## Ruling (owner, 2026-10-09, end-of-season option b, relayed by the board keeper)

Build a CAMPER Excel export using the same canonical-workbook pattern as
`src/utils/downloadWorksheet.js`, whose sheet re-imports through the EXISTING preference-sheet
import (`src/ingest/preferenceSheet.js` and its commit path, `commitElectiveRun`) to UPDATE campers.
No camper removal; the camper-removal ticket (T342) stays shelved.

## Shape

- One sheet in the preference-sheet table shape the importer already reads: `Camper ID`,
  `Camper Name`, `Division`, then `Day`/`Period` when the choices are per-cell, then `#1..#N` —
  the camper's ranked choices from their most recent run.
- Identity on re-import is the importer's own rule: `Camper ID` (external id) when present,
  otherwise the name. So a name is safely editable only for a camper with a Camper ID.
- A camper with no stored choices is not exported (the importer writes nothing for a row with no
  ranked choices), so export before **Clear season's elective choices**.

## Acceptance

1. Red-first round trip on a real templated DB, no mock of the code under test: seed → export →
   edit Division in the produced workbook → re-import via the real CLI import + commit →
   the field changed, camper count and ids unchanged.
2. **Download campers** on the Electives screen beside the season clear control; a failure is
   surfaced via `describeWriteFailure`.
3. `docs/guide/DIRECTOR_GUIDE.md` §11 describes export → edit → re-import, then clear.

## Non-goals

Removing campers (T342). New identity columns. Exporting campers who hold no choices.
