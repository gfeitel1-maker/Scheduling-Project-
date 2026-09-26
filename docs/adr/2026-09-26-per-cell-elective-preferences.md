---
title: "Elective preferences are per (day, period) cell, and placement is two-phase"
document_type: adr
status: accepted
authority: normative
implementation_state: not-started
date: 2026-09-26
approved: 2026-09-26 (owner — preference shape corrected against a real artifact; cancellation order ruled)
task_class: scheduling-engine
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
related_adrs:
  - docs/adr/2026-09-17-individual-elective-scheduling.md
  - docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md
---

# Elective preferences are per (day, period) cell, and placement is two-phase

## Status of what this replaces

This supersedes the **global ranked list** premise that `src/engine/buildElectiveAssignments.js`
is built on. That file's header currently states:

> *"Preferences are ranked GLOBALLY: a camper ranks each elective once for the session, not once per
> slot (ADR D14, after real camp artifacts contradicted the per-occurrence premise)."*

**D14 did not establish that.** It withdrew the *previous* model and said so in terms that were
deliberately careful:

> *"strong enough to **retire** the ranked-per-occurrence premise, and **not** strong enough to
> establish any replacement premise. No design should treat either observed format as confirmed
> input."*

D14 was right to refuse, and it is sharper than an overread. **D14 observed BOTH formats and
established neither.** It recorded a single globally ranked list *and*, in its own words, *"a
chosen-schedule-plus-alternates planner — a camper fills in one activity per open cell of a day ×
period grid."* The engine adopted the first as settled and cited D14 as its authority. The owner's
2026-09-26 artifact is **the second format, which D14 already had in hand.**

So the failure is not a missing observation. It is a *withdrawal* being read as an *affirmation* of
whichever candidate was listed first, when the document explicitly declined to choose between them.
(Credit: this framing was corrected by the peer session working the ingest ADR, 2026-09-26.)

## The evidence

A real artifact, supplied by the owner 2026-09-26: **JCC Camps at Medford, GILAD (grade 5), 2024
Activity Selection Sheet.** A real camp, a real season, a real blank form of the kind this app must
ingest. It is **not committed to this repository and must not be** — only its structure is described
below, in the same discipline D14 used.

What it shows:

1. **A day × period grid, and every selectable cell carries its own distinct offering list.** The
   lists are not the same from cell to cell and are not the same size — one Monday afternoon cell
   offers roughly 27 activities, the corresponding Friday cell roughly 9.
2. **A camper selects within a cell.** The sheet's instructions address the reader cell by cell.
3. **Most activities recur across many cells.** Archery appears in roughly 15 of the 18 selectable
   cells. This is what makes the global model not merely different but **unreadable** on this form:
   "Archery, rank 1" does not identify an occurrence, and no rule recovers which one was meant.
4. **Not every period is selectable.** Period 1 (Instructional Swim), period 4 (Free Swim) and
   period 5 (Lunch) are fixed across the week; one period-2 cell is "Bunk Unity — no selection
   needed"; the Friday period-2 cell is Shabbat. **18 of 35 cells take a selection.**
5. **Linkage is declared on the catalog, by glyph, exactly as D14 inferred.** A double period is
   marked with a down-arrow in the earlier cell and an up-arrow in the later one on the same
   activity; multi-day activities carry their own marks; the sheet's header tells the reader to
   watch for both.

Point 5 is the one part of the existing model this artifact **confirms**. D12's parent/member shape
and D14's "linkage is a catalog property, not a camper expression" both stand.

## Decision 1 — a preference names the cell it applies to

A preference is `(camper, occurrence, activity, rank)`, not `(camper, activity, rank)`. Ranks are
scoped **within** a cell: a camper's rank 1 in Monday period 3 and their rank 1 in Monday period 6
are two independent first choices, not a contradiction.

