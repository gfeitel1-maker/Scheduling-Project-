---
title: "Activities as one entity with a placement axis: retiring the fixed/recurring entity split"
document_type: adr
authority: normative
status: proposed
date: 2026-09-12
supersedes: []
refines: [docs/adr/2026-08-28-fixed-vs-recurring-events.md]
related: [docs/adr/2026-08-03-ingesting-recurring-fixed-events.md, docs/adr/2026-08-23-unified-schedule-overlay-model.md, docs/work/tickets/T141-fixed-event-eligibility-ignores-group-coverage.md]
implementation_state: not started
affects: [electron/db/schema.sql, electron/db/localDb.js, electron/ops/projections.js, electron/ops/scheduleEngineInputs.js, electron/ops/ingest.js, electron/automerge/campDocument.js, src/engine/buildSchedule.js, src/ingest/fixedEvents.js, src/screens/AnchorsScreen.jsx, src/screens/ActivitiesScreen.jsx, src/components/layout/navSections.js]
---

# Activities as one entity with a placement axis

**DRAFT — for owner approval. No code authorized by this document.**

---

## 1. The owner's model, stated first

Recorded verbatim from the owner, 2026-09-12, because everything below is an
attempt to make the code agree with it:

> There is **Activities** with a capital A — the totality of things that get
> placed onto a schedule in open blocks. There are 3 subsets of Activities:
>
> - **Fixed** — occurs for all groups across all of camp at the same time every day.
> - **Recurring** — occurs for a specific set of groups or all groups at the same time on 1 or more days of the week.
> - **General** — occurs for all groups on a rotating basis throughout the week, with some being more important to schedule first than others.
>
> We split this into 3 parts a long time ago to differentiate between things
> that essentially populate the schedule first (Fixed), second (Recurring),
> third (General, with high and low priority). We changed Fixed and Recurring
> to be "events" to make Shoresh understand them differently.
>
> After typing this all again, I am not sure that was the correct call.

The three subsets are real and are not in question. What this ADR questions is
whether they are three **entities** or one entity with three **placements**.

## 2. Decision

**Model Activities as one entity with a `placement` axis (`fixed` |
`recurring` | `general`), not as two tables.** The three subsets become values,
the three sidebar rows become filtered views, and the engine's placement order
becomes a sort over one list rather than a join across two.

**Stage it.** The end state above is the target; the first slice is a
*non-destructive link*, not a migration. Section 7 explains why the honest
answer may be that the table merge never has to happen at all.

## 3. Why the split is the cause and not a neutral choice

Three symptoms, each independently observed, all reduce to the same root.

### 3.1 The system keeps re-creating what the split removed

Measured on the owner's real file (`Schedule by Group.xlsx`, 14 group sheets),
**14 of 36 proposed activities are events**: Carpool, Busses, Group Time,
Mifkad, CIT Block 1/2/3, Lunch 1/2/3, All Camp Activity, Ruach, Shabbat,
Menucha.

`pinOnlyActivityNames` exists to soften this — but it only forces
`tier: 'low'` (`src/ingest/buildPlan.js:509`); the activity row is still
created, listed and counted. Its own comment claims the name "can never
silently mint." It mints.

A model that must be continuously suppressed is a model disagreeing with the
domain. Under §1 these names *are* Activities, so the fix is not to stop
creating them — it is to stop pretending they are a different kind of thing.

### 3.2 A safety guard is dead, and the split is why

`src/engine/buildSchedule.js:121-123` builds `anchoredActivityIds` from
`anchor.activity_id`, and line 286 filters general placement by it — *don't
also rotate an activity that is already pinned.*

`anchor_activities` **has no `activity_id` column** (`schema.sql:613`; v51
migration `localDb.js:2036`). The set is therefore always empty and the filter
never excludes anything.

The guard is exactly the protection §1 requires, and it is inert because the
split severed identity. It does not bite today only because no name is
currently both. The first camp that pins an activity *and* rotates it gets it
placed twice, silently.

### 3.3 "Name identity is load-bearing" is a missing foreign key

