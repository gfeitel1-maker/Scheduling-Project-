---
title: T16-ingest-prior-year-schedule
document_type: ticket
status: completed
created: 2026-07-28
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: superseded by an approved specification
---

# T16 — Ingest last year's schedule to populate setup

> **Design drafted 2026-07-30** —
> [`docs/work/specs/2026-07-30-prior-year-schedule-ingestion-design.md`](../specs/2026-07-30-prior-year-schedule-ingestion-design.md).
> Recommends column mapping as the spine with grid inference as an optional detector in front of
> it, and entities only rather than placements. Still blocked on the same thing this ticket
> named: real prior-year spreadsheets from two or three camps. Three questions await the
> product owner.

**Status: was a parked placeholder; now has a drafted design.** Sequenced explicitly after T14, T15, and the grid colour work.
This records the intent and the questions so it is not lost. **It is not a design, and no
approach has been chosen.** Do not implement from this file — it needs a brainstorm and a
specification first.

**Raised:** 2026-07-28, product owner.

---

## The intent

> we need to work on schedule ingesting - I would like to find a way for the application to
> read last year's schedule and populate all the corresponding fields.

A returning camp already has a schedule that works. Today they must re-enter units, groups,
time blocks, and activities by hand before the engine can do anything — which is the single
largest barrier between a new camp and a usable app.

## Why this is bigger than an import button

Recording the questions now, because the shape of the feature depends on answers nobody has:

