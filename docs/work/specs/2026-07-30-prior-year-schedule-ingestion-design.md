---
title: "Prior-year schedule ingestion — design"
document_type: spec
status: draft
created: 2026-07-30
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: [docs/work/tickets/T16-ingest-prior-year-schedule.md]
related_specs: [docs/work/specs/2026-07-29-shared-entity-table-design.md]
archive_when: superseded by an approved implementation plan
---

# Prior-year schedule ingestion — design

**Status: draft for product-owner decision.** This proposes an approach and names what it
depends on. It is not implementable as written — §7 lists what must be obtained first, and §8
the questions only the product owner can answer.

> "we need to work on schedule ingesting - I would like to find a way for the application to
> read last year's schedule and populate all the corresponding fields."

## 1. The barrier this removes

A returning camp already has a working schedule. Today they must re-enter units, groups, time
blocks and activities by hand before the engine will do anything. That re-entry is the single
largest obstacle between a camp and a usable app, and it is pure retyping of information they
already have.

## 2. What already exists — and why this is smaller than it looks

**Six screens already import from Excel**: Activities, Anchors, Days, Groups, Time Blocks,
Tiers. Each offers `Download Template` and `Import from Excel`, and each follows the same
shape:

```
choose file → parse rows → PREVIEW with per-row warnings → confirm → write
```

`ActivitiesScreen.confirmImport` (`:499`) is representative: it skips rows with a warning, skips
names that already exist, and writes `name` first so a collision fails atomically.

**This is the machine ingestion should feed, not replace.** The preview-and-confirm step is
already the Article V answer — nothing is written until a director has seen it. A new ingestion
path that wrote directly would be a step backwards.

Note the six implementations are bespoke copies of one idea; the
[shared entity table spec](2026-07-29-shared-entity-table-design.md) is consolidating that
surface. **Ingestion must not become the seventh copy.** Sequence it after that work, or build
against the consolidated component.

## 3. The actual problem: their sheet is not our template

The existing import only accepts our column layout. A camp's real spreadsheet will not match it,
and every camp's differs. So the work is not parsing — it is **mapping**, and possibly
**inference**.

Those are different in a way that matters for risk:

- **Mapping** — "which of your columns is the activity name?" The director answers. The app is
  never wrong, only unhelpful.
- **Inference** — "this looks like a weekly grid; the top row is days and the left column is
  time blocks." The app guesses. It can be confidently wrong.

Article V governs the second: *the engine surfaces conflicts; it never resolves them silently*.
An inference that quietly populates a camp's setup is exactly the failure mode to design out.

## 4. Three approaches

### A. Better templates only

Improve the templates and ask the director to paste their data into our shape.

Cheap, zero inference, zero risk of a wrong guess — and it does not solve the stated problem.
The director still does the conversion, which is the work they wanted removed. Recommended only
as the fallback that always exists.

### B. Column mapping — recommended spine

Read any sheet. Show the columns found and a sample of values. Let the director map each column
to a field, remembering nothing and guessing lightly (a suggested mapping is fine if it is
visibly a suggestion). Then hand the mapped rows to the **existing preview-and-confirm** flow.

Boring, standard, and reliable. The app is never confidently wrong because the director makes
every binding decision. It handles the common real case — a list of activities, or of groups,
in someone else's column order.

### C. Grid inference — the valuable, dangerous one

Read a *weekly grid* as a human laid it out: days across the top, periods down the side,
activity names in the cells, group names as tabs or blocks. Infer days, time blocks, groups and
activities from the shape.

This is what "read last year's schedule" most likely means, and it is where the value is. It is
also guessing, and it is guessing about a camp's whole structure.

If built, it must:

- **Propose, never commit.** Output is a filled-in preview the director edits and confirms.
- **Show its reasoning per inference** — "treated row 3 as a time block because column A holds
  a time range" — so a wrong guess is correctable rather than mysterious.
- **Degrade to B** the moment the shape is unrecognised, rather than producing a bad guess.
- Never touch an existing non-empty setup without an explicit merge decision.

## 5. Recommendation

**B as the spine, C as an optional detector in front of it, A as the permanent fallback.**

Build B first and ship it. It is genuinely useful alone, it needs no inference, and it creates
the mapping-and-preview surface that C would otherwise have to invent. Then evaluate C against
real spreadsheets.

Doing C first risks a large, clever feature whose failure mode is silently mis-structuring a
camp — and which cannot be validated at all without the real inputs we do not yet have.

## 6. Entities, or placements?

