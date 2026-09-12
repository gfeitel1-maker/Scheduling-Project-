---
title: T141-fixed-event-eligibility-ignores-group-coverage
document_type: ticket
status: done
created: 2026-09-11
task_class: ingestion
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-03-ingesting-recurring-fixed-events.md, docs/adr/2026-08-28-fixed-vs-recurring-events.md]
archive_when: All Camp Activity, Shabbat and Ruach are proposed as pinned events scoped to their 13 groups from Schedule by Group.xlsx, and no previously-detected event is lost
---

# T141 — A weekly recurring event is invisible to fixed-event inference

**Raised:** 2026-09-11, from a dev run against the owner's real file
`~/Desktop/camp schedules/Schedule by Group.xlsx` (14 group sheets, days as
columns, 12 blocks). Reproduced headlessly via `npm run ingest:sweep`.

Not a regression. `inferFixedEvents` has never been able to detect this class —
the module was built to recover *daily* anchors and does that correctly. The
gap is that the same module is the only thing standing between a weekly
recurring event and the flat activity catalogue.

## What happens

Measured, real output on that file:

```
entities: groups=14  time_blocks=12  activities=36  tiers=1
fixed events (all-camp): 5  |  recurring (group-scoped): 8
fixed:     Busses, Carpool, Carpool, Group Time, Mifkad
recurring: CIT Block 1/2/3 [1], Lunch 1 [5], Lunch 2 [3], Lunch 2 [2],
           Lunch 3 [3], Menucha [2]
```

The daily anchors are exactly right. What is absent is every event that
recurs on a *fixed subset of weekdays*:

| Label | Block | Days | Groups | Classified as |
|---|---|---|---|---|
| All Camp Activity | 02:25–03:15 | Tue, Thu | **13 of 14** | plain activity |
| Shabbat | 02:25–03:15 | Fri | **13 of 14** | plain activity |
| Ruach | 01:40–02:20 | Fri | **13 of 14** | plain activity |

Each is perfectly invariant: same block, same days, zero exceptions. The one
non-participant is **CIT**, whose 12:55 / 01:40 / 02:25 rows are CIT Block 1/2/3
on all five days — a genuine opt-out, not missing data, which is why the scope
is 13 and not 14. They land in the catalogue beside Clay and Sports, so the
director sees a flat list of 36 "activities" and the engine is free to move
them.

## Cause

``src/ingest/fixedEvents.js:211`` — one line,
applied per `(group, block, activity, period)` tuple before any other
reasoning:

```js
if (occ * 2 <= operating) continue
```

A strict majority of the group's own operating days. Applied to this file:

| Label | occ / operating | test | result |
|---|---|---|---|
| Mifkad | 5 / 5 | 10 > 5 | kept |
| Lunch 1 | 4 / 5 | 8 > 5 | kept |
| All Camp Activity | 2 / 5 | 4 ≤ 5 | **dropped** |
| Shabbat | 1 / 5 | 2 ≤ 5 | **dropped** |
| Ruach | 1 / 5 | 2 ≤ 5 | **dropped** |

The module's own header states the intent — *"activities [that] sit at the SAME
period **every day** for a given group."* It is a daily-anchor detector, and
weekly recurrence is a different shape that no other pass looks for.

## The deeper defect: two of three axes are computed but not used as evidence

A parsed grid gives three independent coordinates per cell — **group**, **day**,
**block**. Fixed-ness is visible on all three. Today:

- **day-coverage** is the sole gate (line 211);
- **block-invariance** is implicit in the tuple key, never tested;
- **group-coverage** is computed at line 307 *after* filtering, and used only to
  label `scope` (`is_all_groups` → `kind: 'fixed'`). It contributes **nothing**
  to whether the event exists at all.

That inverts the information content. Holding an identical block and an
identical day-set across 14 independently-authored sheets is far stronger
evidence of a pinned event than holding a block 3 days out of 5 within one
group. Today the 2-of-5 that is discarded is more certain than some of the
3-of-5 that is kept.

## The rule

Replace the single gate with **two independent arms**. A tuple is eligible if it
clears *either*. Both feed the existing collapse/scope/confidence stage unchanged.

