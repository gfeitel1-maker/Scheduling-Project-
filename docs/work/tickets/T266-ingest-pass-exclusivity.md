---
title: "Ingest pass exclusivity: a claimed event name never reaches the activity pass"
document_type: ticket
status: completed
created: 2026-09-26
archive_when: Through the REAL ingest path, ingesting a sheet containing (a) a name pinned to a period every operating day, (b) a genuine free-choice activity, and (c) a dual-use name yields all four of - 1. the pinned name does NOT appear in the free-choice activity catalogue and CANNOT be minted by resolving a reconciliation card affirmatively; 2. the pinned name still appears on the generated grid at its pinned period, exactly once per group per day, not zero times and not twice; 3. anchor name resolution for the pinned name still returns exactly one row, zero and two-or-more both being failures; 4. the free-choice name is unaffected and the dual-use name remains available to pass 3
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md]
related_adrs: [docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md, docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md]
related_tickets: [docs/work/tickets/T234-ingest-recurring-event-catalog-exclusivity.md]
---

# T266 — Ingest pass exclusivity: a claimed event name never reaches the activity pass

## The rule, in the product owner's words

Ingest walks the schedule three times. Pass 1 pulls FIXED events (carpool). Pass 2 pulls RECURRING
events (lunch, for whatever groups it applies to). Pass 3 pulls ACTIVITIES.

> "Once something is pulled from the first or second pass it should no longer be available to be
> pulled out in the third."

That methodology is correct and is not up for redesign. This ticket makes the code do it.

## Why a ticket already closed against this and the symptom survived

`docs/work/tickets/T234-ingest-recurring-event-catalog-exclusivity.md` (status: completed,
2026-09-23) closed against this exact symptom in the owner's own words: *"things that are recurring
events are also being pulled as activities when they should not."* T234 was correctly diagnosed and
correctly built — it widened *which* names reach the guard, from HIGH-confidence-only to every
inferred event name minus dual-use. It did not change *what the guard does*, and what the guard does
is the defect. T234 is not reopened and not reworded; it is cited.

## The defect, verified in the tree at c711ecaf

1. `src/screens/ImportScreen.jsx:756-765` already states the rule as intent, in a comment: an
   inferred fixed/recurring-event name that is not dual-use "is never a free activity-catalog
   choice, REGARDLESS of confidence", and forces `tier:'low'` "so it can never silently mint".
2. `src/ingest/buildPlan.js:574-585` does not honour it. Inside `emitCreate()` the pinOnly branch
   changes ONLY `tier` to `'low'`; the item is still `op: 'create'`. The row is created either way.
   **The comment asserts EXCLUSION and the code performs DEMOTION.**
3. The demoted name becomes a reconciliation card. `src/screens/ImportScreen.jsx:1253` copies the
   entire unfiltered approved list, and `src/screens/reconciliationResolutions.js:110-125` removes a
   name only inside `if (!isDecisionResolved(decision, answer))`. So a director answering *"yes,
   that looks right"* performs the very write the guard existed to prevent. **The director's act of
   diligence is what creates the duplicate.** This is the owner's reported symptom.

## The constraint that makes the naive fix dangerous

Do **not** simply stop creating the row.

Anchors resolve their activity **by name** against the activities catalogue —
`src/engine/anchorActivityLink.js:41-44`:

```js
if (anchor?.activity_id != null) return [anchor.activity_id]
return activitiesByName.get(anchorNameKey(anchor?.name)) ?? []
```

