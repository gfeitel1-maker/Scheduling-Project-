---
title: T142-fixed-event-collapse-key-fragments-on-one-typo
document_type: ticket
status: closed
created: 2026-09-11
task_class: scheduling-engine
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-03-ingesting-recurring-fixed-events.md]
archive_when: closed — premise disproved by measurement, see below
---

# T142 — CLOSED: the premise was wrong; Lunch 2 splits for a real reason

**Raised** 2026-09-11 alongside T141, **closed the same day** after measuring
instead of reasoning from the symptom.

## What the ticket claimed

That `Lunch 2` fragmenting into two proposed events (`[3]` + `[2]`) was caused
by the `Lunch2` typo in Giborim 1's Wednesday cell, because the collapse key at
`src/ingest/fixedEvents.js:273` uses exact day-set equality.

## What is actually true

The typo is already handled. `extractEntities` builds a canonical-spelling map
before any name is read into an entity, and on the real file it produces
exactly:

    canonicalMap: [['lunch2', 'Lunch 2']]

The catalogue holds one `Lunch 2`, not two. The whitespace-insensitive fold
(`whitespaceInsensitiveName`, `preview.js`) is doing its job.

The split has a different and legitimate cause:

    Lunch 2 @ 12:10-12:50  Mon,Tue,Thu,Fri      3 groups (Chalutzim 1-3)  low
    Lunch 2 @ 12:10-12:50  Mon,Tue,Wed,Thu,Fri  2 groups (Giborim 1-2)    high

On Wednesday, Chalutzim's 12:10 block is **Music** and their lunch moves to
12:55 under the name `Lunch 4`. Giborim keep Lunch 2 in that block all five
days. The two group-sets genuinely have different day-sets, so these are two
different events. Merging them would assert that Chalutzim eat Lunch 2 on
Wednesday, which they do not. `Lunch 3` splits the same way for the same reason
(Alufim move to `Lunch 5` on Wednesday).

Exact day-set equality in the collapse key is therefore correct here, not
brittle. No change was made.

## What this surfaced instead

Chasing this found the typo class that IS unhandled — word-form variants such
as `Swim Return` / `Swim Returning`, which the whitespace-insensitive fold
deliberately does not merge and which no product surface has ever shown to a
director. See **T144**.

## Method note

The ticket was written from a plausible story about a symptom without checking
`canonicalMap`. A measurement that agrees with the story is the dangerous one;
this one disagreed in under a minute and was worth taking before building on it.
