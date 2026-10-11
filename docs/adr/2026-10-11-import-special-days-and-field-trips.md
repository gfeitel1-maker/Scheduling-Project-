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
related_adrs: [docs/adr/2026-10-09-special-day-binds-to-a-week-day.md, docs/adr/2026-08-28-fixed-vs-recurring-events.md, docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md, docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md, docs/adr/2026-08-17-onescreen-reconciliation-undo.md]
---

# Import brings field trips and special days in as events, special days and placements

Design only. No code is changed by this ADR. Findings F3 and F4 of
docs/work/evidence/2026-10-11-synthetic-15-scorecard.md are the evidence.

**Revision note (Red Hat, 2026-10-11; recommendation shape unchanged, four design defects corrected).** Each
was verified in code before being written: (B1) a group-scoped event cannot be `kind 'fixed'`; (B2) the import
commit never writes `schedule_week_id`, so a once-printed trip would recur every week; (B3) the special-day half
of the import has no Undo and duplicates on re-import; (B4) the detector's false-positive classes. Non-blocking
N1-N6 are folded in.

## Context (verified in code and in the scorecard, 2026-10-11)

- **F3.** 13 of 15 synthetic camps print a field trip and 4 print an all-day day for a subset of groups
  (s04, s08, s12, s13). Trips imported as events: 8 of 118 cells (all on s11). Subset all-day cells imported as
  events: 0 of 72 (s04), 0 of 48 (s08), 0 of 60 (s12), 0 of 72 (s13). Cause: src/ingest/fixedEvents.js admits a
  weekly event only when at least two thirds of the groups share the same day-set (`groupsHere.size * 3 <
  totalGroups * 2`); narrower patterns become catalog activities with a `min_per_week`, Generate places them
  elsewhere and fills the real trip cells with ordinary activities (s04: 16 expected cells, 8 placements, 0 at an
  expected cell).
- **F4.** A weekly import writes 0 `special_days` and 0 `special_day_placements` on all 15 camps; a whole-camp
  all-day day is stored as N recurring events (one per block on s09). The three one-day files (s02, s05, s09 in
  docs/work/specs/samples/synthetic/special-days/) build a special day but `placementsAfter` is 0 and each adds 7
  to 9 catalog activities to the permanent setup.
- **T350 (accepted).** A `special_day_placements` row is keyed `(week_id, day_id)` by
  `deriveSpecialDayPlacementId`, is route-agnostic, and **replaces the whole day for every group**.
- **A group-scoped event is `kind 'recurring'`, never `'fixed'`.** The CHECK at electron/db/schema.sql
  (`kind = 'recurring' OR (kind = 'fixed' AND is_all_groups = 1 AND ... group_ids empty ...)`) forbids a
  group-scoped fixed row, and the import commit already writes `kind: slotIsAll ? 'fixed' : 'recurring'`
  (electron/ops/ingest.js, "Fixed vs Recurring" block). So a trip or a subset day is a **Recurring Event**, which
  lives in a different lane and screen from Fixed Events (docs/adr/2026-08-28-fixed-vs-recurring-events.md).
- **The import commit never writes `schedule_week_id`.** The fields object in the same block has no such key, and
  buildSchedule treats `schedule_week_id == null` as "every week" (src/engine/buildSchedule.js, the
  `a.schedule_week_id == null || a.schedule_week_id === weekId` filter). Today every imported recurring event
  therefore recurs in every week, which is right for "Swim Tue/Thu" and **wrong for a trip printed once**.
- **The special-day half of import is outside the import transaction.** `commitSpecialDayPlan` is called from
  the renderer (src/screens/ImportScreen.jsx, `buildSpecialDay`) with one `localClient.write` IPC per field, no
  `import_run_id` and no `captureInverse`; src/ingest/commitSpecialDay.js mints every id with `newId()`
  (`crypto.randomUUID()`), so a second import creates a second copy and Undo import cannot see either.
  `commitPlan` in electron/ops/ingest.js, by contrast, runs in one SQLite transaction and supports
  `captureInverse` and `import_run_id`.
