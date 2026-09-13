---
title: T40-one-day-special-event-schedule
document_type: ticket
status: in-progress
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

## Progress (2026-08-20) — slice 1 (data shape) SHIPPED; initiative now in-progress

Owner brainstorm (2026-08-20) reframed the requirements: **theme/name + run-at-a-location are
essential; throwaway TEAMS and person-per-cell are NOT required** (reuse the camp's groups as columns;
cells hold an activity + optional location). Structurally it is a **standalone single-day schedule**
(like a day-override but its own full thing), **not date-tied**, and it **owns its time blocks**.
Approach ① chosen: a new `special_days` entity family (over extending day-overrides / a third
`schedule_templates.kind`). Design doc: `docs/work/specs/2026-08-20-special-days-data-shape-design.md`.

**Slice 1 (data shape) is implemented** (schema v34: `special_days` + `special_day_time_blocks` +
`special_day_slots`, op-log-synced/camp-scoped; full sync/permissions/migration/rollback/mock
registration; a `deleteSpecialDay` cascade primitive; integration scenario 26). Reviews: Red Hat 5/5
(T88-class registration closed by mechanical load-bearing guards), Security 5/5, Code Reviewer
merge-ready. Full gate green (3383 tests, 26/26 integration).

**Remaining slices (this ticket stays in-progress):** (2) author UI — the screen a director builds a
special day on (creates it, seeds/edits its time blocks, fills the groups×time grid, assigns
locations; wires `deleteSpecialDay`); (3) ingest a special-day file; (4) Context/Roots census wiring.

## Progress (2026-09-13) — slices 2 and 4 already shipped; slice 3 SPLIT, 3a shipped

Verified against the tree before starting: slice 2 is live (`SpecialSchedulesScreen` +
`src/screens/specialDay/SpecialDayGridEditor.jsx`), and slice 4 is wired (`special_days` is in
`CENSUS_ENTITIES`, `src/ingest/existingSnapshot.js`, and carries a domain/label in
`domainRollup.js`). Only slice 3 was outstanding.

### What importing one does TODAY, measured on the ticket's own sample

    days_of_operation: []    a weekly schedule with no days is impossible
    time_blocks:       1     all five periods collapsed into one
    activities:        12    six of them junk — "Sylvia Values", "Unit Heads",
                             "Laura Gym", "Lunch Lunch"

and nothing refuses it: the file has a genuine time axis, so T146's shape gate correctly accepts
it. It IS a schedule; it just is not a WEEK. All of that garbage lands in the camp's PERMANENT
setup, which is the actual harm — the wrong outcome is not "nothing happened", it is a polluted
camp.

### Slice 3a — SHIPPED: recognise it, and stop

`src/ingest/specialDayFile.js`. The signal is this ticket's own point 4, "one day with no day
column at all": ONE page, times down the side, and no day name anywhere — not in the columns, not
in the page title. A weekly file always names its days somewhere; that is what makes it weekly.

Biased against claiming, asymmetrically and on purpose: a false positive would route a camp's real
weekly schedule into a throwaway day, while a false negative merely leaves today's behaviour in
place. All three real corpus samples (campA, campB, campC) are pinned as negatives.

`proposeSpecialDay` also builds the proposal 3b will commit — the day's own name from the title,
the periods in file order, the columns as groups, and each cell split so that `Pool - Unit Heads`
yields the activity `Pool` with `Unit Heads` carried as a NOTE. The weekly path reads that
separator as activity-LOCATION and would mint a room called "Unit Heads"; here it is a staff name,
and person-per-cell is out of scope per the owner — so it is neither invented as an entity nor
silently dropped.

ImportScreen declines such a file with a message naming the day, its period and group counts, and
what importing it would have cost, pointing to Special Events instead.

**KNOWN LIMIT, stated not hidden:** this reads the `pages` shape, which for a SPREADSHEET (the
ticket's sample is one) is one row per sheet row and is exactly right. The plain-TEXT path's
blank-line block logic mangles the shape before it arrives — a one-day file has no blank lines
between periods, so the whole grid joins into a single block. Text-pasted special days are not
supported by 3a.

### Slice 3b — NOT built: create the day from the file

Committing the proposal means creating the `special_days` row, N `special_day_time_blocks`, matching
columns to existing groups by name, minting the activities that do not exist, and writing the
`special_day_slots` — a multi-row write with exactly the partial-failure class T109 is about. It
deserves its own design and review round rather than being appended here.
Deferred/not-required per owner: teams, person-per-cell, calendar dates, multi-block spanning.
