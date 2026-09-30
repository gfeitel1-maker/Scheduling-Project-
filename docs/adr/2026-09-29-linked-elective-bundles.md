---
title: "Linked multi-period elective bundles — storage shape and the per-tier choice-id/rank collision"
document_type: adr
status: proposed
authority: normative
implementation_state: not-started
date: 2026-09-29
task_class: database-sync
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/GOVERNANCE_INDEX.md
related_adrs:
  - docs/adr/2026-09-17-individual-elective-scheduling.md
related_specs:
  - docs/work/specs/2026-09-29-t301-linked-elective-bundles-design.md
related_tickets:
  - docs/work/tickets/T301-linked-elective-choices-never-reach-the-solver.md
  - docs/work/tickets/T219-multi-day-catalog-linkage.md
affects:
  - electron/db/schema.sql
  - electron/db/localDb.js
  - electron/db/rollback/v81_down.js
  - electron/ops/projections.js
  - electron/ops/electiveDerivedIds.js
  - src/engine/buildElectiveAssignments.js
  - src/screens/elective/assignment/deriveChoices.js
  - electron/ops/commitElectiveRun.js
  - src/screens/elective/assignment/AssignmentPanel.jsx
  - docs/current/PLATFORM_STATE.md
---

# Linked multi-period elective bundles — storage shape and the per-tier choice-id/rank collision

## Status

Proposed, 2026-09-29, architect. This settles the one open architectural decision the design spec
(`docs/work/specs/2026-09-29-t301-linked-elective-bundles-design.md`) left for the ADR, plus two
collisions found while tracing the decision to ground truth that the spec did not name. Awaiting
owner approval (GOVERNANCE_INDEX database/sync row: **ADR + migration/rollback plan**). Slice 1
only (schema + derivation); slices 2 (authoring UI) and 3 (wiring the solve/commit path) are not
authorized by this ADR and are Designer's and a later Maker round's work respectively.

## Context

