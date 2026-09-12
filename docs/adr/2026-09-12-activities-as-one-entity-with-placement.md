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

**Model placement as a RELATIONSHIP, not as a table boundary and not as a
column on a merged table.**

- `activities` stays the catalogue: what a thing is, and its rules.
- `anchor_activities` stays, permanently, but is understood and documented as
  **the placement record for an Activity** — gaining a real
  `activity_id` foreign key. It is not "the events table."
- `fixed` / `recurring` / `general` are a **classification computed from a
  placement row's own coverage** (all groups? all days?), not a label asserted
  independently of the data that implies it.

**The table merge is rejected, not deferred.** An earlier draft of this ADR
named "one entity with a placement axis" as the target and treated the merge as
"probably never." Independent architectural review (§11) argued that is the
expensive option with no measurable benefit, and I accept the correction: the
owner's conceptual model — one Activities, three subsets — is fully delivered by
the relationship, and collapsing the tables buys nothing the FK does not already
buy while forcing an Automerge entity-model change and a history-translation
problem.

The owner's model is therefore honoured **in the model and the UI**, without
one-table storage. "One Activities page showing three subsets" remains the
outcome; it just does not require one Activities table.

## 2a. Options considered

The first draft of this ADR proposed one path and called it a decision. That is
the gap this section closes.

| | Model | Verdict |
|---|---|---|
| **A** | One `activities` table; placement as a `placement` enum + nullable pinning columns. `anchor_activities` retired. | **Rejected.** Nullable-column soup on the busiest table; the `kind` CHECK invariant degrades into internal consistency nobody enforces. Forces an Automerge entity-count change (28 → 27) and a history-translation problem. Highest cost, lowest reversibility. |
| **B** | `activities` = catalogue; `anchor_activities` = placement child record with a real FK. Classification computed from the row's coverage. | **Chosen.** Strongest fit to the owner's model, expresses `Lunch 4` with no special case, additive and backward-compatible to Automerge, and is the version that does not need undoing if "one placement per Activity" is ever revisited (drop a uniqueness assumption → 1:N). |
| **C** | Link only: add the FK, change nothing conceptually. | The same SQL migration as B. B is C plus a naming and documentation stance, at zero structural cost. |
| **D** | Store no classification at all; derive fixed/recurring/general entirely at read time. | **Trap in isolation.** T141 already proved that computing "is this fixed" from coverage alone silently misses cases. Viable only combined with B's stored row — which is what B does. |

**A and B differ in cost, not in what the director sees.** That is the whole
argument for B.

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

### 3.2 A safety guard is dead — AND scope-blind

`src/engine/buildSchedule.js:121-123` builds `anchoredActivityIds` from
`anchor.activity_id`, and line 286 filters general placement by it.
`anchor_activities` has no `activity_id` column, so the set is always empty and
the filter never excludes anything.

**The first draft stopped there, and that was the draft's most serious error.**
Adversarial review (§11) found that the guard is not only dead but **scope-blind**:
the set is built from *every* anchor with no group, day or block filter, and
line 286 consumes it with no scope check either. So the moment `activity_id`
exists, an activity pinned **anywhere** — one group, one day — becomes
unplaceable **everywhere**.

The code itself proves this was a known hazard on one axis and fixed only there.
`buildSchedule.js:112-117` filters week-bound anchors out *before*
`anchoredActivityIds` is built, with the comment:

> a week-bound anchor must not occupy a cell on another week, **and must not
> exclude its activity from regular placement there either**

Exactly that reasoning applies to the group and day axes, where it was never
applied.

**Consequence for this ADR: "slice 1 changes no behaviour by default" was
false**, and no appeal to "nothing is dual-use" rescues it — a single
partially-scoped recurring anchor is sufficient. See §7.1.

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

**ANSWERED by the owner, 2026-09-12: no.** A genuinely dual-use activity is not
something a camp would author. This is therefore settled, not provisional:
**an Activity has exactly one placement**, and `dualUseNames` /
`pinOnlyActivityNames` are machinery for a case that will not exist. Both should
be retired by whichever slice first makes them redundant, and neither should
constrain the model.

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

## 7. Staging

The `grep -a` census (graphify cannot see a table-name string; see §11) finds
**43 non-test files and 48 test files** referencing `anchor_activities`: the
schema and four rollback migrations, the Automerge document/projector/seed,
permissions, the projections registry, `deleteRecord`/`deleteWeek`/`restore`/
`undoReferences`, engine inputs, ingest inference and commit, the MCP tools,
and six screens.

Ordered by the owner's priority — data model, ingest and engine correctness
first; UI last (§10 Q3).

### 7.1 Slice 0 — scope the engine guard (do this FIRST, and on its own)

