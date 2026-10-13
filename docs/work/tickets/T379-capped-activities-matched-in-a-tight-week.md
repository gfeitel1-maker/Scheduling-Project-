---
title: "Capped activities are matched slot by slot when a week is tight, so Generate fills a fitting week on every seed"
document_type: ticket
status: completed
created: 2026-10-13
task_class: scheduling-engine
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T378-generate-refills-a-fitting-week-with-spans-on-every-seed.md]
archive_when: "the synthetic harness asserts, for every camp whose inferred rules admit its own file, that Generate leaves nothing still needed and nothing unfillable on every seed of its sweep, and campB plus the synthetic camps are no worse"
---

# T379: a week the file shows fits is filled on every seed, capped activities included

Owner rule: when an imported file shows the week fits, Generate fills it again, on every seed.

## Problem

After T378, s02 and s06 still came out short on some seeds although both satisfy their own inferred rules
(0 faithfulness violations). The short items were activities capped to 1 or 2 groups at once (s02: nearly
all 26 of its activities, max_groups_per_slot 1 with 11 eligible groups; s06: Puppetry, Climbing Wall). s02's
weeks are exact: every group's cells equal the sessions it is owed, and each slot needs a different activity
for each group. That is a Latin-square problem the greedy rounds (cell by cell, then a depth-limited
ejection chain) solve only by luck, and a deeper chain only made it worse.

## What changed (`src/engine/buildSchedule.js`)

`placeScarceSessions` runs once, in the high round, right after the high-priority spans are placed and
before the greedy singles:

- Scarce: a single-block activity with `min_per_week > 0` and `0 < max_groups_per_slot < the number of groups
  it serves`. The cap, not the group count, is then what limits the week.
- It runs only in a tight week: some group has no spare cell (free cells minus the cells its owed sessions
  need, spans counted by length). With a spare cell everywhere the greedy rounds and repair absorb a bad draw
  (every such camp in the corpus was clean on 50 seeds before this change), and those builds are unchanged.
- Low-priority spans are placed first as well (only when it runs), because the matching spends the free runs
  a span needs; without that s06 went from 2 to 10 short seeds.
- Then, for each slot (day, block) in time order: a bipartite matching of the slot's free groups to the
  scarce activities they still owe, each activity taking at most its remaining capacity there. Kuhn
  augmenting paths, groups offered most-pressed first (fewest spare cells), each group's candidates tried
  most-urgent first (sessions owed over capacity left in the week), `prefer_before_day` as the first sort key
  (soft). A match lowers a group's spare cells and owed sessions by one, so it never makes the group's
  other sessions impossible by count.
- Everything the matching leaves goes to the existing greedy rounds, repair, `minRepair` and `fillRepair`,
  untouched.

A per-activity maximum flow was tried first and failed (s02 worse, 137 short): capped activities compete for
the same group cells, which no activity-at-a-time flow can see. Spans keep spans-first (+ T378 repair): a span
needs a free run over several slots, which a slot-by-slot matching cannot express.

Determinism: ties are broken by a stream seeded from `djb2(campId + cohort + '|match')`, separate from the
main PRNG, so no existing draw moves (`buildScheduleDeterminism.pin.test.js` is untouched); identical inputs
give identical output.

## Tests

- `src/engine/buildSchedule.capacityMatching.test.js` (new): 8 groups x 8 cells x 8 one-per-slot activities,
  seeds 0..99 (main: 12 seeds short), determinism, a locked cell never moves, a double-block span stays one
  contiguous session.
- `electron/syntheticCamps.harness.integration.test.js`: a seed sweep (`SYNTHETIC_SEEDS`, default 25) in both
  scenarios for every synthetic camp and campB with its variants. Invariant: when the camp's inferred rules
  admit its own file (faithfulness 0 violations), Generate leaves 0 still needed and 0 unfillable on every
  seed. s04 is listed in `KNOWN_FAILING` for the same whole-day reason as its single-seed fill invariants.

## Evidence

Sweep of 50 seeds per camp (camps with any short seed; the rest are 0 on both sides). Both import scenarios
gave identical numbers.

| Camp | Short seeds before -> after | Still needed | Unfillable | Findings |
|---|---|---|---|---|
| s02-by-day-three-waves | 37 -> 0 | 50 -> 0 | 0 -> 0 | 50 -> 0 |
| s06-by-day-40-groups-late | 2 -> 0 | 2 -> 0 | 0 -> 0 | 2 -> 0 |
| s04-by-day-6day-large (whole-day-for-some, known) | 50 -> 50 | 400 -> 400 | 0 -> 0 | 400 -> 400 |
| campB, its 7 variants, 12 other synthetic camps | 0 -> 0 | 0 | 0 | 0 |

CPU per build (`process.cpuUsage`, old and new interleaved, 12 seeds x 3 repetitions, zero-answer import):
s02 139 -> 26 ms, s06 306 -> 106 ms, s12 67 -> 19 ms, s15 179 -> 48 ms (the repair no longer burns its budget);
campB 33 -> 31, b3 58 -> 60, s04 280 -> 277, s13 118 -> 124, s09 61 -> 63, every other camp within 1-2 ms
(not tight, so unchanged).
