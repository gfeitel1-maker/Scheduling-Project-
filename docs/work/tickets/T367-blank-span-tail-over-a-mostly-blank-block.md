---
title: T367-blank-span-tail-over-a-mostly-blank-block
document_type: ticket
status: completed
created: 2026-10-11
task_class: architecture
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md]
archive_when: a "blank" text-grid span whose tail block is blank for most groups on that day is either imported as one session of N (with a red-first test that also proves a real free period after a shared activity is still not a span) or the owner rules it stays ambiguous and the director is asked
---

# T367: a blank-form span whose tail block is blank for most groups is not detected

## Problem

A text grid prints a merged double period as the name once with the next block blank (the "blank" form in
`src/ingest/textSpans.js`). Three synthetic camps print a span like this and it is not detected:

- s12 Ropes Course: groups 2A to 3B (6 of 10) on Tuesday and Wednesday, 03:50 then blank at 04:40.
- s02 Ropes Course: all 14 groups on Thursday, 01:15 then blank at 02:00.
- s08 Ropes Course: all 12 groups on Tuesday, 10:45 then blank at 11:15.

In each case the tail block is blank in more than half of the (group, day) sequences that have that block on
that day: 6 of 10 on s12, 14 of 14 on s02, 12 of 12 on s08. `inferTextSpans` treats a block like that as a
structural free period (`structurallyFree`), so the activity before it is not read as a span. On s02 and s08
the name is then claimed as an all-camp event too, because every group prints it on the same day and block.
The catalogue-span release in `src/ingest/fixedEvents.js` (F5 follow-up a) only applies to a detected span.

## Why it was not fixed in the F5 follow-up PR

The only signal is the blank tail. A camp-wide free period after a shared activity looks the same: every
group prints one name, then a blank block, then a printed cell. The free-period guard exists to stop exactly
that case from becoming a span, and a wrong span is silent (the engine reserves a block nobody asked for). A
missed span is today's behaviour and is visible.

The cheap fix would be to leave out the blanks that follow the candidate name when counting how free a block
is. That passes s12 but also detects s02 and s08, and it would detect any real free period after an
all-camp activity. That loosens the guard, so it is out of scope for a "cheap and safe" change.

## Proposed direction

Pick one, owner or board keeper to decide:

1. Ask, don't infer. When the tail block is blank for most groups, raise a review question ("Is Ropes Course
   two blocks long?") rather than guessing.
2. Use evidence from other days. Read the block as free only when it is also blank on the group's other days
   (a free period recurs; a span tail is blank only where the span is). s12's 04:40 block has Pottery on
   Thursday. s02's 02:00 block has activities on every other day.

Option 2 is cheaper. It needs a red-first test that a free period printed every day after varying
activities stays not-a-span. It also needs a test that the same shape on one day after one shared activity
is a span.

## Evidence

`docs/work/evidence/2026-10-11-f5-followups.md`; harness `electron/syntheticCamps.harness.integration.test.js`
(`spansDb` for s02, s08 and s12).

## Resolution (2026-10-11)

Option 2 shipped. In `src/ingest/textSpans.js` a block is `structurallyFree` only when it is blank for most
(group, day) sequences AND the group does not print that block on any of its other days, or it does print it elsewhere but is also
blank on a day the candidate span is not the head of (a rotating free period: its blankness is not explained
by the span, so it is free there and no span is inferred). A free period recurs; a span tail is blank only
where the span is. Red-first tests in
`src/ingest/textSpans.f5.test.js` (all-camp shape as s02/s08, partial-group shape as s12; a block blank on
every day after a shared activity stays not-a-span). Not covered: a genuine free period that is printed on
some other day for that group (e.g. a Friday short day that otherwise fills the block) reads as a span tail
if every occurrence of the name is followed by it and the block is blank only after that name; the all-or-nothing per-activity rule still applies.
 Also not covered: two different double activities that share one block pair on different days can read as free periods and miss the span; this fails safe (a blank cell, never a wrong claim).
