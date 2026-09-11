---
title: T140-one-block-holds-two-periods
document_type: ticket
status: open
created: 2026-09-11
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
archive_when: a blank-line block containing two periods yields two rows, and campA's ranged-period ratio does not fall
---

# T140 — One blank-line block can hold two periods, and they merge

**Raised:** 2026-09-11, from the fresh-eyes end-to-end walkthrough. Reachable
TODAY on the labelled path, on `docs/work/specs/samples/campA-bunk-schedules.txt`.
Not covered by T36, which is about the *unlabeled* path and states its residuals
are unreachable on the current corpus.

## What happens

`parseTextGrid` delimits rows by blank lines, which is correct — Camp A wraps a
period label around its own data row, so line-by-line reading produced periods
running backwards. What a blank-line block does not handle is a block holding
TWO periods with no blank line between them, which Camp A does twice.

`normalizeTimeLabel` then takes the first two times in the joined label, so
every row in the block inherits the FIRST period's name. Measured on page 1:

    row 0: "9:15-9:40"   cells: "Drama", "Dance", "Opening Music"
    rows 2-10: all "11:10-11:45"

Row 0 is the 9:50-10:25 period's activities filed under the 9:15 period's name,
with "Opening" welded onto "Music" across the boundary. The 9:50-10:25 and
11:50-12:25 periods do not exist in the output at all. Nine rows claim one
period. This is a significant part of where campA's **109 "activities"** come
from — many are welded fragments.

## The fix, which was built and measured and then NOT shipped

A pre-pass over each blank-line block, splitting it into one block per period,
feeding the existing per-block logic unchanged:

> A new period starts at a line whose TIME COLUMN carries another time, once the
> period being accumulated already has a complete label (two times) and has seen
> at least one line of data.

Both conditions matter. Without the label test, the second half of a wrapped
label ("10:25  1") starts a period of its own — the bug blank-line blocks exist
to fix. Without the data test, a label spread over three lines fragments.

**Measured with it wired in:**

| | before | after |
|---|---|---|
| campA page-1 rows | 11, mislabelled | 16, each correctly labelled |
| campA activities | 109 | **64** |
| 9:50-10:25, 11:50-12:25 | absent | recovered |
| campA ranged-period ratio | 69% | **58%** |
| campB | 100% | 100% (unchanged) |

## Why it is not shipped

That last row. Splitting produces more periods overall — more correct ones AND
more one-ended fragments on the backcountry/specialist pages (15-18), which use
a third wrap shape where a blank line lands inside the label. The ratio fell
below the 60% floor `extractEntities.test.js` enforces ("gives every period a
start and an end where the source had one"), and that test is measuring
something real.

Shipping a change that halves the phantom activities while degrading a stated
quality metric is a trade someone should make deliberately, not one to slip in.

## What IS shipped

The orphan-tail merge, which is the same family and is a clean win on its own:
a label-only block carrying a single time, following a row whose label is still
missing its end, is that row's tail rather than an empty period. campC went 60%
-> 75% ranged and 10 -> 8 blocks; campB and campA are unchanged.

## Definition of done

- A blank-line block containing two periods yields two rows with their own labels.
- campA's ranged ratio does NOT fall below its current 69%; the fragments on
  pages 15-18 need handling in the same change, not afterwards.
- campB stays at 100% and campC does not regress.
