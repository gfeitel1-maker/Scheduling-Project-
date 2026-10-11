---
title: "F5 follow-ups: catalogue spans stay activities, wrapped span names, prefer_before_day for spans, scorecard write gate"
document_type: evidence
status: active
created: 2026-10-11
archive_when: the F5 follow-ups branch (claude/f5-followups) has merged and the synthetic scorecard has been regenerated on main
---

# F5 follow-ups, before and after

This follows [2026-10-11-f5-spans-first.md](2026-10-11-f5-spans-first.md) and the F5 section of
[2026-10-11-synthetic-15-scorecard.md](2026-10-11-synthetic-15-scorecard.md).

## What changed, per item

- **(a) A catalogue-length span that every group prints stays an activity.** `src/ingest/fixedEvents.js`,
  arm 2 (weekly recurring). A span detected by `inferTextSpans` is no longer admitted when all of these hold:
  - the bucket covers every group;
  - the span is at most half the day's blocks;
  - the name is not a meal.

  This follows strict category exclusivity
  (`docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md`): the name goes in one bucket,
  the activity. A span longer than that is still an event (Color War, Games Day). So is a span printed by
  only a two-thirds subset of groups: that is how s11's part-day Museum Trip becomes an event, and the
  grid gives no way to tell that trip from a catalogue span. Arm 1 (an event held most days) is unchanged.
  Released: s03 Wilderness Skills, s05 Ropes Course, s10 Wilderness Skills, s14 Ropes Course, s15 Ropes
  Course.

  Still pinned: s02 and s08 Ropes Course. Both use the blank form, and the blank tail block is blank for every
  group, so the free-period guard means no span is detected (T367, item c).
- **(b) s08 Wilderness Skills had no activity row.** This was not the claiming path. The labelled by-group
  page wraps "Wilderness" over "Skills" on 2 of 4 day columns. Two filled columns cleared `isValueRow`'s
  floor (`max(2, ceil(4 * 0.5))`), so "Skills" became a second row with the same period. The import then
  produced the activities "Wilderness" and "Skills", and the span could not be seen.

  `src/ingest/textGrid.js` now joins a line to the row above when all of these hold:
  - the page is labelled;
  - the line has no period label;
  - it sits directly under a value row;
  - it fills only columns that row's last line filled, fewer of them, and at most half the columns.

  The at-most-half rule keeps Camp A's nested swim sub-schedule (4 of 5 columns) as its own row. Every
  `.txt` under `docs/work/specs/samples` and `test/fixtures` (42 files) was parsed with the old and new
  parser. s08 is the only file whose output changed.
- **(c) s12 Ropes Course (blank form) is not detected: ticket, not fix.** The tail block is blank for 6 of
  10 groups on that day (s02: 14 of 14, s08: 12 of 12), so `structurallyFree` rejects it. Telling these
  apart from a camp-wide free period would loosen that guard, so this PR does not do it.
  `docs/work/tickets/T367-blank-span-tail-over-a-mostly-blank-block.md` proposes two options: ask the
  director, or check whether the block is blank on the group's other days too.
- **(d) `placeSpansFirst` honours `prefer_before_day`.** The head is now chosen first by `scoreForPrefer`
  (the same deferral the single-block round applies), then by day load, then by the earliest slot. No `rand()`
  call was added.
- **(e) The harness no longer rewrites tracked evidence.** `scorecardWriteTarget(env)` returns null unless
  `SHORESH_WRITE_SCORECARD=1` (the tracked JSON) or `SYNTHETIC_SCORECARD_PATH=<file>` is set. Two harness
  runs in this branch left `docs/work/evidence/2026-10-11-synthetic-15-scorecard.json` unmodified
  (`git status`).

## Tests written to fail first

- `src/ingest/fixedEvents.catalogueSpan.test.js`. On the old code, "is not claimed as a fixed event" and
  "is an activity with span_blocks 2" failed. The subset-trip case failed against the first, unscoped version
  of the release, which also showed up in the harness (s11 Museum Trip event cells went from 8/8 to 0/8).
  The all-day and meal case pins existing behaviour.
