---
title: "Ingest category exclusivity and anchor identity — why the duplicate activity is load-bearing"
document_type: adr
status: accepted
authority: normative
implementation_state: partial
date: 2026-09-26
task_class: architecture
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
related_adrs:
  - docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md
  - docs/adr/2026-08-03-ingesting-recurring-fixed-events.md
  - docs/adr/2026-08-28-fixed-vs-recurring-events.md
  - docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md
related_tickets:
  - docs/work/tickets/T251-t199-acceptance-fixture.md
  - docs/work/tickets/T234-ingest-recurring-event-catalog-exclusivity.md
  - docs/work/tickets/T266-ingest-pass-exclusivity.md
---

# Ingest category exclusivity and anchor identity

**Status: ACCEPTED 2026-09-26 by the product owner — Option A, in two halves.**

The owner ruled on the substance in conversation on 2026-09-26, after the scope below was put to him
in plain terms: a marker rather than a hole, a visibility flag on the existing activity row, present
so anchor name resolution still succeeds and absent from pass 3's menu. His words were *"go ahead,
run the ticket and get this done."* His statement of the rule itself — *"once something is pulled
from the first or second pass it should no longer be available to be pulled out in the third"* — is
also the answer to OQ2 below: hidden entirely, not greyed and not deprioritised.

**What is implemented, and what is not.** Option A has two halves and only one of them is being
built now.

