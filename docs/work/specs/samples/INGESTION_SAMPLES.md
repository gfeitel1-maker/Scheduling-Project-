---
title: "Ingestion samples — camp schedule layouts"
document_type: reference
status: active
created: 2026-07-30
governing_docs: [docs/work/specs/2026-07-30-prior-year-schedule-ingestion-design.md]
archive_when: the ingestion work is merged and these become test fixtures
---

# Ingestion samples

Layout-preserved text extractions (`pdftotext -layout`) of two real camp schedules, supplied by
the product owner 2026-07-30, with camp names, group/bunk names, and any staff names replaced by
a fabricated but length-preserving substitution (see below) so the committed files carry no real
camp data. The structural properties — page/column counts, geometry, layout quirks — are
unchanged. These are the design input for
[the ingestion spec](../2026-07-30-prior-year-schedule-ingestion-design.md) §7 and should become
the first fixtures for any reader that is built.

- `campA-bunk-schedules.txt` — 33 pages, **one per group**, days across the top. Three different
  title conventions in the one file; a rotated `Block N` spine that interleaves with the time
  column; merged full-width rows for fixed events; merged multi-row cells for swim spans; colour
  used as meaning (lost in this extraction).
- `campB-by-day.txt` — 5 pages, **one per day**, 14 groups across the top. Fixed events
  appear as a value repeated across every column rather than as merged rows; lunch is staggered
  (`Lunch 1/2/3`); times are 12-hour with no meridiem.

These are text extractions, not the originals. **The originals matter too** — colour and cell
merges are only in the PDFs, and both carry meaning. Ask the product owner before committing
binaries; the original PDFs carry real camp names and group names and must not be committed
as-is — they would need the same anonymization treatment as the text files, or to stay off the
repo entirely.

## Camper preference sheets (wholly fabricated, T226)

Unlike the two files above, these two are **not** anonymized real data — they were **generated
from scratch** and contain no real camper, camp, division or elective name. Every name is
invented. They are the fixtures for the preference-sheet importer
(`scripts/preferenceSheetCli.js`) and its end-to-end MCP test.

- `fabricated-camper-preferences-100.csv` — 100 campers, one row each, with a `Camper ID`
  column, a `Camper Name` column, a `Division` column, and ten ranked columns headed
  `#1`..`#10` drawn from an 18-elective catalogue. **Why ten and not twenty-five:** the ranking
  is global for the session (ADR 2026-09-17 D12), and a real form asks a camper to rank their
  top handful out of a longer catalogue rather than to order the entire list — ten ranks over
  eighteen electives exercises both "more choices than ranks" and a full rank column set, while
  staying a file a reviewer can read. No two rows share a name and no camper holds a rank twice,
  so this is the **happy path**: it commits.
- `fabricated-camper-preferences-same-name.csv` — three rows, no camper-id column, and one name
  appearing twice. The **refusal** fixture: two children sharing a name with nothing to tell them
  apart would be merged into one record, so the importer refuses the whole sheet.