**How many ranks per cell is a per-camp setting, not a constant.** The artifact does not fix a
number — it has no numbered blanks — and cells vary from ~9 to ~27 options, so a hardcoded 3 would be
wrong at both ends. Do not bake in an N.

**Consequences to carry, not to discover later:**

- **The repeat question dissolves.** A camper may choose the same activity in several cells, or
  different activities in each. It is now *expressed*, not inferred. The owner ruling of 2026-09-18
  ("repeats are normal, a camper swims twice a week") stands and is unaffected — what changes is
  that the camper now says so rather than the engine deducing it.
- **A measurement made under the old model must not be carried forward.** A synthetic fixture built
  on global lists showed ~88% of placements being repeats, and that was diagnosed in-session as the
  cost function summing raw ranks. **Both the figure and the diagnosis are artifacts of the wrong
  data model** — one list answering the same question five times — and are withdrawn here so they are
  not re-derived from the transcript.
- **Not every camper needs a placement in every occurrence.** Fixed and no-selection cells exist. An
  engine that assumes otherwise will manufacture findings for Lunch.

## Decision 2 — placement is two-phase, because a minimum cannot be honoured while placing

A capacity can be enforced during assignment; a **minimum cannot**, because no offering's headcount
is known until everyone is placed. **Owner ruling 2026-09-26:**

1. **Place** every camper from their per-cell preferences.
2. **Validate** each offering against its minimum.
3. **Surface** every offering that did not meet its minimum to the DIRECTOR, one decision per
   (activity, period), and execute what they choose.

**Step 3 is a decision surface, not an automatic cascade — owner correction 2026-09-26.** An earlier
draft of this ADR said the engine moves those campers to their next available choice by itself. That
is wrong. The owner's words: *"the answer is not asking the kid again, it's asking the user how they
want to handle each activity in each period what they want to do."* The camper's form is not
re-consulted as an oracle; the **director** decides what happens to each failed offering, and the
options are theirs (redistribute by preference, merge it with another offering, run it under its
minimum anyway, or cancel the period for those campers). The engine's job is to present each failing
offering with its shortfall and the affected campers, and then to carry out the ruling.

This does not weaken the case for the per-cell preference shape — it sharpens it. The moment a
director chooses "redistribute these campers by what they asked for," the engine must read *this
camper's next choice IN THIS CELL*, which the withdrawn global list cannot express.

**Consequence for decision 3 below:** the largest-shortfall ordering governs whatever redistribution
the director delegates to the engine. It is no longer the whole of step 3, because a director may
decide offerings in any order they like, or decide them in a way that makes ordering moot.

**The loop terminates, and it is worth recording why, because it looks like it might not.** Campers
move only OUT of cancelled offerings and INTO surviving ones, so headcounts are monotonically
non-decreasing. Nothing that already met its minimum can later fall below it. Each round strictly
improves; the loop cannot oscillate.

## Decision 3 — cancel the offering furthest below its minimum first

Cancellation order changes the outcome, so it must be fixed. Two offerings, minimum 6 each: Archery
has 4, Fishing has 5. Cancel Archery first and one of its campers flows into Fishing, which reaches 6
and **runs**. Cancel Fishing first and two of its campers flow into Archery, which reaches 6 and
**runs instead**. Both are legitimate weeks.

**Ruling (owner, 2026-09-26): cancel the offering with the largest shortfall first**, shortfall being
`min_to_run - enrolled`. Ties broken by a stable identifier so runs are reproducible.

Rationale: the furthest-below offering is the least rescuable, so retiring it first releases the most
campers to rescue the offerings that are close. And it is explainable in one sentence to a director,
which is the standard D11 set for this engine — *"Archery had 4 of the 6 it needed, so it came off
first, and those campers moving to Fishing is what let Fishing run."*

**The distinguishing test**, because the obvious wrong implementations pass casual ones: give the two
offerings **different** minimums. Archery 4 of 6 (shortfall 2) against Fishing 3 of 4 (shortfall 1) —
Fishing has fewer campers, but Archery is further below its own minimum, so **Archery** is cancelled
first. An implementation that sorts by enrolled count, or by id, gets this backwards.

