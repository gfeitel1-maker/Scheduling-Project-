---
title: "Generate fills a fitting week with a double period again on every seed"
document_type: ticket
status: completed
created: 2026-10-13
task_class: scheduling-engine
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: []
archive_when: "the synthetic harness asserts the r9 double-period week comes out of Generate with nothing still needed and nothing unfillable on all 200 seeds, and campB plus the synthetic camps are no worse"
---

# T378: a span in the wrong place no longer leaves a fitting week short

Found by final-audit step 11 on 18524ad5 ("Generated 32/32, 1 still needed" on the r9 double-period camp).
The board keeper put it in v1 under the owner's standing rule: when an imported file shows the week fits,
Generate fills it again.

## Problem

Generate's choices come from a PRNG seeded by the camp id, and every audit run makes a new camp. On r9
(`docs/work/specs/samples/synthetic/repro/r9-double-period-elective.txt`), seeds `seed-0`..`seed-199` left
an Otters group's Archery or Music minimum short on 136 of 200 seeds (90 with one item short, 46 with two),
and the split was identical before #984, #994, #995 and #997, so this was not a regression. The file shows
the week fits: each Otters group's minimums take 7 of its 8 cells, with "Pottery / Drama" as a two-block span.

Spans are placed first, but the minimum repair (`raise` in `src/engine/buildSchedule.js`) could lift only
single-block sessions. A span that took the pair of blocks a minimum needed could never move.

## Change

When the existing chain fails to raise a short (group, activity), a second attempt may lift a whole placed
span in the way (never a pre-placed one) and place it again through the same chain, refilling any cell the
lift left empty. Every step is journaled and a chain that does not end with nothing newly short and nothing
newly empty is rolled back. The first attempt is unchanged, so every week that came out clean before comes
out the same. There is no `rand()`, so the same input still gives the same week, and a span still counts as
one session.

## Evidence

Sweep of 50 seeds per camp, zero-answer import (still needed / unfillable / clean seeds):

| Camp | Before | After |
|---|---|---|
| r9 | 49 / 0 / 15 | 0 / 0 / 50 |
| s12-daysheet-4d-late | 2 / 0 / 48 | 0 / 0 / 50 |
| s02-by-day-three-waves | 61 / 0 / 11 | 50 / 0 / 13 |
| s04-by-day-6day-large | 400 / 0 / 0 | 400 / 0 / 0 |
| s06-by-day-40-groups-late | 2 / 0 / 48 | 2 / 0 / 48 |
| campB, its seven variants, and the other synthetic camps | 0 / 0 / 50 | 0 / 0 / 50 |

## Remaining

s02, s04 and s06 still leave items short on some seeds. Whether their files show those weeks fit has not
been checked; that is the next question before treating them as the same defect.