T247 built a two-tier solver. Tier 1 (`runLinkedChoiceTier`, `src/engine/buildElectiveAssignments.js:576-766`)
places a *linked choice* — a set of occurrences a camper takes together or not at all — atomically
across its members, and is complete, deterministic, tested, and **unreachable in the product**
(T301): nothing ever writes `elective_choices.is_linked = 1` or gives a choice more than one
`elective_choice_offerings` row. The owner ruled 2026-09-29 that the feature is wanted. Four
authoring decisions were taken the same day and are not reopened here (bundle = director-picked
subset of an offering's periods; division/tier scoping is fully general; an activity may carry more
than one bundle; a bundle's name is proposed and director-editable, because it is the string a
camper's sheet must match).

The spec traced one collision and asked the ADR to settle it: a bundle serving more than one tier
must expand into one `elective_choices` row per tier (tier 1's `absent` rule excludes a camper who
does not attend *every* member occurrence, so one cross-tier choice excludes everyone), but
`deriveElectiveChoiceId(runId, labelKey)` keys on label alone, so two tiers' choices for one bundle
collide on one id.

Verifying that against the tree surfaced two more collisions the spec did not name, both confirmed
by reading the actual resolution code, not by inspection alone:

1. **The rank collision.** `buildElectiveAssignments.js`'s preference loop resolves a labelKey-only
   preference through `choiceByLabelKey`, which keeps only the **lowest-id** choice per label
   (`:182-186`) and records the camper's rank against only that one choice's id in `rankByChoice`
   (`:274-276`). Two same-named per-tier choices mean the second tier's campers can never register a
   rank against their own tier's choice id — `choiceRankMinOverMembers` (`:254-264`), which tier 1
   reads by choice id, returns `null` for them, and the whole tier is silently unplaceable, with no
   finding.
2. **The sheet/bundle coexistence gap (not previously named).** Decision 4 makes a bundle's name the
   string a camper's *sheet* is expected to match — so a real camp's imported preference sheet will
   plausibly name a bundle by its bundle label, not its activity name. Tracing `commitElectiveRun.js`'s
   preference-writing loop (`:394-421`) against `buildElectiveAssignments.js`'s resolution order
   (`:266-277`) shows that a preference row's stored `choice_id` — once one exists — is resolved
   **before** `labelKey`, unconditionally. If `commitElectiveRun` keeps minting an ordinary,
   un-linked sheet choice for that label (as it does today, `:394-397`, hardcoding `is_linked: 0`),
   every camper who wrote the bundle's name on their sheet has their rank recorded against that plain
   choice's id, which is not a member of any bundle's `elective_choice_offerings` — their preference
   never reaches tier 1 at all, and (traced one level further) does not even reach tier 2 correctly:
   tier 2's `rankAt` looks up by the **offering's** labelKey, which `buildOfferings.js` derives from
   the **activity's own name**, not the choice's label (confirmed by the comment at
   `AssignmentPanel.jsx:552-554`) — so a bundle-named sheet preference matches neither the bundle nor
   the plain activity, and that camper is placed as if unranked, in whichever single period the
   ordinary per-occurrence pass happens to seat them, losing the all-or-nothing guarantee entirely.
   This is the same silent-failure shape as collision 1, one layer further from where the spec was
   looking, and it is the one that will actually fire the first time a real camp's sheet names a
   bundle.

## Decision

### D1 — New setup-level storage, sibling to `elective_set_activities`, not the run-scoped participant substrate

Two new tables plus one exception-list child table, all schema v81 (see D9 for why v81, not a
reused number):

```sql
-- elective_bundles (schema v81, T301, ADR docs/adr/2026-09-29-linked-
-- elective-bundles.md). A director-authored declaration that an activity's
-- offering on an elective set is taken AS A SET across more than one of the
-- set's periods, placed all-or-nothing (tier 1 of buildElectiveAssignments.js,
-- T247 -- built, tested, and unreachable in the product until this ticket).
--
-- SETUP-LEVEL, LIKE elective_set_activities, NOT RUN-SCOPED LIKE
-- elective_choices. A bundle must outlive a run -- authored once, solved
-- against every week -- mirroring exactly the split the design spec draws
-- between elective_set_activities (persists across runs) and elective_choices
-- (run-scoped, rebuilt every generation, D6 of the 2026-09-17 ADR). The
-- run-scoped expansion of a bundle into per-tier elective_choices rows is
-- deriveChoices.js (beside deriveOccurrences.js), not this table -- see D3.
--
-- NOT elective_set_activities, DELIBERATELY. That table carries an inline
-- UNIQUE(elective_set_id, activity_id) (this file, above), and decision 3
-- of the design spec (an activity may carry MORE THAN ONE bundle) is fatal
-- to reusing it -- relaxing an inline UNIQUE in this codebase is a
-- table-rebuild migration plus a two-direction sweep, the wrong price when a
-- sibling table with no such constraint costs one migration block. This
-- table has no UNIQUE(elective_set_id, activity_id): that is the point.
--
-- activity_id has NO SQL REFERENCES, matching elective_set_activities.
-- activity_id exactly (soft pointer; a dangling one renders as an em dash,
-- same as everywhere else in this schema). elective_set_id IS a real
-- REFERENCES, also matching elective_set_activities exactly -- both are HARD
-- FKs under foreign_keys = ON, so both need the SAME ensureExists
-- reconstruct-both-then-insert-once stub-seed treatment in projections.js
-- that elective_set_activities' own entry uses (see D2 of this ADR's
-- Consequences).
--
-- MEMBERS ARE (day_id, time_block_id) PAIRS, in elective_bundle_periods
-- below -- NOT occurrence_id. An occurrence is run-scoped and re-derived
-- every generation; storing one here would tie an authored bundle to a run
-- that may no longer exist by the time it is next solved. Tier falls out at
-- expansion time (deriveChoices.js resolves (day_id, time_block_id, tier_id)
-- against whatever occurrences THIS run actually derives).
--
-- NO ADJACENCY, NO span_blocks, ANYWHERE (design spec decision 5). Members
-- are an arbitrary edge list; nothing here or in deriveChoices.js validates
-- or derives contiguity.
--
-- name IS PROPOSED AND DIRECTOR-EDITABLE (decision 4) -- it is what a
-- camper's imported sheet must match, so it must read the way the camp's own
-- catalog does. NO UNIQUE on name, deliberately, matching event_groups' and
-- event_time_blocks' own precedent for a director-editable child label: two
-- bundles (or a bundle and an unrelated sheet-only choice) sharing a name
-- degrade to "the same nameable thing" for sheet-matching -- see D6 -- which
-- a director fixes by renaming, rather than risking the cross-device
-- UNIQUE-collision hazard an inline UNIQUE on a collaboratively-edited text
-- field invites in this codebase (T233 and its merge-unique-collision
-- history).
--
-- scope_mode / elective_bundle_tiers (below) express the design spec's
-- decision 2, "fully general" tier scoping -- "all tiers", "a few tiers",
-- and "all but one" are three spellings of one primitive, not three
-- features (D2 of this ADR). New table (T301) -- column order is free to
-- choose, there is no pre-existing shape to stay compatible with.
CREATE TABLE IF NOT EXISTS elective_bundles (
  id TEXT PRIMARY KEY,
  elective_set_id TEXT NOT NULL REFERENCES elective_sets(id),
  activity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  scope_mode TEXT NOT NULL DEFAULT 'all'
    CHECK (scope_mode IN ('all', 'only', 'except')),
  sort_order INTEGER
);
CREATE INDEX IF NOT EXISTS idx_elective_bundles_set ON elective_bundles(elective_set_id);

-- elective_bundle_periods (schema v81, T301). A bundle's member periods --
-- see elective_bundles' comment for why (day_id, time_block_id), not
-- occurrence_id. Parent-scoped by bundle_id, no elective_set_id column
-- (redundant with the parent's) -- matches elective_choice_offerings' shape
-- (parent-scoped by choice_id), not elective_set_activities' (set-scoped):
-- this table has exactly one reason to exist, naming one member cell of one
-- bundle.
--
-- bundle_id has NO SQL REFERENCES -- a pure child row, same posture as
-- elective_choice_offerings.choice_id. day_id/time_block_id also carry no
-- REFERENCES, matching template_slots' and event_slots' own soft pointers to
-- the same two entities.
--
-- id IS A PLAIN randomUUID(), minted by the renderer at the moment a
-- director selects a cell -- NOT a derived id. Unlike the run-scoped
-- solve-time ids in electiveDerivedIds.js, there is no cross-device
-- independent-recomputation hazard to close here: a bundle's period list is
-- authored by one discrete user gesture at a time, and two devices that
-- offline-concurrently add "the same" (bundle_id, day_id, time_block_id)
-- member produce two rows stating the identical fact -- harmless
-- duplication, matching event_groups' own accepted duplicate-child-row
-- precedent (that table's comment, this file). deriveChoices.js (D3) dedupes
-- by (day_id, time_block_id) before deriving occurrence ids, rather than
-- relying on storage to guarantee uniqueness.
--
-- NO UNIQUE(bundle_id, day_id, time_block_id), for the same reason: an
-- inline UNIQUE on a row two offline devices can both legitimately write is
-- the exact hazard this codebase's merge-unique-collision history warns
-- against. A duplicate is inert; deriveChoices.js's dedupe is the
-- correctness boundary, not a DB constraint.
CREATE TABLE IF NOT EXISTS elective_bundle_periods (
  id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL,
  day_id TEXT NOT NULL,
  time_block_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_elective_bundle_periods_bundle ON elective_bundle_periods(bundle_id);

-- elective_bundle_tiers (schema v81, T301). The scope EXCEPTION list --
-- read only when the parent's scope_mode is 'only' or 'except' (see D2). A
-- row here while scope_mode = 'all' is simply ignored by deriveChoices.js,
-- never validated away -- scope_mode is the sole authority, the same
-- discipline elective_set_activities' capacity_mode/capacity_limit and
-- min_mode/min_to_run pairs already established in this file (see that
-- table's own comment for why a cross-column pairing CHECK is wrong under
-- applyProjection's one-field-per-op write model, and why an authority mode
-- plus a separately-true value/list beats a single wide column).
--
-- Same posture as elective_bundle_periods: no REFERENCES, id is a plain
-- randomUUID() minted at authoring time, duplicates are inert and
-- deriveChoices.js dedupes by tier_id via a Set, no UNIQUE(bundle_id,
-- tier_id) for the same offline-concurrent-write reason.
CREATE TABLE IF NOT EXISTS elective_bundle_tiers (
  id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL,
  tier_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_elective_bundle_tiers_bundle ON elective_bundle_tiers(bundle_id);
```

No change to `elective_choices` or `elective_choice_offerings` — both already have exactly the
shape a bundle-derived row needs (verified against `schema.sql:1493-1507`). The v81 migration is
additive-only: three new tables, no `ALTER`.

### D2 — Scope is a mode plus an exception list, not enumerated rows and not a bare predicate

Three candidates from independent divergent framings converged on two poles: enumerate every
applicable tier as its own row (simple, `applyProjection`-safe, but an "all tiers" bundle silently
excludes a tier added after authoring — a real staleness bug, not hypothetical, since tiers are
ordinary director-editable rows), or store scope as a rule evaluated against the live roster (always
current, but "a few tiers" still needs *some* enumerated list, so a pure rule cannot express the
spec's own decision-2 example on its own).

**Decision: a `scope_mode` enum (`'all' | 'only' | 'except'`) on `elective_bundles`, plus
`elective_bundle_tiers` rows read only when the mode names a list.** `'all'` needs zero child rows
and stays correct as tiers are added, renamed, or removed later — an enumerated snapshot would not.
`'only'`/`'except'` hold the list the mode names. `scope_mode` is one atomic column, safe alone
under `applyProjection`'s one-field-per-op model; the exception rows are independently-true child
facts, safe under the same model for the reason `elective_bundle_tiers`' own comment states.

`deriveChoices.js`'s resolution rule (D3) is two-level and deliberately conservative at both levels:
resolve the bundle's scope **against the tiers actually present in this run's own occurrences for
this bundle's elective set** — never the camp's full tier list — so a scope of `'all'` or an
`'only'` list naming a tier with nothing scheduled in this elective set this week does not manufacture
a choice for a tier that is not relevant to this run at all. That is a tier-level filter. It is the
*only* filter deriveChoices.js applies — see D5 for why a bundle's individual member periods are
never filtered the same way.

### D3 — The linked-choice id is keyed on the bundle's own id, not on its label, and lives in `electiveDerivedIds.js` as a new id kind

The design spec's own option (A) proposed `deriveElectiveChoiceId(runId, labelKey, tierId)` at a new
per-kind version (`echo2:`), reaching `commitElectiveRun`'s `choiceIdByKey`. This ADR takes option
(A)'s shape — a tier-qualified id at a new per-kind version, not a change to tier 1's placement
algorithm and not authoring-time per-tier bundles — but changes what the id is keyed on, for two
reasons found while implementing the sketch rather than only reading it:

1. **Renaming a bundle must not re-key its solve-time choices.** The name is director-editable
   (decision 4) specifically so it can be corrected to match a real catalog. A labelKey-keyed id
   means every correction mints new choice ids mid-season; a bundle-id-keyed id does not.
2. **Decision 3 permits more than one bundle per activity, and two bundles can transiently share a
   label** (a director mid-edit, or two devices concurrently authoring offline). A labelKey-keyed
   id cannot tell those apart; a bundle-id-keyed one always can, because the key is the row's own
   opaque identity, not its current display text.

```js
// LINKED ELECTIVE BUNDLE CHOICE derivation version (T301), separate from V
// and PREFERENCE_V for the same reason PREFERENCE_V is separate from V: a
// different id kind with its own shape, and bumping the shared V would
// re-key camper ids along with everything else V governs.
const BUNDLE_CHOICE_V = 1

// Key: (run_id, bundle_id, tier_id). A linked bundle's per-tier expansion
// (T301, docs/adr/2026-09-29-linked-elective-bundles.md D3). Keyed on the
// bundle's own opaque, never-renamed id -- NOT its label -- so renaming a
// bundle never re-keys its choices, and two bundles of one activity that
// transiently share a label (decision 3 permits more than one bundle per
// activity) still derive distinct ids. Every component is an opaque
// surrogate (run_id, bundle_id, tier_id are all randomUUID-derived, the same
// argument deriveElectiveOccurrenceId already relies on for tier_id), so the
// result matches OPAQUE and needs NO carve-out in derivedChoiceId() the way
// the label-keyed deriveElectiveChoiceId needed CHOICE_ID_PREFIX -- smaller
// blast radius, and the reason this is its own function rather than a tier
// parameter grafted onto deriveElectiveChoiceId, which would also break R2's
// contract that that function's key is exactly (run_id, normalized label).
export function deriveLinkedElectiveChoiceId(runId, bundleId, tierId) {
  return `elbc${BUNDLE_CHOICE_V}:${join([
    opaque('run_id', runId),
    opaque('bundle_id', bundleId),
    opaque('tier_id', tierId),
  ])}`
}
```

Added to the existing `electron/ops/electiveDerivedIds.js`, not a new file: it shares `opaque()`,
`join()`, and the `OPAQUE` alphabet with every other elective id kind in that module, and the
module's own stated reason for being separate from `scheduleTemplateId.js` (a distinct back-compat
contract) does not apply between two id kinds inside the same feature family. `deriveElectiveChoiceOfferingId`
(existing, `:290-296`) needs **no change** — it already accepts any id that is either its own output
or matches `OPAQUE`, and `deriveLinkedElectiveChoiceId`'s output matches `OPAQUE` for the reason
stated in the comment above, so it is usable as a `choiceOfferings.choice_id` component unmodified.

`elective_bundles.id`, `elective_bundle_periods.id`, and `elective_bundle_tiers.id` are **not**
derived ids — see their own schema comments (D1). Only the run-scoped choice id needs
cross-device convergence; the authored rows do not.

### D4 — The rank collision is fixed by broadcasting a labelKey-resolved rank to every choice sharing that label, not by changing the placement algorithm

`buildElectiveAssignments.js`'s preference loop (`:266-277`) is the only place the collision needs
fixing — tier 1's own logic (`choiceRankMinOverMembers`, `:254-264`) is correct once it is fed a rank
recorded against the right choice id, so it stays untouched, honoring the hard constraint that tier 1's
placement algorithm is not to change.

Current code:

```js
const ch = (p.choice_id != null ? choiceById.get(p.choice_id) : undefined)
  ?? (p.labelKey != null ? choiceByLabelKey.get(p.labelKey) : undefined)
  ?? null
const labelKey = p.labelKey ?? ch?.labelKey ?? null
if (labelKey != null) {
  record(entryFor(rankOf, p.camper_id, labelKey), p.occurrence_id ?? null, p.rank)
}
if (ch) {
  record(entryFor(rankByChoice, p.camper_id, ch.id), p.occurrence_id ?? null, p.rank)
}
```

`rankOf` (tier 2's map, keyed by raw labelKey) already has no collision — every per-tier choice
shares the label deliberately (D6 below), and `rankOf` is keyed by that shared label directly, not by
choice id. The collision is entirely in `rankByChoice`, whose population picks exactly one `ch`
(`choiceByLabelKey`'s lowest-id winner) when resolution falls through to labelKey. Fix, scoped to
that one branch:

```js
const choicesByLabelKey = new Map() // labelKey -> choice[], ALL of them, not one
for (const c of choices) {
  if (!choicesByLabelKey.has(c.labelKey)) choicesByLabelKey.set(c.labelKey, [])
  choicesByLabelKey.get(c.labelKey).push(c)
}
// ... inside the preference loop, replacing the `if (ch) { record(...) }` line:
if (p.choice_id != null && ch) {
  record(entryFor(rankByChoice, p.camper_id, ch.id), p.occurrence_id ?? null, p.rank)
} else if (p.labelKey != null) {
  for (const c of choicesByLabelKey.get(p.labelKey) ?? []) {
    record(entryFor(rankByChoice, p.camper_id, c.id), p.occurrence_id ?? null, p.rank)
  }
}
```

An explicit `choice_id`-based preference still resolves to exactly one choice, unambiguous by
construction — unchanged. A labelKey-based preference now records its rank against **every** choice
sharing that label, so `choiceRankMinOverMembers` finds it regardless of which tier's expansion it
is asked about. `choiceByLabelKey` (the single-winner map) stays, unmodified, for `ch?.labelKey`'s
role in populating `rankOf` — that role needs *a* labelKey, not a specific choice, so it has no
collision to fix.

**What this fix cannot see.** It broadcasts a *labelKey-resolved* rank; a preference that already
carries an explicit (and wrong) `choice_id` is untouched, because `choice_id`-based resolution was,
and remains, exactly-one-match by construction — a stored preference naming the wrong tier's choice
id is a data-integrity question this fix does not address and nothing at this layer should paper
over.

### D5 — `deriveChoices.js` never pre-filters a missing member occurrence; tier 1's existing case (a) does that job

The design spec asked whether `deriveChoices` should pre-empt tier 1's case (a) (`UNSUPPORTED_LINKED_CHOICE`
for "a member names an occurrence this run does not contain", `buildElectiveAssignments.js:602-618`).

**Decision: no.** `deriveChoices.js` always emits a `choiceOfferings` row for every member
`(day_id, time_block_id)` of a bundle, for every tier its scope resolves to, computing the
occurrence id via the **same** `deriveElectiveOccurrenceId(runId, electiveSetId, dayId, timeBlockId, tierId)`
function `deriveOccurrences.js` uses — regardless of whether that exact occurrence exists among this
run's derived occurrences. When it does not (a director unplaced that cell, or that tier simply has
no class at that day/block), the computed id is absent from `occurrenceIdSet`, and tier 1's own case
(a) fires exactly as it already does for any other malformed linkage — no new code path, no duplicated
exclusion logic that could drift from the tested one. This is a direct instance of reusing an
existing, tested guard rather than building a second one that checks the same fact.

The tradeoff, named rather than hidden: case (a)'s message ("lists a period that is not part of this
run") is generic and was written for a different authorship error; it remains accurate but not
maximally specific for "an authored bundle's member period isn't scheduled for this tier this week."
Accepted for slice 1 as the smaller responsible change; revisit the message only if directors report
it as unclear in practice.

### D6 — Coexistence policy: a bundle's label supersedes a plain sheet choice of the same label; a camper's preference for that label resolves to the bundle's own per-tier choice, never a separately-minted sheet choice

This is the collision named in Context item 2, and the ticket explicitly requires the ADR to settle
it.

**Decision.** When at least one bundle exists for a label (in any tier it resolves to), a camper's
sheet-derived preference naming that label must resolve, at commit time, to that bundle's per-tier
choice for **the camper's own tier** (derivable from `campers.group_id` → `groups.tier_id`, both
already stored) — never to a separately-minted plain `elective_choices` row for that label. A plain
sheet-derived choice continues to be minted, exactly as today, only for a label no bundle claims.