`src/ingest/fixedEvents.js` resolves an event's block/days/groups **by name**
against created-or-existing rows, and says so repeatedly in its own comments.
That is not a design preference; it is what remains when two rows describing
the same real-world thing have no id between them. The typo-canonicalization
work (T144) exists partly to protect that string join.

### 3.4 The word "events" is overloaded

There is a genuine `events` table (`schema.sql:961`) for special events —
trips and one-offs with their own internal sub-schedules. "Event" therefore
means both *a thing that is not an activity* and *an activity that is pinned*.
The vocabulary stopped carrying information.

## 4. What the split legitimately bought, and what it actually needed

| Bought | Needed |
|---|---|
| Placement order (fixed → recurring → general) | An **attribute** to sort on |
| Pinning fields (`day_id`, `time_block_id`, scope) | **Nullable columns** or a child record |
| Separate authoring screens | A **filtered view** |

Sidebar rows are views, not tables. None of the three benefits requires a
second entity.

### 4.1 The axis is one continuum

| placement | time | scope | days |
|---|---|---|---|
| `fixed` | pinned | all groups | all days |
| `recurring` | pinned | some or all groups | one or more days |
| `general` | open | — | — (ordered by priority) |

"Swim before Gaga" is the same axis continuing past the end of the table.
Placement order is `fixed → recurring → general(high) → general(low)` — one
sorted pass, not two mechanisms.

## 5. An Activity has exactly one placement

**`dualUseNames` is empty on the owner's real file.** Nothing is both pinned
and rotating. Swim is not a counterexample: it sits at a different block per
age division, so it is a general activity with a pool rotation, not a pinned
one. Ruach and Ruach Prep are two names, not one dual-use name.

This ADR therefore models **one placement per Activity** and treats
`dualUseNames`/`pinOnlyActivityNames` as machinery serving a case that has not
been observed. If a real camp produces a counterexample, the model gains a
per-scope placement — but complexity should be added on evidence, not in
anticipation of it.

**Open for the owner (§10 Q1):** is a genuinely dual-use activity something a
camp would ever author deliberately?

## 6. What the model must be able to express, including what inference cannot yet find

`Lunch 4` and `Lunch 5` are Wednesday's variants of Lunch 2 and Lunch 3 — a
lunch pinned to one block, for 3 of 14 groups, on one day.

**Neither inference arm detects them today.** Arm 1 (day-majority) fails at
1 of 5 days; arm 2 (group-coverage, T141) fails at 3 of 14 groups. They are
currently proposed as general activities. That is a known hole in T141, not a
consequence of this ADR — but it constrains the model: **placement must be
expressible for a minority-of-groups, minority-of-days pinning even while
inference cannot propose it**, because a director will author it by hand.

This also settles a modelling question: `Lunch 2` and `Lunch 4` are **separate
Activities**, each with its own pinning, not one Activity whose pinning varies
by day. Pinning stays a scalar per Activity. If that proves wrong for some real
camp, the model breaks and §9 catches it.

## 7. Staging — and why the merge may never be required

The `grep -a` census (graphify cannot see a table-name string; see §11) finds
**43 non-test files and 48 test files** referencing `anchor_activities`: the
schema and four rollback migrations, the Automerge document/projector/seed,
permissions, the projections registry, `deleteRecord`/`deleteWeek`/`restore`/
`undoReferences`, engine inputs, ingest inference and commit, the MCP tools,
and six screens.

A single migration across that surface is not a small reversible change.

### Slice 1 — the link (small, reversible, high value on its own)

Add `activity_id` to `anchor_activities`; backfill by name from existing rows.
No table is merged and no behaviour changes by default.

This alone:

- restores identity, so §3.3's by-name resolution stops being load-bearing;
- makes §3.2's dead guard **live** — which is a behaviour change and needs its
  own test before it is enabled (§9.2);
- turns "is this name also an activity?" from a string question into a join;
- is the prerequisite of any later merge, so it is not wasted work if the merge
  never happens.

### Slice 2 — the view

`placement` becomes a derived read model over the linked pair, and the
Activities screen shows one list of Activities labelled by subset instead of a
flat list plus a second list repeating some of the same names. **This is the
change the owner actually asked for**, and slice 1 is sufficient for it.

