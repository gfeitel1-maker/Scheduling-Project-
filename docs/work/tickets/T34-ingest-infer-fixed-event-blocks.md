---
title: T34-ingest-infer-fixed-event-blocks
document_type: ticket
status: open
created: 2026-08-02
task_class: scheduling-engine
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
archive_when: superseded by an approved design + ADR decision on placements-in-ingest
---

# T34 — Ingest should recognise recurring fixed-event blocks per unit/group

**Raised:** 2026-08-02, product owner — "it is not calculating or picking up fixed event blocks for a
unit or for a group — i.e. lunch for two groups is always X period every day."

## The intent

A schedule grid encodes more than a list of activities: some activities sit at the **same period
every day for a given group/unit** — lunch, swim, carpool, a staggered `Lunch 1/2/3`. Today the app
sees "Lunch" only as an activity NAME; it does not notice that Lunch is *fixed to period X for these
groups on every day*. The product owner wants ingest to surface those recurring fixed placements so
they don't have to be rebuilt by hand.

## Why this is bigger than T16/T33 — it reopens a decided scope boundary

ADR 2026-08-01 §2 fixed the ingest scope at **entities only, not placements**, enforced by a
whitelist (`INGESTIBLE_ENTITIES`) that deliberately excludes `template_slots` and `anchor_activities`.
A fixed-event block IS a placement (an activity pinned to a time block for specific groups across
days). The app already models this — `anchor_activities` / spans (`is_span_head`, overlays). So this
ticket is a **deliberate, product-owner-driven reopening of ADR §2**, not an oversight to patch
quietly.

## Open questions for the product owner (before any design)

1. **Where does an inferred fixed event land?** An `anchor_activity` (the app's existing "this
   activity is fixed at this period" concept), or a full `template_slot` placement? Anchors stay
   closer to "setup"; slots cross fully into placements.
2. **What counts as "fixed"?** Same activity + same period across *all operating days* for a group?
   For a whole unit? A majority? The rarity/threshold call is the same shape as the activity-tally
   work already in `extractEntities`.
3. **Still preview-and-confirm.** Whatever is inferred is a *proposal* the director edits, never a
   silent write (ADR §1) — inference here is higher-stakes than entity extraction.
4. **Staggered variants** (`Lunch 1/2/3` at different blocks per group — real in Camp B): one fixed
   event with per-group variants, or three? A judgement the parser cannot make alone.

## Next step

Brainstorm → spec → **ADR decision to reopen §2** (this is the human gate; scheduling-engine +
database/sync task class). Do not implement from this ticket. Blocked on the product-owner answers
above and sequenced after T33 (units must tie correctly before fixed-events-per-unit mean anything).