This is the only resolution consistent with decision 4's own stated purpose: the bundle's name
**is** proposed specifically so it matches what a camper's sheet says, which only pays off if a
sheet-recorded preference for that name is actually wired to the bundle's placement mechanism rather
than to an inert, unlinked lookalike choice sharing its text.

**Consistency with D3/D4.** All of a bundle's per-tier expansions deliberately share one label —
that is what makes decision 4's "one name, matched by a sheet regardless of the camper's tier" work,
and it is exactly why D4's broadcast fix (not a label-uniqueness fix) was the right shape for the
rank collision: the two decisions assume the same fact about labels on purpose, not by accident.

**Scope and consequence, stated plainly.** The mechanism above lives in `commitElectiveRun.js`'s
preference-writing loop (`:400-472`), which is **slice 3** (wiring), not slice 1. What slice 1 owes
slice 3, and delivers: a bundle-derived choice id that slice 3 can compute directly from
`(run_id, bundle_id, tier_id)` via `deriveLinkedElectiveChoiceId` (D3) without needing anything from
`deriveChoices.js`'s in-memory output — so slice 3's implementation is a lookup against the
`elective_bundles`/`elective_bundle_tiers` tables plus one derived-id call, not a dependency on
solve-time state. Slice 3 must also decide, and this ADR does not, the exact SQL for resolving a
camper's tier at commit time and the UI/copy consequence (does a director ever see the superseded
plain choice) — those are implementation and product-copy questions, not storage or id-scheme
questions, and are out of this ADR's scope.

