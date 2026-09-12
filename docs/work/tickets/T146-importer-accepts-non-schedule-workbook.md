---
title: "The importer extracts from a workbook that is not a schedule, instead of declining it"
document_type: ticket
status: open
created: 2026-09-12
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: a workbook with no schedule shape is declined with a clear message naming the file, instead of producing residual extractions
---

# T146 — The importer extracts from a non-schedule workbook instead of declining it

**Found by measurement, 2026-09-12** (ingestion session sweep across 8 workbooks), while checking a
different ticket's premise. Not a residual-parser bug — a missing precondition.

## What was measured

`Shoresh-Campus-Map-Template.xlsx` produced **13 residual cells**:

    "3" x3   "7" x3   "L" x3   "M" x3   "12" x2   "2" x2   "6" x2   "S" x2
    "11" x1  "4" x1   "5" x1   "8" x1   "9" x1

Sheets: **Read me | Campus Map | Legend**. Those values are grid coordinates and legend keys from a
campus MAP template. The file is not a schedule in any sense, and the importer parsed it far enough
to emit extractions rather than recognising it as the wrong kind of document.

## Why this is NOT T36

T36's three residuals (F1 location-strip, F2 header-match, F3 banner-strip) are all about
**schedule-shaped input** being mis-segmented. None of them apply here. T36's premise — unreachable
on its named four-camp corpus — is untouched by this finding, for two independent reasons: the map
template is not in that corpus, and the failure is not one of its three shapes.

Recording this explicitly because the finding was initially mistaken for "T36's fifth-camp trigger
arriving early." It is not.

## Why it matters

A director picks a file out of a folder. Picking the wrong one is not an edge case — it is how this
very file entered the sweep. Today that produces a reconciliation screen full of meaningless
one-character "activities" (`L`, `M`, `S`, `3`, `7`) presented with the same confidence as real
extractions, and the director has to recognise the nonsense and back out. The screen's whole promise
is "nothing is added until you have looked at the list"; that promise is weaker when the list is
plausible-looking garbage.

## Scope

- Decide the precondition: what minimally makes a workbook schedule-shaped (a day axis? a time axis?
  a minimum ratio of multi-character cells? named sheets that are not `Legend`/`Read me`?).
- Decline a workbook that fails it, with a message that names the file and says what was expected —
  never a silent empty result, and never a partial extraction.
- Test with `Shoresh-Campus-Map-Template.xlsx` as the negative fixture and at least two real camp
  schedules as positives, so the gate cannot be tightened into rejecting real input.

**Non-goal:** guessing what the file IS, or importing map data. Declining is the whole job.

## Risk to challenge (Red Hat)

The obvious failure mode is a precondition tight enough to reject a legitimately odd camp file — the
corpus already contains four materially different layouts, and a fifth is expected. Bias the rule
toward accepting anything ambiguous; only decline what is clearly not a schedule.

## Review loop

**Architect (the precondition) → Red Hat (false-reject risk on real camp files) → Maker (test-first,
negative fixture) → Code Reviewer → Verifier.**
