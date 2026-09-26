---
title: "Elective preferences are per (day, period) cell, and placement is two-phase"
document_type: adr
status: accepted
authority: normative
implementation_state: not-started
date: 2026-09-26
approved: 2026-09-26 (owner — preference shape corrected against a real artifact; cancellation order ruled)
task_class: scheduling-engine
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
related_adrs:
  - docs/adr/2026-09-17-individual-elective-scheduling.md
  - docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md
---

# Elective preferences are per (day, period) cell, and placement is two-phase

## Status of what this replaces

This supersedes the **global ranked list** premise that `src/engine/buildElectiveAssignments.js`
is built on. That file's header currently states:

> *"Preferences are ranked GLOBALLY: a camper ranks each elective once for the session, not once per
> slot (ADR D14, after real camp artifacts contradicted the per-occurrence premise)."*

**D14 did not establish that.** It withdrew the *previous* model and said so in terms that were
deliberately careful:

> *"strong enough to **retire** the ranked-per-occurrence premise, and **not** strong enough to
> establish any replacement premise. No design should treat either observed format as confirmed
> input."*

D14 was right to refuse, and it is sharper than an overread. **D14 observed BOTH formats and
established neither.** It recorded a single globally ranked list *and*, in its own words, *"a
chosen-schedule-plus-alternates planner — a camper fills in one activity per open cell of a day ×
period grid."* The engine adopted the first as settled and cited D14 as its authority. The owner's
2026-09-26 artifact is **the second format, which D14 already had in hand.**

So the failure is not a missing observation. It is a *withdrawal* being read as an *affirmation* of
whichever candidate was listed first, when the document explicitly declined to choose between them.
(Credit: this framing was corrected by the peer session working the ingest ADR, 2026-09-26.)

## The evidence

A real artifact, supplied by the owner 2026-09-26: **JCC Camps at Medford, GILAD (grade 5), 2024
Activity Selection Sheet.** A real camp, a real season, a real blank form of the kind this app must
ingest. It is **not committed to this repository and must not be** — only its structure is described
below, in the same discipline D14 used.

What it shows:

1. **A day × period grid, and every selectable cell carries its own distinct offering list.** The
   lists are not the same from cell to cell and are not the same size — one Monday afternoon cell
   offers roughly 27 activities, the corresponding Friday cell roughly 9.
2. **A camper selects within a cell.** The sheet's instructions address the reader cell by cell.
3. **Most activities recur across many cells.** Archery appears in roughly 15 of the 18 selectable
   cells. This is what makes the global model not merely different but **unreadable** on this form:
   "Archery, rank 1" does not identify an occurrence, and no rule recovers which one was meant.
4. **Not every period is selectable.** Period 1 (Instructional Swim), period 4 (Free Swim) and
   period 5 (Lunch) are fixed across the week; one period-2 cell is "Bunk Unity — no selection
   needed"; the Friday period-2 cell is Shabbat. **18 of 35 cells take a selection.**
5. **Linkage is declared on the catalog, by glyph, exactly as D14 inferred.** A double period is
   marked with a down-arrow in the earlier cell and an up-arrow in the later one on the same
   activity; multi-day activities carry their own marks; the sheet's header tells the reader to
   watch for both.

Point 5 is the one part of the existing model this artifact **confirms**. D12's parent/member shape
and D14's "linkage is a catalog property, not a camper expression" both stand.

## Decision 1 — a preference names the cell it applies to

A preference is `(camper, occurrence, activity, rank)`, not `(camper, activity, rank)`. Ranks are
scoped **within** a cell: a camper's rank 1 in Monday period 3 and their rank 1 in Monday period 6
are two independent first choices, not a contradiction.

**How many ranks per cell is a per-camp setting, not a constant.** The artifact does not fix a
number — it has no numbered blanks — and cells vary from ~9 to ~27 options, so a hardcoded 3 would be
wrong at both ends. Do not bake in an N.

**Consequences to carry, not to discover later:**

