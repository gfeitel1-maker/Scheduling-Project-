---
title: T40-one-day-special-event-schedule
document_type: ticket
status: completed
created: 2026-08-01
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
archive_when: all four slices shipped - data shape, author UI, ingest, census wiring
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

## CLOSED 2026-09-13 — all four slices shipped

| slice | what | state |
|---|---|---|
| 1 | data shape (`special_days` + time blocks + slots, schema v34) | shipped 2026-08-20 |
| 2 | author UI (`SpecialSchedulesScreen`, `specialDay/SpecialDayGridEditor`) | already shipped |
| 3a | recognise a one-day file instead of folding it into the weekly setup | shipped, PR #378 |
| 3b | build the day from the file | shipped, PR #379 |
| 4 | Roots census wiring (`special_days` in `CENSUS_ENTITIES`, `domainRollup`) | already shipped |

Deferred by the owner and still not required: throwaway TEAMS, person-per-cell, calendar dates,
multi-block spanning. The person-per-cell decision is why an imported `Pool - Unit Heads` cell keeps
"Unit Heads" as a NOTE on the day rather than modelling a staff assignment.

Ticket status was `in-progress` while slices 2 and 4 were in fact already shipped — the same
stale-ticket trap T140 carries. Verified against the tree before the 2026-09-13 work, not assumed.

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

**Review round (Red Hat, same day).** Three findings, all confirmed in code first:

- **The detector blocked real weekly schedules.** Its day recognition matched full day names only —
  the same rule `src/ingest/textGrid.js`'s `isDayName` uses. That is correct for a parser
  EXTRACTING days and wrong for a gate that REFUSES a file: a camp heading its columns
  `Mon/Tue/Wed` read as "no day named anywhere", so an ordinary weekly schedule was classified
  single-day and declined outright, with a message pointing at the wrong screen. Day recognition
  here is now deliberately BROADER than the pipeline's — abbreviations, all-single-letter headers,
  date headings — plus a check on the ROW labels, since a transposed week is still a week. Being
  over-eager to see a day is safe (a missed special day merely behaves as it does today); being
  under-eager blocks a camp's real file.
- **A non-ASCII dash defeated the cell split.** A sheet authored in Word or Excel autocorrects
  `" - "` to an en dash, and matching only the ASCII hyphen let the whole cell — staff name
  included — become the activity name, the exact outcome the split exists to prevent.
- **A cell containing only a dash proposed an activity called `"-"`**, because `trim()` collapses
  `" - "` before the split sees it.

Also hardened, same review: `readFiles` reset STATE but not the refs that carry a parse to the
commit, so any early decline left the previous file's pages and unit maps in memory. Nothing could
reach them (every consumer is gated behind `proposal`), but that was an implicit guarantee. Cleared
once at the top, so it holds for every early return rather than being re-argued at each.

**KNOWN LIMIT, stated not hidden:** this reads the `pages` shape, which for a SPREADSHEET (the
ticket's sample is one) is one row per sheet row and is exactly right. The plain-TEXT path's
blank-line block logic mangles the shape before it arrives — a one-day file has no blank lines
between periods, so the whole grid joins into a single block. Text-pasted special days are not
supported by 3a.

### Slice 3b — SHIPPED: build the day from the file

`src/ingest/specialDayPlan.js` (pure) resolves the proposal against the camp's LIVE rows and
`src/ingest/commitSpecialDay.js` writes it. The rule 3a exists for stays in force — a special day
must not quietly enlarge the camp's PERMANENT setup — so nothing is minted silently:

- a column matching no group is REPORTED, never created. A Maccabiah team is a throwaway; putting
  one in the camp's permanent roster is the same pollution 3a refuses the whole file to avoid. The
  plan is NOT READY while any column is unresolved, because committing then would silently leave
  that share of the day unbuilt.
- activities the camp lacks are listed separately and named in the panel, so the director sees
  exactly what agreeing adds to the catalog.
- a name already taken blocks the plan (`special_days` has `UNIQUE(camp_id, name)`).

**The staff names are preserved.** `special_day_slots` has no notes column, so `Pool - Unit Heads`
has nowhere to put "Unit Heads". Dropping it would silently lose something the file plainly said, so
the DAY records it in `special_days.notes` — the right grain for "here is what the source told us
that the grid cannot hold".

**There is no transaction, and the code does not pretend otherwise.** A day is a parent row, N
period rows and N*M cell rows, each its own IPC write — the partial-write class T109 covers. The
existing author screen (`SpecialEventsScreen.seedFromCampTimeBlocks`) already faces this and answers
the same way, so this follows that precedent rather than inventing a guarantee the IPC surface
cannot honour. The ORDER is the design: the `special_days` row is written FIRST so any later failure
leaves something the director can SEE and delete, rather than orphan periods and cells pointing at a
parent that never existed. On failure the rejection carries the day's id and the counts, the message
names the day and says where to find it, and the panel is cleared — offering a retry would create a
second day of the same name and trip the UNIQUE constraint.

**Review round (Red Hat).** Four findings, all confirmed in code first:

- **The failure message lied when the FIRST write failed.** The day's id is minted before any
  write, and was attached to every error unconditionally — so a rejection on the very first call
  still told the director to "find it under Special Events and delete it", sending them to look for
  a day that was never created. That is the same class of lie as claiming nothing happened, pointed
  the other way. The id is now attached only once the parent row has actually landed, and the
  message for an unstarted day says plainly that nothing was written.
- **Two live groups normalizing to the same name silently collided.** A plain `Map` is
  last-write-wins, so "Bogrim" and "bogrim " bound the column to whichever came last: one group got
  the whole day, the other silently got nothing, with no way to tell. Collisions are now collected
  and BLOCK the plan, reported as `ambiguous_columns` — distinct from `unmatched_columns`, because
  "you have two groups with this name" and "you have none" need different fixes.
- **Activities minted by an import survive deleting the day.** `deleteSpecialDay`'s cascade covers
  the three special-day tables and does not touch `activities` — correctly, since by then one may be
  in use elsewhere. Accepted rather than changed, but it is no longer SILENT: the panel says these
  stay in the camp's activities even if the day is deleted afterwards. The feature's rule is against
  QUIET enlargement of permanent setup; disclosed-and-agreed is a different thing.
- **Silent reuse of existing activities was not disclosed.** Matching ignores spacing and capitals
  so a re-import cannot double the catalog, which also means a one-off "Ga Ga pit" attaches to the
  camp's real, rule-governed "GaGa Pit". The panel now names what it reuses, not only what it adds.

Also hardened: the Build button's re-entrancy guard read React state, which only takes effect once a
render commits, so two clicks dispatched before that commit could both write. It is now a ref,
checked and set synchronously before the first await.

Verified at the seam, not just the layers: `ImportScreen.divisionSupport.test.jsx` drives the real
parse -> detect -> plan -> confirm -> write path, including the disabled-while-unmatched case, the
"what this adds" disclosure before any write, and the mid-way write refusal.
Deferred/not-required per owner: teams, person-per-cell, calendar dates, multi-block spanning.
