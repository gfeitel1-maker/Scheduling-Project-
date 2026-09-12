---
title: T143-swim-return-never-paired-as-multiblock
document_type: ticket
status: done
created: 2026-09-11
task_class: ingestion
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-24-merged-cell-multiblock-ingest.md]
archive_when: Swim + Swim Return from Schedule by Group.xlsx is proposed as one multi-block occurrence rather than two activities
---

# T143 — Swim / Swim Return is two activities, not one two-block session

**Raised:** 2026-09-11, alongside T141, from `Schedule by Group.xlsx`.

In all 14 sheets, `Swim Return` occupies the block immediately after `Swim` and
never occurs independently. It is the travel half of one two-block swim session
— the exact shape `src/ingest/multiBlockCandidates.js` exists to propose, and
the engine already models (a multi-block activity counts as ONE session toward
`min_per_week`).

Today both land in the catalogue as separate activities, so a swim reads as two
sessions and the return block is schedulable on its own.

## RESOLVED 2026-09-11

Built as a second detector inside `inferMultiBlockCandidates`, feeding the same
candidate stream as the merged-cell walk. B is the TAIL of A iff, across the
whole file: (1) B never occupies a block A does not immediately precede;
(2) B occurs at least twice; (3) A is followed by B in >= 2/3 of A's
occurrences; (4) B's name CONTINUES A's ("Swim" -> "Swim Return").

Clauses (3) and (4) were both forced by measurement, not foreseen:

- (3) rejects **Lunch 1 + Menucha**. Menucha always sits right after Lunch 1 and
  never stands alone, so (1)+(2) alone welded them. Lunch 1 runs five days and
  is followed by Menucha in only 6 of 25 occurrences.
- (4) rejects three more that a purely structural rule welded on the real file:
  **Group Time + Mifkad** (two separate daily anchors that simply always run in
  that order, all groups, all days), **CIT Block 1 + CIT Block 2** (a numbered
  chain), and **Ruach + Shabbat** (two distinct all-camp Friday events). Rigid
  sequence is not the same relation as "second half of one session", and
  nothing in the grid's shape separates them — only the name does.

Measured on `Schedule by Group.xlsx`, final output is exactly three candidates
and nothing else:

    Swim + Swim Return @ 01:40-02:20  Wednesday  7 groups
    Swim + Swim Return @ 12:10-12:50  Monday     5 groups
    Swim + Swim Return @ 12:55-01:35  Monday     5 groups

One per (start_block, group-set), which is correct: Swim sits at a different
block per age division. The Wednesday candidate covers 7 groups rather than 8
because Alufim 2's Wednesday cell reads `Swim Returning` — the typo T142's
sibling gate already flags, correctly excluded here rather than silently folded.

Known cost, accepted: a tail named for something other than its head (a camp
writing "Swim" -> "Towel Time") gets no candidate. That is the right trade —
this detector INFERS a pairing the camp never marked up, unlike the merged-cell
walk where the camp explicitly merged the cells and over-inclusion is cheap. A
wrong weld silently turns two sessions into one.

## Why it was not caught

Swim is not block-invariant per group (Yeladim 1: 12:10 Monday, 01:40
Wednesday), so it is correctly not an anchor and is correctly dropped by
`fixedEvents.js:211` — and T141's group-coverage arm deliberately does not
rescue it either. The pairing therefore has to come from
`multiBlockCandidates`, on the activity path, not the fixed-event path.

Worth checking first whether `multiBlockCandidates` only considers *merged*
cells (per the ADR title) and so structurally cannot see two adjacent
distinctly-named cells. If so this is a new detector, not a threshold fix:

> B follows A in the next block, in every (group, day) where A occurs, and B
> never occurs without A immediately preceding it.

The near-duplicate warning already fires correctly on `Swim Returning`
(Alufim 2, Wednesday) — that gate is healthy and is not this ticket.