## Over-offering is deliberate, so seat abundance is not a fixture defect

**Owner ruling 2026-09-26.** A camp offers far more activities than it expects to run, knowing many
will not attract enough campers. Culling is the *job of the minimum*, and what happens to the campers
in a culled offering is the camp's reprovisioning decision. So a generated fixture with 1.3-2.5x more
seats than campers is **modelling the real starting state**, not over-provisioning by mistake.

This resolves a measurement that otherwise reads as an error bar. Holding preferences, engine and
collapse fixed and scaling only capacity, the share of placements matching something the camper
ranked in that cell runs **77.8% at the abundant end and 33.6% at the scarce end**. That range is not
uncertainty about one number. **It is the trajectory a run walks:** placement happens at the abundant
end, minimums cull offerings, seats contract, and reprovisioning happens at the scarce end.

Two consequences follow, and the second is the load-bearing one:

- **A satisfaction figure measured before culling is close to meaningless.** With more seats than
  campers almost any model looks adequate, including the withdrawn global one. Any future measurement
  of placement quality must state where on this curve it was taken.
- **The global model's cost is concentrated AFTER culling.** Reprovisioning requires reading a
  camper's *next choice in that specific cell*. A global ranked list cannot answer that question at
  all — it names an activity, not an occurrence, and the activity it names may not be offered in the
  cell that needs refilling. So the per-cell shape is not merely more faithful to the form; it is a
  **precondition for the reprovisioning half of the two-phase loop**, which is the half the owner
  identified as where the real work happens.

## What this does not decide

- **The ingest format.** D14's warning stands in full: the artifact here is a **blank form**, and the
  camp states that final requests are submitted through a third-party portal, so the export this app
  would actually read is still unseen. This ADR fixes the *internal* shape a preference must have. It
  does **not** claim to know the file that will arrive.
- **Fairness across cells.** A camper unlucky in period 3 is still not compensated in period 6.
  Ruling R4 deferred this and it stays deferred.
- **The tier-1 / tier-2 linked-choice split** (T247, ADR 2026-09-23 decision (c)) is untouched. It
  operates on occurrences, which is the axis this ADR *adds* precision to, not one it removes.

## Migration note

`elective_preferences` gains an occurrence dimension, and the existing uniqueness — one rank per
camper per activity — becomes one rank per camper per activity **per occurrence**. Per the memory of
`feedback_relaxing_a_constraint_two_sweeps`, relaxing this needs **two** sweeps: code that resolves a
preference *by* the old key, and code that depends on the old write *failing*. There is no production
camp data (pre-production, `feedback_preproduction_bias_bold`), so a clean cutover is preferred to a
back-compat shim.

## Implementation: v78 schema shape

Realizes Decision 1 (T265). Schema:

```sql
CREATE TABLE elective_preferences (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  camper_id TEXT,
  occurrence_id TEXT NOT NULL,
  choice_id TEXT,
  rank INTEGER
);
CREATE INDEX idx_elective_preferences_run_camper_occurrence
  ON elective_preferences(run_id, camper_id, occurrence_id);
```

No `UNIQUE` constraint: the derived id `PRIMARY KEY` **is** the uniqueness invariant, the same
convention `elective_assignments` uses. The index is non-unique — it exists only to make "this
camper's ranked choices in this cell" a non-table-scan query for the deferred director-facing
redistribute-by-preference surface, not for correctness.

**Derivation** (`electron/ops/electiveDerivedIds.js`):

```js
deriveElectivePreferenceId(runId, camperId, occurrenceId, choiceId)
```