`commitElectiveRun`'s existing hardcoded `is_linked: 0` (`:397`) stays correct for the sheet path
(plain choices remain unlinked by construction). Slice 3's new write loop for bundle-derived choices
should write `is_linked: 1` — a small, correct improvement that finally makes the column meaningful
for the case it names, though nothing in the engine reads it (tier 1 derives "linked" from member
count, deliberately, per that module's own comment) — so this is cosmetic-but-truthful, not
load-bearing, and slice 3 may defer it without correctness consequence if time-boxed.

**Amendment 2026-09-30 (board item 9b, T318 close-out).** D6's "only for a label no bundle claims"
is narrowed by exactly one case: a camper whose tier the bundle's scope genuinely does **not** cover
now has a plain choice minted on demand for that label, and their ranking is written against it —
alongside, not instead of, the `BUNDLE_TIER_NOT_COVERED` finding. D6 was written on the premise that
a camper's tier is always derivable via `campers.group_id`, and does not adjudicate the uncovered
case at all; it also defers the UI/copy consequence to slice 3 by name. The narrowing is directed by
CONSTITUTION Art. V — the engine surfaces conflicts and never resolves them silently, and dropping a
child's written answer is absorbing one. This is the only exception: where a bundle does cover the
camper, D6's rule is unchanged. (D6's parenthetical tier derivation is also superseded in practice —
see `electron/ops/camperElectiveIdentity.js`, which resolves `division_label` first.)