Let `G` = `operatingDays.size` (groups observed in this import).

### Arm 1 — daily anchor (unchanged, line 211)

For `(group, block, activity, period)` with day-set `D` and operating days `O`:

> eligible iff `|D| * 2 > |O|`

Confidence: `high` iff `|D| === |O|`, else `low`. Catches Mifkad, Carpool,
Group Time, Busses, Lunch *n*, CIT Block *n*, Menucha. No behaviour change.

### Arm 2 — weekly recurring event (new)

Operates on the *same* `occupied` map, keyed across groups rather than within one.

For each `(block, activity, period)`, partition the contributing groups by their
exact day-set. For each such bucket with day-set `D` and contributing group set
`S`:

> eligible iff `|S| >= 2` **and** `|S| * 3 >= G * 2`

That is: at least two groups, and at least two-thirds of all observed groups,
hold **the same activity, in the same block, on exactly the same days**.

Confidence: `high` iff `|S| === G`, else `low`.

Rationale for each clause:

- **Same block** — the invariance that distinguishes a pinned event from a
  rotation. Swim is deliberately excluded by this: it sits at 12:10 on Monday
  and 01:40 on Wednesday for Yeladim 1, so it is a rotating activity with a
  pool roster, not an anchor. (Its Swim/Swim Return pairing is T143.)
- **Exact same day-set** — Water Play appears in most groups but on
  group-specific days and blocks, so it forms many small buckets and clears
  nothing. Correct: it is an activity.
- **`|S| >= 2`** — a single group can never mint an all-camp event through
  this arm; that is arm 1's job.
- **two-thirds** — matches the module's stated over-inclusion bias (a wrong
  proposal costs the director an untick; a missing one costs the rebuild this
  feature exists to remove) while degrading gracefully: the `Lunch2` typo
  (T142) drops one group from a bucket, taking 14/14 to 13/14 — still
  eligible, now `confidence: 'low'`, rather than vanishing.

### Deduplication

A tuple eligible under both arms is emitted **once**. Arm 2 contributes only
`(group, block, activity, period)` tuples arm 1 did not already admit.

### Evidence

Each emitted entry carries `basis: 'daily' | 'weekly'` through to `support`, so
the review panel can explain `confidence: 'high'` on an event that holds only
2 of 5 days — the justification is group-coverage, not day-coverage, and the
two must not appear to contradict each other.

### Unchanged by this ticket

`kind` stays scope-derived per
the fixed-vs-recurring ADR (`docs/adr/2026-08-28-fixed-vs-recurring-events.md`)
§1 — **fixed = all-camp, recurring = group-scoped**. All Camp Activity,
Shabbat and Ruach are all-camp and therefore surface as `kind: 'fixed'`. This
ticket changes *eligibility only*, never classification.

## Expected result on the owner's file

| | before | after | measured |
|---|---|---|---|
| fixed (all-camp) | 5 | 5 (unchanged) | 5 |
| recurring (group-scoped) | 8 | **11** (+ All Camp Activity, Shabbat, Ruach) | 11 |
| activities | 36 | 36 names, 3 more of them pin-only | 36, freq spread 13/12 → 11/11 |

All three arrive as `kind: 'recurring'` scoped to their 13 groups, with
`confidence: 'low'` — correct on both counts, since CIT genuinely does not hold
them. An earlier draft of this ticket predicted `fixed` / 14-of-14; that was an
eyeballing error, corrected against the measured run.

No previously-detected event may be lost. That is the load-bearing half of the
acceptance test.

## Spun off, not in scope here

- **T142** — `Lunch 2` fragments into two events (`[3]` + `[2]`) because the
  collapse key at `fixedEvents.js:273` includes `days.join(',')`, so one
  typo'd cell (`Lunch2`, Giborim 1 Wednesday) splits a camp-wide anchor.
- **T143** — `Swim` / `Swim Return` are never paired as a multi-block event.
  `Swim Return` occurs immediately after `Swim` in all 14 sheets and never
  independently, but both halves are dropped by line 211 before
  `multiBlockCandidates` sees them.
