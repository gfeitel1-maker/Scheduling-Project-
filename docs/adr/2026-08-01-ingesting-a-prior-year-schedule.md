---
title: "Ingesting a prior-year schedule to populate setup"
document_type: adr
authority: normative
status: accepted
date: 2026-08-01
supersedes: []
implementation_state: implemented
affects:
  - docs/work/tickets/T16-ingest-prior-year-schedule.md
  - docs/work/specs/2026-07-30-prior-year-schedule-ingestion-design.md
---

# Ingesting a prior-year schedule to populate setup

**Status: ACCEPTED by the product owner, 2026-08-01**, who also instructed implementation to
begin. `GOVERNANCE_INDEX.md` puts ingestion in the Database/sync row, whose gate is "ADR +
migration/rollback plan"; both are here and the gate is cleared.

Resolves the design question behind [T16](../work/tickets/T16-ingest-prior-year-schedule.md).
The analysis is in
[the ingestion design](../work/specs/2026-07-30-prior-year-schedule-ingestion-design.md); this
records the decisions and the parts that touch stored data.

---

## Context

A returning camp already has a schedule that works, and today must retype every unit, group,
time block, day and activity before the engine can do anything. That retyping is the largest
barrier between a new camp and a usable app.

Product-owner decisions, 2026-07-30 and 2026-08-01:

1. **Entities only, not placements.** Reconfirmed 2026-08-01.
2. **Skip duplicates**, matching the per-screen imports.
3. **One entry point** — a single "import my old schedule", not mapping bolted onto each screen.
4. **Read any document** — Excel, PDF, Word.
5. The two supplied PDFs are **for testing the PDF route**; separate Excel files will be supplied
   for the Excel route; both **for testing only**.

## Decision

### 1. Ingestion never writes without the director seeing what it inferred

This is the load-bearing decision and everything else follows from it.

Deriving units, groups, blocks and activities from a grid a human laid out for humans is
**inference, not parsing**. Guessing wrong is expected. Guessing wrong *and silently populating
the camp's setup with it* would violate CONSTITUTION Article V — the director is not a software
operator and must not be handed a database shaped by a guess they never saw.

So the pipeline is always **read → propose → director edits → commit**, and the proposal stage is
not skippable, not even when confidence is high. There is no "import directly" path to add later;
its absence is the feature.

The preview must state what will be **skipped** and why, before the confirm, not after. A skip is
a silently partial result — decision 2 above makes that the normal case, not an edge case.

### 2. Entities only, and the boundary is enforced by what the writer can address

Ingestion may create rows in `cohorts`, `tiers`, `groups`, `days_of_operation`, `time_blocks`
and `activities`. It may **not** write `template_slots`, `template_overlays`, `anchor_activities`
or anything else.

State it as a whitelist in code, not as a convention. "Entities only" is a scope decision that
will be under pressure the moment someone notices the placements are sitting right there in the
parsed grid, and a whitelist is the difference between that being a deliberate reopening of the
decision and an afternoon's work.

### 3. No schema change, and therefore no migration

Ingestion writes existing entities through the existing op-log write path. It needs no new table,
no new column, and no new projection.

This is worth stating explicitly because it is the single biggest risk reduction available, and
because it was not obvious: the feature *sounds* like it needs an import-session table for undo.
It does not — see §4.

**Rollback plan:** there is nothing to roll back at the schema level. If the feature is withdrawn,
the code is removed; rows it created are ordinary rows and stay valid.

### 4. An import is one transaction, and undo is deletion of what it created

> "A partial ingest that half-populates a camp is worse than one that fails cleanly."
> — T16

Two mechanisms, both existing:

- **Atomicity:** the whole commit runs inside one SQLite transaction on the Host, appending every
  op and applying every projection together. A failure anywhere rolls the whole import back. No
  camp is ever left half-populated.
- **Undo:** every created record is an ordinary record, so the existing delete path removes it,
  and the existing Trash path restores it if the director changes their mind again. Nothing new
  is invented.

The op-log consequence is real and should be stated: importing a mid-sized camp writes on the
order of a few hundred ops in one action. That is bounded, countable before the confirm, and of
the same order as the delete-a-used-group case already shipped (~150 ops).

### 5. Duplicate detection is by name, case- and whitespace-insensitive, within the camp

Matching the per-screen imports. The preview shows each skipped row with the existing record it
matched, because "skipped 12 rows" without saying which is not something a director can check.

### 6. Formats are tiers, and each is separately shippable

Per the design's §9, revised by the 2026-08-01 answers:

| Tier | Input | Notes |
|---|---|---|
| 1 | Excel / CSV | `xlsx` is already a dependency; the grid arrives pre-parsed. Real files to be supplied. |
| 3 | Digital PDF | Text extraction plus column reconstruction. Both supplied samples are this. |
| 2 | Word | After 1 and 3. |
| 4 | Scanned PDF / OCR | **Deferred indefinitely.** Neither sample needs it. |

Tiers 1 and 3 both produce the same intermediate — a grid of cells — and everything after that
point is shared. **The parser is the only format-specific part**, which is what makes the tiers
independently shippable rather than a sequence.

### 7. What the samples establish about the parser

Measured from the two real files, not assumed:

- **The two camps' layouts are transposes of each other.** Camp A is one page per group, columns
  are days. Camp B is one page per day, columns are groups. A parser that assumes either
  orientation will be wrong for half the corpus, so orientation is **detected and then shown in
  the preview for confirmation**, never assumed.
- **Cells wrap across lines.** "Little Playground" arrives as two lines in a column. Reassembly by
  column position is required; naive line-splitting produces garbage entity names.
- **Camp A interleaves non-schedule rows** ("11:10–11:20 Change") among the blocks. These must not
  become time blocks.

**The bunk names encode the units, and this document said otherwise.** §7 originally recorded
that neither layout carries units, so `tiers` was proposed empty. That was wrong: 29 of Camp A's
33 page titles read `Unit - Bunk` — "Adom 4's - Matzo Balls", "Maccabiah- Rookies", "Omanut-
Chagalls" — which yields 13 units and files 29 bunks under them. Product owner spotted it on
2026-08-01: *"camp A — this would be one with many programs and units within those."*

The cost of the error was the whole point of the feature for a large camp: 13 units to type in
and 33 bunks to file by hand. Corrected — units are proposed, bunks carry their short name where
that is unambiguous, and the link is written in the same transaction. A bunk whose title has no
separator stays unfiled, which is a real shape rather than a parse failure.

**Programs genuinely are absent.** Nothing in a weekly grid says which session it belongs to, so
`cohorts` remains empty for the director to fill in.

Entities are recoverable from structure alone: the header row, the time column, the page titles,
and the distinct cell values. That is the whole extraction — no placement inference is needed for the agreed scope,
which is why §2's boundary also makes the parser markedly simpler.

**§7 addendum (2026-08-02) — a third layout family.** A fourth real camp (one page per group, days
across the top, like Camp A) leaves its **time column unlabeled**, so page/column detection can no
longer depend on a `Time` token; it now also keys on a **day-name-majority header row**, with the
unlabeled time column located from where the body's times sit. This family prints a **location under
each activity** (room name or number) — these are **stripped** (location metadata, not activities),
discriminated from a genuine wrapped continuation by **vertical adjacency** (a data line directly
under another data line, with no time line between, is a location). Its group titles are
**separator-less positional codes** (`1A`, `KA`, `RB`, `K1 (ECC)`) from which the **unit is inferred**
from the grade prefix, over-including per this section's existing bias. A repeating page **banner** is
dropped. All of this is gated on the absent `Time` label, so Camp A and Camp B are provably
unaffected. No schema, projection, IPC, or commit-path change — §2 and §3 stand.

## Consequences

- A returning camp's setup goes from an afternoon of retyping to a review of a proposal.
- The preview screen is a new surface with real design weight: it is where a director corrects a
  machine's guess about their camp, and it is the only thing standing between inference and their
  data.
- Ingestion becomes a second path that creates setup entities. The first is the per-screen
  imports; both must apply the same duplicate rule, or the same file imported two ways gives two
  results.
- Test fixtures derived from the supplied files carry a real camp's group names. Committing them
  writes those names into git history permanently. Prefer a redacted fixture where it would
  exercise the parser equally well.

## Completion evidence

1. No ingestion path writes anything the director has not seen in a preview.
2. The whitelist is enforced in code, and a test asserts that a parsed grid containing placements
   still writes no `template_slots` row.
3. A failure partway through a commit leaves the camp exactly as it was — proven by an
   integration test that injects a failure mid-import.
4. The preview names every row it will skip and the record it matched, before the confirm.
5. Both supplied layouts — one page per group, one page per day — produce correct entity lists,
   including the wrapped-cell and interleaved-row cases named in §7.
6. Fresh-vs-migrated schema equivalence is untouched, because there is no migration.

## Addendum — 2026-08-02 (T33): an import must file into the active Program

The first real use surfaced a defect this ADR's §2/§4 did not anticipate: the commit created the
entities but left the **Program-scoped** ones orphaned, so the director could not see them.

- Two ingestible entities are scoped to a Program (cohort) in the app — **`tiers` (Units) and
  `time_blocks`** carry `cohort_id`, and their setup screens list only rows whose `cohort_id` matches
  the active Program. `groups`, `activities`, `days_of_operation` are camp-scoped (no `cohort_id`
  column on `groups`) and are unaffected.
- `commitIngest` wrote those rows with `cohort_id = NULL`, so they existed but were filtered out of
  every Program view. The group→unit `tier_id` link was set correctly, but an invisible unit cannot
  appear tied to its groups — which is what the product owner saw as "units aren't tying to groups".
- **Fix:** the active Program's id is threaded from `ImportScreen` (`useCohorts`) through
  `ingestCommit` into `commitIngest`, which sets `cohort_id` on created tiers and time blocks, scopes
  the unit-reuse map to that Program (a same-named unit in another Program is not reused), and the
  preview's duplicate check is scoped to the active Program for those two entities.
- **No schema change, no migration.** The columns and their projections already exist; this is a
  write-correctness fix. A null Program (older callers/tests) preserves the pre-fix behaviour.
- **No backfill.** Rows orphaned by imports done before this fix keep `cohort_id = NULL`; the feature
  is new enough that these are test data. A director can delete and re-import, or reassign the unit's
  Program by hand. Flagged rather than silently migrated.