- **The one-day file names no day.** proposeSpecialDay recognises a file because it has no day column or day name.
- **Week-bound beats all-weeks per cell.** `setFixedEventLookup` in buildSchedule.js lets a week-scoped event win
  a cell over an all-weeks one, and resolves two same-scope collisions last-write-wins.

## Observable success predicate

On the synthetic corpus plus a mutated copy of campB (see slice 1), judged **per row, not per cell count**:

1. **Trip (some groups, part of one day).** Imports as `fixed_events` rows with `kind='recurring'`,
   `is_all_groups=0`, `group_ids` exactly the printed groups, `day_id` the printed day, `span_blocks` the
   printed run length, and **`schedule_week_id` = the week the review item named**. Never NULL (all weeks) for a
   once-printed trip. At least 95 percent of expected trip cells present on all 13 camps; Generate places no
   trip name elsewhere.
2. **Subset all-day day.** Same row shape as 1, one event per contiguous run of blocks, for exactly those
   groups; other groups' cells untouched.
3. **Whole-camp all-day day.** Offered as a special day plus placement **only when the director answers that
   item explicitly**; confirm-all never accepts it. Unanswered, it commits as week-bound all-camp `kind='fixed'`
   events (the non-replacing, today's-behaviour-but-week-bound result). Accepted: 1 `special_days` row, 1
   `special_day_placements` row on the named `(week, day)`, 0 leftover events for that day.
4. **One-day file.** Lands as a special day with a placement when the week and day resolve (below), otherwise
   unplaced with a plain flag. No catalog activity is added that an equivalent already covers.
5. **Idempotent and undoable, including the special-day half.** Re-importing the same file creates zero new
   `special_days`, `special_day_time_blocks`, `special_day_slots`, events or placements (row counts and ids
   unchanged). Undo import removes every row the import created in this run (events, special day, its periods and
   cells, its placement, and any activities it minted) and does not touch rows the director made by hand.

## Non-goals

Calendar dates (T350 non-goal stands); half-day special days and a per-group placement (schema change, Q1);
electives (F6); changing T350 resolution or render; a UI redesign of how Recurring Events are labelled; asking
the director to choose a file format.

## Owner rule

"We read their data, we don't make them choose the format." No option may require the director to say "this is
a one-day file" or "this file contains trips". Questions about **what we found**, with a pre-selected answer,
are fine; questions about the **shape of the file** are not.

## Candidate approaches considered

Divergence was run as written reasoning over four frames (regulator, 3am on-call, competitor breaking it, remove
the load-bearing assumption); no parallel sub-agents were spawned.

| # | Approach | Key assumption |
|---|---|---|
| A | **Widen the silent heuristic.** Soften the two-thirds line so trips and subset days are admitted automatically. | Group count is a good enough event signal. |
| B | **Typed detection inside the existing review flow, pre-selected answers.** A detector classifies day-specific, block-spanning name runs as trip / whole-camp day / subset day and raises a reviewable item. | The shape of the run, not group count, separates these from ordinary activities. |
| C | **Explicit up-front question.** "Does this file contain trips or special days? On which days?" | The director knows their file better than we can read it. |
| D | **Separate import mode for one-day files** with a week/day picker. | One-day files are a different object. |

**A** swaps a missed trip for a silently pinned real activity and cannot tell trip from special day. **C**
violates the owner rule. **D** alone fixes only the one-day half. D's placement step is kept inside B.

## Recommendation

**Option B, with D's placement step folded in, plus relocating the special-day commit into the main-process
import transaction.** Confidence: **medium** overall (was medium-high before Red Hat). Higher (medium-high) on the
model corrections and the commit relocation, which are verified against code; lower on the detector, whose
lexical-cue coverage on real camps is unmeasured and whose corpus is synthetic.

### Model (what each thing becomes)

| Printed in the file | Becomes | Product meaning |
|---|---|---|
| Trip: some groups, part of one day | `fixed_events`, **`kind='recurring'`**, `is_all_groups=0`, `group_ids`, `day_id`, `span_blocks`, **`schedule_week_id`=chosen week** | A one-time group-scoped event in that week, shown with the Recurring Events. The word "recurring" is the schema's name for "scoped to some groups"; a week-bound one occurs once. Whether the screen should say so is a Designer note, not decided here. |
| Trip for **every** group | `kind='fixed'`, `is_all_groups=1`, `schedule_week_id`=chosen week | Fixed Event for that week only. |
| Subset all-day day | Same as trip: group-scoped recurring events, week-bound, one per contiguous run | The other groups still run a normal day; a placement would blank them. |
| Whole-camp all-day day, director accepts | `special_days` + children + one `special_day_placements` row | T350's "replaces that day's schedule", for every group. |
| Whole-camp all-day day, unanswered | Week-bound all-camp `kind='fixed'` events | Non-replacing; today's behaviour with the week binding added. |
| One-day file | `special_days` + children, plus a placement when `(week, day)` resolves | As above. |

The new `schedule_week_id` write is added to the commit's fields object. It needs the importer to be handed a
`weekId` per event; today `fixedEvents` entries carry none.

### Week resolution (B2 and N2; decided here)

1. The default week is **the week open in the app** when the import starts. It is **named inside every trip,
   subset-day and special-day item** ("Aquarium Trip, Tuesday, 8 groups - Week 2") with a week picker on the
   item. The trip is never written with NULL week.
2. If exactly one week exists, that is the default. If several exist and none is open, the picker has no default
   and the item is not pre-selected until one is chosen; confirm-all leaves it pending, and a pending item
   commits the cells as they commit today (ordinary activity), never as an all-weeks event.
3. If the camp has no weeks, trip and special-day detections are not offered and a plain flag says why. Never
   all-weeks.
4. A weekly import that already imports into a specific week uses that week and says so.

### Weekly import

1. **Detector, pure, src/ingest/, a new module beside fixedEvents.js.** Evaluated **per group-set**, not per
   camp: for each `(day, set of groups sharing the same printed run, name)` it finds runs of the same printed name
   over consecutive blocks, and emits `{ kind: 'trip' | 'all-camp-day' | 'subset-day', day, groupIds, blocks,
   name, evidence, confidence, lexicalCue }`. A run is broken by any block in which a group prints a *different*
   name (a printed Lunch inside the span ends the run), so a trip event never covers a block the file filled with
   something else.
2. **Classification and tolerance (B4).**
   - *Whole-camp*: every operating group prints the name, in at least 80 percent of that day's blocks each, one
     day only. The existing two-thirds tolerance ("one typo'd cell") is **not** reused here, because the cost of
     a false whole-camp is a replaced day, not a missed event.
   - *Near-whole* (for example 23 of 24 groups): classified **subset-day**, never whole-camp. The item says
     "23 of 24 groups; group X prints something else" and offers whole-camp as the explicit alternative.
   - *Trip / subset-day*: any smaller group-set.
   - *Default answer* is event only with **evidence**: a lexical cue in the name (trip, field, outing,
     excursion, day) or whole-day coverage. A name with neither is shown, default **ordinary activity**.
     A genuine two-block catalogue activity on one day (a double Pottery for one group) therefore stays an
     activity unless the director says otherwise.
   - *Rotation*: a name printed for different group-sets on different days is evaluated per `(day, group-set)`;
     with a lexical cue each is a separate trip, without one the name is ordinary (a rotation is the signature of
     a catalogue activity).
   - *Rainy-day or alternate swap*: a run that overlaps another detection on the same `(day, group-set, blocks)`,
     or whose name contains a rain/alternate/backup token, gets **no default**; both are shown.
   - *Same name, disjoint group-sets, same day*: separate events (the identity check is slice 0, below).
3. **Claim ordering and dedup (N1).** Detector first, then existing fixed/recurring inference, then activity
   inference. Claimed cells leave the inputs of the other two, which also stops the trip name inflating
   `min_per_week` (appearances are counted from unclaimed cells only; a trip whose name equals an existing
   catalogue activity leaves that activity's rule computed from its unclaimed cells). The trip event links
   `activity_id` by name as every event does today. Subset groups' own Lunch or meal events: a week-bound
   trip wins its cells over an all-weeks Lunch (buildSchedule's week-scoped-beats-all-weeks rule), so the
   detector only claims blocks where the *file* printed the trip name; it never claims a printed Lunch block, and
   the run splits around it. Two same-scope events colliding on a cell remain last-write-wins, so slice 2 asserts
   no cell is covered by two week-bound events.
4. **Review item.** One line per detection, pre-selected per above, with the week named. **The whole-camp item
   is different by design:** it is not pre-selected, is excluded from confirm-all and from every auto-apply
   path, and its text states the consequence ("Replaces the whole day for every group on Tuesday, Week 2. Other
   cells that day are hidden, not deleted, and come back if you unplace it."). Until answered it commits as the
   non-replacing fixed events.
5. **Answer memory (N3).** `QKINDS` in src/ingest/answerMemory.js (`classify, exclusion, value, drift_ack,
   split, merge, residue`) has no kind for this. Slice 2 adds `trip` (verdicts `event`, `activity`) and
   `special_day` (verdicts `special_day`, `events`) to `QKINDS` and `VERDICTS`. A `special_day` verdict is
   **never** added to the frozen auto-apply allow-list, so a remembered answer pre-selects but never silently
   places a day.

### Special-day commit (B3, the top risk; N5, N6)

This is the highest-risk part of the design: today it is neither atomic, undoable nor idempotent.

1. **Move the commit into the main-process import transaction.** The plan gains `specialDays` (with their
   children and optional placement) and `commitPlan` writes them through the same `write` wrapper that
   `captureInverse` uses, under the same `import_run_id`, inside the same SQLite transaction. Both doors
   (weekly detection and one-day file) go through it. `commitSpecialDayPlan` in the renderer is retired; its
   write order (parent first) is kept inside the transaction.
2. **Deterministic ids.** The special day id is derived from `(camp_id, normalized name)` the way
   `deriveLocationId` is; periods and cells derive from `(special_day_id, period name)` and `(special_day_id,
   group id, period id)`; the placement is already `deriveSpecialDayPlacementId(weekId, dayId)`. A re-import
   addresses the same rows: no duplicate, nothing for Undo to miss.
3. **Re-import with a different grid under the same name.** The import compares against the existing day: equal
   content is a no-op; different content is a reviewable "update Games Day / keep existing" item that defaults to
   **keep existing** and never overwrites silently. This also settles the case of two differently-built days a
   camp wants under one name: the director renames one, as with any name collision in the catalog.
4. **"Keep existing binding" must not orphan (N5).** If the director keeps the existing binding on a
   `(week, day)`, the plan marks the new special day **not created** before commit, so no unplaced copy is left
   behind. A special day created and then left unplaced by a declined placement is a visible row on the Special
   Events screen, flagged, not an orphan.
5. **Replace re-import (N6).** `special_day_placements` is deliberately outside `PARENT_SCOPED_DEPENDENTS`, and
   `replaceScope` never clears weeks. With deterministic special-day ids a Replace addresses the same days, so a
   placement cannot be left pointing at a regenerated day. If a Replace file no longer contains a day the import
   previously created, slice 0 verifies whether `replaceScope` touches `special_days`; if it does, it must also
   delete that day's placements (as `deleteSpecialDay` does, T350 D8); if it does not, the day and its binding
   remain, which is correct.
6. **Catalog pollution.** The plan's minted activities are shown in the "what this adds" preview and are not
   created where an equivalent activity exists; any it does mint are written under the same `import_run_id` so
   Undo removes them.

### One-day file

Recognition is unchanged. Resolution order: (a) a weekday printed in the file title or name, matched to the
camp's `days_of_operation`; (b) the week open in the app for the week. If the weekday resolves, the placement is
proposed pre-filled and named in the review with a week/day picker. **If no weekday resolves, the day lands
unplaced with a flag; it never forces a picker (decided here) and never invents a weekday.** Placing it is the
existing action in SpecialDayPlacements.

### Interface contract check (org-interface-contracts)

Idempotent: every row has a derived id; a second import is a no-op, asserted by row counts and ids. Concurrent
retries: converge by key (T350 D5); two devices importing the same file produce the same rows. Unknown outcome:
the transaction either commits all rows or none (`commitPlan`), unlike the current per-field IPC path, which is
the defect this fixes; the result carries `{ ok:false, reason }` and every failure surfaces. Authority: the
special-day writes move under the import's existing `authorize()`; verify in slice 0 that the import permission
covers `special_days`, children and `special_day_placements`. Trust boundary: file content is untrusted and
validated by the existing gates; the detector proposes only.

## Options compared (operational)

| | A widen heuristic | **B detect + review (recommended)** | C ask up front | D separate one-day mode |
|---|---|---|---|---|
| Director effort | none | confirm-all; one explicit answer per whole-camp day | high, per file | one extra flow |
| False positives | high, silent, pinned | low, shown, reversible | none | n/a |
| Fits events / special days / placements | no | yes, all three | yes | one-day only |
| Fixes F3 / F4 | partly / no | yes / yes | yes / yes | no / one-day only |
| Owner rule | ok | ok | **violates** | ok if auto-detected |
| Undo / re-import | unchanged | ledger plus answer memory, with the relocation | unchanged | unchanged |

## Interplay with F5 (multi-block spans) and event exclusivity

- **F5 first.** A trip is a multi-block span; text-grid spans import as one session of N (#910). The detector
  uses the same span helper, not its own. Slice 1 depends on #910 and F2 (#906).
- **Exclusivity.** A cell is claimed once (order above). The existing exclusivity integration test gains a trip
  sharing a block with a camp-wide recurring Lunch, and a trip whose name equals a catalogue activity.
- **Event versus special day.** A placed day replaces everything (T350), so the detector never emits both an
  event and a special day for the same `(day)`; accepting a whole-camp item removes that day's other detections.

## Slice plan (ticket-sized, red-first)

Each slice is one PR; numbers from `npm run ticket:next`.

0. **Pin the premises (read-only).** Verify: the importer can be handed a `weekId`/`schedule_week_id` per event
   and the commit can write it; fixed-event identity for two same-name events with disjoint `group_ids`; whether
   `replaceScope` touches `special_days`; the import permission covers the special-day entities; whether a
   special day grid may omit groups; `commitPlan`'s transaction extends to the new entities.
1. **Detector, pure.** Red: per-row expected detections (kind, day, groupIds, blocks, lexicalCue, confidence)
   for s04, s05, s08, s09, s12, s13, plus a **mutated copy of campB** (an uncorrelated plant: add a trip, then
   mutate one group's cell) asserting the detection set changes by exactly that trip. Negatives: a two-block
   catalogue activity on one day; a rotation of one name across groups and days; a rainy-day pair on the same
   `(day, group-set, blocks)`; 23-of-24 groups (must be subset-day, not whole-camp); a run broken by a printed
   Lunch; two same-name trips for disjoint groups; a trip name equal to a catalogue activity (no `min_per_week`
   inflation). Measure the lexical-cue coverage on the corpus and report it. No wiring.
2. **Trips and subset days become week-bound recurring events.** Red: per-row assertion of `kind`,
   `is_all_groups`, `group_ids`, `day_id`, `span_blocks`, **`schedule_week_id`** (never NULL for a detected
   trip); at least 95 percent of expected trip cells; no cell covered by two week-bound events; Generate places no
   trip name elsewhere. Green: week threading, commit field, claim ordering, pre-selected item with named week,
   `QKINDS`/`VERDICTS` entries (N3), decline into answer memory.
3a. **Relocate the special-day commit into `commitPlan` (top risk).** Red: importing the same one-day file twice
   leaves identical row counts and ids for `special_days`, `special_day_time_blocks`, `special_day_slots`; Undo
   import removes the special day, children and minted activities; a mid-commit failure leaves nothing. Green:
   plan field, derived ids, `import_run_id`, `captureInverse`, renderer path retired.
3b. **Whole-camp day: special day plus placement.** Red: accepted item yields 1 special day + 1 placement on the
   right `(week, day)` and 0 leftover events; unanswered yields week-bound fixed events; confirm-all leaves the
   item pending; keep-existing-binding creates no special day; Replace leaves no dangling placement; Undo removes
   both. Green: item text, exclusion from confirm-all and auto-apply.
4. **One-day file placement.** Red: `placementsAfter` is 1 for s02, s05, s09 when the title names a weekday;
   unplaced with a flag otherwise.
5. **Catalog pollution on one-day files.** Red: no equivalent-name activity is minted; any minted is undone.

Gate: `npm run verify` in CI per slice; 2, 3a and 3b are import-pipeline changes and take Red Hat. 3a also takes
Security-lite review of the authority check (the writes move under `authorize()`).

## Challenges considered (self red-hat pass, revised)

1. **Red Hat B1 (group-scoped 'fixed' is impossible).** Accepted; model corrected. Trips and subset days are
   Recurring Events. Residual: the label "recurring" for a once-in-a-week event is a vocabulary wart, handed to the
   Designer, not solved here.
2. **Red Hat B2 (NULL week recurs everywhere).** Accepted; week default, naming in the item, and the "never
   NULL" predicate added. Residual: a camp with several weeks and none open gets a pending item, which costs one
   click.
3. **Red Hat B3 (special-day half not undoable, not idempotent).** Accepted and promoted to the top risk;
   predicate 5 rewritten and slice 3a is its own PR with failure-atomicity and row-count tests. Residual: the
   commit relocation touches the most-tested file in the repo; mitigated by landing it before any detector
   wiring depends on it.
4. **Red Hat B4 (detector false positives).** Accepted; per-group-set evaluation, an 80-percent coverage rule for
   whole-camp (not the two-thirds typo tolerance, because the failure cost differs), near-whole classed as
   subset, a lexical-evidence rule for defaults, and a negatives list in slice 1. Residual: **lexical cues are an
   unmeasured proxy**. A real trip named "Camden Adventure" gets default ordinary activity and the director must
   flip it; slice 1 reports the corpus cue rate and the 95-percent predicate is judged on cued trips.
5. **Whole-camp placement is the dangerous item.** Not pre-selected, excluded from confirm-all and auto-apply,
   consequence text in the item, safe non-replacing default. Residual: a director can still click through it;
   unplace is one action and nothing is deleted (T350 D4.6).
6. **Subset day as events, not a special day (Q1).** Decided here with owner veto: placement is whole-day and
   would blank groups that did not print the name. Residual: a director who thinks of Color War for Seniors as a
   reusable special day gets events instead; promotion is out of scope.
7. **Confirm fatigue.** Corpus camps print 1 to 4 items; one line each, confirm-all for everything but the
   whole-camp item. A camp with 30 trips needs grouping; deferred until measured.
8. **Synthetic corpus.** All evidence is camps we authored; no real camp file has been run. This is the reason for
   medium, not medium-high. Slice 2 is not done until the owner's own camp file has run through it.
9. **Deterministic special-day id by name collapses two genuinely different days with one name.** Handled by the
   keep-existing default and a rename; a silent merge is never offered.

## Risks

1. **Top: special-day commit relocation (3a).** Atomicity, Undo and idempotency all depend on it; every other
   special-day claim in this ADR is false until it lands.
2. Detector claim ordering swallowing real activities (mitigated: proposals only until slice 2; negative pins).
3. Lexical-cue coverage on real camps (measured in slice 1).
4. An import-made placement persists until undone; mitigated by never auto-replacing an existing binding.

## Open questions

Decided in this revision (owner may veto, none needs an answer to proceed):

- **Q1, subset all-day days:** group-scoped week-bound recurring events, no schema change. Veto path: per-group
  placement, which needs a schema ADR and re-shapes slices 2 and 3b.
- **Q2, auto-accept:** never for the whole-camp item; everything else is pre-selected and confirm-all-able. No
  auto-accept without showing the item until a real camp file has run.
- **Q3, week:** the open week, named in the item with a picker; never all-weeks; no weeks means not offered.
- **Q4, one-day file with no weekday:** lands unplaced with a flag; no forced picker.

**Remaining owner question: Q1 only**, and only as a veto: do directors think of "Color War for just the
Seniors" as a special day or as an event?

## Consequences

If accepted: slices 0-5, no schema or genesis change, no new IPC; the special-day import becomes transactional,
idempotent and undoable, which it is not today. If the owner vetoes Q1, slices 2 and 3b change shape for subset
days and a schema ADR precedes them.
