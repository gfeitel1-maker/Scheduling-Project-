---
title: "F5 spans-first: Generate places text-grid spans as one session of N blocks"
document_type: evidence
status: active
created: 2026-10-11
archive_when: the F5 branch (claude/f5-text-grid-spans) has merged and the synthetic scorecard has been regenerated on main
---

# F5 spans-first, before and after

Scorecard finding F5 ([2026-10-11-synthetic-15-scorecard.md](2026-10-11-synthetic-15-scorecard.md)): a double or triple period read from a text grid imported as N separate single blocks, with `min_per_week` counting blocks rather than sessions. When the import first wrote `span_blocks`, Generate placed **zero** sessions of some spans (s01 Ropes Course, s06 Wilderness Skills, s09, s11, s15). The import change was then held back until the engine was fixed. This change fixes the engine (option A) and turns the import change back on.

## What changed

- `src/engine/buildSchedule.js`
  - **Spans go first.** At the start of each priority round, an activity with `span_blocks` N > 1 is placed first: longest spans first, then each group in turn, one session per group per pass, until every group has `min_per_week` sessions. Each session's first block is the free cell whose day already has the fewest sessions of that activity, with ties going to the earliest cell. Placement and capacity checks are the same as for any other placement (`canPlace`): all N blocks are free, in one day, for one group. This step draws no random numbers, so a camp with no span activity is scheduled exactly as before.
  - **Repair fills a span as a unit.** The fill pass can now place a span activity starting at an empty cell (all N blocks), and `unplace` undoes a whole span. Repair still never moves an existing span, so a span is never split. If a span placed for one cell already covers the next cell, that cell counts as filled.
- `src/ingest/activityRules.js`, `src/screens/ImportScreen.jsx`, the harness: detected text spans are passed into `inferActivityRules` again, undoing the earlier stopgap. The rule carries `span_blocks = N`, and `min_per_week` counts sessions, not blocks.
- `src/ingest/textSpans.js`: in the "blank" form, the empty blocks after a span must be followed by a printed cell. Empty blocks that run to the end of a group's day mean that group has a short day; they are not the rest of a span.

## Tests written to fail first

- `src/engine/buildSchedule.spansFirst.test.js`. Three tests failed on the old engine:
  - spans placed first and in contiguous blocks (old engine: 0 sessions);
  - a 3-block span placed around a midday fixed event (old engine: 0);
  - repair fills empty cells with a whole span (old engine: 2 cells left unfillable).
  
  The determinism test also passes on the old engine. It pins existing behavior and was never red.
- `src/ingest/textSpans.f5.test.js`, "a blank that ends one group's day (a minority short day) is not a span tail". On the old code the extra cells were captured: 4 placements where 2 were expected. The existing positive "blank" test data now prints a cell after each empty block, as a merged cell always would.

## Before and after (Generate, zero-answers import)

Columns:
- **before**: this branch with spans held back from the rule (the stopgap), on the old engine.
- **stopgap-off old engine**: spans written to the rule, old engine. This is the 6→0 failure.
- **after**: this change.

Runs are written as count×length. For example, 6×2 means six runs, each two blocks long.