- **The role marker — implemented** by `docs/work/tickets/T266-ingest-pass-exclusivity.md`
  (`activities.catalog_role`, schema v75; NULL = ordinary free choice, `'pinned_event'` = excluded
  from the free-choice catalogue and from the engine's placeable pool). This is §3's "marker, not a
  hole", and it is the whole of the reported symptom.
- **The `activity_id` identity half — NOT implemented, and deliberately still open.** Keeping the
  catalog row is precisely what makes it unnecessary for the cleanup: name resolution keeps working
  because the row it resolves to keeps existing. Option A's ordering constraint
  (identity-before-cleanup) is satisfied vacuously here, because nothing is deleted or merged. It
  becomes required the moment anything *does* delete or merge a catalog row, and D's invariant
  ("every anchor resolves to exactly one activity") remains the acceptance condition for that work.

The role marker is **symmetric**: a later import that no longer claims a name clears it. Written
one way only it would be a one-way door with no UI behind it (OQ2 chose "hidden entirely"), so a
heuristic false positive would make an activity vanish irreversibly. Re-importing a corrected sheet
is the recovery path. Clearing is guarded on detection having actually run (a non-empty claimed set),
because every caller except ImportScreen supplies an empty one and an unguarded clear would re-expose
a camp's whole event catalogue.

Sync is settled too, by the same owner ruling: a disagreement about `catalog_role` raises a conflict
for a human, because an activity's category is a fact about the camp rather than an opinion a device
holds, so two devices can never legitimately differ and a disagreement is evidence that one of them
ingested something wrong. It raises by INHERITANCE — `PROJECTIONS[entity].fields` is the single gate
for both syncing and conflict-raising, and `reconcile` has no field allowlist — so no mechanism was
added, only the evidence (`electron/catalogRoleConflict.test.js`) and a human-readable label.

One thing this ADR does NOT settle: whether ImportScreen's React layer is covered. Its derivation is;
the component is not mounted.

OQ1 is answered: **A**, not B. OQ3 is **not** answered here and nothing depends on it — the existing
`dualUseNames` carve-out keeps a genuinely dual-use name out of the pin-only set entirely, so the
one-row-or-two question is untouched by T266.

This ADR does not fix anything. It states one decision the product owner has to make, because the
obvious fix for the bug he reported would introduce a worse, silent one. It is also the gate on
T251's acceptance fixture: the leak described below only appears through the real ingest path, so
until this is decided T251 cannot write a fixture that would catch it.

---

## Why this is an ADR and not another patch

**A ticket already closed against this exact symptom, in the owner's own words, three days ago —
and the symptom survived.**

T234 (`docs/work/tickets/T234-ingest-recurring-event-catalog-exclusivity.md`, **status:
completed**, 2026-09-23) opens by quoting the owner: *"things that are recurring events are also
being pulled as activities when they should not."* T234 was correctly diagnosed, correctly scoped,
and correctly built. It did what it said. The events are still in the catalogue.

The reason is the shape of the guard, and it is worth one sentence of the owner's time because it
is the whole argument for stopping to decide rather than patching again:

> **The guard's success condition and the system's success condition were not the same condition.**

T234's guard succeeds by ensuring the name **always reaches the director as a question**. The
system succeeds only if the name **never becomes a free-choice activity**. Those read as the same
goal and are not. The guard demotes the name into a reconciliation card; the director then ticks
*"yes, that looks right"*; and the inversion described below turns that tick into the very write
the guard existed to prevent. A director doing the careful thing is what creates the duplicate.

So the next patch, aimed at the same symptom, has good odds of landing in the same place. And the
most natural next patch — just stop proposing the name — is the one that quietly breaks schedule
generation, for the reason in §3. That is why this needs a decision rather than a fix.

---

## What the owner is seeing

Import a prior-year spreadsheet. Recurring events — the things that happen at a pinned period every
day, like Lunch or a morning line-up — turn up in the activity catalogue as ordinary, freely
schedulable activities, alongside their event. The catalogue fills with entries the director never
asked for and would never drag anywhere.

## What is actually happening (verified in the tree at `9a014321`)

**1. Two proposers, no arbiter.** `src/ingest/extractEntities.js` walks the grid and proposes every
activity-like cell value as a catalog `activities` candidate. `src/ingest/fixedEvents.js`
(`inferFixedEvents`) independently walks *the same cells* and proposes `anchor_activities` rows for
names pinned to the same period across a majority of operating days. Neither subtracts from the
other. This is Decision 1 of
`docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md`, which is still
`status: proposed` and `implementation_state: not-started`.

**2. The guard is a demotion, not an exclusion — so confirming is what writes the duplicate.**

T234 made the guard confidence-independent: `src/screens/ImportScreen.jsx:767` computes
`eventNonDualUseNames` — every inferred fixed/recurring name minus `dualUseNames` — and ships it as
`pinOnlyActivityNames`. But read what buildPlan does with it (`src/ingest/buildPlan.js:579–581`):

```js
const tier = entity === 'activities' && pinOnlyActivityNames.has(normalizeName(name))
  ? 'low'
  : createConfidenceTier(entity, name, seenCounts)
```

The name is **forced to `tier: 'low'`**. Its own comment states the intent plainly: it "always
requires an explicit director resolution instead of reaching tier:'new'". The name is not removed
from the catalog proposal. It is turned into a question.

And the answer to that question is the defect. `src/screens/ImportScreen.jsx:1253` copies the entire
unfiltered proposal into `approved`:

```js
for (const entity of INGESTIBLE_ENTITIES) approved[entity] = [...(effectiveProposal?.entities[entity] ?? [])]
```

and `src/screens/reconciliationResolutions.js:110–125` removes a name from `approved` **only** inside
`if (!isDecisionResolved(decision, answer))`.

The resolution direction is inverted, and backwards from what any director would expect. Ticking
*"yes, that looks right"* on the very card T234's guard created is what lets the duplicate activity
through to the write. Leaving the card untouched would have held it back. **The director's act of
diligence is the thing that creates the duplicate** — which is why the owner is still seeing the
symptom three days after a ticket closed against it. (There is only one copy of this module —
`electron/ops/reconciliationResolutions.js` does not exist.)

T234 was not wrong. It correctly widened *which* names reach the guard. It did not touch what the
guard does, and what the guard does is hand the director a control whose safe answer is silence.

**3. The obvious fix is worse than the bug. This is the centre of gravity.**

An anchor references its activity **by name**. There is no `activity_id` column on
`anchor_activities` and there never has been — confirmed against the v51 table rebuild in
`electron/db/localDb.js` (columns: `id, camp_id, cohort_id, day_id, time_block_id, name, unit_id,
span_blocks, is_all_groups, group_ids, notes, schedule_week_id, recurrence_level, location_id,
kind`). `src/engine/anchorActivityLink.js` is the single place that link is resolved, by lowercased
whitespace-stripped name match, and `resolveAnchorActivityIds` returns `[]` on a miss.

Both consumers are suppression mechanisms:

- `src/engine/buildSchedule.js:160,177` — `anchoredActivityIdsByGroupDay`, the don't-place-it-twice
  exclusion.
- `src/engine/weekCatalog.js:62,65` — week-level activity and location exclusion.

So **the duplicate catalog row is the object the suppression matches on.** Delete the duplicates and
`resolveAnchorActivityIds` resolves to `[]`, both suppressions become no-ops, and the engine places
the event a second time as a free-choice activity. No exception, no `finding`, no red test. The
corruption is load-bearing.

This repository has already paid for that exact failure once. The comment at the head of
`src/engine/anchorActivityLink.js` records it: T62 was closed against an `anchor.activity_id` the
row does not carry, so its exclusion Set was empty in production for a month while its unit test —
which hand-built an anchor **with** the field real rows lack — stayed green. A fixture that
constructs the object the code wishes existed proves nothing about the object the database returns.

**4. The same weakness, one layer over — and a scope boundary.**

The defect in §3 is not local to anchors. It is **identity carried by a name string rather than a
row id**, and duplicate catalog rows are worse anywhere that shape appears: two rows spelling one
real activity are two distinct `activity_id`s and two distinct offerings to anything downstream that
has no notion they are the same thing. That is the general form of the problem this ADR asks the
owner to rule on.

One boundary, recorded so a later reader does not mistake silence for agreement. The elective
preference model — whether a camper ranks electives **once globally** or **once per (day, period)
cell** — is under active revision as of 2026-09-26, following a real filled-in selection sheet the
owner produced. `src/engine/buildElectiveAssignments.js:7–9` currently states the global model and
cites D14 as its authority; D14 (`docs/adr/2026-09-17-individual-elective-scheduling.md:481`)
observed **two** formats and deliberately established neither. **This ADR neither depends on nor
confirms the preference shape**, and must not be cited as having settled it. Nothing in §1–§3
changes under either model: the category leak and the anchor circularity are about identity and
resolution, not about how preferences are expressed.

What is *not* in doubt, and what Option A below is safe to assume, is that **linkage is declared by
the offering catalog, not expressed by the camper** — double periods and multi-day activities are
marked on the offering itself. The parent/member model stands, so giving an event's catalog row a
role marker does not disturb it.

---

## The decision the owner has to make

Not *whether* to fix it — it is a real defect. **In what order, and how far.** Specifically:

> Do we give anchors a stable identity *before* we clean up the duplicates, accept a schema change
> and a slightly larger change now — or do we take the cheap filter now and accept that the engine
> can silently place events twice?

The hypothesis carried into this design was: *any sequencing that deletes or merges duplicate
activities before anchors resolve by a stable id is unsafe, so identity-before-cleanup is the
ordering constraint.* **The code agrees with that hypothesis.** §3 is the evidence: name is the only
handle, so removing the named row is removing the handle. That is now a finding, not a prior.

---

## Options

### Option A — Identity first, then role. One row per real thing. *(recommended)*

Give `anchor_activities` an `activity_id` column that points at the catalog row, populated at
commit time by the ingest path that already knows the pairing (it proposed both from the same cell).
Do **not** delete the "duplicate" — recognise that it was never a duplicate; it is the event's
identity, and its only defect is that it appears in the *free-choice* catalogue. Add a role marker
on `activities` so a pinned event's row is excluded from the free-choice pickers and from the
elective offering pool, while remaining a real, referenceable row.

`resolveAnchorActivityIds` already prefers `activity_id` when present
(`anchorActivityLink.js:41–44`) and falls back to the name. After backfill the fallback is dead
code, and can be removed in the same change or left as a belt.

- **What the owner sees:** the catalogue stops showing Lunch and the line-up as draggable
  activities. The events still appear on the grid at their pinned period, exactly once. Nothing he
  has already built changes shape.
- **What it costs:** a schema migration (v74 → v75) adding `activity_id` to `anchor_activities` and
  a role column to `activities`, plus a backfill that resolves existing anchors by name *while the
  name still matches* — the one moment that resolution is guaranteed correct.
- **Blast radius:** `electron/db/localDb.js` (migration, table rebuild for the CHECK-bearing
  `anchor_activities`), `electron/ops/ingest.js` (`commitPlan` writes the link), `src/ingest/
  extractEntities.js` + `src/ingest/buildPlan.js:579` (the `pinOnlyActivityNames` demotion becomes
  an exclusion), `src/screens/ImportScreen.jsx:767,1253` (filter at the seam), `src/screens/
  reconciliationResolutions.js` (invert: hold back by default), `src/engine/anchorActivityLink.js`,
  and the catalogue/elective-offering read paths that must honour the role marker.
- **Reversible?** Yes. The name fallback still exists; nothing is deleted.

### Option B — Collapse the distinction. An anchor is an activity with a pinned placement.

Retire `anchor_activities` as a separate entity. One `activities` row carries an optional pinned
placement (day, block, scope). Double-placement becomes structurally unrepresentable because there
is only one row and one placement path — there is no suppression pass left to break.

- **What the owner sees:** the same end state as A, but the Anchors/Special-Events screens and the
  Roots census tiles are rebuilt on a different underlying shape.
- **What it costs:** the largest change here by a wide margin. `anchor_activities` is referenced by
  the ingest reconciliation report, the root map model, the first-import signal, the existing
  snapshot, the week catalog, both engine passes, and the `kind: fixed|recurring` CHECK constraint
  that `docs/adr/2026-08-28-fixed-vs-recurring-events.md` established.
- **Genuinely better in the long run** and genuinely disproportionate to the reported symptom. The
  owner's standing preference for clean hard cutovers makes this tempting; the amount of shipped,
  tested surface built on the two-entity model is why it is not the recommendation.
- **Reversible?** No.

### Option C — Promote the demotion. Turn `pinOnlyActivityNames` from `tier: 'low'` into exclusion.

The one-line-shaped fix, and the reason this ADR exists. The set already exists and is already
correct; make `buildPlan` drop those names from the `activities` proposal instead of demoting them
to a director question. Implements 2026-08-09 Decision 1 as written: a pinned name does not also
create a catalog activity.

- **What the owner sees:** the catalogue is clean immediately. Then, on the next schedule
  generation, some events appear twice on the grid — once pinned, once placed as a free choice —
  with no flag, no finding, and no error anywhere to explain it.
- **This is the trap.** Removing the catalog row removes the only thing the anchor can resolve to.
  It is a correct fix to the reported symptom and a silent scheduling regression.
- **Do not take this option alone.** It is safe only *after* A's identity change, at which point it
  is a small part of A rather than an alternative to it.

### Option D — Change nothing; make the corruption loud.

Leave both rows. Add a finding when an anchor resolves to zero or to more than one catalog row, and
refuse to generate rather than generate a schedule with an unresolvable suppression edge.

- **What the owner sees:** the duplicate activities are still in his catalogue. The reported symptom
  is not fixed. He would, however, be told when the engine cannot trust itself.
- **Worth doing regardless** — as part of A, not instead of it. An invariant that says "every anchor
  resolves to exactly one activity" is what stops the next person re-introducing this.

---

## Recommendation

**Option A, with D's invariant folded in as an acceptance condition.** Confidence: **high** on the
ordering constraint (identity before cleanup), **medium** on the specific shape of the role marker,
which is a UI-visible product choice the owner may want to see before it is fixed.

Evidence behind it: the name-only link is read directly from the v51 table definition and from
`anchorActivityLink.js`'s own contract comment; the two suppression call sites are enumerated above;
and the T62 precedent recorded in that same file is a measured instance of this exact failure
reaching production undetected for a month. Option C is rejected on that evidence, not on taste.

## Migration and back-compat posture

Pre-production. No live users, no live camp data. **No compatibility shim.** The backfill exists for
one reason only — it is the last moment at which name resolution is guaranteed correct, so it is
the moment to convert names into ids — and not to keep an old path working. Once
`anchor_activities.activity_id` is populated, name resolution is dead weight and should be deleted
in the same PR.

## How anyone would know this worked — the observable predicate

Ingest a spreadsheet containing at least one name that is pinned to a period every operating day
(an event) and at least one name that floats (a real free-choice activity), through the **real**
ingest path, then generate a schedule. All four must hold:

1. The pinned name does not appear in the free-choice activity catalogue.
2. The pinned name still appears on the generated grid, at its pinned period, **exactly once per
   group per day** — not zero times, not twice.
3. Every `anchor_activities` row has a non-null `activity_id` resolving to exactly one live
   `activities` row. Zero matches and two-or-more matches are both failures.
4. The free-choice name is still freely placeable and unaffected.

**A hand-built fixture cannot demonstrate any of this.** The leak is a disagreement between two
proposers that only meet on a real parsed grid, and the suppression bug is invisible to any fixture
that constructs an anchor object carrying fields the database does not store — which is precisely
how T62 passed for a month. The predicate must be exercised end to end from a spreadsheet through
`commitPlan` into SQLite and out through `buildSchedule`.

**This ADR is therefore the gate on T251's acceptance fixture.** T251 cannot specify a fixture that
would catch this class of defect until the owner has decided A, B, C or D, because the fixture's
assertion 3 above does not exist as a checkable fact under C or D.

## Out of scope, explicitly

- **T264 is ADR-gated and is not addressed here.** No mechanism for it is proposed, designed or
  referenced.
- **The elective solver is not reopened**, neither its scoring nor its preference model. Both are
  the owner's to rule on separately, and the preference shape is under active revision. This ADR
  proposes no change to either, depends on neither, and takes no position on either.

## Open questions for the owner

1. **Option A or Option B?** A is the smaller responsible change; B is structurally cleaner and much
   larger. Recommendation is A.
2. **What does a pinned event's activity row look like in the app?** Hidden from the catalogue
   entirely, or shown greyed with "pinned to a period"? This is a product/UI choice, not a technical
   one, and it decides the shape of the role marker.
3. **A name used both ways** — genuinely pinned on some days and free on others — is a real case the
   2026-08-09 ADR anticipated as a reviewable exception, and `fixedEvents.js` already computes
   `dualUseNames` as a seed for it. Under A, does such a name get one row with a partial pin, or two
   rows the director is asked to distinguish? Nothing should be built until this is answered.
