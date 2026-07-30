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

## 7. Real samples — obtained 2026-07-30, and what they change

Two real schedules from two different camps. **Both are PDFs**, which is itself the most
important finding. Everything below is measured from the actual files, not assumed.

| | Camp A — "ALL 2025 Bunk Schedules" | Camp B — "Camp Achva, by day" |
|---|---|---|
| Pages | 33 — **one per group** | 5 — **one per day** |
| Rows | time blocks | time blocks |
| Columns | **days** (Mon–Fri) | **groups** (14, Yeladim 1 … CIT) |
| Unit and group | both in the page title | unit encoded in the group-name stem |
| Fixed events | full-width **merged rows** | **same value repeated** across every column |
| Text | vector, extracts cleanly | vector, extracts cleanly |

### The headline: the two layouts are transposes of each other

Camp A puts days across the top and gives each group its own page. Camp B puts groups across the
top and gives each day its own page. Both are "last year's schedule". **Neither axis can be
assumed.** Day names are the one reliable anchor — a closed vocabulary that can be recognised
wherever it appears — so detection should key on finding the day axis and deriving everything
else relative to it.

### Both are digital PDFs, so Tier 4 is not needed for these

`pdftotext -layout` returns correctly aligned text for both. No OCR, no image processing. This
is a substantial de-risking of the format decision: the two real inputs sit in **Tier 3**, and
Tier 4 can wait for a scan that may never arrive.

### Concrete hazards, each observed in these files

- **Three title conventions in ONE file.** Camp A uses `Adom 4's - Matzo Balls Schedule` (26
  pages), `Zahav Schedule` with no separator at all (4 pages), and `Kesef 3- Cooking/ Baking/
  Dance` with no `Schedule` suffix and slash-separated specialties (3 pages). Spacing around the
  hyphen also varies — `Omanut- Chagalls` against `Adom 4's - Matzo Balls`. A parser keyed on
  one pattern silently mis-handles roughly a quarter of the file.
- **12-hour times with no meridiem.** Both camps write `01:40–02:20` meaning 1:40 pm. Parsed
  naively that is 1:40 am and the day sorts wrongly. Camp B uses an en-dash, Camp A a hyphen.
- **A rotated spine column interleaves with the time column.** Camp A's `Block 1…8` labels
  extract inline with the two-line time ranges: `9:50- Block` / `10:25  1`. Rows must be
  reconstructed by position, not by line.
- **Wrapped cell text splits across lines** — `Little` / `Playground`, `Arts and` / `Crafts` —
  and must be rejoined per column.
- **Staggered lunch defeats "a fixed event happens at one time".** Camp B has `Lunch 1`,
  `Lunch 2`, `Lunch 3` at different blocks for different groups. Whether those are one fixed
  event with variants or three activities is a judgement the app cannot make.
- **Colour carries meaning.** Camp A marks swim red and lunch black. Text extraction loses it
  entirely; recovering it means reading cell fills.
- **The title pattern collides with cell content.** Searching Camp B for `All Camp` matches both
  the page title `Monday — All Camp` and the `All Camp Activity` row.
- **Activity names are not in any dictionary** — `Mifkad`, `Teva`, `Mercaz`, `Shalomaste`,
  `Avodom`, `Ruach Prep`, `FBBG`, `A/C`. They must be taken literally as names. No
  normalisation, no spell-correction, no matching against a known list.

### Spans are real, and the app already models them

Camp A merges swim across Blocks 3–4 and Friday's special event across Blocks 6–8. The engine
already has `span_blocks` / `is_span_head` for exactly this, and a span counts as one session.
If placements are ever imported (§6 says not now), the concept is already there.

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

**Build order — corrected 2026-07-30 by the real samples.** This spec originally recommended
1 → 2 → 3: spreadsheets first, PDF last as the risky tail. **That was wrong.** Both real camps
handed over PDFs. Building Excel-first would deliver nothing usable to either of the only two
camps whose schedules we have actually seen, and would postpone the one format that is
demonstrably in use.

Revised: **build Tier 3 first, against these two files.** Tier 1 remains trivial to add — the
`xlsx` library is already bundled and the grid arrives pre-parsed — so it costs little and can
follow. Tier 2 follows Tier 1. Tier 4 is deferred indefinitely: neither real sample needs it,
and it should not be committed to until a scan actually appears.

One question this raises for the product owner: **do these camps also have the source
spreadsheets?** A PDF is usually an export. If the underlying Excel is available, Tier 1 becomes
the better path for those camps and the correction above softens. Worth asking before building
a PDF table reconstructor.

## 10. Non-goals

- No inference of a camp's *rules* — min/max per week, eligibility, priorities. Those are
  judgements the director makes; a spreadsheet does not record them and guessing them would
  silently shape the engine's output.
- No import of another Shoresh camp's database. That is backup/restore, not ingestion.
- No ongoing sync with an external spreadsheet. One-time seeding only.
- No cloud document service, at any tier. Local-first is not negotiable for a camp's data.