### Slice 3 — the merge, only if slices 1-2 prove insufficient

Collapse `anchor_activities` into `activities`. Recommended posture:
**do not do this unless a concrete need survives slices 1 and 2.** The
user-visible goal is reachable without it, and §9.3 (op-log replay) is a real
constraint that may make "keep both tables, keep the link" the permanently
correct answer.

## 8. Priority, and a latent schema defect

Confirmed: `buildSchedule.js:475-477` runs exactly two rounds, `'high'` then
`'low'`. `ActivitiesScreen.jsx` offers the same two.

**`schema.sql:387` declares `priority INTEGER`, but the application writes the
strings `'high'` and `'low'`.** SQLite's loose typing lets this pass silently.
The column is already an enum stored in an integer column.

Adding a `medium` tier is one extra `runRound` in the engine, but it would be
built on that lie. **Recommendation: correct the column to a constrained TEXT
enum first, in the same slice as any third tier.** Whether `medium` should
exist at all is a product question the owner has flagged as open (§10 Q2).

## 9. How to try to break this — required before any code

These are gates, not suggestions. Each must be answered with evidence.

1. **Per-day pinning.** §6 asserts pinning is a scalar per Activity. Sweep every
   real file for one name pinned to *different* blocks on different days for the
   *same* group. One instance invalidates §6 and complicates the model.
2. **The newly-live guard.** Construct a camp where an activity is both pinned
   and eligible for rotation. Today it is placed twice. Prove the new behaviour
   is correct *and* that no existing schedule changes when the guard activates —
   a behaviour change hidden inside a refactor is the failure mode to fear.
3. **Op-log replay.** Every historical op is typed `anchor_activities` or
   `activities`. Replay a real op-log from before the change and assert the
   projection is byte-identical. This is the constraint most likely to force
   "link, never merge."
4. **The `kind` CHECK constraint** (`schema.sql:629-632`) encodes *fixed ⇒
   all-groups ∧ no unit ∧ no group_ids*. If placement moves, that invariant must
   move with it or it is silently lost. Assert it still rejects the bad shapes.
5. **Automerge.** `campDocument.js:203` lists `anchor_activities` among 28
   modelled entities. Any shape change touches the flat-record concurrency
   work. Two devices editing placement concurrently must converge.
6. **Ingest round-trip.** `Schedule by Group.xlsx` must produce the same fixed
   (5) and recurring (11) results before and after, plus `Lunch 4`/`Lunch 5`
   still authorable by hand (§6).
7. **Delete/restore/undo.** `deleteRecord`, `deleteWeek`, `restore` and
   `undoReferences` each special-case `anchor_activities`, including the
   anchors-first delete order (`ingest.js:42`). Each needs a surviving test.

## 10. Open questions for the owner

- **Q1 (§5)** — Is a genuinely dual-use activity (pinned for some groups,
  rotating for others) something a camp would author deliberately? If no, the
  model simplifies permanently and `dualUseNames`/`pinOnlyActivityNames` can be
  retired.
- **Q2 (§8)** — Should `medium` priority exist? Recommendation: decide it
  alongside the column-type correction, not before.
- **Q3 (§7)** — Is "one Activities page showing all three subsets" the actual
  goal? If so, slices 1-2 deliver it and slice 3 should stay unbuilt.
- **Q4 (§6)** — Should inference *propose* a minority-groups/minority-days
  pinning like `Lunch 4`, or is hand-authoring the right answer for that shape?

## 11. Method note

`graphify` was consulted first per the standing rule. It could not produce the
blast radius here: `anchor_activities` is a **table-name string**, not an import
edge — the documented blind spot — and `affected` returned no unique match,
indexing local test variables instead. `god-nodes` and a neighborhood query were
useful for orientation only. The §7 census is therefore a `grep -a` pass, and
every file-and-line claim in this document was confirmed by opening the file.

## 12. Document hygiene

`docs/adr/2026-08-28-fixed-vs-recurring-events.md` is `status: proposed`,
`implementation_state: not started` — but its v51 migration, `kind` column,
CHECK constraint and both nav rows are **shipped**. That document is stale
against the code and should be corrected regardless of whether this ADR is
accepted.
