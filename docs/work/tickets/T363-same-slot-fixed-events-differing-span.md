---
title: T363-same-slot-fixed-events-differing-span
document_type: ticket
status: completed
created: 2026-10-11
task_class: architecture
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md, docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md]
archive_when: two same-name, same-day, same-block fixed events that differ in span both import and both place in Generate, with a red-first test and an ADR amendment recording the new slot key
---

# T363: same-slot fixed events that differ in span

## Problem

A camp file can show the same event at the same block on the same day for two group sets that hold it for
different lengths. For example, Lunch runs one block for the younger groups and two blocks for the older
groups.

Fixed events are keyed by name, day and block. Scope is deliberately not part of the key (ADR 2026-08-09
§1), so a director who narrows a live row's groups does not get a duplicate on the next Keep re-import.
Span is not in the key either. One slot can therefore hold only one row. When two events share a slot,
their group sets are unioned into that row (PR #905).

That union is only correct when the spans match. When they differ, the second event cannot be stored. PR
#905 reports it in `fixedEvents.partial` ("…different length…") instead of dropping it silently. That
group set still loses the event, in import and in Generate.

## Proposed direction

Amend ADR 2026-08-09 §1 so the slot key is name, day, block and span. Two rows with different spans can
then coexist at one slot. Each row keeps the existing scope-blind behaviour for the director's own scope
edits.

Check before building:

- recognition on re-import (Keep writes 0 new records);
- the rejected-slot tombstones;
- the Replace pre-pass;
- scope drift;
- the open-decision ids;
- whether the engine handles two same-name rows at one block for disjoint groups.

## Ruling

The keeper ruled on 2026-10-11 to ticket this rather than fix it now. Reporting it in
`fixedEvents.partial` is acceptable until then.

## Evidence

- PR #905 (F1 from `docs/work/evidence/2026-10-11-synthetic-15-scorecard.md`): the span-differing case is
  skipped and reported.
- The test is "spans differ" in `electron/ops/ingest.sameSlotTwoScopes.test.js`.

## Resolution (2026-10-11)

Matching stays on the span-blind place key (`fixedEventPlaceKey` in `electron/ops/ingest.js`; ADR 2026-08-09
amended). A place splits into one row per span only when the incoming file holds two or more spans there with
pairwise-disjoint group scopes; each span row then matches a live row at that place with the same span.
Every other case is one row per place with scopes unioned, and an event at a different span for overlapping
groups is reported in `fixedEvents.partial`, never double-covered. A tombstone at the place suppresses
re-import whatever the span; a hand-edited span plus a Keep re-import of the original file creates no
duplicate. Replace restores a preserved division scope (span-aware only for a split place). Engine: when two
rows cover one group at one head block, `buildSchedule.js` picks the larger span (ties: smaller id) and raises
`FIXED_EVENT_OVERLAP`. Tests: `electron/ops/ingest.sameSlotTwoScopes.test.js`,
`src/engine/buildSchedule.sameSlotSpans.test.js`. Not covered: the review-screen match key
(`fixedEventMatchKey`, name + block + days) is still span-blind; the mock (`src/localClient.mock.js`) has no
slot recognition or union, so no mirror was needed.