`anchoredActivityIds` must be keyed by the anchor's actual footprint
(group × day × block), not by bare activity id, matching what the week filter
at `buildSchedule.js:112-117` already does for weeks.

**This is a standalone bug fix and belongs before anything else**, for two
reasons. It is latent today and becomes live the instant anyone adds
`activity_id` — so shipping it separately means the behaviour change is
observable, tested and reviewed on its own rather than buried inside a
migration. And with the guard correctly scoped, slice 1 genuinely does become
behaviour-neutral, which is what the first draft wrongly claimed it already was.

Open design question this raises, and it is a product question rather than a
technical one (§10 Q5): if an activity is pinned for some groups, *should* it be
rotatable for the others? "Scope the guard" assumes yes. The owner's "no
dual-use" answer may instead mean such data should be refused at authoring time,
in which case the guard's breadth is harmless and the fix is a validation rule.
**Slice 0 cannot be designed until that is answered.**

### 7.2 Slice 1 — the link

Add `activity_id` to `anchor_activities`; populate it for existing rows.
Three preconditions, each identified by review and none of them optional:

1. **The backfill must be written through the Automerge document, not as a SQL
   `UPDATE`.** `rebuildFromDoc` (`electron/automerge/projector.js:382-392`)
   does `DELETE FROM <entity>` and re-projects from the document. A value that
   exists only in SQLite is therefore not merely unreplayable — it is
   **destroyed by the next rebuild**, silently, on whichever device rebuilds.
   `activity_id` must also be added to `PROJECTIONS.anchor_activities.fields`
   (`electron/ops/projections.js:289-291`) or it is not a projected field at all.
2. **The zero-match case needs a stated contract.** An anchor whose name matches
   no activity must have one defined outcome — mint, leave null, or surface to
   the director — not silence. (Two-match is NOT a live risk: see §11.2.)
3. **The backfill must be idempotent.** Running it twice must not drift.

### 7.3 Slice 2 — engine and ingest correctness

Retire `dualUseNames`/`pinOnlyActivityNames` (§5, now dead by the owner's
answer). Close the §6 detection hole so `Lunch 4`-shaped pinnings are proposed
rather than silently filed as general activities — pending §10 Q4.

### 7.4 Slice 3 — the view

One Activities surface showing all three subsets. Last, per §10 Q3.

### 7.5 Not planned: the table merge

Rejected (§2, §2a), not deferred. It would be reconsidered only if Automerge/
op-log migration tooling were built for some unrelated reason — that is the
blocking dependency, not general caution.

## 8. Priority, and a latent schema defect

Confirmed: `buildSchedule.js:475-477` runs exactly two rounds, `'high'` then
`'low'`. `ActivitiesScreen.jsx` offers the same two.

**`schema.sql:387` declares `priority INTEGER`, but the application writes the
strings `'high'` and `'low'`.** SQLite's loose typing lets this pass silently.
The column is already an enum stored in an integer column.

Adding a `medium` tier is one extra `runRound` in the engine, but it would be
built on that lie. **Recommendation: correct the column to a constrained TEXT
enum first, in the same slice as any third tier.**

**Owner, 2026-09-12: `medium` may need to exist, but not yet.** So the column
correction is in scope for this work and the third tier is not. The correction
should leave adding a value cheap — a constrained enum with two values today.

## 9. How to try to break this — required before any code

Gates, not suggestions. Revised after review; the first draft's list was the
right shape but answered too optimistically in the body text.

1. **The scoped guard (slice 0).** Build a camp with a recurring anchor covering
   3 of 14 groups on one day, for an activity other groups are eligible for.
   Assert those other groups can still be scheduled it. Then assert no existing
   schedule changes. This test must exist and fail before the fix.
2. **Rebuild-from-document.** Populate `activity_id`, call `rebuildFromDoc`, and
   assert the link survives. This is the test that catches a SQL-only backfill.
   A pure op-log replay test does NOT catch it (§11.1).