widens the key from `(run_id, camper_id, choice_id)` to `(run_id, camper_id, occurrence_id,
choice_id)`. `occurrenceId` is passed through `opaque()` with no null-guard: a preference missing
its occurrence throws, which `commitElectiveRun`'s whole-transaction rollback turns into a refused
commit rather than a corrupted one. **Owner ruling R1 (2026-09-17) is superseded, not
contradicted** — R1 chose the 3-tuple because the row had no occurrence column to key on at the
time; the row has one now, so R1's own stated condition no longer holds. The derivation's `V` (the
`epref1:` version tag) is **not** bumped: only this one function's signature changed shape, and
bumping `V` would re-key offerings/choices/occurrences/assignments that did not change.

**Migration v78** is a table REBUILD (`DROP TABLE` + `CREATE TABLE`), not `ALTER TABLE ADD COLUMN`:
a `NOT NULL` column has no valid default, and inventing one for an existing row is forbidden
(pre-production, no live camp data — discard, don't guess). Every existing `elective_preferences`
row is therefore discarded; the count is logged before the drop. Classified **SCHEMA_ONLY** in
`electron/db/migrationDomainState.js`: the classification tracks *mechanism* (does the migration
call `appendOp` to rewrite domain rows through the document?), not *consequence* (does data get
discarded?) — v78 calls no `appendOp`, only `db.exec` DDL inside its own transaction. Precedent:
v66, which also destroys `campers`/`elective_preferences`/`elective_assignments` rows outright, is
itself classified SCHEMA_ONLY for the identical reason.

The named index is created **inside the v78 migration block**, not in `schema.sql`'s unconditional
`CREATE INDEX IF NOT EXISTS` — `schema.sql` is re-executed on every open, and a `CREATE INDEX`
naming `occurrence_id` would fail against a not-yet-migrated pre-v78 file whose table has no such
column (the same reason `idx_schedule_templates_camp_kind` was retired from `schema.sql`, per that
table's own comment). The migration block runs on fresh databases too, so both paths end up
identical.

**Known sequencing gap.** The v78 migration guard is `>= 74 && < 78` rather than the file's usual
one-wide `>= (N-1) && < N` (`>= 77 && < 78`): versions 75–77 are allocated to peer sessions and do
not exist on this branch. `>= 74` is the actual immediately-preceding migration this branch has, and
remains correct once 75–77 land (a database that has passed through them will already be at 77 by
the time this check runs in the same `initSchema` pass, and `74 <= 77 < 78` still holds — the guard
does not need to change). `migrationDomainState.test.js`'s "covers 1..CURRENT_SCHEMA_VERSION with no
gaps" assertion fails with `missing: [75, 76, 77]` until those land — left failing deliberately, per
owner instruction, as a sequencing signal rather than papered over.

**Rollback** (`electron/db/rollback/v78_down.js`) does not simply narrow the key back. Because v78
*widened* the key, narrowing it can *collapse* two genuinely distinct rows (a linked choice ranked
differently per occurrence) onto one — exactly the silent-loss defect this ticket eliminates. The
rollback therefore **refuses**, naming the blocking `(run_id, camper_id, choice_id)` groups, whenever
any of them spans more than one `occurrence_id`; only when every group is single-occurrence does it
drop the column.

**Write path.** `commitElectiveRun.js` now requires every parsed preference to carry an
`occurrence_id` naming one of the run's occurrences — checked twice: `describeElectiveRunRefusal`
(usable from a preview, before any transaction) reports "names no (day, period) cell" for a missing
one, and the in-transaction write loop additionally refuses one that names an occurrence outside
this run (which the preview-only function cannot see, having no run context). `src/ingest/
preferenceSheet.js` is unchanged — out of scope, per the ADR's own "What this does not decide" — so
every sheet-imported preference today has no `occurrence_id` and is refused until a per-cell ingest
format exists. `setElectiveAssignment.js`'s preference-rank lookup is now scoped by `occurrence_id`
as well, which makes its pre-existing `LIMIT 1` *provably* correct (the 4-tuple is the full key)
rather than a latent bug waiting for a second occurrence-scoped row to expose it.
