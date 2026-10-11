---
title: "F3/F4 slice 1: trip and special-day detector on the synthetic corpus"
document_type: evidence
status: active
created: 2026-10-11
date: 2026-10-11
task_class: ingestion
related_tickets: []
related_specs: [docs/adr/2026-10-11-import-special-days-and-field-trips.md]
archive_when: slice 2 of docs/adr/2026-10-11-import-special-days-and-field-trips.md wires the detector into the import and a real camp file has been measured
---

# Slice 1: trip and special-day detector

Module: `src/ingest/tripDetection.js` (`detectTripsAndSpecialDays`), pure and not wired into the import.
Pins: `src/ingest/tripDetection.test.js` (33 tests). Deterministic evidence: test runs only; no build, no full
gate.

## Red before green

- Detector stubbed to return `[]`: 31 of 33 failed. The two that passed are the rotation negative (absence is
  its pass condition) and the cue-word unit test.
- Plant to make the rotation negative bite: deleting the "one day only unless cued" rule failed 5 tests (the
  rotation negative plus the s04, s08, s09 and s13 per-row pins, which then pick up catalogue runs).
- Real detector: 33 of 33 pass. `src/ingest/textSpans.f5.test.js` and `src/ingest/fixedEvents.catalogueSpan.test.js`
  still pass after `groupDaySequences` was exported from `src/ingest/textSpans.js`.

## Corpus results (15 synthetic camps, plus campB)

| | Count |
|---|---|
| Manifest trips | 13 |
| Manifest all-day days | 10 (5 for the whole camp, 5 for a subset; s09's is 20 of 21 groups) |
| Detected with matching name, day, groups and block count | 23 of 23 |
| Default `event` | 18 (13 trips, 5 subset days) |
| No default (whole-camp, explicit answer only) | 5 |
| Shown with default `activity` (uncued one-day runs) | 9, all of them manifest catalogue spans |
| Catalogue spans the generator printed | 20; the other 11 run on more than one day and are filtered out as rotations |
| campB, unmodified | 0 detections |
| campB with a trip planted and one group's cell changed | exactly 1 new detection, without the changed group |

## Lexical-cue coverage

- Corpus trips and all-day days that carry a cue word (trip, field, outing, excursion, day): **23 of 23 (100%)**.
- Uncued one-day runs: 9, all catalogue spans, all defaulted to activity. No uncued run defaulted to event
  except through whole-day coverage, and none of those exist on the corpus.
- **The 100% tells us nothing about real camps.** The generator picked every trip name (Aquarium Trip, Farm
  Trip, Museum Trip, Games Day, Color War Day), so every one has a cue by construction. This is the residual
  the ADR records under "Challenges considered" 4. A real camp file is needed to measure it; until then a trip
  named without a cue word (for example "Camden Adventure") will be shown with default activity.

## Not covered

- A one-block event such as s04's "Trip Day" is not a detection, because the rule needs at least 2 blocks. It
  stays with the existing fixed-event inference.
- Whole-camp days broken by a printed Lunch come out as one `all-camp-day` detection per run. Slice 3b must
  merge these into one special day.
- The corpus has no blank-form trip, so the blank-continuation path is reached only through `inferTextSpans`
  and has no pin of its own here.
