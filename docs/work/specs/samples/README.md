# Ingestion samples

Layout-preserved text extractions (`pdftotext -layout`) of two real camp schedules, supplied by
the product owner 2026-07-30. They are the design input for
[the ingestion spec](../2026-07-30-prior-year-schedule-ingestion-design.md) §7 and should become
the first fixtures for any reader that is built.

- `campA-bunk-schedules.txt` — 33 pages, **one per group**, days across the top. Three different
  title conventions in the one file; a rotated `Block N` spine that interleaves with the time
  column; merged full-width rows for fixed events; merged multi-row cells for swim spans; colour
  used as meaning (lost in this extraction).
- `campB-achva-by-day.txt` — 5 pages, **one per day**, 14 groups across the top. Fixed events
  appear as a value repeated across every column rather than as merged rows; lunch is staggered
  (`Lunch 1/2/3`); times are 12-hour with no meridiem.

These are text extractions, not the originals. **The originals matter too** — colour and cell
merges are only in the PDFs, and both carry meaning. Ask the product owner before committing
binaries; camp names and group names are real.