- `src/ingest/textGrid.wrapUnderValueRow.test.js`. Both tests failed on the old parser, which returned
  separate "Wilderness" and "Skills" rows and found no span.
- `src/engine/buildSchedule.spansFirst.test.js`, "places prefer_before_day_min sessions before the target day".
  On the old engine g1 got days [1, 2] instead of [0, 1]. The determinism test pins existing behaviour.
- `electron/syntheticCamps.harness.integration.test.js`, "scorecard write gate". This failed first because
  the gate did not exist.

## Harness before and after (zero answers; confirm-all identical)

Columns: Generate placed / unfillable, then each span's import result and Generate run lengths
(`{length: runs}`). "EV" means pinned as an event.

| Camp | placed / unfillable | spans before | spans after | runs before | runs after |
|---|---|---|---|---|---|
| s01 | 114/0 -> 114/0 | Ropes act | Ropes act | {2:6} | {2:6} |
| s02 | 280/0 -> 280/0 | Ropes EV | Ropes EV (T367) | none | none |
| s03 | 39/0 -> 48/0 | Wilderness EV | Wilderness act, span 3, min 1 | none | {3:3} |
| s04 | 724/0 -> 724/0 | both act | both act | {2:8}, {2:16} | same |
| s05 | 34/0 -> 40/0 | Ropes EV | Ropes act, span 3, min 1 | none | {3:2} |
| s06 | 1040/0 -> 1040/0 | both act | both act | {3:10}, {2:20} | same |
| s07 | 192/0 -> 192/0 | Ropes act | Ropes act | {2:4} | {2:4} |
| s08 | 288/0 -> 288/0 | Wilderness: no row; Ropes EV | Wilderness act, span 3, min 2; Ropes EV (T367) | none | Wilderness {3:6} |
| s09 | 340/0 -> 340/0 | Ropes act | Ropes act | {2:16} | {2:16} |
| s10 | 56/0 -> 64/0 | Wilderness EV | Wilderness act, span 2, min 1 | none | {2:4} |
| s11 | 76/0 -> 76/0 | Ropes act | Ropes act | {2:2} | {2:2} |
| s12 | 288/0 -> 288/0 | Wilderness act; Ropes act, no span | unchanged (T367) | {3:4}, Ropes {1:8} | {3:4}, Ropes {1:9} |
| s13 | 440/0 -> 440/0 | Ropes act | Ropes act | {2:16} | {2:16} |
| s14 | 207/0 -> 225/0 | Ropes EV | Ropes act, span 2, min 1 | none | {2:12} |
| s15 | 468/0 -> 522/0 | Wilderness act; Ropes EV | both act | {3:18}, none | {3:18}, Ropes {3:18} |
| campB | 352/0 -> 352/0 | no span | no span | none | none |

Unfillable is 0 on every camp, before and after. Placed is never lower. It rises on s03, s05, s10, s14 and s15
because cells that used to be pinned event cells are now open activity cells, and Generate fills them with
the released span (every run is exactly N blocks). The slot totals are unchanged. Per-event-name
event-cell matches (`generate.eventCells.byName`) are identical before and after on all 15 camps. On s14,
`stillNeeded` rises from 18 to 25 because Ropes Course now carries a `min_per_week` goal of 1 for 9 groups.

Commands (scorecards written to the scratchpad, not to the tracked JSON):

```
SYNTHETIC_SCORECARD_PATH=<out>.json npx vitest run electron/syntheticCamps.harness.integration.test.js
SYNTHETIC_ONLY=zzz SYNTHETIC_REPRO=docs/work/specs/samples/campB-by-day.txt npx vitest run electron/syntheticCamps.harness.integration.test.js -t "prints the import"
```

The "before" run used `8b5068d6` plus only the new `prefer_before_day` engine test. That test cannot change
the harness output.