### D7 — No schema-level uniqueness on bundle name; the naming rule is proposed-default plus director edit

Decision 4 requires a proposed, editable name. This ADR does not design the authoring control
(Designer's job, slice 2) but constrains what it must produce: **the default proposed for a bundle's
first period selection should be the activity's own name** (the common case — many camps do not
distinguish a bundle's catalog name from its activity's); **the default proposed for a second or
later bundle on the same activity must not repeat the bare activity name**, since two unedited
defaults would silently share a label and collide exactly as D6 describes for a sheet/bundle pair —
a human-legible disambiguator (e.g. the member periods' day/time-block labels) is Designer's to
choose, not this ADR's.

No `UNIQUE` constraint on `elective_bundles.name`, matching `event_groups`'/`event_time_blocks`' own
precedent (D1's schema comment) — a same-named pair (two bundles, or a bundle and a sheet-only
choice) degrades to "the same nameable thing" for matching purposes (D6), which a director corrects
by renaming; an inline `UNIQUE` on a collaboratively-edited text field is this codebase's own
documented merge hazard (T233) and would price a rename-collision far higher than the collision
itself costs.

### D8 — Two bundles of one activity overlapping on a cell: accepted existing engine limit, not reopened

Tier 1's case (c) (`buildElectiveAssignments.js:620-648`) refuses **both** of two linked choices that
share a member occurrence — an owner-accepted, documented, tested limitation of the two-pass
bipartite construction (2026-09-23 ADR decision (c) and its "WHAT THIS CANNOT DO" comment), not a
bug. Two bundles of one activity whose periods overlap on one cell (e.g. Mon P3+P4 and Mon P3+Thu P2,
both including Mon P3 for the same tier) inherit this refusal automatically and correctly — nothing
in `deriveChoices.js` needs to detect or special-case it, because `elective_choice_offerings` rows
from two different bundles naming the same occurrence id trigger the exact code path that already
exists for any two colliding linked choices, bundle-derived or not.

**Decision: accept this as-is for slice 1.** Recommended, not decided here: slice 2's authoring
control should warn a director at authoring time when a new bundle's periods overlap an existing
bundle of the same activity on the same tier, since the condition is fully checkable client-side and
catching it before a solve is strictly better than a director discovering it via a runtime finding.
Routed to Governor as an open question (see below), not settled by this ADR.

### D9 — Schema version v81; migration and rollback shape

`CURRENT_SCHEMA_VERSION = 80` (`electron/db/localDb.js:42`), confirmed against all local and remote
refs 2026-09-29 (see ticket). v81 is free.

Migration block, matching the shape this file already uses for a pure-new-table version (the v67
`device_identity_key` block, `localDb.js:2874-2889`, which inlines its `CREATE TABLE IF NOT EXISTS`
inside the versioned block in addition to schema.sql's own unconditional copy, rather than relying on
schema.sql's unconditional `db.exec(schema)` alone) — no `ALTER`, since these are wholly new tables:

```js
// v81 (T301, docs/adr/2026-09-29-linked-elective-bundles.md) -- linked
// elective bundle authoring: elective_bundles, elective_bundle_periods,
// elective_bundle_tiers. Three wholly new tables, so no ALTER and no
// column-order migrated-vs-fresh hazard (that hazard is specific to adding a
// column to an EXISTING table, which CREATE TABLE IF NOT EXISTS does not
// reconcile on its own -- see this block's sibling comments for v78/v79/v80).
if (getSchemaVersion(db) >= 80 && getSchemaVersion(db) < 81) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS elective_bundles (
        id TEXT PRIMARY KEY,
        elective_set_id TEXT NOT NULL REFERENCES elective_sets(id),
        activity_id TEXT NOT NULL,
        name TEXT NOT NULL,
        scope_mode TEXT NOT NULL DEFAULT 'all'
          CHECK (scope_mode IN ('all', 'only', 'except')),
        sort_order INTEGER
      )
    `)
    db.exec('CREATE INDEX IF NOT EXISTS idx_elective_bundles_set ON elective_bundles(elective_set_id)')
    db.exec(`
      CREATE TABLE IF NOT EXISTS elective_bundle_periods (
        id TEXT PRIMARY KEY,
        bundle_id TEXT NOT NULL,
        day_id TEXT NOT NULL,
        time_block_id TEXT NOT NULL
      )
    `)
    db.exec('CREATE INDEX IF NOT EXISTS idx_elective_bundle_periods_bundle ON elective_bundle_periods(bundle_id)')
    db.exec(`
      CREATE TABLE IF NOT EXISTS elective_bundle_tiers (
        id TEXT PRIMARY KEY,
        bundle_id TEXT NOT NULL,
        tier_id TEXT NOT NULL
      )
    `)
    db.exec('CREATE INDEX IF NOT EXISTS idx_elective_bundle_tiers_bundle ON elective_bundle_tiers(bundle_id)')
  })()
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (81, ?)').run(
    new Date().toISOString()
  )
}
```

Rollback, `electron/db/rollback/v81_down.js`, matching `v80_down.js`'s shape and its
`DELETE FROM schema_migrations WHERE version >= 81` convention (not `= 81`, for the reason `v80_down.js`'s
own comment states — stranding a higher version on a database that migrated further):

```js
// Inverse of migration v81 (electron/db/localDb.js) -- T301, linked elective
// bundles.
//
//   1. DROP the three new tables outright (not ALTER DROP COLUMN -- these are
//      whole tables this migration introduced, nothing pre-existing to
//      preserve).
//   2. Order: children before parent (elective_bundle_periods,
//      elective_bundle_tiers, then elective_bundles) -- no FK enforces this
//      (bundle_id is a soft reference, D1), but it keeps the rollback
//      legible as "undo the leaves, then the root" and costs nothing.
//   3. No registry membership restored: this script does not touch
//      PROJECTIONS (electron/ops/projections.js) or any other registry.
//      Those are separate, deliberate code changes a schema-only rollback
//      does not undo -- same ruling as v77_down/v79_down/v80_down.
//   4. Data loss: every authored bundle, its periods, and its tier scope are
//      discarded outright. There is no prior state to restore -- none of
//      these tables existed before v81. A director who had authored bundles
//      must author them again. Unlike v80's rollback, this is not a lost
//      CONSTRAINT on otherwise-live data -- it is the removal of rows whose
//      only consumer (deriveChoices.js, tier 1) also stops being reachable
//      the moment this rollback runs, so nothing downstream is left
//      half-referencing a dropped table.
//
// Usage: node electron/db/rollback/v81_down.js <path-to-shoresh.sqlite>

