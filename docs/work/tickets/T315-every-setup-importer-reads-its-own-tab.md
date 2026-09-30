---
title: "Every setup importer reads the tab that holds its entity"
document_type: ticket
status: open
created: 2026-09-29
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T314-the-import-panel-reads-every-tab-of-a-workbook.md, docs/work/tickets/T313-one-spelling-for-a-provisional-subject.md]
archive_when: "a director importing a workbook into Days, Groups, Activities or Anchors gets the tab that holds that entity read rather than tab 1; the camp's Programs tab can no longer be imported as a group or an activity; each screen says which tab it read when the workbook had more than one; and the F4 import caps still apply through the new boundary"
---

# T315 — Every setup importer reads the tab that holds its entity

T314 fixed this for the elective preference panel. The same defect was in SIX more doors, and fixing
some of them is the pattern the owner named: *"this is the stopping before the work is actually done
piece."*

## What a director hits, measured before this was written

Each of `src/screens/DaysScreen.jsx`, `GroupsScreen.jsx`, `ActivitiesScreen.jsx`,
`AnchorsScreen.jsx`, `TiersScreen.jsx` and `TimeBlocksScreen.jsx` ran
`XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], …)`. Run against a
workbook in **this app's own export order** (`Programs`, `Age Divisions`, `Groups`, `Days`,
`Time Blocks`, `Activities`):

| screen | reads | result |
|---|---|---|
| DaysScreen | `label` off `Programs` | nothing — no usable rows |
| AnchorsScreen | `name`, `day_label` off `Programs` | nothing |
| **GroupsScreen** | `name` off `Programs` | **would import "Main Camp" as a group** |
| **ActivitiesScreen** | `name` off `Programs` | **would import "Main Camp" as an activity** |
| **TiersScreen** | `name` off `Programs` | **would import "Main Camp" as an age division** |
| **TimeBlocksScreen** | `name` off `Programs` | **would import "Main Camp" as a time block** |

**FOUR of the six, not two, are the silent-wrong-data kind** — every screen that keys on `name`. That
count was itself short at first: this ticket was written against four doors after a peer's report named
four screens, and `TiersScreen` and `TimeBlocksScreen` were found by checking the claim rather than
taking it. A partial count of a defect class is how the fifth and sixth doors get forgotten, which is
the same failure the owner was objecting to.

The `name`-keyed rows are the reason this is not merely an inconvenience. They do not fail; they
succeed, with the camp's own program name arriving as a plausible-looking row of the wrong entity
that nobody created. Silence with wrong data in it, which is the same shape as T314's phantom camper.

## Design

`readEntitySheet` in `src/utils/exportSanitize.js`, beside `readWorkbookRows` — one layer above
`readWorkbookSafely`, which keeps owning the capped READ. It returns the selected sheet, its rows as
objects keyed by header (what these importers consume), and the tabs it did not read.

**Two row shapes, one read boundary.** `readWorkbookRows` returns array-of-arrays for the preference
transforms; `readEntitySheet` returns header-keyed objects for the entity importers. That is not a
fork: the two families genuinely need different shapes, and the thing that must not fork — the read,
its caps, and `unescapeRow` — is shared underneath both.

**The selection order, each step earning its place:**

1. the sheet **name**, case- and space-insensitively. Exact, and it is what this app's own export
   writes, so it needs no guessing about columns.
2. the required **columns**, for a third-party file that names its tabs anything. All of them, not
   any: `name` alone matches four of this app's own sheets. First match wins, the rest are reported.
3. the **first** sheet, unchanged. A single-sheet file — the ordinary third-party case — therefore
   behaves exactly as it always did, which is what keeps this from being a rewrite of every
   importer's contract.

**The director is told which tab was read**, through `ImportModal`'s existing `previewSubtitle`, via
one shared `ImportPreviewSubtitle` component rather than four spellings of the same sentence. Said
only when the workbook had more than one tab: on a single-sheet file there was no choice to report.

## A SEPARATE defect found here and deliberately NOT fixed

**Fixing the tab does not make this app's own export importable.** The export's columns and the
importers' expectations do not match, independently of which tab is read:

| entity | export writes | importer reads |
|---|---|---|
| Days | `label` | `label`, **`day_of_week`**, `sort_order` |
| Groups | `name`, **`unit`**, `availability` | `name`, **`tier_name`**, `availability` |
| Activities | `name`, `priority`, `min_per_week`, `max_per_week`, `eligible_groups`, `location` | `name`, **`eligible_tiers`**, **`weather_alternative`** |

So an exported `Days` sheet imports zero rows even once the right tab is found, because every row
warns `day_of_week must be a whole number 0–6` on a column the export never writes. This ticket
deliberately does not widen into aligning those columns — that is a decision about what the export is
FOR, not a tab-selection bug — but it is recorded here with evidence so the next reader does not
mistake T315 for "round-tripping works now". It does not.

## Success predicate

1. Each of the six screens reads the tab holding its entity, from a workbook in the app's own export
   order, asserted on the rows the importer receives.
2. The camp's `Programs` tab cannot arrive as a group, an activity, an age division or a time block.
3. A single-sheet file is unchanged — the no-regression case.
4. Each screen names the tab it read when the workbook had more than one, and says nothing when it did
   not.
5. The F4 caps (byte and per-sheet row) still fire through `readEntitySheet`, and `unescapeRow` still
   applies.
6. The structural import gate still rejects a file that parses a workbook by hand, with its own
   non-vacuity check now that it matches a set of boundary functions rather than one name.
7. Red-then-green: planting first-sheet selection turns the selection tests red and leaves the
   fallback and cap tests green.
8. `npm run verify` green.

## Non-goals

- Aligning the export's columns with the importers' — recorded above as its own defect.
- Combining tabs. Exactly one is read and the rest are reported.
- Rewriting the six screen suites to stop mocking `XLSX`. They mock it, so they cannot exercise tab
  selection at all, which is why `readEntitySheet` has its own tests against real workbook bytes. That
  split is stated rather than left to be discovered.
