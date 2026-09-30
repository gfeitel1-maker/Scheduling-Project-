---
title: "The seventh import door shares the tab rule instead of spelling it"
document_type: ticket
status: open
created: 2026-09-30
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T315-every-setup-importer-reads-its-own-tab.md, docs/work/tickets/T314-the-import-panel-reads-every-tab-of-a-workbook.md]
archive_when: "every import door in the app selects its sheet through readEntitySheet or readWorkbookRows; a locations workbook whose tab is named `locations` or whose table sits on a later tab with no `Locations` tab at all is read rather than falling back to somebody else's entity"
---

# T317 — The seventh import door shares the tab rule instead of spelling it

Found by auditing `main` for `SheetNames[0]` after T315 landed, rather than by assuming the class was
closed. One site remained: `src/screens/LocationsScreen.jsx`.

## Why this one looked done and was not

T121 had already fixed the headline hazard here, and correctly:

```js
const sheetName = wb.SheetNames.includes('Locations') ? 'Locations' : wb.SheetNames[0]
```

That reads the app's own multi-sheet setup export, and this screen's own `downloadTemplate` also names
its sheet `Locations`, so both first-party paths worked. It is the only one of the seven doors that was
not simply taking tab 1 — which is exactly why it survived the T315 sweep.

Two gaps it left, both the mild face of T315's defect rather than the silent-wrong-data face:

- **No column fallback.** A third-party workbook with the locations table on a later tab and no sheet
  called `Locations` still read tab 1.
- **A case-SENSITIVE name match.** `includes('Locations')` misses `locations`, or `Locations ` with a
  trailing space, and fell back to tab 1 — where the rows belong to somebody else's entity.

And one that is not about behaviour at all: it is a **seventh hand-rolled copy** of a rule the other
six now share. That is the drift the choke point exists to prevent, and it is half the reason this
moves rather than being patched where it sits.

## Design

`readEntitySheet(ev.target.result, { sheetName: 'Locations', requiredColumns: ['name', 'capacity'] })`.
No new mechanism — the rule and its three-step order already exist and are already tested; this door
stops keeping its own version.

`requiredColumns` is `['name', 'capacity']` rather than `['name']` deliberately: `name` alone matches
four of this app's own sheets, so a one-column rule would let the `Programs` tab answer for a locations
table, which is the failure T315 fixed.

## Success predicate

1. A locations workbook whose tab is named `locations`, `LOCATIONS` or `Locations ` is read.
2. A locations table on a later tab with no `Locations` tab at all is found by columns.
3. A tab carrying `name` but not `capacity` is NOT taken for a locations table.
4. `LocationsScreen` contains no sheet-selection logic of its own.
5. Red-then-green for each gap SEPARATELY: planting the case-sensitive match and planting the removal
   of the column fallback each turn a named set red.
6. `npm run verify` green, with BOTH halves of the governance gate run locally.

## Non-goals

- The export-columns mismatch (`q-export-columns-do-not-round-trip`, owner-gated). A locations sheet
  exports `name`/`capacity`/`kind` and the importer reads the same three, so locations happens not to
  suffer it — which is a fact about locations, not a reason to widen.
- `LocationsScreen.test.jsx` mocks `XLSX` like the other six suites, so it cannot exercise tab
  selection. Coverage stays in `src/utils/readEntitySheet.test.js` against real workbook bytes, as for
  the other doors.