const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

export function rollbackV81(db) {
  const discarded = {
    bundles: hasTable(db, 'elective_bundles')
      ? db.prepare('SELECT COUNT(*) c FROM elective_bundles').get().c
      : 0,
    periods: hasTable(db, 'elective_bundle_periods')
      ? db.prepare('SELECT COUNT(*) c FROM elective_bundle_periods').get().c
      : 0,
    tierExceptions: hasTable(db, 'elective_bundle_tiers')
      ? db.prepare('SELECT COUNT(*) c FROM elective_bundle_tiers').get().c
      : 0,
  }

  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS elective_bundle_periods')
    db.exec('DROP TABLE IF EXISTS elective_bundle_tiers')
    db.exec('DROP TABLE IF EXISTS elective_bundles')
    db.prepare('DELETE FROM schema_migrations WHERE version >= 81').run()
  })()

  return { ok: true, discarded }
}

if (process.argv[1] && process.argv[1].endsWith('v81_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v81_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  const result = rollbackV81(db)
  db.close()
  console.log(
    `v81 rolled back: discarded ${result.discarded.bundles} bundle(s), ${result.discarded.periods} ` +
    `period row(s), ${result.discarded.tierExceptions} tier-scope row(s). There is no prior state to ` +
    'restore -- none of these tables existed before v81. A director who had authored bundles must ' +
    'author them again. This app build still declares schema version 81 -- reopening it re-creates ' +
    'all three tables, empty.'
  )
}
```

A migration test (`electiveBundles.migration.test.js` or folded into the existing elective-migration
suite) must assert fresh-install and migrated-forward column sets/order match for all three tables
(GOVERNANCE_INDEX's mandatory fresh-vs-migrated check), that exactly one `schema_migrations` row with
`version = 81` is written, and — separately, because column-order parity cannot see this — that
`scope_mode` actually rejects a fourth value (`INSERT ... VALUES (..., 'sometimes', ...)` must throw).
A rollback test mirrors `v80_down`'s own test shape: migrate to v81, insert one row per table, roll
back, assert all three tables are gone and no `schema_migrations` row `>= 81` remains.

### D10 — `deriveChoices.js` module contract

New file, `src/screens/elective/assignment/deriveChoices.js`, beside `deriveOccurrences.js`. Pure, no
IPC, no db — same discipline as its sibling.

```js
/**
 * Expands authored elective bundles into this run's per-tier linked choices
 * and their member offerings -- the run-scoped derivation deriveOccurrences.js
 * is to template_slots. Pure, no IPC, no db.
 *
 * SCOPE RESOLUTION is tier-level only (ADR D2/D5): a bundle's scope_mode/
 * elective_bundle_tiers resolve against the DISTINCT tier_ids present among
 * `occurrences` for the bundle's OWN elective_set_id -- never the camp's full
 * tier list -- so a tier with nothing scheduled in this elective set this run
 * never gets a manufactured, guaranteed-empty choice.
 *
 * MEMBER-PERIOD RESOLUTION IS NOT FILTERED (ADR D5): for every tier the scope
 * resolves to, every member (day_id, time_block_id) gets a choiceOfferings row,
 * computed via the SAME deriveElectiveOccurrenceId call deriveOccurrences.js
 * uses, regardless of whether that occurrence exists in `occurrences`. A
 * mismatch surfaces via buildElectiveAssignments' own existing
 * UNSUPPORTED_LINKED_CHOICE case (a) -- not duplicated here.
 *
 * DEDUPE, NOT UNIQUENESS, is the correctness boundary for bundlePeriods/
 * bundleTiers (ADR D1): storage allows duplicate rows for the same
 * (bundle_id, day_id, time_block_id) or (bundle_id, tier_id) fact
 * (offline-concurrent authoring), so this function deduplicates via Set
 * before iterating rather than trusting a DB constraint that does not exist.
 *
 * @param {object} input
 * @param {{id, elective_set_id, activity_id, name, scope_mode}[]} input.bundles
 * @param {{bundle_id, day_id, time_block_id}[]} input.bundlePeriods
 * @param {{bundle_id, tier_id}[]} input.bundleTiers  read only for bundles
 *        whose scope_mode is 'only' or 'except'
 * @param {{id, elective_set_id, day_id, time_block_id, tier_id}[]} input.occurrences
 *        this run's ALREADY-DERIVED occurrences (deriveOccurrences.js output)
 * @param {string} input.runId
 * @returns {{choices: {id, run_id, label, is_linked}[],
 *            choiceOfferings: {id, choice_id, occurrence_id, activity_id}[]}}
 *          Shapes match buildElectiveAssignments.js's own JSDoc (:156-159)
 *          exactly. No `findings` array (unlike deriveOccurrences.js) --
 *          see ADR D5 for why "missing occurrence" is deliberately not this
 *          module's finding to raise, and D2 for why "scope resolves to zero
 *          tiers" is not an error.
 */
export function deriveChoices({ bundles = [], bundlePeriods = [], bundleTiers = [], occurrences = [], runId } = {}) {
  // ... groups bundlePeriods/bundleTiers by bundle_id (Set-deduped per the
  // header above); for each bundle, resolves its tier set per ADR D2 against
  // `new Set(occurrences.filter(o => o.elective_set_id === bundle.elective_set_id).map(o => o.tier_id))`;
  // for each resolved tier, calls deriveLinkedElectiveChoiceId(runId, bundle.id, tierId)
  // once and deriveElectiveOccurrenceId(runId, bundle.elective_set_id, dayId, timeBlockId, tierId)
  // plus deriveElectiveChoiceOfferingId(choiceId, occurrenceId, bundle.activity_id)
  // per deduped member period.
}
```

Consumed by `AssignmentPanel.jsx`'s `solve()` (slice 3): called fresh on **every** solve, first or
re-solve, immediately after `deriveOccurrences` — never read back from stored `runChoices`, because
(like occurrences) a bundle's current definition is what must govern, not a stale snapshot from a
previous solve. Its output is unioned with whatever sheet-derived `choices` apply on that path
(`parsed.choices` on first solve, `runChoices` on re-solve) before the union reaches
`buildElectiveAssignments`. This also corrects the stale comment at `AssignmentPanel.jsx:555-558`
("Left EMPTY on the parsed path... where passing choices would newly feed the engine's dormant
linked-choice tier") — feeding that tier is now the intent on **both** paths, and slice 3 must update
that comment rather than leave it contradicting the shipped behavior.

### Candidates considered and rejected

Three independent forks, each with genuinely different answers surfaced by parallel divergent
framings (regulator/audit, adversarial, logistics, remove-the-fixed-assumption, and biological
analogy) before converging on the above:

- **Per-tier expansion timing.** *(a) Ephemeral, derived fresh at every solve* (adopted, D10) vs.
  *(b) the director authors one row per tier directly, no expansion step.* Rejected: (b) cannot
  express "all tiers" without staleness as tiers change, and it is the only one of the two that is
  NOT how this codebase already treats the sibling case (`elective_occurrences`/`elective_choices`
  are already rebuilt fresh every generation; (a) is the established pattern, (b) would be a new,
  inconsistent one).
- **Rank-collision fix.** *(a) Broadcast a labelKey rank to every choice sharing that label*
  (adopted, D4) vs. *(b) eliminate `choiceByLabelKey` and stamp a rank in in at choice-construction
  time via an explicit (camper_id, bundle_id) key.* Rejected for slice 1: (b) is a cleaner principle
  in isolation but requires restructuring when/where ranks are resolved relative to when choices
  exist, a larger and riskier change to a tested module than the fix the actual collision needs; (a)
  is a five-line change scoped to exactly the branch that collides.
- **Choice-id key.** *(a) Key on the bundle's own opaque id* (adopted, D3) vs. *(b) key on
  (labelKey, tierId), the spec's own literal sketch.* Rejected: (b) re-keys every choice on a
  director's rename and cannot distinguish two same-activity bundles that transiently share a label;
  (a) costs nothing extra (every component is already opaque, so `derivedChoiceId()` needs no change
  either way) and closes both gaps.

One idea surfaced by the divergent pass and rejected outright as a trap: a full append-only bundle
version ledger (stamping every edit with a new version, keeping bundle_id stable across versions) to
guarantee traceability of what a bundle looked like when a preference was recorded. This solves an
audit requirement nobody has asked for; the existing pattern (current authored state always governs,
matching R2's own precedent for the sheet-derived path) already answers "what happens when the
authored thing changes after a preference was recorded" without new storage, and Automerge's own op
history is the audit trail if one is ever needed. Not adopted.

## Consequences

- **Schema:** three new tables at v81 (additive only), with `v81_down.js` rollback. Rollback destroys
  every authored bundle outright (D9) — acceptable because nothing existed before v81 to preserve, and
  the feature's only consumer is removed in the same rollback.
- **PROJECTIONS (`electron/ops/projections.js`).** Three new entries are required — `elective_bundles`
  (hard FK stub-seed of its `elective_sets` parent, matching `elective_set_activities`' own entry
  exactly), `elective_bundle_periods`, and `elective_bundle_tiers` (both soft, reconstruct-then-insert
  with no parent stub-seed, since neither has a hard FK). **A new entity absent from PROJECTIONS means
  its writes never materialize, silently** — this is not optional bookkeeping. Full shapes are in D1's
  and D10's code blocks' surrounding prose; Maker should write these directly from
  `elective_set_activities`' own entry (`projections.js:489-546`) as the template, changing only the
  field lists and dropping the redundant parent-stub line for the two child tables.
- **Registration blast radius beyond PROJECTIONS is not fully enumerated here** — this ADR's mandate
  was the storage shape and the id/rank collisions, and the concrete sweep (`DIRECT_CAMP_ENTITIES`/
  `PARENT_SCOPED_ENTITIES`, `MODELED_ENTITIES`/`GENESIS_ENTITIES`, `permissions.js`, mocks, schema
  parity tests) was not independently re-verified file-by-file in this pass. The 2026-09-17 ADR's own
  Consequences section names the exact file list a comparable addition had to sweep; Maker's exit
  condition is parity across that same list for these three tables, verified by `grep`-ing every
  occurrence of `elective_set_activities` across those files and mirroring it, not by assuming this
  list is complete.
  - `MODELED_ENTITIES`/`GENESIS_ENTITIES` in particular: adding these requires regenerating the
    frozen `GENESIS_B64` blob, which the 2026-09-17 ADR's D13 states is free only because the project
    is pre-production with no real camp documents. **Maker must re-confirm that condition still holds
    on the day this lands**, not assume it from this ADR's date.
  - Permissions: these three tables carry no camper/PII data (pure catalog/setup structure), so they
    take **ordinary** entity permissions matching `elective_set_activities`, not the D9 admin-only
    treatment the five participant-substrate tables received — they are not one of that ruling's five
    named entities and nothing about them resembles that ruling's reasoning.
- **Engine (`src/engine/buildElectiveAssignments.js`).** One scoped change (D4), inside the existing
  preference-resolution loop, adding a `choicesByLabelKey` multimap alongside the existing
  `choiceByLabelKey`. Tier 1's placement algorithm, `choiceRankMinOverMembers`, and
  `choiceByLabelKey`'s other use are untouched. `buildElectiveAssignments.test.js` and
  `electiveMinimumToRun.test.js` must stay green; a new test pins the fix (two choices sharing a
  label both receive a labelKey-only preference's rank).
- **`electiveDerivedIds.js`:** one new exported function (D3), no change to any existing export's
  signature or behavior.
- **Slice 3 (not authorized by this ADR, described for continuity):** `commitElectiveRun.js` needs a
  new write loop for bundle-derived choices/offerings (`is_linked: 1`) and the coexistence resolution
  in its preference-writing loop (D6); `AssignmentPanel.jsx` needs to call `deriveChoices` on both the
  first-solve and re-solve paths and correct the stale comment at `:555-558` (D10).
- **Write-failure surfacing.** Slice 1 itself adds no renderer write path (no screen calls
  `repository.writeFields` against these tables yet) — that arrives with slice 2's authoring control.
  Carried forward, not waived: every write slice 2 adds against `elective_bundles`/
  `elective_bundle_periods`/`elective_bundle_tiers` must surface a failure through
  `describeWriteFailure(err, ...)` into the screen's error surface, the same idiom
  `ElectiveSetDetail.jsx`'s `saveCapacity`/`saveMinimum` already use for their sibling table.
- **`docs/current/PLATFORM_STATE.md`:** the sentence currently stating the CURRENT schema version
  (distinct from any `_Prior:`-wrapped historical sentence, such as the existing v80/T265 paragraph,
  which must NOT be touched — it correctly and permanently states what v80 introduced) must be updated
  to 81 with a one-line description of what v81 added. Maker should locate that live sentence by its
  content ("N is the current version"), not assume this ADR names its exact location.
- **Test plan, one item per seam, each naming what it cannot see:**
  1. Schema/migration (D9) — fresh-vs-migrated parity plus a CHECK-rejection test. Cannot see a wrong
     value that is still one of the three legal `scope_mode` strings assigned to the wrong bundle —
     that is an application-logic question, not a schema one.
  2. `deriveChoices` (D10) — pure unit tests: single-tier one-member; multi-tier same-label-distinct-id;
     `'except'` excludes a tier; a member with no matching occurrence still emits a choiceOffering
     (composed with an engine-level test proving case (a) fires); duplicate period/tier rows produce
     identical output to non-duplicated input. Cannot see whether its output ever reaches the real
     solve path correctly wired — that is exactly this ticket's original defect shape, and is slice 3's
     integration test to write, not slice 1's unit test.
  3. Engine rank-collision fix (D4) — pins the broadcast behavior directly. Cannot see a wrong
     `choice_id` deliberately stored on a preference row (D4's own stated limit).
  4. Coexistence policy (D6, slice 3) — a fixture run with both a sheet preference naming a bundle's
     label and the authored bundle itself, asserting the camper's rank reaches the bundle's own
     per-tier choice. Not slice 1's to implement or test; named here so slice 3 does not have to
     re-derive the requirement.

## Gate

Owner approval required (GOVERNANCE_INDEX database/sync row: ADR + migration/rollback plan). On
acceptance: Maker implements slice 1 test-first per the plan above → Red Hat (sync/replay and the
migration) → Security (no new camper data, confirm the ordinary-permissions call in Consequences) →
Code Reviewer → Verifier → Grader. Slices 2 and 3 require their own briefs (Designer first for slice
2, per the ticket's own ordering) and are not authorized by this acceptance.
