---
title: "A whole day for some groups is an event, never a catalog activity"
document_type: ticket
status: completed
created: 2026-10-13
task_class: test-infrastructure
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T378-generate-refills-a-fitting-week-with-spans-on-every-seed.md]
archive_when: "the synthetic harness imports trips and whole days for some groups the way ImportScreen does, asserts no all-day manifest item becomes a catalog activity, and s04 fills on every seed"
---

# T379: s04's Games Day is an event, and the week fills on every seed

Raised during T378's follow-up. s04-by-day-6day-large came out of Generate with 8 groups short on every
seed (400 short over 50 seeds), because "Games Day" (a whole Friday for the 8 Otters and Herons groups)
was an activity spanning all 9 blocks with a weekly minimum, which Friday's fixed events left no room for.
The board keeper put it in v1: a day-long item for some groups is a whole-day event or trip, never a catalog
activity with a weekly minimum.

## Finding

The product classifier already gets this right. `detectTripsAndSpecialDays` returns Games Day as a
`subset-day` (8 groups, whole day, cue "day", default answer `event`, high confidence), and ImportScreen
plans it against the Week 1 a fresh camp's import creates (`weeksForImport`), so it lands as a week-bound
recurring event for those groups and its cells leave activity inference.

The defect was in the synthetic harness glue (`electron/syntheticCamps.harness.integration.test.js`
`importFile`), which skipped the trip path. Every subset whole day in the corpus became an activity there:
s04, s08, s12 and s13. s04's two fill-again invariants were listed as known failing for that reason.

## Change

`importFile` now plans trips and whole days as ImportScreen does, with the same product functions
(`detectTripsAndSpecialDays`, `planTripEvents`, `planWholeCampDays`, `applyTripClaims`, `weeksForImport`),
at the detector's default answers: claimed cells leave fixed-event and activity inference, a fully claimed
name carries no rule, and a partly claimed name's rule is recomputed from its other cells.

The harness also ran Generate with no week, so a week-bound trip event was filtered out and its day filled
with ordinary activities: a fill check could pass with the event missing (Red Hat). `scheduleInput` now
passes the camp's one week, as the schedule screen generates for a week.

New invariants: no trip or whole-day manifest item becomes a catalog activity (every corpus camp, zero
answers and confirm all); s04 has nothing still needed and nothing unfillable on seeds 0-49, with Games Day
asserted as an event whose one activity row is its pinned marker, and filling every Friday cell of its 8
groups in Generate. Turning the trip path off turns the s04 test red. s04 leaves the known-failing list.
Full harness file: 359 passed, 1 skipped.

A manifest whole-day item is assumed to be printed only on its own day; one also printed on other days would
be partly claimed and keep a catalog activity, and the invariant would then need to allow it.

## Remaining

With several schedule weeks and none open, `planTripEvents` leaves a trip pending and its cells import as
they did before, so a whole day for some groups can still become an activity on a re-import into a
multi-week camp. That is a product decision (which week to bind to) and is not changed here.