The product owner's phrasing — "populate all the corresponding fields" — reads as the **setup
entities**: units, groups, time blocks, activities, days. That is the retyping burden.

Importing last year's actual **placements** into `template_slots` is a materially different
feature: larger, and of doubtful value, since a new season has different groups and dates and
the engine exists precisely to produce placements. It would also cross into bulk-replace and the
op log, raising the task class.

**Recommendation: entities only.** Confirm before scoping — this is the single largest lever on
the size of the work.

## 7. What must be obtained before this is implementable

**Two or three real prior-year schedules from actual camps.** Nothing in §4C can be designed,
and nothing can be validated, against an imagined input. Specifically needed:

- the raw files as camps actually keep them, not cleaned up;
- at least two from *different* camps, since the whole difficulty is that they differ;
- ideally one that is messy — merged cells, a title row, colour-as-meaning, a legend off to one
  side. The messy one is the design input that matters.

Until those exist, B can be specified precisely and C cannot.

## 8. Product-owner decisions, 2026-07-30

1. **Entities only.** Not placements. Scope confirmed as §6 recommended.
2. **Skip duplicates**, matching what the per-screen imports already do. Note the consequence:
   a skip is silently partial, so the preview must *say* which rows will be skipped and why,
   before the director confirms — not report it afterwards.
3. **One entry point** — a single "import my old schedule", not mapping bolted onto each setup
   screen.
4. **Read any document — Excel, PDF, Word, "etc."** This reverses this spec's own non-goal and
   is the largest of the four decisions. §9 replaces it.

## 9. File formats — decided, with the cost of each stated

The product owner asked for **any document**: Excel, PDF, Word, and more. This spec previously
listed PDF and OCR as non-goals; that is withdrawn. What follows is not a hedge against the
decision — it is the order to build in, because the formats differ enormously in how reliably
they can be read, and the difference is invisible from the outside.

**One constraint shapes all of it: this app is local-first and offline.** There is no cloud
document service available and there should not be — a camp's schedule should not need to leave
the building. Every reader has to run on the director's machine and ship inside the bundle.
Today the app bundles exactly one document library (`xlsx`); each tier below adds weight.

| Tier | Format | What the file actually gives us | Reliability |
|---|---|---|---|
| 1 | `.xlsx` `.xls` `.csv` | A real cell grid, already parsed by the bundled `xlsx` | High |
| 2 | `.docx` | Tables are structured XML — rows and cells genuinely exist | High *if* it is a table |
| 3 | Digital PDF | Positioned text runs. No cells: a "table" must be reconstructed from coordinates | Fragile |
| 4 | Scanned PDF, images | Pixels. Nothing until OCR runs | Poor, and silently so |

The distinctions that matter, stated plainly:

- **A Word schedule laid out as a real table is close to Excel in tractability.** One laid out
  with tabs and spaces to *look* like a table is closer to Tier 3, and the director cannot tell
  those apart by looking. The reader must detect which it has and say so.
- **A digital PDF has no rows.** It has text with x/y positions, and rows must be inferred by
  grouping on vertical alignment. This works acceptably for clean, ruled tables and degrades
  badly on merged cells, wrapped text and multi-column layouts.
- **Tier 4 is different in kind, not degree.** OCR misreads are *silent*: `9:00` becomes `900`,
  `Swim` becomes `Swrm`, and nothing in the file signals low confidence. It also means bundling
  an OCR engine (Tesseract and its language data) into an app that currently ships one small
  library.

**This is why the preview is load-bearing rather than a courtesy.** As fidelity drops, the
preview stops being a confirmation step and becomes the actual mechanism of correctness. So:

- Every tier ends in the **same** mapping-and-preview surface. No format writes directly.
- The preview **names the source fidelity** — "read from a scanned PDF; check every row" is
  different advice from "read from a spreadsheet".
- Low-confidence cells are marked as such rather than presented as facts.

**Build order: 1 → 2 → 3, and decide on 4 separately once there is a real scanned example.**
Tiers 1 and 2 are the same pipeline with a different reader in front. Tier 3 is a genuine
inference problem. Tier 4 is a dependency and support decision as much as an engineering one,
and should not be committed to sight-unseen.

## 10. Non-goals

- No inference of a camp's *rules* — min/max per week, eligibility, priorities. Those are
  judgements the director makes; a spreadsheet does not record them and guessing them would
  silently shape the engine's output.
- No import of another Shoresh camp's database. That is backup/restore, not ingestion.
- No ongoing sync with an external spreadsheet. One-time seeding only.
- No cloud document service, at any tier. Local-first is not negotiable for a camp's data.
