---
title: "Import brings field trips and special days in as events, special days and placements"
document_type: adr
authority: normative
status: proposed
implementation_state: not_started
date: 2026-10-11
decided: ""
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
supersedes: []
amends: []
implements: []
related_adrs: [docs/adr/2026-10-09-special-day-binds-to-a-week-day.md, docs/adr/2026-08-28-fixed-vs-recurring-events.md, docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md, docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md]
---

# Import brings field trips and special days in as events, special days and placements

Design only. No code is changed by this ADR. Findings F3 and F4 of
docs/work/evidence/2026-10-11-synthetic-15-scorecard.md are the evidence.

## Context (verified in code and in the scorecard, 2026-10-11)

- **F3.** 13 of 15 synthetic camps print a field trip and 4 print an all-day day for a subset of groups
  (s04, s08, s12, s13). Trips imported as events: 8 of 118 cells (all on s11, which passes only because its trip
  covers 4 of 6 groups). Subset all-day cells imported as events: 0 of 72 (s04), 0 of 48 (s08), 0 of 60 (s12),
  0 of 72 (s13). Cause: the weekly event inference in src/ingest/fixedEvents.js admits an event only when at
  least two thirds of the groups share the same day-set (the `groupsHere.size * 3 < totalGroups * 2` line).
  Anything narrower becomes an ordinary catalog activity with a `min_per_week`; Generate then puts "Aquarium Trip"
  somewhere else and fills the real trip cells with ordinary activities (s04: 16 expected cells, 8 placements,
  0 at an expected cell).
- **F4.** Across all 15 camps a weekly import writes 0 `special_days` and 0 `special_day_placements`. A
  whole-camp all-day day inside a weekly grid is stored as N separate recurring events (one per block on s09).
  The three recognised one-day files (s02 Color War Day, s05 Games Day, s09 Games Day in
  docs/work/specs/samples/synthetic/special-days/) build a special day through proposeSpecialDay and
  commitSpecialDayPlan, but `placementsAfter` is 0: the day is bound to no week or day, and its cells added 7 to 9
  new catalog activities to the permanent setup.
- **T350 (accepted).** A `special_day_placements` row is keyed by `(week_id, day_id)` (derived id), is
  route-agnostic, and **replaces the whole day for every group** on both routes. Nothing in the importer writes one.