3. **Backfill contracts.** Zero-match, idempotency on re-run, and a name whose
   canonical spelling changed after the anchor was written (T144's class).
4. **BINARY collation.** `idx_activities_camp_name` is case- and
   whitespace-sensitive, so `Swim`/`swim` can coexist. Assert the backfill's
   matching rule against that, using the same canonicalization T144 built.
5. **The `kind` CHECK constraint** (`schema.sql:629-632`) encodes *fixed ⇒
   all-groups ∧ no unit ∧ no group_ids*. Assert it still rejects the bad shapes.
6. **Automerge convergence.** Two devices editing placement concurrently.
7. **Ingest round-trip.** `Schedule by Group.xlsx` must still yield fixed 5 /
   recurring 11, with `Lunch 4`/`Lunch 5` hand-authorable (§6).
8. **Delete/restore/undo.** `ingest.js:35-38` states "nothing points into
   anchors," which is what makes anchors-first delete order safe. `activity_id`
   makes that comment stale — anchors now depend on activities existing. Correct
   the comment in the same commit, and re-verify restore ordering.

## 10. Owner answers, and what they change

Answered 2026-09-12:

- **Q1 — dual-use: NO.** One placement per Activity. Settled; see §5.
- **Q2 — `medium`: later, not now.** Correct the column type in scope, leave the
  third value cheap to add. See §8.
- **Q3 — the goal is CORRECTNESS at the data-model, ingest and schedule-engine
  levels. UI/UX is explicitly secondary.**

**Q3 changes this ADR's staging, and the change matters.** §7 originally ordered
the slices toward the one-Activities-page view, on the assumption that the view
was the goal. It is not. Re-ordered by the owner's actual priority:

| | was | is |
|---|---|---|
| 1 | link (`activity_id`) | link (`activity_id`) — unchanged, still first |
| 2 | the one-page view | **engine correctness**: activate the dead guard (§3.2) under test, and retire `pinOnlyActivityNames` (§5) |
| 3 | merge, probably never | **ingest correctness**: close the §6 detection hole so `Lunch 4`-shaped pinnings are proposed, not silently filed as general activities |
| 4 | — | the view (UI), and only then any table merge |

The view is now the LAST thing, not the second. Everything above it is
observable without a screen: engine output, ingest proposals, projection state.

Still open:

- **Q4 (§6)** — Should inference *propose* a minority-groups/minority-days
  pinning like `Lunch 4`, or is hand-authoring right for that shape? This is now
  load-bearing, because it is slice 3.

## 11. Review — what two independent passes found, including where they disagreed

The first draft was written without divergent ideation or adversarial review:
one author, one option, converged immediately. Both passes were run afterwards,
and both changed the ADR materially. Recorded here because the disagreements are
more informative than the agreements.

**They agreed, from different directions, on the thing that matters most:** the
FK is the fix, and the table merge is not worth its cost. Adversarial review
reached it via migration and replay risk; architectural review reached it via
Automerge entity modelling and the absence of any measurable benefit. That
convergence is why §2 rejects the merge outright rather than deferring it.

### 11.1 Where they contradicted each other — and both were wrong

Architectural review held that the FK "replays identically, because old ops
simply don't set the new field." Adversarial review held that the backfill is
invisible to op-log replay and the link silently would not survive.

Checking the code settles it in neither's favour. `rebuildFromDoc`
(`electron/automerge/projector.js:382-392`) does `DELETE FROM <entity>` and
re-projects **from the Automerge document**, not from the op-log. So the risk is
real but the mechanism is different from the one described: a SQL-only backfill
is not merely unreplayable, it is **destroyed by the next rebuild**. That is a
sharper and more dangerous failure than either pass stated, and it is now §7.2's
first precondition.

### 11.2 A finding that did not survive verification

Adversarial review reported HIGH severity on `activities.name` having no
uniqueness, making a by-name backfill ambiguous. **Not true.**
`electron/db/localDb.js:628` creates
`UNIQUE INDEX idx_activities_camp_name ON activities(camp_id, name)`, preceded
by a dedupe `DELETE`. The review grepped `schema.sql` and missed it, because in
this repo constraints frequently live in the migrations rather than the schema
file.

A weaker version does survive and is kept as a gate (§9.4): the index is
BINARY-collated, so `Swim`/`swim` and whitespace variants can coexist, and an
anchor name written before T144's canonicalization may now match **zero**
activities. Zero-match needs a contract; two-match does not.

### 11.3 The finding that most changed this document

The guard's scope-blindness (§3.2). Adversarial review found it; architectural
review looked at the same lines and judged the risk "identical in shape
regardless of A vs B," which is true of the merge question and misses the defect
entirely. It invalidated this ADR's claim that slice 1 is behaviour-neutral and
produced a new slice 0.

## 11a. Method note

`graphify` was consulted first per the standing rule. It could not produce the
blast radius here: `anchor_activities` is a **table-name string**, not an import
edge — the documented blind spot — and `affected` returned no unique match,
indexing local test variables instead. `god-nodes` and a neighborhood query were
useful for orientation only. The §7 census is therefore a `grep -a` pass, and
every file-and-line claim in this document was confirmed by opening the file —
including the ones asserted by reviewers, two of which did not survive that
check (§11.1, §11.2).

## 12. Document hygiene

`docs/adr/2026-08-28-fixed-vs-recurring-events.md` is `status: proposed`,
`implementation_state: not started` — but its v51 migration, `kind` column,
CHECK constraint and both nav rows are **shipped**. That document is stale
against the code and should be corrected regardless of whether this ADR is
accepted.