- **The repeat question dissolves.** A camper may choose the same activity in several cells, or
  different activities in each. It is now *expressed*, not inferred. The owner ruling of 2026-09-18
  ("repeats are normal, a camper swims twice a week") stands and is unaffected — what changes is
  that the camper now says so rather than the engine deducing it.
- **A measurement made under the old model must not be carried forward.** A synthetic fixture built
  on global lists showed ~88% of placements being repeats, and that was diagnosed in-session as the
  cost function summing raw ranks. **Both the figure and the diagnosis are artifacts of the wrong
  data model** — one list answering the same question five times — and are withdrawn here so they are
  not re-derived from the transcript.
- **Not every camper needs a placement in every occurrence.** Fixed and no-selection cells exist. An
  engine that assumes otherwise will manufacture findings for Lunch.

## Decision 2 — placement is two-phase, because a minimum cannot be honoured while placing

A capacity can be enforced during assignment; a **minimum cannot**, because no offering's headcount
is known until everyone is placed. **Owner ruling 2026-09-26:**

1. **Place** every camper from their per-cell preferences.
2. **Validate** each offering against its minimum.
3. **Replace** the campers in any offering that did not meet its minimum, into their next available
   choice in that same cell.

**The loop terminates, and it is worth recording why, because it looks like it might not.** Campers
move only OUT of cancelled offerings and INTO surviving ones, so headcounts are monotonically
non-decreasing. Nothing that already met its minimum can later fall below it. Each round strictly
improves; the loop cannot oscillate.

## Decision 3 — cancel the offering furthest below its minimum first

Cancellation order changes the outcome, so it must be fixed. Two offerings, minimum 6 each: Archery
has 4, Fishing has 5. Cancel Archery first and one of its campers flows into Fishing, which reaches 6
and **runs**. Cancel Fishing first and two of its campers flow into Archery, which reaches 6 and
**runs instead**. Both are legitimate weeks.

**Ruling (owner, 2026-09-26): cancel the offering with the largest shortfall first**, shortfall being
`min_to_run - enrolled`. Ties broken by a stable identifier so runs are reproducible.

Rationale: the furthest-below offering is the least rescuable, so retiring it first releases the most
campers to rescue the offerings that are close. And it is explainable in one sentence to a director,
which is the standard D11 set for this engine — *"Archery had 4 of the 6 it needed, so it came off
first, and those campers moving to Fishing is what let Fishing run."*

**The distinguishing test**, because the obvious wrong implementations pass casual ones: give the two
offerings **different** minimums. Archery 4 of 6 (shortfall 2) against Fishing 3 of 4 (shortfall 1) —
Fishing has fewer campers, but Archery is further below its own minimum, so **Archery** is cancelled
first. An implementation that sorts by enrolled count, or by id, gets this backwards.

## What this does not decide

- **The ingest format.** D14's warning stands in full: the artifact here is a **blank form**, and the
  camp states that final requests are submitted through a third-party portal, so the export this app
  would actually read is still unseen. This ADR fixes the *internal* shape a preference must have. It
  does **not** claim to know the file that will arrive.
- **Fairness across cells.** A camper unlucky in period 3 is still not compensated in period 6.
  Ruling R4 deferred this and it stays deferred.
- **The tier-1 / tier-2 linked-choice split** (T247, ADR 2026-09-23 decision (c)) is untouched. It
  operates on occurrences, which is the axis this ADR *adds* precision to, not one it removes.

## Migration note

`elective_preferences` gains an occurrence dimension, and the existing uniqueness — one rank per
camper per activity — becomes one rank per camper per activity **per occurrence**. Per the memory of
`feedback_relaxing_a_constraint_two_sweeps`, relaxing this needs **two** sweeps: code that resolves a
preference *by* the old key, and code that depends on the old write *failing*. There is no production
camp data (pre-production, `feedback_preproduction_bias_bold`), so a clean cutover is preferred to a
back-compat shim.
