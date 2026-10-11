---
title: "Synthetic 15-camp scorecard: what the importer and Generate do with fictional camps"
document_type: evidence
status: active
date: 2026-10-11
task_class: ingestion
related_tickets: []
related_specs: [docs/work/specs/samples/INGESTION_SAMPLES.md]
archive_when: the root causes F1 to F9 are fixed or ruled out and the harness has been folded into the standing suite
---

# Synthetic 15-camp scorecard, 2026-10-11

Findings only: nothing in product code was changed. Source of every number below is
`docs/work/evidence/2026-10-11-synthetic-15-scorecard.json`, written by
`electron/syntheticCamps.harness.integration.test.js` over the corpus in
`docs/work/specs/samples/synthetic/` (manifest and expected facts per camp: that directory's `README.md` and `manifest.json`).

- Run: `SHORESH_WRITE_SCORECARD=1 npx vitest run electron/syntheticCamps.harness.integration.test.js` to regenerate the JSON (a plain run writes nothing; `SYNTHETIC_SCORECARD_PATH=<file>` writes elsewhere) (about 53 s on a loaded 4-core machine, load average ~25; per-camp 0.6 to 7.9 s; 152 tests, 143 pass, 8 expected-fail, 1 skipped repro hook).
- Per camp: fresh db, parse -> extract -> inferFixedEvents -> dry run -> `buildReconciliationReport` -> `foldTriageInputs` -> commit, once with ZERO answers and once on a separate fresh db confirming every `confirm_value` (plus every `elective_candidate`, so the elective path is reachable). Then Generate (`buildSchedule`) and Manual-from-import (`capturePlacements` -> `materializeImportedVersion`) on both, then on the zero-answers db a Keep re-import and a Replace re-import (CPU from `process.cpuUsage`).
- The glue mirrors `ImportScreen`/`ReconciliationScreen` (division and co-schedule inference, `electiveCandidates`, `allCampOverrides`, `openDecisions`); it does NOT run ImportScreen's other pre-steps (name-variant merge prompts, compound-cell patterns, location bindings) or the XLSX path.

## Hard invariants versus recorded metrics

Hard (fail CI): any pipeline stage throwing; the T266 exclusivity invariant (a claimed event name raises no activity-pass decision, persists no open item, is an activity only as the pinned-event marker, and sits in one bucket, not both); Generate returning an error-severity finding; Keep re-import writing any record; Replace re-import not completing; and "every printed meal cell is covered by a fixed event" (the owner's lunch regression). Reason: these are correctness or crash properties with one right answer. Everything else (counts, event recall, spans, special events, electives, placed / unfillable / still-needed) is recorded in the JSON and not asserted, because the right answer is a product judgement and a red build for it would block unrelated work.

Failing hard invariants are held in `KNOWN_FAILING` and run under `it.fails`: 8 entries, all the lunch-coverage invariant on four camps (s04, s09, s12, s13), root cause F1 below. When F1 is fixed `it.fails` goes red, which is the prompt to delete the entries.

## Results by camp

Import (zero-answers run unless stated). "Activities (regular)" excludes names the importer pinned as events, and the manifest count includes span activities. "Meals covered" is strict: group x day x block covered by a `fixed_events` row of the right name, resolved through the product's own `resolveFixedEventGroupIds`.

| # | Camp | Grid | Groups | Divisions | Time blocks | Activities (regular) | Fixed / recurring events | Questions (0-answers / confirm-all) | Exclusivity (both runs) | Meals covered | Keep: new records | Replace CPU ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `s01` byDay | 5d x 6g x 7b | 6/6 | 2/2 | 7/7 | 14/13 | 16 / 0 | 0 / 0 | pass | 30/30 | none | 211 |
| 2 | `s02` byDay | 5d x 14g x 10b | 14/14 | 4/4 | 10/10 | 26/26 | 26 / 12 | 6 / 6 | pass | 56/56 | none | 277 |
| 3 | `s03` byDay | 4d x 3g x 6b | 3/3 | 1/1 | 6/6 | 9/9 | 11 / 0 | 0 / 0 | pass | n/a (no lunch) | none | 90 |
| 4 | `s04` byDay | 6d x 25g x 9b | 25/25 | 7/7 | 8/9 | 41/37 | 2 / 24 | 9 / 9 | pass | 102/142 | none | 401 |
| 5 | `s05` byDay | 5d x 2g x 8b | 2/2 | 1/1 | 6/8 | 8/7 | 13 / 0 | 1 / 1 | pass | 8/8 | none | 102 |
| 6 | `s06` byDay | 5d x 40g x 10b | 40/40 | 8/8 | 10/10 | 44/42 | 21 / 12 | 6 / 6 | pass | 160/160 | none | 719 |
| 7 | `s07` byGroup | 5d x 8g x 8b | 8/8 | 3/3 | 8/8 | 18/16 | 11 / 10 | 1 / 1 | pass | 40/40 | none | 171 |
| 8 | `s08` byGroup | 4d x 12g x 8b | 12/12 | 4/4 | 8/8 | 25/22 | 1 / 8 | 3 / 3 | pass | n/a (no lunch) | none | 169 |
| 9 | `s09` byGroup | 6d x 21g x 8b | 21/21 | 6/6 | 7/8 | 32/31 | 4 / 25 | 10 / 10 | pass | 101/106 | none | 311 |
| 10 | `s10` byGroup | 5d x 4g x 7b | 4/4 | 2/2 | 7/7 | 11/11 | 21 / 0 | 3 / 3 | pass | 16/16 | none | 110 |
| 11 | `s11` daySheet | 5d x 6g x 6b | 6/6 | 2/2 | 6/6 | 9/9 | 16 / 2 | 2 / 2 | pass | 30/30 | none | 115 |
| 12 | `s12` daySheet | 4d x 10g x 10b | 10/10 | 3/3 | 10/10 | 22/20 | 1 / 15 | 9 / 9 | pass | 31/34 | none | 206 |
| 13 | `s13` daySheet | 5d x 16g x 9b | 16/16 | 4/4 | 9/9 | 32/26 | 4 / 24 | 22 / 22 | pass | 60/72 | none | 347 |
| 14 | `s14` byDayPeriod | 5d x 9g x 8b | 9/9 | 3/3 | 8/8 | 16/15 | 12 / 11 | 4 / 4 | pass | 45/45 | none | 174 |
| 15 | `s15` byDayPeriod | 6d x 18g x 9b | 18/18 | 6/6 | 9/9 | 32/32 | 28 / 0 | 3 / 3 | pass | n/a (no lunch) | none | 307 |

Generate (`buildSchedule` on the committed db, zero-answers run). Still needed = sum of UNDERSERVED shortfalls. OVERLAP from `computeOverlaps`. Placed and unfillable are stable between runs; still-needed moves by a few units run to run (the seeded PRNG is keyed on camp and cohort id, which are random UUIDs here), so read it as a magnitude.

| # | Camp | Placed | Unfillable | Still needed | OVERLAP | Error findings | Generate CPU ms | Placed (confirm-all run) |
|---|---|---|---|---|---|---|---|---|
| 1 | `s01` | 114 | 0 | 8 | 0 | 0 | 42 | 114 |
| 2 | `s02` | 280 | 0 | 0 | 0 | 0 | 58 | 280 |
| 3 | `s03` | 39 | 0 | 4 | 0 | 0 | 3 | 39 |
| 4 | `s04` | 844 | 0 | 91 | 0 | 0 | 165 | 844 |
| 5 | `s05` | 34 | 0 | 6 | 0 | 0 | 4 | 34 |
| 6 | `s06` | 1040 | 0 | 45 | 0 | 0 | 246 | 1040 |
| 7 | `s07` | 192 | 0 | 41 | 0 | 0 | 23 | 192 |
| 8 | `s08` | 324 | 0 | 61 | 0 | 0 | 41 | 324 |
| 9 | `s09` | 355 | 0 | 23 | 0 | 0 | 50 | 355 |
| 10 | `s10` | 56 | 0 | 7 | 0 | 0 | 4 | 56 |
| 11 | `s11` | 76 | 0 | 24 | 0 | 0 | 6 | 76 |
| 12 | `s12` | 327 | 0 | 53 | 0 | 0 | 49 | 327 |
| 13 | `s13` | 516 | 0 | 76 | 0 | 0 | 96 | 516 |
| 14 | `s14` | 199 | 0 | 25 | 0 | 0 | 42 | 199 |
| 15 | `s15` | 468 | 0 | 12 | 0 | 0 | 101 | 468 |

Owner columns. Definitions: *spans* = `activities.span_blocks` equals the printed span length, and `min_per_week` not inflated beyond the sessions printed per week; *special events* = trips and all-day days found as fixed/recurring events when imported, `special_days` rows created, `special_day_placements` written; *displaced* = for the cells those trips/all-day days should own, the share holding that event in the Manual-from-import version and in Generate; *electives* = elective sets created on the confirm-all run out of those the manifest expects, how many carry day, block or group scope, and the `elective_candidate` questions asked; *Generate respects* = every expected event cell is a fixed-event slot (all kinds), every generated run of a span activity is as long as the span, every expected elective cell is an elective slot.

| # | Camp | Spans preserved as one session | Special events created / placed | Regular schedule displaced (trips + all-day) | Elective sets and eligibility | Generate respects |
|---|---|---|---|---|---|---|
| 1 | `s01` | span_blocks set 0/1; min_per_week inflated 1 | events 0/6; special_days 0; placed 0 | manual 0/6; Generate 0/6 | - | events 96/102; spans runs of the right length 0/6; - |
| 2 | `s02` | span_blocks set 0/1; min_per_week inflated 0; blank-form tail kept 14/28 | events 140/140; special_days 0; placed 0 | manual 140/140; Generate 140/140 | sets 0/1; eligibility 0/1; questions 0 | events 392/392; spans none placed; elective slots 0/14 (+14 as fixed event) |
| 3 | `s03` | span_blocks set 0/1; min_per_week inflated 0 | events 0/4; special_days 0; placed 0 | manual 0/4; Generate 0/4 | - | events 24/28; spans none placed; - |
| 4 | `s04` | span_blocks set 0/2; min_per_week inflated 2 | events 0/88; special_days 0; placed 0 | manual 0/88; Generate 0/88 | sets 1/2; eligibility 0/2; questions 9 | events 356/706; spans runs of the right length 0/28; elective slots 0/24 |
| 5 | `s05` | span_blocks set 0/1; min_per_week inflated 0 | events 12/18; special_days 0; placed 0 | manual 12/18; Generate 12/18 | - | events 20/42; spans none placed; - |
| 6 | `s06` | span_blocks set 0/2; min_per_week inflated 1; blank-form tail kept 20/40 | events 400/430; special_days 0; placed 0 | manual 400/430; Generate 400/430 | sets 0/2; eligibility 0/2; questions 1 | events 880/950; spans runs of the right length 0/25; elective slots 0/50 (+40 as fixed event) |
| 7 | `s07` | span_blocks set 0/1; min_per_week inflated 1 | events 0/6; special_days 0; placed 0 | manual 0/6; Generate 0/6 | sets 1/1; eligibility 0/1; questions 1 | events 128/134; spans runs of the right length 0/3; elective slots 0/2 |
| 8 | `s08` | span_blocks set 0/2; min_per_week inflated 0; blank-form tail kept 12/24 | events 0/48; special_days 0; placed 0 | manual 0/48; Generate 0/48 | sets 0/1; eligibility 0/1; questions 1 | events 48/132; spans none placed; elective slots 0/6 |
| 9 | `s09` | span_blocks set 0/1; min_per_week inflated 1 | events 140/168; special_days 0; placed 0 | manual 140/168; Generate 140/168 | sets 0/1; eligibility 0/1; questions 0 | events 464/613; spans runs of the right length 0/13; elective slots 0/63 (+63 as fixed event) |
| 10 | `s10` | span_blocks set 0/1; min_per_week inflated 0 | events 28/32; special_days 0; placed 0 | manual 28/32; Generate 28/32 | - | events 76/80; spans none placed; - |
| 11 | `s11` | span_blocks set 0/1; min_per_week inflated 1 | events 8/8; special_days 0; placed 0 | manual 8/8; Generate 8/8 | sets 0/1; eligibility 0/1; questions 0 | events 98/98; spans runs of the right length 0/3; elective slots 0/6 (+6 as fixed event) |
| 12 | `s12` | span_blocks set 0/2; min_per_week inflated 1; blank-form tail kept 12/24 | events 0/68; special_days 0; placed 0 | manual 0/68; Generate 0/68 | sets 0/1; eligibility 0/1; questions 2 | events 73/180; spans runs of the right length 0/21; elective slots 0/2 |
| 13 | `s13` | span_blocks set 0/1; min_per_week inflated 1 | events 0/80; special_days 0; placed 0 | manual 0/80; Generate 0/80 | sets 0/1; eligibility 0/1; questions 0 | events 188/344; spans runs of the right length 0/11; elective slots 0/20 (+16 as fixed event) |
| 14 | `s14` | span_blocks set 0/1; min_per_week inflated 0 | events 0/6; special_days 0; placed 0 | manual 0/6; Generate 0/6 | sets 1/1; eligibility 0/1; questions 3 | events 143/150; spans none placed; elective slots 0/6 |
| 15 | `s15` | span_blocks set 0/2; min_per_week inflated 0; blank-form tail kept 18/54 | events 162/174; special_days 0; placed 0 | manual 162/174; Generate 162/174 | sets 0/1; eligibility 0/1; questions 0 | events 432/444; spans runs of the right length 0/11; elective slots 0/18 (+18 as fixed event) |

## Layouts used

Four, each confirmed to parse (groups, days and time blocks recovered) before camps were built on it:

| Layout | Shape | Camps |
|---|---|---|
| by-day (campB shape) | one page per day, groups across, `Time` header, `Monday — All Camp` titles | s01-s06 |
| by-group (campA shape) | one page per group, days across, `Time` header, `Unit - Bunk Schedule` titles | s07-s10 |
| day sheet (campC shape) | unlabeled time column, AM/PM start and end lines, a room line under each activity, positional group codes | s11-s13 |
| by-day with `Period` header | upper-case `THURSDAY SCHEDULE` titles, 24h times | s14-s15 |

The 15 grids vary: 2 to 40 groups, 1 to 8 divisions, 4/5/6-day and Sunday-to-Thursday weeks, 7:30 and 10:20-to-18:00 days, 20/30/35/40/45/50/55/60-minute and uneven blocks, 0 to 3 lunch waves, 6 to 40 activities, 12h/24h/AM-PM clocks, collisions with event words ("Lunch Bunch", "Swim Test", a weekly "Swim" event), daily, weekly, every-other-day and single-day events, an all-but-one-group day, split cells, blank cells, the "Musik" and "Archary" typos and wrapped cells.

## What passed

- Exclusivity: 30/30 runs (15 camps x zero-answers and confirm-all). No claimed name raised an activity-pass decision, left an open item, or sat in two buckets. Questions about the *event itself* (entity `fixed_events`, for example "Is Lunch 2 right?") are legitimate and are recorded, not failed.
- Re-import with Keep wrote zero new records on 15/15; Replace completed on 15/15 (CPU 73 to 598 ms; the 40-group camp is the slowest at 598 ms).
- No pipeline stage threw and Generate returned no error-severity finding on 15/15 (both runs). OVERLAP: 0 on every camp.
- Groups, days and divisions were recovered exactly on 15/15; time blocks on 12/15 (F2 explains the other three).
- Whole-camp all-day days (s02 Color War, s06 and s15 Games Day) and most-camp all-day days (s09, all but one group) were imported as recurring events and Generate honoured them (s02 140/140, s06 400/400, s15 162/162) apart from the F2 cells.
- The three one-day special-day files in `special-days/` were all recognised by `proposeSpecialDay`, planned ready, and committed (8, 10 and 8 periods): the text path works for these.

## Failures, grouped by root cause

Ranked by severity. "Expected" is the manifest's intent; every number is from the JSON.

### F1 (high): a second group scope on the same event, day and block is silently dropped

Camps: s04, s09, s12, s13 (hard invariant, known-failing) and s08 (Check In/Check Out 24/42, same cause, not asserted).

Expected: every group that prints Lunch/Arrival/Dismissal/Sign In on a day has a fixed event for it. Happened: when a subset of groups differs in WHICH days they print an event (for example 8 of 25 groups lose Friday to an all-day Games Day, or one lone group runs a sixth day), inference correctly emits two events with the same name, block and overlapping days but different group sets, and commit keeps the first and treats the second as "unchanged". The second group set loses every overlapping day.

- s04: Lunch 1 30/70, Arrival 102/142, Dismissal 102/142; the 8 groups with the Friday Games Day (Otters 1-4, Herons 1-4) have no Lunch/Arrival/Dismissal on the other five days. 40 Lunch cells missing (strict lunch coverage 102/142).
- s09: the lone `Counselor Aides` group has Arrival, Lunch and Dismissal only on Saturday; Monday-Friday lost (events table: 20 groups Mon-Fri, Aides Sat). Lunch 101/106.
- s12: Lunch 31/34, Sign In and Pick Up 16/34 each; s13: Lunch 60/72, Sign In and Pick Up 40/72; s08: Check In/Out 24/42.
- Consequence: Generate regenerates a week without lunch for those groups (this is the owner's "lunch was skipped for half the groups" class). Manual-from-import looks right (lunch 142/142 on s04) because `resolveImportedPlacements` links by event NAME, not scope, so the defect is masked on the Manual route and exposed on Generate.

Minimal repro: `docs/work/specs/samples/synthetic/repro/r1-same-event-two-scopes.txt` (3 groups, 4 days; Lunch is printed by all three on Mon-Wed, by Otters 3 only on Thu).

```
   Time           Otters 1   Otters 2   Otters 3        (Monday-Wednesday)
10:00–10:45       Lunch      Lunch      Lunch
   Time           Otters 1   Otters 2   Otters 3        (Thursday)
10:00–10:45       Tennis     Drama      Lunch
```
`SYNTHETIC_REPRO=docs/work/specs/samples/synthetic/repro/r1-same-event-two-scopes.txt npx vitest run electron/syntheticCamps.harness.integration.test.js -t "prints the import"` prints `Lunch | Monday | Otters 1,Otters 2` (Tue, Wed likewise) and `Lunch | Thursday | Otters 3`: Otters 3 has no Lunch Monday-Wednesday.

Suspected area: `electron/ops/ingest.js:1261` (`fixedEventSlotKey`, scope-excluding by design, comment at :1854) used at `:2415` where `fixedEventSlots.has(slotKey)` routes the second event's days to `fixedUnchanged` (the scope difference is only noted in `fixedScopeChanged`, never asked). Inference side is correct: `src/ingest/fixedEvents.js:322` keys the collapse on (activity, block, days) and emits both events.

### F2 (high): a 10-minute block is discarded as a "change-over", taking its events with it

Camps: s04 (Flag Raising, 08:50-09:00), s05 (Reveille 07:30-07:40 and Taps 09:40-09:50; 6 of 8 blocks), s09 (Flag Raising, 09:10-09:20).

Expected: an event printed in a 10-minute row is a time block and an event. Happened: the row is dropped by `isChangeOverSpan` (`span <= 10`), so the block does not exist, the event has no `fixed_events` row (Flag Raising 0/142 on s04, Reveille and Taps 0/16 on s05, Flag Raising 0/106 on s09), every all-day special that included that block loses those cells (s05 Games Day 12/16, s09 Games Day 140/160), and the name is still minted as a `pinned_event` activity row with no event behind it (r2 shows `Flag Raising` in `activities`, none in the events).

Minimal repro: `repro/r2-ten-minute-event.txt` (`08:50–09:00  Flag Raising x3` above two normal rows); blocks printed: `09:05-09:45`, `10:00-10:45` only, no Flag Raising event.

Suspected area: `src/ingest/periodSpan.js:21` (`CHANGE_OVER_MAX_MINUTES = 10`) and `:44` (`<=`), called from `src/ingest/extractEntities.js:570`. The constant's own comment says the shortest real period in the corpus was 15 minutes; a 10-minute flag raising or reveille is plausible at a real camp.

### F3 (high): field trips and subset all-day days become catalog activities, never events or special days

Camps: 13 of 15 print a trip (s01, s03, s04, s05, s06, s07, s09, s10, s12, s13, s14, s15; s11 passes only because its trip covers 4 of 6 groups, over the two-thirds line) and 4 print a subset all-day day (s04, s08, s12, s13).

Expected: a trip (some groups, part of a day) and an all-day day for a subset of groups are special events that displace the regular schedule on that day. Happened: with fewer than two thirds of the groups sharing the same day-set the inference never admits an event (`src/ingest/fixedEvents.js:280`), so "Museum Trip", "Aquarium Trip", "Farm Trip" and "Games Day" become ordinary catalog activities with a `min_per_week`. Trip cells imported as events: 8/118 (all on s11). Subset all-day cells: 0/72 (s04), 0/48 (s08), 0/60 (s12), 0/72 (s13). Generate then places the trip activity somewhere else (for example s04 Aquarium Trip: 16 expected cells, 8 placements, 0 at an expected cell) and fills the real trip cells with ordinary activities. Manual-from-import shows the printed cells, so the regular schedule is displaced there only because the file said so; Generate does not preserve it.

Minimal repro: `repro/r6-partial-day-trip.txt` (Otters 1 prints Museum Trip for two blocks on Tuesday only). The printed result has `Museum Trip` in `activities` with `catalog_role: null, min_per_week: 2` and no event.

Suspected area: no code path produces a `special_days` row from a weekly grid; the only reader is the one-day-file door at `src/screens/ImportScreen.jsx:516` (`proposeSpecialDay`). Whole-camp and near-whole-camp all-day days are recognised only because they look like any all-camp recurring event (`src/ingest/fixedEvents.js:279-280`).

### F4 (high): no way to bring a special day from a file onto a week and day

Camps: all 15 (`special_days` rows from a weekly import: 0, `special_day_placements` written: 0). The 3 one-day files recognised and built a special day each (`placementsAfter: 0`): the special day exists but is bound to no week or day, and its cells added 7 to 9 new catalog activities to the permanent setup. Expected (T350): the all-day day should arrive as a special day placed on the right day, with the regular schedule displaced by `special_day_placements`. Happened: a whole-camp all-day day inside a weekly grid is stored as N separate recurring events (one recurring event per block on s09) and a one-day file creates an unplaced special day; nothing connects the two or writes a placement.

Repro: `SYNTHETIC_ONLY=s05 npx vitest run electron/syntheticCamps.harness.integration.test.js` then read `camps.s05-by-day-tiny-early.specialDayFiles` in the JSON (`recognised: true, ready: true, commit.ok: true`, `placementsAfter: 0`).

Suspected area: `src/screens/ImportScreen.jsx:516-531` and `src/ingest/commitSpecialDay.js` (parent `special_days`, periods, cells; no `special_day_placements` write; placement lives only in `src/screens/specialDay/SpecialDayPlacements.jsx`).

### F5 (medium-high): multi-block spans from a text grid are never one session

Camps: all 15 print spans (20 span activities). `activities.span_blocks` set: 0/20 (the only writer is the XLSX merge path, `src/ingest/sheetGrid.js:107` -> `multiBlockCandidates`, which a text grid cannot trigger).

- Name printed in every block ("repeat"): each block is a separate placement. `min_per_week` is inferred from block appearances and is inflated: 9 of the 12 span activities that stayed ordinary activities have `min_per_week` above the sessions printed per week (s01 Ropes Course 4 for 2 sessions, s07 4 for 2, s13 4 for 2, s06 Wilderness Skills 3 for 1, s12 3 for 1). Generate places them as single blocks: every generated run is length 1 (for example s04 Ropes Course 16 runs of length 1, s13 11 runs of length 1), never 2 or 3.
- Name printed once, later blocks blank ("blank", how a merged cell extracts): only the head block survives. Manual-from-import keeps 14/28 (s02), 20/40 (s06), 12/24 (s08, s12), 18/54 (s15) of the span's cells.
- When every group prints the same span the activity is claimed as an event instead (7 of 20: s02, s03, s05, s08, s10, s14, s15 Ropes Course/Wilderness Skills), so it is pinned and not a candidate for goals.

Minimal repro: `repro/r6-partial-day-trip.txt` also shows it: a two-block name gives `min_per_week: 2` and `span_blocks: null` for a single occurrence.

Suspected area: `src/ingest/activityRules.js:98` (`perWeek = round(appearances / eligibleGroupCount)` counts blocks, not sessions), `src/ingest/capturePlacements.js` header comment ("Multi-block spans flatten to per-block cells"), and no `span_blocks` write in `electron/ops/ingest.js` for text input.

### F6 (medium): electives lose their shape between the file and the elective set

Camps: s02, s04, s06, s07, s08, s09, s11, s12, s13, s14, s15 (11 of 15 print electives).

- Camp-wide elective header words ("Chugim", "Bechirot", "Electives") are claimed as fixed events and never raise an elective question: s02, s09, s11, s15, and the Chugim on s06 and s13. Elective sets created: 0. Generate treats the cell as a fixed event (14/14, 63/63, 6/6, 18/18) but never as an elective slot.
- Group-limited electives raise `elective_candidate` questions (s04 9, s06 1, s07 1, s08 1, s12 2, s14 3), but a header word also becomes a regular catalog activity (`Electives` on s04, `Indoor Elective` on s07, `Elective` on s14) and Generate fills those cells with ordinary activities (0 elective slots on every one of these camps).
- Confirming creates the set with `name` and `camp_id` only: day, block and groups are never captured (eligibility 0/N sets on every camp; confirm-all created 1 of 2 on s04, 1/1 on s07 and s14, 0 elsewhere).
- List-shaped cells ("Ceramics / Kayaking / Yoga / Puppetry", 2 to 5 choices) become one activity whose name is the whole list (s04, s06, s08, s13: for example `Hiking / Fishing / Kayaking / Orienteering / Bocce`); the uneven choice counts are lost.

Minimal repro: `repro/r7-electives-for-some-groups.txt` (two of four groups print `Electives` in one block on Tuesday): `Electives` appears in `activities` with `min_per_week: 1`, an `elective_candidate` question is asked, and no set exists until confirmed.

Suspected area: `src/ingest/buildPlan.js:318-346` (header and shape findings suppressed for a name already claimed as a fixed event, and kept as an activity otherwise), `electron/ops/ingest.js:658-690` (`commitElectiveCandidates` writes only `name` and `camp_id`).

### F7 (medium): a day-sheet room line is welded onto the activity name

Camps: s12 (6 unresolved placements in Manual-from-import: `Pottery Lake`, `Orienteering Pavilion`, `Music Lake`, `Knitting Field 2`, `Pottery / Drama / Robotics Field 1/2`), s13 (`Sailing Dock`, `Trampoline Field 2` minted as activities). Expected: the room line under an activity is a location. Happened: it is stripped as a location only when the line fills at least half of the day columns, so a row where most columns are events (no room) leaves one room line that is read as part of the cell.

Minimal repro: `repro/r5-daysheet-room-under-one-column.txt` (4 day columns, only Monday has an activity with a room): printed events contain `Pottery Loft`.

Suspected area: `src/ingest/textGrid.js:479` (`isValueRow`, threshold `max(2, ceil(columns * 0.5))`) used at `:559` in the `stripLocations` branch.

### F8 (medium): a wrapped cell becomes its own row when it wraps in half or more of the columns

Camps: s06 (Closing Ceremony 0/40, the whole-camp finale), s08 (`Wilderness` and `Skills` minted as two activities; the Wilderness Skills span cells 0/18).

Expected: "Arts and / Crafts" is one cell. Happened: the continuation line is treated as a new value row when it occupies at least half the columns. By-group pages have only 4 to 6 day columns, so a name wrapping on 2 or 3 days splits into two activities; a by-day event wrapping in every column splits into two events.

Minimal repro: `repro/r3-wrap-in-half-the-columns.txt` (by-group, `Arts and`/`Crafts` wrapped on Mon, Wed, Fri) produces events `Arts and` and `Crafts`; `repro/r4-event-wraps-in-every-column.txt` produces `Closing` and `Ceremony`.

Suspected area: `src/ingest/textGrid.js:479` (`isValueRow`) with the wrap handling at `:549-555` (`wrapsAcrossNarrow`).

### F9 (low-medium): a weekly all-camp event that shares its name with an activity drops any group that also runs the activity at that block on another day

Camp: s14 (weekly `Swim`, Wednesday 09:20, all 9 groups: 8/9 covered; Otters 1 also runs the activity `Swim` at that block on Thursday so its day set differs). Expected 9/9. Happened: Otters 1's Wednesday Swim stays an activity cell.

Minimal repro: `repro/r8-weekly-event-shares-name-with-activity.txt` (printed event list shows `Swim | Wednesday | Otters 2,Otters 3,Otters 4`).

Suspected area: `src/ingest/fixedEvents.js:272-284` (arm 2 buckets groups by the EXACT day set).

### F10 (low): character-level typos create separate activities with no question

Camps: s02, s08 and s13 (`Musik`), s05 (`Archary`). Expected: a near-duplicate question or a fold into the dominant spelling. Happened: a separate activity, no question (questions on s02: 6, all about events). This is the documented T144 precision rule (word-form suffix variants only), so it is a known policy gap rather than a regression: `src/ingest/nearDuplicateNames.js:51`.

### F11 (low, latent): an activity with a null `max_per_week` can never be placed

Observed while building the harness: committing the pipeline with the rule Map from `inferActivityRules` passed straight to `commitIngest` (as `electron/importDirectorPath.integration.test.js` and `electron/ingestPassExclusivity*.integration.test.js` do) stores no rules, and Generate on campB then places 0 activities and flags every free cell "Weekly max reached". `ImportScreen` sends a plain object, so the product import is unaffected, but `src/engine/buildSchedule.js:539` (`getCount(...) >= act.max_per_week`) treats null as 0, so any activity row reaching the engine without a `max_per_week` is unplaceable. Reachability from the product was not established. The harness here passes the object form the screen sends. The existing tests that pass the Map exercise Generate with no activity rules; their Generate assertions (`slots.length > 0`) are satisfied by fixed events alone.

## Re-run against main a7cfb38f (same day, deterministic seeds)

The harness now derives camp and cohort ids from the camp slug and scenario. Previously random ids seeded the engine's PRNG, so identical runs differed: s02 stillNeeded ranged 0 to 3 and s07 ranged 38 to 47. The JSON above was regenerated from this run, and a second run matches it with 0 changed metrics (timestamps and CPU timings excluded); a standing test now runs one camp twice and requires identical metrics. 153 pass, 1 skipped repro hook, and `KNOWN_FAILING` is empty.

The deltas below compare against the earlier (random-seed) JSON, so small per-camp swings in placed and stillNeeded on unchanged camps are seed noise, not product change.

| Indicator (15 camps, zero answers) | Before | Now |
|---|---|---|
| Lunch-coverage invariant (F1) | 8 expected-fail | passes, `KNOWN_FAILING` empty |
| Daily event cells covered (Generate and Manual) | 1896 / 2160 | 2160 / 2160 |
| One-off ("single") event cells | 46 / 86 | 86 / 86 |
| All-day event cells | 882 / 1158 | 906 / 1158 |
| Weekly event cells (F9), zero answers / confirm all | 49 / 58 and 49 / 58 | 49 / 58 and **58 / 58** |
| Trip event cells (F3) | 8 / 118 | 8 / 118 |
| Multi-block span, e.g. s14 Ropes Course (F5) | not one session | `runs: {2: 10}`, one double session |
| Day-sheet camps s12/s13: questions, Manual unresolved (F7) | 8 and 21 questions; 6 and 20 unresolved | 1 and 1; 0 and 0 |
| Unresolved time blocks (F2) | 4 | 0 |
| Activities missing vs manifest / spurious | 8 / 31 | 2 / 28 |
| Generate stillNeeded (sum) | 506 | 140 |
| Questions asked (sum) | 66 | 43 |
| Electives created from file (F6, e.g. s14) | 0 / 1 | 0 / 1 (fix in open PR #929) |

**Fixed:** F1, F2, F5 and F7, plus most daily and one-off event coverage.

**Still open:**
- F3: trips and subset all-day days.
- F6: electives, in flight in #929.
- F9: weekly events.
- Part of all-day coverage.

**F9 was a harness gap, not a product bug.** s14 "Swim" is the only shortfall: a weekly all-camp event whose name is also an activity. `inferFixedEvents` infers it correctly as a dual-use name and returns it in `ambiguousEvents`. The app turns that into one `name_kind` question (ADR 2026-09-26 OQ3, where unanswered means activity). The harness never passed `ambiguousEvents` to the report, so the question was never asked and could not be answered.

The harness now mirrors ImportScreen. It uses `settleAmbiguousFromCamp` against the camp's records (except on Replace), passes the remaining ambiguous names to the report, and "confirm all" answers `name_kind` with "fixed time". Swim is then 9/9 in Generate and Manual, and weekly is 58/58. With zero answers Swim stays an activity (0/9) by design. Whether a high-confidence, every-group dual-use name should default to an event when unanswered is a product question for the board, not a defect.

**New regressions:** none distinguishable from seed noise (the baseline above was drawn with random seeds, so a per-metric split between product change and noise isn't possible for it). The apparent upticks (s02 and s07 stillNeeded, s05 and s09 questions) are seed noise or a newly imported activity, for example Ropes Course now present on s05 and s14.

## Inferred minimum capped at what the file shows (same day)

Owner question: "why aren't we generating more activities to fill slots?" The harness now records an `underservedDetail` entry per UNDERSERVED finding. Classifying the 140 still-needed sessions (zero answers) by cause:

| Cause | Before | After |
|---|---|---|
| (a) trip, subset day or elective treated as an activity | 18 | 18 |
| (b) span counted per block | 0 | 0 |
| (c) inferred min above what the file shows for the group | 58 | 1 |
| (c) group capacity: the group's mins add up to more than its activity cells | 49 | 10 |
| (d) eligibility or co-scheduling | 15 | 4 |
| **Total** | **140** | **33** |

Cause: `inferActivityRules` set `min_per_week` to the rounded average across groups, so an activity the file shows twice for some groups and once for others got min 2 everywhere. The min is now capped at the lowest per-group weekly count (`seenCounts.activityGroupCounts`, span cells scaled to runs). The capacity and eligibility counts fell as a knock-on effect of the smaller mins.

## Fill-again invariants (same day)

Owner's acceptance criterion: "imagine that a camp imports a schedule - all things have been filled in. it would be reasonable to assume that when we generate it should be again". Last year's file is a feasible week, so two invariants are now hard, CI-failing assertions in the harness. Both run with zero answers and with every card confirmed.

1. **Inference is faithful.** Every rule read from the file admits the file. For each group, the week's session count (a printed span counts once per run) lies within `[min_per_week, max_per_week]`. A group the file shows doing an activity is eligible for it, and each group's minimums fit in the cells the file gives it activities. Planted defects must be reported: Music's min raised to 9 (belowMin), its max lowered to 1 (aboveMax), its eligibility narrowed to one group (ineligible). A min-0 activity is still checked for eligibility and max. The harness copies ImportScreen's plan assembly by hand, so it does not cover the accepted-trip rule recompute, the director's rule edits, or the trip review; its header says so.
2. **Generate fills the week again.** Nothing is left short (`stillNeeded` 0) and no cell is left empty (`unfillable` 0).

**The owner's camp (campB) and seven variants built from it** (`synthetic/campb-variants.mjs`: renamed groups, 8 and 24 groups, times +30 min, 4-day and 6-day weeks, an Aquarium Trip and a Games Day for some groups):

| File | Rule violations | Still needed | Empty cells |
|---|---|---|---|
| campB (the owner's file) | 0 | 0 | 0 |
| b1-renamed | 0 | 0 | 0 |
| b2-8-groups | 0 | 0 | 0 |
| b3-24-groups | 0 | 0 | 0 |
| b4-times-plus-30 | 0 | 0 | 0 |
| b5-4-day | 0 | 0 | 0 |
| b6-6-day | 0 | 0 | 0 |
| b7-trip-and-games-day | 0 | 0 | 0 |

Each row has the same result with zero answers and with every card confirmed. Before this change, campB had 5 rule violations (Music and FBBG shown 4–5 times a week against an inferred max of 3).

**Synthetic corpus:** still needed fell from 140 to 33 (the first fix above) and then to 8. The 8 are all s04's Games Day, which runs a whole day for 8 groups. A whole-day item for some groups is read as an event only when the camp has a schedule week to bind it to (`src/ingest/tripEvents.js`), and a camp's first import has none. So the name becomes a 9-block activity with no room around the inferred daily fixed events. **So the owner's goal is not yet met for a whole-day item for some groups on a camp's first import.** The fix (bind trips to the Week 1 the import creates, with the commit creating that week first, amending the trips ADR) is ruled and routed to the trips seam. It is tracked as `KNOWN_FAILING`, which fails CI the day it is fixed.

What changed to get there:

| Seam | Fix |
|---|---|
| Inference (`activityRules.js`) | min ≤ the lowest per-group weekly count. A split cell ("Volleyball - Yoga") counts as a share of a session, so a group that only ever got part of one requires none. max ≥ the busiest group's week. An eligibility fallback that opens an activity to groups the file never shows doing it makes the min 0. |
| Import (`extractEntities.js`, `fieldUpdate.js`, `buildPlan.js`, `ImportScreen.jsx`, `ops/ingest.js`) | Per-group weekly counts are recorded. A file-shown 0 (`min_from_file`) passes through, and the commit keeps it instead of applying the T61 floor of 1. |
| Engine (`buildSchedule.js`) | Two repair passes after the greedy rounds and the existing `repair()`. `minRepair` raises a short (group, activity) by an ejection chain: lift what is in its cells, re-place anything that leaves short, or move another group's session of a capped activity. `fillRepair` fills an empty cell by moving the one session blocking it (same day, weekly max, or capacity), then fills the cell that move vacated. Both are journaled and roll back whole, and both are bounded per item and per week. |

Engine evidence: a property test builds 1,000 seeded weeks from a known-feasible schedule and reads the rules off it the way import does. Without the repairs, 462 of the 1,000 leave something short or empty; with them, none do. A wider sweep of 5,000 weeks, run once and not committed, leaves 2 weeks short (bounded search, not an exact solver). The existing 480-cell infeasible-week CPU budget (3 s) still holds.

## Not covered by this run

- XLSX merges (`blockSpans`) and any non-text input, so real merged-cell spans are untested; the text forms in this corpus are the closest a text grid can express.
- ImportScreen's name-variant, compound-cell and location-binding steps.
- Elective offerings for header-word electives (listed only in the manifest; they come from a separate electives file in the product).
- A UI check: nothing here renders a screen.

## Existing test coverage

`electron/ingestPassExclusivity.allSamples.integration.test.js` globs `docs/work/specs/samples/*.txt` non-recursively and was left untouched. It should also cover `synthetic/`: the exclusivity invariant held on all 15 here, so adding the glob (including subdirectories, excluding `repro/` and `special-days/`) would cost little and keep new synthetic camps under the same guard. This harness already asserts that invariant on all 15 in both runs, so the gap is currently closed by this file rather than by that one.