`[]` is treated as a correct no-op, and `anchor_activities` has **no `activity_id` column**. Both
suppression call sites — `src/engine/buildSchedule.js:177` (don't-place-it-twice) and
`src/engine/weekCatalog.js:65` (week exclusion) — depend on that resolution succeeding. So if pass
1/2 removes the name from the catalogue entirely, the suppression silently switches off and events
get placed twice: no error, no finding, no red test. This repository has already paid for that exact
failure once (T62's exclusion Set was empty in production for a month behind a green unit test that
hand-built a field real rows lack).

**Pass 1/2 must therefore leave a MARKER, NOT A HOLE.** The row remains present so name resolution
still succeeds, and carries a visibility flag that keeps it off pass 3's menu and out of the
free-choice activity catalogue. A flag on the existing activity row — not a new entity, not a new
table.

## Already solved; not rebuilt

The dual-use carve-out. `src/screens/ImportScreen.jsx:766-768` computes `dualUseSet` and derives
`eventNonDualUseNames` as inferred-event names MINUS dual-use. A name that is genuinely both a
recurring event and a free choice (a swim that is scheduled AND selectable) never enters the pin-only
set. Strict exclusivity needs no new carve-out; this ticket uses what exists.

## Scope

**In:** `activities.catalog_role` (schema v75, TEXT, NULL = ordinary free choice, `'pinned_event'` =
excluded from pass 3 and from every free-choice menu); buildPlan writing the marker instead of
merely demoting; one shared `isFreeChoiceActivity` predicate applied at every free-choice read site;
flipping the governing ADR to `accepted`.

**Out:** the `activity_id` identity half of ADR Option A (keeping the row is exactly what makes it
unnecessary here, and it stays open); the elective preference model; T264.

## Owner decisions recorded

- Schema **v75**, with `.toBe(75)` tripwires in the sibling migration tests.

  This was briefly allocated as **v76**, on the reasoning that v75 was spoken for by an unpushed
  worktree (T197). That was wrong, and the correction is worth keeping: scanning worktrees prevents
  two branches CLAIMING one number, but `migrationDomainState.test.js` separately requires the
  sequence to be CONTIGUOUS on the branch being gated, and an unpushed v75 does not exist from
  main's point of view — so skipping to 76 left a hole and the gate said so. T266 takes v75 because
  it merges first; T197 renumbers to v76 and rebases onto this migration.

- The migration guard is **one-wide** (`>= 74 && < 75`), matching every block from v49 onward. It
  was briefly two-wide. The documented hazard (bug #194, `localDb.js:1975-1979`) is a bare `< N`
  with NO LOWER BOUND, and the remedy was to ADD `>= N-1` — not to widen the top. A `< N+1` upper
  bound re-fires a migration on a database already at N, which is not harmless for the several
  blocks here that do full table rebuilds.
- ADR `2026-09-26-ingest-category-exclusivity-and-anchor-identity.md` flips to **accepted**, Option A
  direction, ruled by the owner 2026-09-26.
- ADR OQ2 — a pinned event's row is **hidden from the catalogue entirely**, not greyed, not
  deprioritised. Unavailable.
- One shared filter, every reader. A second hand-written copy of the predicate is how the UI and the
  export come to disagree about what exists.

## The marker is symmetric (added in review)

Red Hat's review found that writing the marker one way only makes a
misclassification a one-way door: the inference is a majority-of-days heuristic,
OQ2 chose "hidden entirely" rather than "greyed", and there is therefore no
surface anywhere in the app on which a director could see the marker, let alone
undo it. An activity would simply vanish with no error and no route back short
of hand-editing SQLite.

So a re-import that no longer claims a name CLEARS the marker. This is narrow by
construction: the recognized-update arm runs only for names the current import
actually carries, so a name absent from the sheet is never touched and a partial
import cannot un-mark the rest of the camp. Re-importing a corrected sheet is the
recovery path, which is one the director already has.

This does not weaken the owner's rule. While a name IS claimed by pass 1 or 2 it
is unavailable to pass 3, absolutely. The symmetry governs what happens when a
LATER import says the name is no longer claimed.

**The clear path is as deliberate as the set path.** Symmetry re-arms the original bug if it is
sloppy: an import that fails to detect a genuine event would clear its marker and silently re-expose
it as a free choice. So a marker is cleared ONLY because the name is genuinely absent from a claimed
set that was actually computed for that import — never as a default, never because the field was
missing or the import was partial.

The concrete hazard, which is live rather than theoretical: only ImportScreen computes a claimed set.
Every other caller — the MCP ingest server, a workbook re-import, the clipboard/schedule path, and
every fixture predating the field — reaches `commitIngest` through `pinOnlyActivityNames ?? []`
(`electron/main.js:421` and `:510`, `src/localClient.mock.js:832`). By value, their empty set is
indistinguishable from "this import read the sheet and found nothing pinned". Treating those the same
would let one MCP or workbook re-import un-mark a camp's entire event catalogue. `buildPlan` therefore
clears only when the claimed set is NON-EMPTY (`pinOnlyDetectionRan`).

Residual, stated rather than hidden: an import whose claimed set drops to exactly zero will not clear
that last marker. That is the safe direction of the ambiguity and is a deliberate choice.


## Sync: a disagreement about the category reaches a human

Owner ruling, 2026-09-26: a disagreement about `catalog_role` must raise a conflict, exactly like any
other same-field disagreement. Not last-writer-wins, not a silent merge, not a field that quietly
fails to sync.

The reasoning is domain-level, not technical. **An activity's category is a fact about the camp, not
an opinion a device holds.** Lunch is either a fixed event (everyone eats at one time) or a recurring
event (several shifts); there is no camp where some groups eat at random times. So two devices can
never legitimately differ. Two consequences: the path essentially never fires in normal operation, so
it carries no ongoing annoyance cost; and when it DOES fire it is not noise but evidence that one
device ingested something wrong. Silently picking a winner would be the app choosing which of two
contradictory versions of the camp to believe, and the losing outcome re-exposes the pinned event as
a free-choice activity — the original bug, restored silently on one device.

**Which of the three outcomes the field has, read rather than assumed: it RAISES, by inheritance.**
Before this ticket the column did not exist at all. `PROJECTIONS[entity].fields` is the single gate
for BOTH syncing and conflict-raising — `applyWrite` (`electron/automerge/campDocument.js:569`) drops
any field absent from that list, so an unregistered field never enters the document and can neither
sync nor conflict; and `reconcile` (`electron/automerge/reconcile.js:75-107`) walks every key of every
collection with `A.getConflicts` and has **no field allowlist or denylist at all**. Registering
`catalog_role` so it would materialize in SQLite therefore also enrolled it in conflict detection.

**No code was added to make that look deliberate.** What was missing was the evidence, and that is
`electron/catalogRoleConflict.test.js`: two divergent documents, really merged, really reconciled,
asserting the `conflicts` ROW came back with `field = 'catalog_role'` and both values intact. Non-
vacuity runs the other way too — a control where the two devices AGREE raises nothing, an unregistered
field raises nothing, and de-registering `catalog_role` at source turns four of the six tests red.

The one thing genuinely added for humans: `src/screens/ConflictsScreen.jsx` gets a real label for the
field, so the director is asked about "whether an activity is a scheduled event or a free choice"
rather than "a change to this record".

## Known limit (not addressed here, deliberately)

- **ImportScreen's React layer is not exercised by the acceptance test.** The derivation it uses IS
  covered — it is the same `src/ingest/pinOnlyActivityNames.js` module, called from the same
  `inferFixedEvents` output — but the component is not mounted. The path is not tested end to end
  through the UI.

## Testing bar

Non-vacuity is mandatory: plant the defect, show red, restore, show green — including at least one
defect the guard's own description would not lead you to. Predicate clause 2 in particular cannot be
demonstrated by a hand-built fixture: the leak is created by the RESOLUTION path, not by the data, so
it must be routed through the real ingest path or plainly reported as not discharged. Fixtures are
built from the SCHEMA, not from the code under test, and assertions are on the ROW that came back,
not on a call having been made.
