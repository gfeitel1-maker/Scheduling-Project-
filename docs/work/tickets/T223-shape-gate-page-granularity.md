---
title: T223-shape-gate-page-granularity
document_type: ticket
status: closed
created: 2026-09-18
archive_when: the shape gate's whole-file/per-page granularity mismatch is closed or accepted with a recorded rationale
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md, docs/adr/2026-09-18-schedule-shape-gate-per-page-granularity.md]
---

# T223 — one schedule-shaped page launders every other page in the file

## The mismatch

`isScheduleShaped` (`src/ingest/scheduleShape.js`) is a **whole-file** predicate: `pages.some(...)`.
`extractEntities` is **per-page**: it extracts from every page it is handed. So a single qualifying
page admits the entire workbook to extraction, including pages that are not schedules at all.

## Observed

The T224 fixture, with a day × period elective menu added as a second tab:

```
fake-selections.xlsx   -> isScheduleShaped = true
   page "Camper Selections"  cols = Division | Swim Alternative (Y/N) | #1 | #2 | #3 …
   page "Elective Menu"      cols = Monday | Tuesday | Wednesday | Thursday | Friday
```

The menu tab is genuinely schedule-shaped, so the gate passes — and the camper tab's column headers
are then extracted as 33 groups and 33 tiers exactly as in T224. **T224's fix does not help here**,
because the gate it wires in returns true for this file. The UI path has the same hole today.

## Why this is not a trivial tightening

Gating per page, rather than per file, is the obvious fix and it carries real regression risk. A
genuine multi-page schedule may legitimately have continuation pages that carry neither axis — the
day header appears once on the first page and the rest inherit it. Per-page rejection would silently
drop those pages, converting a loud wrong-import into a quiet partial-import, which is worse.

T146's stated bias is strongly toward accepting (its Red Hat risk #1). Changing the granularity
reopens that decision and should not be done by adjusting a ratio.

## Wanted

A design pass, not a patch. Options worth weighing: per-page gate plus an explicit
inherit-from-previous-page rule; a gate that declines individual pages but surfaces the declined page
list to the director rather than dropping it silently; or accepting the current behaviour and instead
making the post-import summary legible enough that `#1` appearing as a group is obvious.

Whichever is chosen, the T224 fixture shape is the regression test.

## Resolution — 2026-09-18

Closed as option 2 from "Wanted" above: a per-page gate (`isSchedulePage`,
`partitionSchedulePages` in `src/ingest/scheduleShape.js`) that declines individual pages and
surfaces the declined titles rather than dropping them silently. See
[the ADR](../../adr/2026-09-18-schedule-shape-gate-per-page-granularity.md) for the full design,
the corpus evidence backing it, and why it does not reopen T146's file-level accept bias. Both
entry points (`src/screens/ImportScreen.jsx`, `scripts/ingestCli.js`) now extract only from
`shaped` pages; the T224 fixture shape is the regression test in `src/ingest/scheduleShape.test.js`
and `scripts/ingestCli.test.js`.