- **What is "last year's schedule"?** Almost certainly a spreadsheet, and almost certainly not
  in a shape the app defines. Every camp's will differ. The app already has `Import from
  Excel` and `Download Template` on Units, Groups, Days, Time Blocks, and Activities — an
  existing, structured path. The real question is whether ingestion means "conform to our
  template" (works, but the director does the conversion) or "read what they already have"
  (much harder, much more valuable).
- **This is inference, not parsing.** Deriving units, groups, blocks, and activities from a
  grid a human laid out for humans means guessing. Guessing wrong and silently populating the
  camp's setup with it would violate Article V — the director must see and correct what was
  inferred before it becomes their data.
- **Where does it land?** Populating setup tables is a bulk write across five entity types
  through the op log. Bulk-replace has bitten this codebase before (ADR
  `2026-07-24-bulk-replace-seq-fix`), and a partial ingest that half-populates a camp is worse
  than one that fails cleanly.
- **What about the schedule itself,** as opposed to the setup it implies? Reading last year's
  *placements* into `template_slots` is a materially different feature from reading the
  *entities* — and the product owner's phrasing, "populate all the corresponding fields",
  reads as the entities. Worth confirming before anyone scopes it.

## Built — 2026-08-01

ADR approved by the product owner and implemented.

| Piece | Where |
|---|---|
| Column reconstruction from PDF text | `src/ingest/textGrid.js` |
| Grid → entity proposal, orientation detection | `src/ingest/extractEntities.js` |
| Duplicate detection and the preview | `src/ingest/preview.js` |
| Transactional, whitelisted commit | `electron/ops/ingest.js` |
| The review screen | `src/screens/ImportScreen.jsx` |

Proven on both real camps' files: 47 unit tests, 13 commit tests, and integration
scenario 21 running the whole chain — parse, extract, preview, commit — against a real database.

**Three things the real files taught that no amount of design would have:**

1. **Wrapped text appears above *and* below its own row.** "Little" sits on the line before the
   timed row and "Playground" on the line after. Applying untimed lines eagerly split it into two
   activities that were each wrong. Lines are now buffered and resolved by what follows.
2. **A time is not always followed by a dash.** Camp A's period cells read "10:30 Block". Requiring
   the dash missed the row boundary, merged two rows, and would have proposed
   *"Drama Back Playground"* as an activity name.
3. **The time column is two lines tall in Camp A**, so the block number sat in the Monday column
   and every activity there read "Drama 1". Text left of the first data column is now time-column
   text and dropped.

Each was a wrong entity name that would have reached the preview. None was visible from the
design; all three came from running the parser over the actual files.

**What it deliberately does not guess.** Neither layout records which unit a bunk belongs to, so
Units and Programs come back empty for the director to fill in. An empty list is honest; a guessed
hierarchy would be silently wrong in a way that is hard to notice.

## ADR — approved 2026-08-01

[`docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md`](../../adr/2026-08-01-ingesting-a-prior-year-schedule.md)
is written and **proposed**. That is the governance gate this ticket has been blocked on since it
was filed; implementation starts once it is approved.

Two findings from writing it are worth surfacing here, because both make the work smaller than
this ticket assumed:

**No schema change, and therefore no migration.** Ingestion writes existing entities through the
existing op-log path. This ticket's "where does it land?" worry — a bulk write across five entity
types — is answered by one SQLite transaction on the Host, and undo is ordinary deletion plus the
Trash path that already exists. The feature sounds like it needs an import-session table. It does
not.

**Entities-only makes the parser markedly simpler, not just the writer.** Extracting the entity
lists needs the header row, the time column, and the distinct cell values — no placement inference
at all. The dangerous part of grid inference is exactly the part the agreed scope removes.

## Product-owner answers — 2026-08-01

The three questions are answered. They change scope, so they are recorded here:

1. **The two PDFs are for testing the PDF route specifically.** They are not a stand-in for
   missing spreadsheets. **Separate Excel documents will be supplied for the Excel route.**
   This settles §9 of the design: its correction — "build Tier 3 first, against these two
   files" — holds, and Tier 1 gets its own real inputs rather than being inferred from a PDF.
2. **Entities only, not placements.** Confirmed; the spec's assumption stands.
3. **The supplied files may be used for testing only.** That is authorisation to use them as
   test fixtures, and also a limit: not for documentation, screenshots, demos, or anything
   shipped.

Note for whoever adds the fixtures: committing them writes a real camp's group names into git
history permanently, and deleting the file later does not remove them. Worth checking which
repository this is before the first `git add`, and worth preferring a redacted fixture if one
would exercise the parser equally well.

**Still required before implementation**, unchanged by these answers: `GOVERNANCE_INDEX.md`'s
Database/sync row — an ADR plus a migration/rollback plan, mandatory integration tests, and a
product-owner approval gate on the ADR.

## Why this was blocked — 2026-07-31

Worked through the open-ticket queue on 2026-07-31; this is the one that could not be finished,
and the reason is a governance gate rather than effort.

`GOVERNANCE_INDEX.md` puts ingestion in the **Database / sync** row: an ADR plus a
migration/rollback plan, mandatory integration tests, and a **product-owner approval gate**. The
drafted design also stops on a question only the product owner can answer, recorded at §9 of the
spec: **do the two camps whose PDFs we have also hold the source spreadsheets?**

That answer changes what gets built, not merely when:

- **If the spreadsheets exist**, Tier 1 (read the Excel directly) is the better path for those
  camps, the `xlsx` library is already bundled, and the grid arrives pre-parsed. Small, and the
  inference layer stays shallow.
- **If they do not**, Tier 3 — reconstructing a table from a PDF — is the first thing that has
  to work, which is a materially larger and less certain piece of engineering.

Building the PDF reconstructor before asking would be committing the expensive option on a
guess, when one question makes it unnecessary for some or all camps.

Two further answers are wanted at the same time, both from the ticket and the spec:

1. **Entities only, or placements too?** The product owner said "entities only, skip duplicates,
   one entry point" on 2026-07-30, which the spec takes as settled — confirm it still holds.
2. **May the two supplied PDFs be committed as test fixtures?** They contain a real camp's group
   names and staff-facing structure. Without them the integration tests the governance row
   requires have nothing real to run against; with them, that data enters the repository
   permanently.

Nothing here is blocked on design work. It is blocked on those answers.

## Next step when this is picked up

Brainstorm, then an approved specification, before any implementation. Likely needs an ADR:
it introduces an inference layer and a bulk write path across the setup tables. Route via
`docs/governance/GOVERNANCE_INDEX.md` — Database/sync row, which requires an ADR plus a
migration/rollback plan and mandatory integration tests.

The first thing to obtain is **real examples of two or three camps' actual prior-year
schedules.** Nothing here can be sensibly designed against an imagined input.
