---
title: "Arbitrary-length activity span — extend a period across N blocks"
document_type: spec
status: draft
created: 2026-08-21
governing_docs: [docs/governance/constitution/CONSTITUTION.md]
related_adrs: [docs/adr/2026-08-21-arbitrary-length-activity-span.md]
archive_when: arbitrary-length spans are live on both routes with the drag-to-extend and interior-split UI delivered
---

# Spec: Arbitrary-length activity span (extend a period across N blocks)

Status: scope-confirmed, ADR accepted, write-path implemented; UI-interaction layer + repair-pass wiring pending
Owner-flagged: LATER (not urgent)

## Problem (owner's words)

> "the merge functionality is cute but it isn't what I wanted because it only
> lets someone block 1 extra period whereas from Excel I could do as many or
> as few as I wanted."

Today the manual-route merge (`expandSlot`) caps a span at head + one adjacent
tail block = 2 blocks max. From Excel the director could span any number.

## Confirmed scope (owner, 2026-08-21)

1. **What it is:** ONE activity spanning N consecutive periods, rendered as a
   single merged cell. (Not "hold N periods empty" — a genuine multi-block
   session, like a triple-length swim counted as one session.)
2. **How length is set:** drag-to-extend — grab a cell edge and drag across as
   many periods as wanted; length = what you drag over. Matches current feel.
3. **Day-part boundaries:** a span MAY cross a day-part boundary (e.g. morning
   into afternoon across lunch) if the director drags it there. ADR to define
   the exact rule and edge cases.
4. **Routes:** BOTH manual and generated (the engine already supports arbitrary
   `span_blocks` with no ceiling; the generated route's editing UI needs it too).

## Engine already supports this (verified 2026-08-21)

`src/engine/buildSchedule.js` loops `for (i=1; i<spanCount; i++)` over
`act.span_blocks` with no ceiling. `span_blocks INTEGER` stored freely in
schema. A multi-block activity counts as ONE session toward `min_per_week` /
`prefer_before_day`.

## The cap (verified against tree 2026-08-21)

- `expandSlot(groupId, dayId, headBlockId, tailBlockId, tailActivityId, ...)` in
  `src/screens/schedule/useSlotMutations.js:842` — single head + single tail.
  Writes `flags.expanded` on head (with ONE `from_block`, one displaced
  activity) and `is_span_head=false` on the one tail.
- Wired in `src/screens/ScheduleScreen.jsx` (~294, 1207, 1243) and
  `src/screens/schedule/dragHandlers.js`.
- Tests: `src/screens/schedule/useSlotMutations.test.js`.

## Why this needs an ADR + Red Hat (not a quick edit)

Changes stored slot shape and how many op-log rows a span writes, plus the
swap/split/overlap interactions around a multi-tail span. Precedent: span-tail
release (T91) had a HIGH write-race caught by Red Hat; per-cell WRITE QUEUE
already exists. Precedent ADRs:
`docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md` and the span-tail
work.

## Open design questions for the ADR

- **Stored shape:** does `flags.expanded` grow to a list of tails, or do we move
  to `is_span_head` + `is_span_tail`/`span_head_id` back-pointers on each covered
  slot? Which survives replay/conflict best?
- **Op-log write count:** N-block span = N slot writes in one gesture. How does
  the per-cell WRITE QUEUE + gestureId claim cover N cells atomically? Undo shape.
- **Boundary crossing:** what counts as "consecutive" across a day-part boundary;
  what stops a drag (day end, existing locked/released slot, week exclusion).
- **Split/swap/overlap semantics** on a span of length > 2 (release a middle
  tail? swap a spanned head? OVERLAP derivation on manual route).
- **Generated route parity:** UNFILLABLE flag interaction; editing a
  generated-route span vs manual.