| camp | placed cells | unfillable | span activities |
|---|---|---|---|
| s01-by-day-small-5d | 114 → 114 | 0 → 0 | Ropes Course (N=2): before 5×1 (min 4) · stopgap-off old engine 0 · after 6×2 (span_blocks 2, min 2 vs printed 2) |
| s02-by-day-three-waves | 280 → 280 | 0 → 0 | Ropes Course (N=2): claimed as event, not a candidate |
| s03-by-day-4day-24h-nolunch | 39 → 39 | 0 → 0 | Wilderness Skills (N=3): claimed as event, not a candidate |
| s04-by-day-6day-large | 724 → 724 | 0 → 0 | Ropes Course (N=2): before 9×1 (min 2) · stopgap-off old engine 9×2 · after 8×2 (span_blocks 2, min 1 vs printed 1)<br>Wilderness Skills (N=2): before 9×1 (min 4) · stopgap-off old engine 9×2 · after 16×2 (span_blocks 2, min 2 vs printed 2) |
| s05-by-day-tiny-early | 34 → 34 | 0 → 0 | Ropes Course (N=3): claimed as event, not a candidate |
| s06-by-day-40-groups-late | 1040 → 1040 | 0 → 0 | Wilderness Skills (N=3): before 11×1 (min 3) · stopgap-off old engine 0 · after 10×3 (span_blocks 3, min 1 vs printed 1)<br>Ropes Course (N=2): before 10×1 (min 2) · stopgap-off old engine 10×2 · after 20×2 (span_blocks 2, min 2 vs printed 2) |
| s07-by-group-3-divisions | 192 → 192 | 0 → 0 | Ropes Course (N=2): before 3×1 (min 4) · stopgap-off old engine 2×2 · after 4×2 (span_blocks 2, min 2 vs printed 2) |
| s08-by-group-24h-wrapped | 288 → 288 | 0 → 0 | Wilderness Skills (N=3): before 0 (min null) · stopgap-off old engine 0 · after 0 (span_blocks —, min null vs printed 2)<br>Ropes Course (N=2): claimed as event, not a candidate |
| s09-by-group-6day-except | 340 → 340 | 0 → 0 | Ropes Course (N=2): before 10×1 (min 4) · stopgap-off old engine 0 · after 16×2 (span_blocks 2, min 2 vs printed 2) |
| s10-by-group-sun-thu-early | 56 → 56 | 0 → 0 | Wilderness Skills (N=2): claimed as event, not a candidate |
| s11-daysheet-5d-small | 76 → 76 | 0 → 0 | Ropes Course (N=2): before 3×1 (min 2) · stopgap-off old engine 0 · after 2×2 (span_blocks 2, min 1 vs printed 1) |
| s12-daysheet-4d-late | 288 → 288 | 0 → 0 | Wilderness Skills (N=3): before 7×1 (min 3) · stopgap-off old engine 4×3 · after 5×3 (span_blocks 3, min 1 vs printed 1)<br>Ropes Course (N=2): before 9×1 (min 2) · stopgap-off old engine 12×1 · after 7×1 (span_blocks —, min 2 vs printed 2) |
| s13-daysheet-16-splits | 440 → 440 | 0 → 0 | Ropes Course (N=2): before 15×1 (min 4) · stopgap-off old engine 10×2 · after 16×2 (span_blocks 2, min 2 vs printed 2) |
| s14-by-day-period-24h | 207 → 207 | 0 → 0 | Ropes Course (N=2): claimed as event, not a candidate |
| s15-by-day-period-6day-nolunch | 468 → 468 | 0 → 0 | Wilderness Skills (N=3): before 10×1 (min 3) · stopgap-off old engine 0 · after 18×3 (span_blocks 3, min 3 vs printed 3)<br>Ropes Course (N=3): claimed as event, not a candidate |
| campB (`docs/work/specs/samples/campB-by-day.txt`) | 352 → 352 | 0 → 0 | no span detected |

Placed cells and unfillable cells are **identical** on all 15 synthetic camps and campB. The confirm-all imports give the same placed and unfillable counts as the zero-answers imports shown above. After the change, every span activity has `min_per_week` equal to the sessions per week printed in the file. Every Generate run of a span is exactly N blocks long, and the number of runs meets the printed sessions × groups (for example s01 3 groups × 2 = 6, s15 6 × 3 = 18).

**Not used as evidence:** the harness's `stillNeeded` (UNDERSERVED) total. It changes from one run to the next even when the code has not changed, because each run makes a new random camp id and that id seeds the engine. Placed and unfillable counts did not change across any of the runs.

**Not fixed here (other findings):**
- Seven spans are claimed as events: Ropes Course on s02, s05, s08, s14 and s15, and Wilderness Skills on s03 and s10.
- s08 Wilderness Skills has no activity row.
- s12 Ropes Course (blank form) is not detected as a span.

## How it was measured

```
SYNTHETIC_SCORECARD_PATH=<out>.json npx vitest run electron/syntheticCamps.harness.integration.test.js
SYNTHETIC_ONLY=zzz SYNTHETIC_REPRO=docs/work/specs/samples/campB-by-day.txt npx vitest run electron/syntheticCamps.harness.integration.test.js -t "prints the import"
```

The harness REPRO mode now also prints a Generate summary (placed, unfillable, run lengths for each span activity). That is where the campB row comes from.