- **The one-day file names no day.** proposeSpecialDay recognises a file precisely because it has no day column
  and no day name. So the file itself never says which week or weekday it belongs to; that fact has to come from
  somewhere else (the file title or name, the camp's weeks, the director).
- **Placement is all-or-nothing per day, trips are not.** A trip is some groups for part of a day. A special day
  placement cannot express that, so trips are events, not special days. A subset all-day day (8 of 24 groups on
  s04) cannot be a placement either, because the other 16 groups still run their normal day.

## Observable success predicate

On the synthetic corpus, with no director input beyond accepting defaults:

1. A trip printed for some groups on one day imports as events scoped to those groups, on that week and day, with
   the right span. Trip cells present as events: at least 95 percent on all 13 camps (today 8 of 118 on one camp).
   Generate leaves the trip cells alone and places no "trip" activity elsewhere.
2. A whole-camp all-day day inside a weekly grid imports as **one** special day plus **one** placement on its
   week and weekday, not N recurring events (s05, s09 style days: `special_days` 1, placements 1, zero leftover
   recurring events for that day).
3. A subset all-day day imports as group-scoped events covering that day for exactly those groups (s04, s08,
   s12, s13: expected cells present, other groups' cells untouched).
4. A one-day file lands as a special day **with** a placement when its week and day are known or proposed; if
   they are not, it lands unplaced exactly as today and says so. It adds no catalog activities to the permanent
   setup that the director did not accept.
5. Re-importing the same file changes nothing (idempotent), and Undo import removes what the import made,
   including the special day and its placement, without touching placements the director made by hand.

## Non-goals

Calendar dates (T350 non-goal stands); half-day special days or a per-group placement (schema change, see Open
questions); electives (F6); changing T350 resolution or render; classifying activities that are not trips or
all-day days; asking the director to choose a file format.

## Owner rule

"We read their data, we don't make them choose the format." No option below may require the director to say
"this is a one-day file" or "this file contains trips" before import. Questions about **what we found**, with a
pre-selected answer, are fine; questions about the **shape of the file** are not.

## Candidate approaches considered

Divergence was run as written reasoning over four frames (regulator, 3am on-call, competitor breaking it,
remove the load-bearing assumption). No parallel sub-agents were spawned; the live design space is small. Say so
if the full `adhd` fan-out should be re-run.

| # | Approach | Key assumption |
|---|---|---|
| A | **Widen the silent heuristic.** Drop or soften the two-thirds line so trips and subset days are admitted as events automatically. | Group count is a good enough signal for "this is an event, not an activity". |
| B | **Typed detection inside the existing reconcile flow, confirm-all by default.** A new detector looks for day-specific, block-spanning, name-repeating patterns, classifies each as trip / whole-camp day / subset day, and raises a reviewable item with the answer pre-selected. Commit writes events, or special day plus placement. | The shape (one day, repeated name, spans blocks) distinguishes these from ordinary activities far better than group count does; pre-selected answers keep effort near zero. |
| C | **Explicit up-front director question.** "Does this file contain trips or special days? On which days?" | The director knows their file better than we can read it. |
| D | **Separate import mode for one-day files.** A distinct door with a week and day picker, for files with no day column. | One-day files are a different object from weekly grids and deserve their own flow. |

Rejections. **A** is the F3 cause run in reverse: it trades a missed trip for a silently pinned real activity
("Swim Meet" printed for 9 of 24 groups on Tuesday becomes an immovable event), and it still cannot decide
trip versus special day, so F4 stays open. **C** violates the owner rule and fails the zero-effort predicate on a
15-camp corpus. **D** alone fixes only the one-day half of F4; F3 and the weekly half of F4 never touch it. D's
placement step is worth keeping, folded into B.

## Recommendation

**Option B, with D's placement step folded in.** Confidence: **medium-high on the weekly half (B), medium on the
one-day placement defaults.** Evidence: every printed trip in the corpus is one day and 2+ blocks (scorecard F3,
13 camps); the whole-camp days (s05, s09) and subset days (s04, s08, s12, s13) are all single-day full-height
runs; T350 gives a placement target that already exists; commitSpecialDayPlan already builds the special day.

### Model (what each thing becomes)

| Printed in the file | Becomes | Why this and not a special day |
|---|---|---|
| Trip: some groups, part of a day, one day only | `fixed_events` rows (`kind: 'fixed'`, `schedule_week_id`, `day_id`, `group_ids`, `span_blocks` from the F5 span) | Placement replaces a whole day for everyone; a trip must not. |
| All-day day, **every** group, every block, one day | One `special_days` row (own time blocks and group x block grid from the printed cells) + one `special_day_placements` row on that `(week, day)` | This is exactly T350's "replaces that day's schedule". |
| All-day day, **some** groups, one day | Group-scoped `fixed_events` spanning the day for those groups only | Other groups still run a normal day; placement cannot express that today. |
| One-day file | `special_days` row as today, plus a placement when a `(week, day)` is resolved | Same as row 2. |

### Weekly import (F3 and the weekly half of F4)

1. **Detector, pure, in src/ingest/** (a new module beside fixedEvents.js; no DB). Input is the extracted
   placement grid. It finds, per `(day, group-set, name)`, runs of the same name over consecutive blocks on
   **one** day only, where the name does not recur on other days with the same shape. Output is a list of
   `{ kind: 'trip' | 'all-camp-day' | 'subset-day', day, groupIds, blocks, name, evidence, confidence }`.
   The discriminator is day-specificity plus span, not group count.
2. **Claim before the generic paths.** Detected cells are removed from the activity-inference and recurring-event
   inputs so they cannot also mint a catalog activity or N recurring events. This is the exclusivity discipline of
   docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md; the detector is one more claimant in
   that ordering.
3. **Reviewable item, pre-selected.** Each detection appears in the existing reconcile/review surface as a
   one-line item ("Aquarium Trip, Tuesday, 8 groups, 09:05-11:10 - import as a trip") with the proposed answer
   chosen and "treat as an ordinary activity" as the alternative. Confirm-all accepts every default. A decline is
   written to the camp-owned answer memory (shipped in #909) so the next import does not ask again.
4. **Week and day.** A weekly file carries its day columns; the week is the week being imported into. The
   implementer must verify how the importer picks `schedule_week_id` today (Q3, slice 0).
5. **Commit.** Events use the existing fixed-event write path and identity. A whole-camp day goes through
   `commitSpecialDayPlan` (reuse, do not fork) followed by a placement write using
   `deriveSpecialDayPlacementId(weekId, dayId)`, so a retry or re-import is the same row.

### One-day file (the one-day half of F4)

1. Recognition is unchanged (proposeSpecialDay). The plan gains a **resolved placement**: week and day.
2. **Resolution order, no question unless it cannot be answered:** (a) a weekday printed in the file title or
   file name, matched against the camp's `days_of_operation`; (b) the week currently open in the app. If both
   resolve, propose the placement pre-filled and visible in the review ("Place on Week 2, Tuesday") with a
   week/day picker to change it. If a weekday cannot be resolved, the day lands **unplaced** (today's behaviour)
   with a plain flag, and placing it is the existing action in SpecialDayPlacements. We never invent a weekday.
3. The "7 to 9 new catalog activities" are already previewed by buildSpecialDayPlan; a slice stops adding a
   catalog activity where an equivalent one exists, and keeps the "what this adds" preview.

### Undo, re-import, sync

- All writes are `appendOp`, so they sit in the device-local ledger and Undo import covers them. Import must not
  silently replace a director's existing binding on the same `(week, day)`: it proposes the replace and defaults
  to keeping the existing one (T350 replace-on-occupied).
- Per T350 D8 `special_day_placements` is refused by restore and is not in `PARENT_SCOPED_DEPENDENTS`; a Replace
  re-import therefore leaves placements alone. That is right for hand-made ones but means an import-made
  placement is not removed by Replace; Undo import must delete it explicitly (slice 3 test).
- Sync: no new schema, no genesis change. Events and placements are existing document entities; the only new
  contract is write order (special day, then placement), following `commitSpecialDayPlan`'s parent-first order so
  a partial failure leaves a visible, deletable special day.

### Interface contract check (org-interface-contracts)

Idempotent: events and placements use existing derived identities, a second import is a no-op. Concurrent
retries: converge by key (T350 D5). Unknown outcome: the commit reports `{ ok:false, reason, counts }` like
`commitSpecialDayPlan` and the UI surfaces every failure (standing rule). Authority: no new IPC, existing
`authorize()` paths. Trust boundary: file content is untrusted and passes existing validation; the detector emits
proposals and never writes.

## Options compared (operational)

| | A widen heuristic | **B detect + confirm (recommended)** | C ask up front | D separate one-day mode |
|---|---|---|---|---|
| Director effort | none | confirm-all, one click | high, per file | one extra flow, picker |
| False positives | high, silent, pinned | low, shown, reversible | none | n/a |
| Fits special_days/placements | no | yes, all three shapes | yes | one-day only |
| Fixes F3 | partly | yes | yes | no |
| Fixes F4 | no | weekly yes | yes | one-day yes |
| Owner rule | ok | ok | **violates** | ok if auto-detected |
| Undo / re-import | unchanged | ledger plus answer memory | unchanged | unchanged |

## Interplay with F5 (multi-block spans) and event exclusivity

- **F5 first.** A trip is a multi-block span. Text-grid spans now import as one session of N (#910), so the
  detector must use the same span helper, not re-derive it; a fallback to N one-block events is acceptable only
  if the helper declines. Slice 1 depends on #910 and on F2 (#906, 10-minute blocks) being on main.
- **Exclusivity.** A detected cell is claimed once. Order: detector first (day-specific, narrow), then the
  existing fixed/recurring inference, then activity inference. The existing exclusivity integration test gains a
  case where a trip shares a block with a camp-wide recurring event (Lunch) and neither steals the other.
- **Event versus special day on one day.** A placed day replaces everything (T350). The detector never emits both
  an event and a special day for the same day; a whole-camp day removes that day's other detections.

## Slice plan (ticket-sized, red-first)

Each slice is one PR; ticket numbers from `npm run ticket:next` at ticketing time.

0. **Pin the premises (read-only).** Confirm how a weekly import selects `schedule_week_id`; how the event write
   path expresses a group-scoped spanned event; whether a special day grid may omit groups. Output: a note on the
   ticket. Answers Q3 and the model rows.
1. **Detector, pure.** Red: tests driven by the synthetic corpus assert exact detections (kind, day, groups,
   blocks) for s04, s05, s08, s09, s12, s13 and no detection on every ordinary activity; negative pin "Swim
   printed Tuesday for 9 of 24 groups on 3 days". Green: the module, no wiring.
2. **Trips and subset days become events (weekly).** Red: harness assertion that trip cells present as events is
   at least 95 percent on all 13 camps and subset all-day cells 100 percent; Generate does not place the trip
   name elsewhere. Green: wire the detector, claim ordering, pre-selected reconcile item, decline into answer
   memory, extended exclusivity test.
3. **Whole-camp all-day day becomes special day plus placement (weekly).** Red: s05/s09 yield 1 special day, 1
   placement on the right `(week, day)`, 0 leftover recurring events for that day; re-import is a no-op; Undo
   import removes both. Green: reuse `commitSpecialDayPlan` plus the placement write.
4. **One-day file placement.** Red: `placementsAfter` is 1 for s02, s05, s09 when the title names a weekday and 0
   with an explicit "unplaced" flag when it does not. Green: resolver plus picker in the existing review.
5. **Catalog pollution on one-day files.** Red: committing a one-day file adds no catalog activity that already
   exists under an equivalent name. Independent of 4.

Gate: `npm run verify` in CI per slice; slices 2 and 3 are import-pipeline changes and take Red Hat. Slice 1 is
pure.

## Challenges considered (self red-hat pass)

1. **"Day-specificity plus span is just another heuristic and will misfire."** True, but it is narrower than
   group count, nothing below high confidence is silent, and a decline is remembered. Residual: a real once-a-week
   two-block activity ("Swim Meet") is flagged as a trip. Answered by confirm-by-default with a one-click
   "ordinary activity". **Left open:** whether auto-accept at high confidence is ever safe (Q2).
2. **"A subset all-day day should be a special day too."** Placement is whole-day, so placing it would blank the
   other groups' day, a data-destroying default. Events preserve every other group. **Left open:** does the owner
   want per-group placement (schema change, new ADR)? (Q1)
3. **"Group-scoped events lose the reusable, printable special day."** Correct and acceptable: a subset day in a
   weekly grid is a week fact, not an authored reusable object. Promotion later is out of scope.
4. **"Pre-selected answers are confirm fatigue."** Mitigated by confirm-all and one line per detection (corpus
   camps have 1 to 4). A camp with 30 trips needs grouping; deferred until measured.
5. **"Weekly and one-day detection can disagree about the same day."** Not resolved here; the importer proposes
   and keeps the existing binding by default.
6. **"The corpus is synthetic."** All evidence is camps we authored. The detector is pinned on them, but no real
   camp file has been run. Confidence is capped at medium-high; slice 2 should not be called done until it runs on
   the owner's own camp file.
7. **"Detector ordering could regress F2/F5 work."** Both are on main or in review; the detector reads the post-F2/F5
   grid and slice 1 states that dependency.

## Risks

The ingest pipeline is the most heavily tested code in the repo and the claim-ordering change is the highest-risk
edit: a mis-ordered claim could swallow real activities. Mitigation: the detector only proposes until slice 2, and
slice 2 carries negative pins. Import-made placements survive Replace by T350 design, so a wrong placement
persists until undone; mitigation: never auto-replace an existing binding.

## Open questions for the owner

1. **Subset all-day days (Color War for some groups).** Events for those groups (recommended, no schema change)
   or a per-group special-day placement (larger design, new ADR)? Do directors think of this as a special day or
   as an event?
2. **Auto-accept at high confidence, or always show the item?** Recommended: always show, confirm-all one click,
   until one real camp file has been run.
3. **Which week does a weekly import land in, and does the director expect a one-day file to land on the week
   they are looking at?** Slice 0 reads the code; the expectation is the owner's.
4. **A one-day file with no weekday:** land unplaced with a flag (recommended, matches the owner rule) or force a
   picker before it can be saved?

## Consequences

If accepted: slices 1-5 above, no schema or genesis change, no new IPC. If the owner chooses per-group placement
(Q1), slices 2 and 3 change shape for subset days and a schema ADR precedes them.
