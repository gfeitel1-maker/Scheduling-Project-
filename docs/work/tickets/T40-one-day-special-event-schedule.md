---
title: T40-one-day-special-event-schedule
document_type: ticket
status: parked
created: 2026-08-01
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
archive_when: superseded by an approved specification
---

# T28 — A one-day schedule for a special event

**Status: parked, deliberately.** Product owner, 2026-08-01: *"we haven't talked about creating a
one off/one day schedule for a special event. keep this as a side project to explore after we
work through normal schedules."* Recorded so it is not lost. **Not a design — no approach chosen.**

---

## What it is

A camp's normal output is a repeating week. A Maccabiah day, a colour war, a trip day is a
**single day**, built once, thrown away after — and it is scheduled differently enough that
bending the weekly grid to hold it may be the wrong move.

## What the sample already shows

*Maccabiah Friday Schedule (Camp Chai, Dallas, 2022)* — supplied 2026-08-01, one spreadsheet.
Read but not built against:

```
"Among Us" Maccabiah Schedule 2022
Time     Lil Chai        Chaverim        Shalom          Giborim
9:15     Opening         Opening         Opening         Opening
9:45     Team Meeting    Team Meeting    Team Meeting    Team Meeting
10:15    Pool - Unit Heads  Stem - Sylvia  Values - Laura  Gym - Tomer
```

Four things about it that the weekly model does not currently express:

1. **The columns are teams, not bunks.** "Lil Chai", "Chaverim", "Shalom", "Giborim" are
   Maccabiah teams — campers are re-divided for the day and the normal groups do not apply.
2. **The cells name a person, not just an activity.** "Pool - Unit Heads", "Stem - Sylvia",
   "Values - Laura". Staffing is part of the schedule here in a way it is not in a normal week.
   Note the consequence for ingestion: the ` - ` split added for T16 would read these as two
   activities. Ingestion of a file like this is **not** currently correct, which is one reason
   this is its own piece of work.
3. **It has a theme.** "Among Us" is the day's name, not the camp's.
4. **It is one day with no day column at all** — the whole grid is one day, where every other
   sample has days across the top or one page per day.

## Questions nobody has answered

- Is this a third **route** alongside Manual and Generated, or a different kind of object
  entirely? The plural-candidates ADR is explicit that neither existing route is canonical; a
  third would have to fit that rule or consciously break it.
- Does it reuse `groups`, or does it need its own idea of a team that exists for one day?
  Re-dividing the camp is the whole point of a Maccabiah, and forcing it through `groups` would
  put throwaway rows in the camp's permanent setup.
- Does it belong to a date, where the weekly schedule belongs to a day-of-week?
- Is `day_override_templates` the seed of this already, or a different feature that happens to
  sound similar? Worth reading before designing anything.

## Next step when this is picked up

Brainstorm, then a specification. Likely an ADR: on the evidence above it introduces either a
new entity or a new route, both of which are architecturally significant. Sequenced explicitly
after the normal-schedule work.
