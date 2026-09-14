---
title: "Locations from a schedule: bind on identity, never infer meaning"
document_type: ticket
status: completed
created: 2026-09-13
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-08-15-camp-locations-entity.md]
archive_when: an import proposes activity-to-location bindings on exact name identity only, offers activity names as candidate places without binding them, and infers nothing from what a name means
---

# T147 — Locations from a schedule: bind on identity, never infer meaning

**Owner decision, 2026-09-13.** The conversation this ticket was parked for has
happened. The question was put as a binary — *"try to infer and ask, or
explicitly stop trying?"* — and the answer is neither half of it exactly: stop
inferring what a name MEANS, but do offer what a name IS.

## What decides it: a location is a constraint, not a label

`src/engine/buildSchedule.js` keeps `placeUsage` — who is in each place in each
block, capped at that place's `capacity`. A location is therefore an input to
what the engine will and will not schedule, not a caption on a cell.

So a wrongly-guessed location does not merely display wrong. It silently refuses
a pairing that would have been fine, or admits two groups into a room that holds
one. And it does that without surfacing anything: the director sees a schedule
that looks ordinary and has been shaped by a room assignment they never made.

That moves the question off "how often would a guess be right?" and onto "what
does a wrong guess cost, and would anyone catch it?" Here, wrong is invisible.

## The owner's own camp, which is the evidence

Where a name IS the place:

> "for my camp - virtual sports is in the room with that name, same for art, same
> for clay, etc."

Where a name is NOT the place — and this is the decisive case:

> "slingshots is at the archery range, not the slingshot range"

Name-based inference gets that exactly backwards, and the wrong answer is
PLAUSIBLE: "Slingshots → Slingshot Range" reads fine in a review list and would
be skimmed past. That is the same failure shape T146 was written for — an import
producing confident nonsense that looks like real extraction.

Genuinely variable, so not confirmable either:

> "sports is usually outside on the field but could be in the gym"

Ambiguous only AFTER the places exist:

> "big playground and little playground, gaga field and gaga pit are different
> places and activity names"

Two playgrounds not distinguished by name is a disambiguation question, not an
inference one — it can only arise once the director has said both exist, and it
belongs in the binding step where they are already looking.

## The design

**1. Bind only on identity.** An activity whose name matches an EXISTING
location's name (whitespace- and case-insensitively) is proposed for binding and
confirmed by the director. This is not an inference: the director named that
place. Covers the Virtual Sports / Art / Clay bulk.

**2. Offer activity names as candidate PLACE NAMES — no binding.** A camp with
few or no locations gets its activity list as a tick-list of possible places.
That is typing saved, not a guess: a location ticked and never used costs
nothing, while a binding asserted wrongly costs a distorted schedule.

**3. Infer nothing from what a name means.** No `Art` → "there must be an Art
Room", no `Slingshots` → "probably the Slingshot Range". Every counterexample
above lives in this tier.

**The file always wins.** Where a schedule cell states the place outright
(`Archery / Barn`, the existing Q8/M4 path), that stated fact is untouched by any
of this — a binding is only ever proposed for an activity the file left unplaced.

**Two locations with the same name refuse to bind.** Same rule as T40's
`ambiguous_columns`: "you have two places called this" and "you have none" need
different fixes and must not read the same.

## Built 2026-09-13

`src/ingest/locationsFromActivities.js` — two functions, pure, and the split
between them IS the design:

- `matchActivitiesToLocations` proposes a BINDING on exact name identity only.
  It excludes any activity the file already placed, and refuses to bind when two
  places share a name (returning them as `ambiguous` instead).
- `candidatePlaceNames` offers activity names the camp has no place for, as
  possible PLACES. It binds nothing, which is why "Slingshots" may appear here
  while never being bound to "Slingshot Range".

ImportScreen shows both in a "Places" panel. Bindings are ticked ON — an identity
match is not a guess, and the full list is visible so an unwanted one can be
unticked. Candidates are ticked OFF, and a ticked one joins the ordinary
locations proposal, running the same propose-then-confirm path every other
location does.

Tested at the seam as well as the layer: `ImportScreen.divisionSupport.test.jsx`
drives parse -> match -> confirm -> commit, asserting that Slingshots is never
offered a range, that a file-stated place is never overridden, that unticking
Sports keeps it out of the commit, and that a ticked candidate creates a place
without asserting anything happens there.

### Review round (Red Hat)

- **The commit-time staleness bug, for the third time this session.** Bindings were
  computed once at parse time and keyed on the activity name AS SPELLED THEN. A
  compound-cell resolution or a name-variant merge re-keys those names, so a ticked
  binding missed silently at commit: the checkbox stayed ticked and the write never
  happened. The two sibling derivations directly above it in the same function
  (`activityLocationsForCommit`, `coScheduleForCommit`) each carry a comment
  explaining this exact failure — both written earlier the same day. Now re-derived
  against `effectiveProposal`, with a regression test at that seam.
- **Bindings now default to ticked OFF.** They were ON, on the argument that an
  identity match is not a guess. Red Hat's counter is correct: that is an assumption
  about NAMING CONVENTIONS at one camp, not a property of every camp — an activity
  called "Office" need not happen in the Office. Default-ON also makes confirmation
  passive, and this whole feature exists because a wrong binding is invisible. The
  asymmetry decides it: a missed binding costs a tick, a wrong one costs a distorted
  schedule nobody can see.
- **Matching no longer deletes whitespace.** `whitespaceInsensitiveName` removes it
  entirely, making "Room 2" and "Room2" one key — a stemming rule wearing a
  normalization costume, contradicting this module's own premise. Runs of whitespace
  now collapse to one space instead: a doubled space between words is typing, a
  missing space is a different name.

## Non-goals

- Guessing indoor/outdoor. Rejected in T114 on the reasoning that outdoor-ness is
  a property of the PLACE, and nothing in a schedule cell carries it. Unchanged.
- Capacity from co-occurrence. Three groups at the Lake in one block is equally
  evidence that the camp overbooked the Lake. Not the same claim.
- Any fuzzy, stemmed, or semantic name match. The whole point is that `Slingshots`
  and `Slingshot Range` are similar strings and unrelated facts.
