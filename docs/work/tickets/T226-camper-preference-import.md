---
title: T226-camper-preference-import
document_type: ticket
status: completed
created: 2026-09-18
archive_when: a fabricated 100-camper ranked-preference sheet imports to campers + elective_choices + elective_preferences, driven end to end through the MCP path
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_tickets: [docs/work/tickets/T218-elective-export-third-party-adapter.md]
---

# T226 — camper + ranked-preference import

## Why this is unblocked, when D14 said the premise was retired

D14 retired the **per-occurrence ranking** premise. It did not invalidate the substrate: T194's
`elective_choices` / `elective_preferences` model a preference as `(run, camper, choice, rank)`,
where a choice is a LABEL with offerings spread across occurrences. That is precisely the shape of a
global 1–25 list, so the schema already fits the format the real artifacts showed.

What remains genuinely unknown is the **transport** — whether filled sheets come back as paper, a
portal export, or a retyped spreadsheet (T218). That is what a column-mapping step exists to absorb,
and it is not a reason to defer the domain logic. The owner's direction (2026-09-18) is to build
against a fabricated fixture of the known form shape and let the real format correct the mapping
layer later.

## Owner rulings (2026-09-18)

- **R3 — unplaced campers:** assign the best available choice and FLAG it. Every camper always has a
  placement; the flag records that it was not a top pick. Never leave a camper unaccounted for.
- **R4 — fairness:** NOT modeled in this pass. Build the straightforward version, look at real output
  against the fixture, then decide. Explicitly not a silent omission.

## Scope of this ticket

Import only. A pure mapping from parsed sheet rows to a proposal of `{ campers, choices,
preferences }`. No solver (that is its own ticket), no assignment rows.

## OPEN DESIGN QUESTION — camper identity

`electron/ops/electiveDerivedIds.js` has derived ids for occurrences, choices, offerings,
preferences and assignments. **There is no `deriveCamperId`**, and the two-device convergence
property (ADR D4) needs one: two devices importing the same sheet must mint the same camper row, or
the per-field conflict machinery cannot apply and the camp gets duplicates instead of a conflict.

The candidate keys are not equivalent:

- `external_id` — correct when present. The `campers` table already has the column. A camp
  management system export would carry one; a paper form will not.
- normalized `display_name` — available always, and **wrong in a way that matters**: two campers
  genuinely named the same person collapse into one row, and a re-import would silently merge them.
- name + row ordinal — stable only until someone re-sorts the sheet, which is exactly the thing a
  director does before sending it.

**Proposed resolution, following this repo's flag-never-drop convention:** key on `external_id` when
the sheet supplies one; otherwise key on normalized name, and surface every same-name collision to
the director as an explicit decision rather than merging or minting behind their back. This preserves
convergence (both devices derive the same id from the same sheet) while refusing to guess about two
real children. Needs confirmation before the derived id is minted, because a derived id is expensive
to change once rows exist.

## Resolution (2026-09-23)

`archive_when` is met. The fabricated 100-camper sheet
(`docs/work/specs/samples/fabricated-camper-preferences-100.csv`) imports to `campers`,
`elective_choices` and `elective_preferences` through the MCP surface:
`preference_sheet_preview` / `preference_sheet_commit`, handled in `scripts/mcp/tools.js` over
`scripts/preferenceSheetCli.js`, which reuses `commitElectiveRun` rather than forking a second write
path. `scripts/mcp/preferenceSheetE2E.test.js` spawns the real stdio MCP server, calls both tools,
then opens the SQLite file and asserts the rows — 100 campers, 18 choices, 1000 preferences — with
every expectation re-derived from the fixture rather than read back out of the module under test.

Two decisions were taken while closing it:

- **Separate tools, not an extension of `ingest_preview`.** The schedule importer is gated by
  `partitionSchedulePages` (T224) specifically to REFUSE a camper preference sheet, after one
  committed its `#1`/`#2`/`Division` headers as groups and tiers. Routing the preference sheet
  through that tool would have reopened the gate it exists to hold.
- **The import path derives its run id from `(camp_id, sha256(file))`**
  (`deriveImportedElectiveRunId`, `electron/ops/electiveDerivedIds.js`). Without it, only `campers`
  converged: a resent sheet minted a second run and a second full set of choices and preferences
  (measured: 2 runs / 36 choices / 2000 preferences). Committing the same bytes twice is now an
  idempotent no-op on every projection table; a corrected sheet is a different document and is
  correctly a new run. The renderer's solve path still mints its own `runId` — `commitElectiveRun`'s
  default is unchanged.

The **camper-identity** question above is resolved as proposed and implemented: `deriveCamperId`
keys on `external_id` when the sheet supplies one and on the normalized name otherwise, and a
same-name collision with no id to separate the children is REFUSED at commit
(`describeElectiveRunRefusal`) rather than merged.

NOT in this ticket, and still open: the solver (R3/R4 remain unmodelled by design), and the real
third-party export format (T218), which is what the column-mapping step exists to absorb.
