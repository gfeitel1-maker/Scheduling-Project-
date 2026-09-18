---
title: T222-cli-ingest-shape-gate
document_type: ticket
status: open
created: 2026-09-18
archive_when: runIngestCli refuses a non-schedule-shaped workbook and the refusal is pinned by a test
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
---

# T222 — the CLI/MCP ingest path never calls the schedule-shape gate

## Observed, not theorised

A synthetic workbook shaped like a camp's camper elective-selection form (100 fabricated campers,
each with a division, a swim-alternative Y/N, and a 1–25 ranked activity list) was run through
`runIngestCli` against a scratch database. Fixture and run were kept outside the repo.

`action: 'commit'` returned:

```
ok: true   held: false   exitCode: 0
created: 33 groups, 33 tiers, 64 activities, 0 days_of_operation, 0 time_blocks
```

Querying the resulting database, the 33 groups are the form's **column headers** — `#1`, `#2`, …
`#25`, `Division`, `Swim Alternative (Y/N)`, `Additional Comments` — written as camp groups, and
written a second time as tiers. All 100 camper names reached no entity, no conflict, and no warning:
they occupied the row-label column, which the parser treats as structure rather than data.

The failure is not that the importer cannot read a selection sheet. It is that it reported the same
clean green it reports for a correctly-read schedule.

## Root cause — the guard exists and is simply not wired here

`src/ingest/scheduleShape.js` (`isScheduleShaped`, T146) already implements exactly this refusal. It
is imported from `src/screens/ImportScreen.jsx:10` and **nowhere else**. `scripts/ingestCli.js:95`
calls `extractEntities` with no shape precondition, so the CLI — and `scripts/mcp/tools.js`, which is
a one-line wrapper over `runIngestCli` at :43 and :54 — bypasses a gate the app's own UI enforces.

Verified against the fixture: a campers-only workbook returns `isScheduleShaped === false`. The
guard would have declined this file if it had been asked.

## Scope

Call `isScheduleShaped(pages)` in `runIngestCli` between `readPages` and `extractEntities`; on false,
return the existing `errorResult` shape with a message naming what was expected, and a non-zero exit
code. No change to `isScheduleShaped` itself.

**Respect the module's existing scoping constraint.** `scheduleShape.js`'s header states it is
deliberately confined to the schedule import path because the per-entity template importers
(Locations, Electives, Special Events) are non-schedule workbooks by design and must never reach it.
`runIngestCli` only ever drives the schedule path (`commitIngest`), so this is the same path, not a
widening of the gate — but the new call site must not become the precedent for folding the check into
a shared workbook helper.

## Explicit non-goal

This does **not** catch a workbook that mixes a selection-sheet tab with a schedule-shaped tab. See
T223 — that is a different defect in the gate's own granularity, and this ticket must not be closed
by claiming otherwise.
