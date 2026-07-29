---
title: "Separate manual-build and generated-schedule flows"
document_type: spec
status: approved-with-open-gate
created: 2026-07-28
amended: 2026-07-28
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T15-manual-build-starts-from-generated-schedule.md]
related_adrs: [docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
requires_adr: satisfied — docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md is ACCEPTED
archive_when: all child tickets closed and Verifier PASS recorded
---

# Specification — Separate manual-build and generated-schedule flows

## Amendment record — 2026-07-28

This specification was written **before** the ADR and is stale in specific places.
It has been amended in place under Article I: where this spec and
[`docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`](../../adr/2026-07-28-plural-candidate-schedules-per-camp.md)
disagree, **the accepted ADR wins and this spec is corrected**, never the reverse.

| # | What was stale | What replaces it |
|---|---|---|
| A1 | §5a "no new table and no new column", "nearly free" | **False.** A `UNIQUE(camp_id)` index (`electron/db/localDb.js:853`) makes a second row impossible. A `kind` column and **migration v23** are required. |
| A2 | Task treated as Architecture-class | Reclassified **Database/sync**: mandatory integration tests, migration + rollback plan, fresh-vs-migrated schema equivalence. |
| A3 | §9 omitted Security | **Omission void by its own terms.** Security is dispatched. |
| A4 | §5d "extract `auditSlots`" | **Wrong.** `computeFindings()` already exists, exported and pure (`buildSchedule.js:417`). Nothing is extracted. Adds the span-counting fix. |
| A5 | Predicate 7 (unfillable in both routes, same words) | **Rewritten.** Routes share a flag *vocabulary*, not a flag *set*. Manual = OVERLAP, UNDERSERVED, DISTRIBUTION. No UNFILLABLE. |
| A6 | — | New predicates 12–14 for the product owner's decisions. |
| A7 | §11 ordering treated T7 slice 2 as parallel | **Prerequisite**, ordered before any second row can exist. |
| A8 | §2/§8 "there is no export feature anywhere in the app today" | **False.** `ScheduleScreen.jsx:1476` wires `Export to Excel` over the shared `slots`. Recorded as an **open human gate** (§6.1), not designed around. |

Non-goals are unchanged in substance: grid colour scheme stays parked, T16 ingestion stays parked.

Resolves T15. Supersedes T15's "Recommended shape" section, which proposed a
confirmed destructive switch; the product owner has since settled the shape as
two coexisting routes with separate outputs, which removes the destructive
operation entirely rather than guarding it.

**Status: approved, with one open human gate.** The ADR is accepted and every
question §6 originally raised has been answered by the product owner. **One new
gate has since opened and Maker must not be dispatched past it: §6.1, the
export chooser**, which exists because §2's claim that no export surface exists
was found to be false. Sections 8–10 name the Article IV gates this work hits.

---

## 1. Problem

Building a schedule yourself and editing a schedule the engine proposed are two
different intentions. The app serves both from one surface, so choosing "I want
to build this myself" hands you the machine's answer already filled in.

Product owner, verbatim:

> why would going that route (i.e. you want to completely build the schedule)
> involve the generated one? manual edits to the generated schedule is a
> different idea entirely.

> manual build tab stays visible - think of them as separate sections/
> philosophical routes to schedule building that have cross over ideas
> (frequencies, timing, numbers) but separate paths to produce something

> they are both true. any schedule, whether through build your own or generated
> by the engine and manually worked on can be valid ideas to export. that
> decision lives not with us but with the user

---

## 2. Verified current state

Confirmed by reading the code on this branch today, not assumed:

- `src/screens/ScheduleScreen.jsx` holds all schedule state. `view` is a string
  in `useState`: `'manual' | 'group' | 'day' | 'activity'`.
- The **Manual Build tab** is rendered in the view toggle whenever `hasSchedule`
  is true (~`:1409`), and `ManualBuildView` reads the **same `slots` state**
  every other view reads. After generating, Manual Build is a third view of the
  generated schedule. **That is the defect.**
- The **Build Manually button** (~`:1503`) is the genuine from-scratch entry: it
  creates slot rows, applies anchors, sets `view='manual'`.
- `ManualBuildView` already renders dashed `EmptyDropCell` drop targets. The
  blank-grid affordance exists and works. The defect is *which slots reach it*.
- **A camp has exactly one schedule today, and the database enforces it.**
  `electron/ops/scheduleTemplateId.js:19` derives a single deterministic id,
  `schedule-template:${campId}`. Migration v21 re-keyed every existing
  `schedule_templates` row to that value precisely so two devices cannot fork,
  and then added **`CREATE UNIQUE INDEX idx_schedule_templates_camp ON
  schedule_templates(camp_id)`** (`electron/db/localDb.js:853`).
  **A second row per camp is therefore impossible today.** Every database, fresh
  or migrated, runs that migration. `CURRENT_SCHEMA_VERSION` is `22`, so the
  migration this work needs is **v23**.
- **The renderer does not use the derived id yet.** `generate()` (`:290`) and
  `placeAnchors()` (`:703`) both still do `tid = crypto.randomUUID()`, and
  `loadAll()` (`:234-235`) still does `templates.find(x => x.camp_id === campId)`
  — **first match wins.** This is slice 2 of the accepted T7 ADR, held back
  until a parallel UI branch landed. This is that branch, so it is a
  **prerequisite**, not parallel work: the moment a second row exists, that
  `find()` silently elects a winner and violates predicate 11.
- `template_slots`, `template_overlays` and `schedule_snapshots` are all
  **already parent-scoped to `schedule_templates`** (`electron/ops/campScopedEntities.js:24-43`),
  and `bulkReplace` is invoked per `template_id`
  (`ScheduleScreen.jsx:324-325`). Sync, authorization and op-log projection
  therefore already carry a template-id dimension end to end.
- `schedule_snapshots` (`electron/db/schema.sql:326-337`) is an **immutable
  point-in-time JSON blob** keyed to a `template_id`, with an explicit schema
  comment forbidding generalizing the pattern to actively-edited tables.
- **CORRECTED — export is live today.** The original text of this bullet read
  *"There is no export feature anywhere in the app today"*. That is **false**:
  `src/screens/ScheduleScreen.jsx:1476` renders an **Export to Excel** button
  wired to `exportToExcel({ slots, … })` (`src/utils/exportSchedule.js:3`) over
  the **shared `slots` array**. The moment `slots` becomes route-scoped, Export
  silently acts on whichever route happens to be on screen — **predicate 11
  violated by omission.** What to do about it is a product-judgement question
  reserved to the product owner: see **§6.1**.
- Per-slot flags are `UNFILLABLE` only. `UNDERSERVED` and `DISTRIBUTION` are
  aggregate `findings` returned by `src/engine/buildSchedule.js` and surfaced in
  stat tiles / the findings rail
  (`docs/adr/2026-07-28-schedule-flag-findings-reshape.md`).
  **There is no OVERLAP flag today.** `max_groups_per_slot` exists on activities
  and `ScheduleScreen.jsx:772-773` computes `locationFull` at drop time in order
  to **reject** a placement (`:779` sets `flags.UNFILLABLE`).
- **`computeFindings({ slots, groups, activities, days })` already exists**,
  exported and pure at `src/engine/buildSchedule.js:417`, placement-free, taking
  the snake_case persisted-row shape a manual grid already has, and already
  consumed by `loadAll()` (`:247`) and `restoreSnapshot()` (`:674`).
- **The two copies of the findings logic disagree on span counting.**
  `scheduleCohort()`'s DISTRIBUTION pass (`:381-384`) has **no `is_span_head`
  filter**, counting a 2-block activity twice; `computeFindings` filters to
  heads (`:445`), counting it once. Live consequence: a director sees "all
  clear" after generating, then a finding appears on the same schedule after a
  reload. `buildSchedule.test.js` **does not cover this case.**
- `buildSchedule.js` is pure, deterministic (DJB2 + Mulberry32) and is the only
  module with real unit tests (`src/engine/buildSchedule.test.js`).

**Baseline on this branch before any change:** 40 test files, 685 passed,
2 skipped, 0 lint errors, 11 pre-existing `react-hooks/exhaustive-deps`
warnings. Any regression from that baseline is a FAIL.

---

## 3. Domain terms

Fixed vocabulary for this work. Maker, Designer and Architect use these words;
none of them appear in UI copy as written here unless §7 says so.

- **Route** — one of the two ways a director produces a schedule. There are
  exactly two: the **manual route** and the **generated route**.
- **Candidate schedule** — the output of one route: a `schedule_templates` row
  plus its `template_slots` and `template_overlays`. A camp has up to two
  candidate schedules, one per route. Neither is canonical.
- **Version** — an existing `schedule_snapshots` row: an immutable, restorable
  copy of one candidate schedule at a moment in time. **Versions and candidate
  schedules are different concepts** — see §5a. Versions are already plural per
  template; candidates are what becomes plural in this work.
- **Setup** — activities and their min/max per week, time blocks, days of
  operation, groups, tiers, cohorts, anchors. **One per camp, shared by both
  routes.** Not duplicated, not per-route.
- **Finding** — an `UNDERSERVED` or `DISTRIBUTION` observation about a candidate
  schedule. **Aggregate, never per-slot** (see the flag/findings ADR).
- **Flag** — a per-slot marker. `UNFILLABLE` is the only one today; this work
  adds `OVERLAP` (see below).
- **Flag vocabulary vs flag set** — the two routes share the *vocabulary*: the
  same word always means the same thing, and a director learns it once. They do
  **not** share the same *set*. Generated route: `UNFILLABLE` (unchanged).
  Manual route: `OVERLAP`, plus the `UNDERSERVED` and `DISTRIBUTION` findings.
  **No `UNFILLABLE` on the manual route** — see predicate 7.
- **OVERLAP** — a per-slot flag, new in this work, raised when a placement puts
  more groups in an activity than its `max_groups_per_slot` allows. It **records
  a consequence; it never blocks the placement.** It must **not** be added to
  `buildSchedule()`'s `conflicts` array (`buildSchedule.js:18, :524`), which is
  always `[]` and is reserved for Sub-project 3 multi-cohort work.
- **Session** — one scheduled occurrence of an activity, **regardless of how
  many blocks it occupies.** A 2-block swim is *one* session. `min_per_week`,
  `max_per_week` and "twice before Wednesday" goals count sessions, not blocks.
- **Audit** — evaluating an arbitrary set of slots against setup and returning
  `findings`, **placing nothing**. **This capability already exists** as
  `computeFindings()` — it is not new and is not to be recreated or renamed.

---

## 4. Observable success predicate

Stated so a camp director can confirm each line by using the app, with no
knowledge of the code. This is the definition of done. **All fourteen must
hold** — predicate 7 is rewritten and 12–14 are new (amendments A5, A6).

1. **Manual Build starts blank.** With a generated schedule on screen, choosing
   Manual Build shows an **empty grid** — only anchors, no generated
   placements — the very first time it is opened.
2. **The Manual Build tab is always there.** It appears in the view toggle
   whether or not a schedule has been generated. It is never hidden, never
   greyed out, and choosing it never asks "are you sure".
3. **Switching between the two destroys nothing.** Going Generated → Manual →
   Generated returns the generated schedule exactly as it was: same activities
   in the same cells. Going Manual → Generated → Manual returns the manual work
   exactly as it was.
4. **Manual work survives Generate.** Pressing Generate while manual work exists
   does not alter, clear, or overwrite any of the manual grid.
5. **Manual work survives a restart.** Quit the app, reopen it, choose Manual
   Build: the placements made before quitting are still there.
6. **Each route keeps its own placements.** Dragging an activity into a cell on
   the manual grid never makes it appear in the generated schedule, and vice
   versa.
7. **Conflicts show while building manually — same vocabulary, not the same
   flag set.** *(Rewritten; amendment A5.)* As the director places activities on
   the manual grid, under-target activities are reported and clashes are marked,
   in the same place, with the same words and the same colours as the equivalent
   condition on a generated schedule. The counts update as placements change.
   Specifically:
   - **No cell on the manual grid is ever described as unfillable.** An empty
     manual cell is *not filled yet* — neutral, work remaining, not a problem.
     "Unfillable" is an engine verdict, the engine does not run on this route,
     and a verdict with no author must not appear.
   - The manual route's markers are **overlap**, **under-target** and
     **spread-across-the-week** in a director's words. Where a word is shared
     with the generated route it means exactly the same thing in both.
8. **Generated editing is untouched.** Drag-and-drop rearranging of a generated
   schedule in Group View and Daily View works exactly as it does today.
9. **The two routes read the same setup.** Changing an activity's times-per-week
   in Setup changes what is reported as underrepresented in **both** routes. The
   director never enters camp setup twice.
10. **Versions are per route, and restore is per route.** Saving a version while
    on one route and restoring it later restores that route's grid only, and
    leaves the other route untouched. Existing saved versions still restore.
11. **Nothing is elected.** Nowhere does the app label one route's schedule as
    the real / active / current one, nor pick one on the director's behalf.
    Where exactly one must eventually be acted on, the director is asked at that
    moment. **This includes Export to Excel**, which is live today (§2) and
    must not act on a route the director did not name — see §6.1.

12. **The blank manual grid tells the director what the week still owes them.**
    *(New; product-owner decision.)* Opening the manual route for the first time,
    before placing anything, **immediately** lists every activity that is under
    its times-per-week target. It reads as a to-do list of work remaining, not as
    a wall of errors the director has made — nothing on that first screen accuses
    the director of anything. The list shortens as placements are made.

13. **A clashing placement is accepted and told the truth about.**
    *(New; product-owner decision.)* On the manual grid, dropping an activity
    into a cell that already holds as many groups as that activity allows
    **succeeds**. The activity lands where the director put it. The cell is then
    marked as overlapping, and the mark clears when the overlap is resolved. **At
    no point is the director refused, blocked, or silently corrected.** This is
    the opposite of today's behaviour at `ScheduleScreen.jsx:772-779`, which
    rejects the drop.

14. **A long activity counts once.** *(New; product-owner decision.)* An
    activity scheduled across two consecutive blocks counts as **one** session
    towards its times-per-week target and towards any "twice before Wednesday"
    style goal — a double-length swim is one swim that ran long. This reads the
    same **on both routes**, and the same immediately after generating as it does
    after quitting and reopening the app. Today those two disagree (§2).

### What does NOT count as done

- Manual Build presenting a blank grid because the generated schedule was
  cleared, snapshotted-then-cleared, or moved. Predicate 3 fails.
- Manual Build blank on first open but inheriting generated slots after a
  reload, a Generate, or a device sync.
- Findings appearing on the manual grid only after pressing Generate, or only on
  a full rebuild, or computed by silently running `buildSchedule()` and
  discarding its placements. Predicate 7 requires evaluation without placement.
- A regression in `buildSchedule()`'s determinism or public signature. Identical
  inputs must still produce identical schedules.
- **Creating a new `auditSlots` (or any third name) for logic
  `computeFindings()` already performs.** That is duplication, not a capability.
- **Fixing the span count in only one of the two places.** Predicate 14 requires
  the pre- and post-reload numbers to agree; changing one copy leaves them
  disagreeing in the opposite direction and is not done.
- **A span-counting change landing without a test that would have caught the
  divergence.** `buildSchedule.test.js` is green on this defect today, so "tests
  pass" is not evidence here (Article II rule 3). The regression test is part of
  done, not a follow-up.
- **`OVERLAP` implemented by blocking or reverting the drop**, or by routing
  through `buildSchedule()`'s `conflicts` array. Predicate 13 fails.
- **`kind` shipped without projection registration.** If a `kind` value does not
  replicate to other devices it stays `NULL` there, SQLite treats distinct
  `NULL`s as non-conflicting in the unique index, and a camp accumulates
  duplicate manual rows across devices — the exact fork v21 exists to prevent.
  An integration test asserting `kind` **replicates** is part of done; "two rows
  can coexist locally" is not sufficient evidence.
- **A migration that reads, rewrites, or deletes any existing `template_slots`,
  `template_overlays` or `schedule_snapshots` row.** If an implementation finds
  it needs to, that is an Article IV stop and an escalation.
- Any test-suite, lint or build regression from the §2 baseline.
- **Integration tests or the fresh-vs-migrated schema equivalence check not run**
  (amendment A2). Their absence is disclosed as UNVERIFIED, never as a pass.
- Any UI string containing `UNFILLABLE`, `OVERLAP`, `UNDERSERVED`,
  `DISTRIBUTION`, `template_id`, "template", "op-log", "kind", "migration", or
  "route". Article V: the user is a camp director, not a software operator.

---

## 5. Architecture — SETTLED by the accepted ADR

**This section originally posed open questions with Governor recommendations.
They are now answered.**
[`docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md`](../../adr/2026-07-28-plural-candidate-schedules-per-camp.md)
is **accepted** and is normative. It is the implementation instruction; the text
below records what changed and why, so a stale recommendation cannot be followed
by mistake.

**Read the ADR in full before implementing. Where it and this section differ in
detail, the ADR governs.**

### 5a. How plural schedules are stored, and how Versions relate

**Answer first, because getting it wrong duplicates a working mechanism:
Versions and candidate schedules are two different concepts and must stay
separate.** `schedule_snapshots` is an immutable JSON blob with a schema comment
explicitly forbidding its use for actively-edited data. A candidate schedule is
actively edited, field-level synced, and op-logged. Modelling the manual route
as "a snapshot you can edit" would break sync granularity and contradict the
schema's own recorded decision.

**DECIDED (ADR §1–§2, §5).** Each route gets its own `schedule_templates` row,
with ids derived deterministically so no two devices can fork:

| Route | Derived id | `kind` |
|---|---|---|
| generated | `schedule-template:${campId}` — **byte-identical to today** | `generated` |
| manual | `schedule-template:${campId}:manual` | `manual` |

`deriveScheduleTemplateId(campId)` gains an **additive** second argument; the
one-argument call must keep returning today's exact string. That helper already
exists at `electron/ops/scheduleTemplateId.js:19` and is already imported by
migration v21 (`electron/db/localDb.js:7,844`), so **editing it changes migration
behaviour on real databases, not just renderer behaviour**. Do not create a
second copy under `src/` — the renderer imports the existing `electron/` module.

> ### AMENDED — A1. The "nearly free" premise was false.
>
> The original recommendation asserted **"No new table and no new column"** and
> that the change was **"nearly free"**. It is not implementable as written: the
> `UNIQUE(camp_id)` index at `electron/db/localDb.js:853` makes a second row per
> camp impossible on every database, fresh or migrated (§2). Per Article I this
> is recorded as a contradiction, not quietly designed around.
>
> **What is actually required (ADR §2) — migration v23:**
> 1. `ALTER TABLE schedule_templates ADD COLUMN kind TEXT`
> 2. Backfill every existing row to `'generated'`
> 3. `DROP INDEX idx_schedule_templates_camp`
> 4. `CREATE UNIQUE INDEX idx_schedule_templates_camp_kind ON schedule_templates(camp_id, kind)`
> 5. **Add `'kind'` to `PROJECTIONS.schedule_templates.fields`**
>    (`electron/ops/projections.js:206`, today `['camp_id','name']`) **and to
>    `ensureExists`** — omitting this is the sharpest failure mode in the whole
>    change (see "What does NOT count as done").
>
> Step 4 **narrows** the v21 invariant rather than removing it: at most one row
> per camp *per route*, so a regression reintroducing `crypto.randomUUID()` is
> still blocked exactly as v21 intended.
>
> **No row is deleted; no `template_slots`, `template_overlays` or
> `schedule_snapshots` row is read, rewritten or migrated.** Article IV's
> destructive gate is not reached, by construction.
>
> **`kind` is load-bearing, not cosmetic.** Distinguishing the routes by `name`
> (as originally suggested) is **rejected**: `name` is director-editable display
> text with no integrity guarantee, so renaming a schedule would change which
> route the app believes it belongs to. Parsing the id is likewise rejected — it
> would make the id format a parsing contract.
>
> **Rollback (ADR Consequences).** Reverting the code alone is clean: `kind` is
> additive and ignored by older paths. But **restoring the original
> `UNIQUE(camp_id)` index fails if a manual row exists**, and forcing it would
> require deleting that row and its slots — a destructive operation on a
> director's real work. **Rollback after any manual placement requires explicit
> director consent and is not an operation an agent may perform unattended.**

Why the rest of the mechanism is genuinely cheap, and unchanged from the
original reading:
- `template_slots`, `template_overlays` and `schedule_snapshots` are already
  parent-scoped to `schedule_templates` in `campScopedEntities.js:28-49`.
- `bulkReplace` is already called per `template_id` and is delete-then-reinsert
  scoped by `scope_id` (`electron/ops/operations.js:126-167`), so **Generate
  cannot wipe the manual route's rows**. Any change broadening that scope to
  `camp_id` would turn Generate into a destroyer of manual work.
- `schedule_snapshots.template_id` means **each route inherits its own Versions
  history for free**, satisfying predicate 10 with no new mechanism.

Remaining operational consequences:
- **`ScheduleScreen.jsx:234-235` is a live hazard**, and fixing it is a
  **prerequisite** (amendment A7, §11 T15.1), not parallel work.
- **`loadAll()` is a global reset, not a route-scoped one.** Fired on every
  applied op (`:112`), it unconditionally calls `setSlots`, `recalcStats`,
  `setFindings` and `setDismissedFindingKeys(new Set())` (`:243-249`). With two
  candidates, an op belonging to the route the director is *not* viewing would
  clear their dismissed findings mid-build. `loadAll` must learn which route it
  is refreshing.
- **`restoreSnapshot` is not route-safe by construction.** It re-stamps
  `template_id: templateId` from component state onto every row (`:632`) then
  `bulkReplace`s. **Assert `snapshot.template_id === templateId` before the
  `bulkReplace`**, or one wrong id overwrites the other route's entire week.
- **A not-yet-upgraded LAN peer silently drops the entire manual candidate**
  (ADR blocking defect 2). On a pre-v23 peer the still-present `UNIQUE(camp_id)`
  index absorbs the manual row via `INSERT OR IGNORE`, every subsequent
  `template_slots` op then violates the foreign key, and `applyRemoteOp`
  (`electron/sync/syncClient.js:374-378`) swallows projection failures by
  design. There is no schema/protocol version gate on the wire. **Red Hat and
  Security must both be pointed at this specifically.**

**Alternative rejected:** one template with a `route` column on
`template_slots`. Rejected because every existing consumer, every
`bulkReplace` call and the snapshot payload shape would need a route filter
retrofitted, and any consumer that forgot one would silently mix the two routes
— the exact failure T15 reports.

### 5b. What connected LAN devices see, and what replays over sync

**Recommendation (confidence: medium-high).** Both candidate schedules replicate
to every device, and **which route a device is looking at is local UI state that
does not sync.** Rationale: `view` is already local `useState`; making it
replicate would mean one director's tab click changes what a counsellor on
another laptop is looking at, which is a worse surprise than the one it prevents.

Operational consequence the ADR must state plainly, because it is the real risk
here: a director on the office computer and a counsellor on a laptop can be
looking at different candidate schedules **while both believe they are looking
at "the schedule"**. The mitigation is that each route is unmistakably labelled
on screen at all times (§7), not that the app forces agreement. Forcing
agreement would elect a winner, which §4.11 forbids.

**ANSWERED by the product owner: per-device route selection is accepted.** It is
the only option consistent with the standing no-canonical decision — a
designation concept is precisely what predicate 11 forbids. The mitigation
remains labelling (§7), not forced agreement.

### 5c. What export does when several exist

> ### AMENDED — A8. Export is live today. This is not a forward constraint.
>
> The original text of this section read **"There is no export surface in the app
> today — verified, §2"**. That is **false**. `ScheduleScreen.jsx:1476` renders
> **Export to Excel**, wired to `exportToExcel({ slots, … })` over the shared
> `slots` array. The moment `slots` is route-scoped, that button silently exports
> whichever route is on screen — **electing a candidate by accident, which is
> exactly what predicate 11 forbids.**
>
> **This is an open human gate, not an agent decision — see §6.1.** Article II
> rule 2: an agent may not expand this spec's scope to build an export chooser,
> and may not leave a silent election in place either. The product owner decides
> which.

The forward constraint below stands, and now also governs the existing button:

Record in the ADR that any future export,
print, or "show this on the counsellor's device" feature **must present the
director with an explicit choice of which candidate schedule to act on, at that
moment, and must not remember the choice as a default.** No newest-wins, no
generated-wins, no manual-wins. This is Article V at the architecture level.

### 5d. The audit-only path (the hard part)

> ### AMENDED — A4. Nothing is extracted. `auditSlots` is not created.
>
> The original recommendation called the audit path **"a new capability required
> by this work"** and instructed extracting finding computation from
> `scheduleCohort()` into a new `auditSlots`. Both halves are wrong:
>
> 1. **The function already exists.** `computeFindings({ slots, groups,
>    activities, days })` is exported, pure and placement-free at
>    `src/engine/buildSchedule.js:417`, has eight unit tests, is already consumed
>    by `loadAll()` (`:247`) and `restoreSnapshot()` (`:674`), and already takes
>    the snake_case persisted-row shape a manual grid has. Creating a third name
>    for it is duplication, not a capability.
> 2. **The extraction could not have been behaviour-preserving.** The two copies
>    of the logic genuinely disagree on span counting (§2), so moving one on top
>    of the other necessarily changes what directors are told. The original
>    section's own escape clause applies — *"if the extraction cannot be
>    behaviour-preserving, that is an Article IV stop"* — and it was correctly
>    taken. Worse, the original evidence rule (*"`buildSchedule.test.js` passes
>    unchanged"*) **would have registered green** on that behaviour change,
>    because no test covers the case.
>
> **DECIDED (ADR §4).** The manual route calls the **existing**
> `computeFindings` — the same function the generated route already calls. One
> implementation, one vocabulary, structurally shared, satisfying predicates 7
> and 9 **without modifying `buildSchedule()`'s algorithm, signature,
> determinism or seeded PRNG at all.**

**Additionally required — the span-counting fix (predicate 14).** The ADR §4
deferred this to a separate ticket; **the product owner then answered the
question directly, which supersedes that deferral** and brings it into scope:

- A 2-block activity counts as **one session**, not two. A double-length swim is
  one swim that ran long.
- This applies to `min_per_week` / `max_per_week` and to "twice before
  Wednesday"-style goals, **on both routes**.
- Concretely, `scheduleCohort()`'s DISTRIBUTION pass (`:381-384`) counts
  `resultSlots.filter(s => s.type === 'activity' && …)` with **no `is_span_head`
  filter**; `computeFindings` (`:445`) filters to heads. **`computeFindings` is
  the correct one.** The generated path is brought into line with it.
- **A regression test at the counting seam is mandatory and is part of done.**
  `buildSchedule.test.js` does not cover this today, so the suite passing is not
  evidence (Article II rule 3). The test must fail before the fix and pass after,
  and must pin the *specific* case in the ADR: one group, one 2-block
  `span_blocks: 2` activity with `prefer_before_day: 2,
  prefer_before_day_min: 2`, asserting `buildSchedule()` and `computeFindings()`
  now agree.

Standing constraints, unchanged:
- `buildSchedule()`'s **signature, return shape, determinism and seeded PRNG do
  not change.** Identical inputs still produce identical schedules. Only the
  session-counting predicate inside the DISTRIBUTION pass changes, and only to
  match the behaviour `computeFindings` already has.
- `computeFindings` places nothing, mutates nothing, does no IPC. Keep it that
  way.
- `findings` remains non-persisted, per the flag/findings ADR.

### 5e. OVERLAP — the new per-slot flag *(new section; product-owner authorised)*

Predicate 13 requires the manual route to **accept** a placement that today is
rejected. Constraints:

- `ScheduleScreen.jsx:772-779` computes `locationFull` from
  `max_groups_per_slot` and sets `flags.UNFILLABLE`, refusing the drop. **On the
  manual route the placement is accepted and `OVERLAP` is recorded instead.**
  Generated-route behaviour is unchanged.
- `OVERLAP` **must not** be added to `buildSchedule()`'s `conflicts` array
  (`buildSchedule.js:18, :524`), which is always `[]` and reserved for
  Sub-project 3 multi-cohort work.
- `OVERLAP` is a per-slot flag, in the same family as `UNFILLABLE` — not a
  `finding`. The legend (`src/components/schedule/slotCellConstants.js`,
  `legend.test.js`) must document it, per the rule fixed on this branch that the
  legend documents **every** treatment the grid renders.
- Flag taxonomy is a human gate (governance index, Scheduling-engine row). It is
  **satisfied**: the product owner named `OVERLAP` explicitly. No further
  taxonomy addition is authorised.

---

## 6. Product-owner confirmations

### 6.0 Answered — all original confirmations are closed

1. **5a — CONFIRMED.** Two `schedule_templates` rows, one per route, generated id
   byte-identical to today. **The `kind` column and migration v23 are accepted as
   the cost of the approach.**
2. **5b — CONFIRMED.** Route selection is per-device local state and does not
   sync. Two devices may be on different candidates, each clearly labelled.
3. **5c — CONFIRMED as a principle**, but see 6.1: it is no longer hypothetical.
4. **§7 copy — CONFIRMED, provisionally.** "Manual" and "Generated" for now,
   explicitly not settled vocabulary. **Do not spend design effort renaming, and
   do not treat these as final.**
5. **CONFIRMED.** Two-route model applies to candidate schedules only. Camp setup
   stays single.
6. **Versions ≠ candidate schedules — CONFIRMED.** A version is a point in time to
   go back to; a candidate is an idea being worked on. The mechanisms do not
   merge.
7. **No UNFILLABLE on the manual grid — CONFIRMED**, and `OVERLAP` authorised.
8. **A span counts as one session — CONFIRMED.**

### 6.1 OPEN GATE — Export to Excel already exists, and will silently elect a winner

**Maker must not be dispatched past this.** §2 and §8 both asserted that no
export surface exists. **That is false**: `ScheduleScreen.jsx:1476` exports the
shared `slots` array today. Once `slots` is route-scoped, that button acts on
whichever route the director happens to be looking at — a silent election,
forbidden by predicate 11, arrived at by omission rather than by decision.

This is a **product-judgement question reserved to the product owner** (Article
IV; ADR blocking defect 5). An agent may neither build a chooser (scope
expansion, Article II rule 2) nor leave the silent election in place (predicate
11). The options, with the Governor's recommendation:

| Option | Consequence |
|---|---|
| **A — Export asks which schedule, every time** *(recommended, confidence: high)* | Consistent with §5c and predicate 11 the moment it matters rather than later. Cost: one small chooser, in scope for this work. |
| B — Export stays as-is | The app quietly elects a candidate. **Predicate 11 fails.** Not recommended. |
| C — Disable Export until a chooser is designed | Honest and safe, but removes working function from a director. |

**Recommendation: A.** It is the smallest change that keeps the no-canonical rule
true, and it is the same decision §5c already commits the app to for every future
export surface — making it now costs less than retrofitting it.

**Non-goal reminder:** option A authorises a *chooser on the existing button*
only. It does not authorise building print, PDF, or "show on the counsellor's
device" surfaces (§8).

---

## 7. UI copy and labelling constraint

Designer owns the treatment; this spec constrains the substance.

- Both routes are labelled on screen at all times, in a director's words. The
  words "template", "route", "canonical", "active", "primary", "master" and
  "current" are forbidden in UI copy — each either means nothing to a director
  or implies an election §4.11 forbids.
- **Shared vocabulary, not an identical flag set** *(amended, A5)*. Where a
  condition exists on both routes it reads **identically**: same words, same
  colours, same placement, so a director learns the vocabulary once. But the sets
  differ — the manual route has **no unfillable** and gains **overlap**. A word
  never means two different things across the routes; not every word appears on
  both. The legend fixed on this branch
  (`src/components/schedule/slotCellConstants.js`, `legend.test.js`) is the
  single source for those treatments, must remain accurate in both routes, and
  must gain the overlap entry.
- **The blank manual grid's tone is a hard constraint, not a preference**
  (predicate 12). It opens listing what the week still owes the director. It must
  read as work remaining — never as a wall of errors, and never as an accusation
  about a grid the director has not yet touched.
- Nothing in either route's chrome asserts that it is the one that counts.

---

## 8. Non-goals

Out of scope. Attempting any of these is a scope violation (Article II rule 2),
not a bonus.

- **Grid colour scheme work** — parked by the product owner. The
  decolorization design doc is not implemented by this work.
- **Prior-year schedule ingestion (T16)** — a third input path, explicitly
  separate.
- **Building a print / PDF / CSV surface.** *(Amended, A8 — the original wording
  said "an export / print / PDF / CSV feature", on the false premise that no
  export existed. Excel export exists today and is handled by §6.1; everything
  else remains out of scope.)*
- **Any designation, "share this to devices", or election mechanism.** §4.11
  forbids it and §5b's open question is not resolved by building it.
- **Changing `buildSchedule()`'s signature, determinism, or seeded PRNG.**
  *(Amended: the sole authorised algorithm change is the span-counting fix in
  §5d, required by predicate 14. Nothing else in the engine is in scope — in
  particular `conflicts` stays `[]`.)*
- **Extracting, renaming, relocating or reimplementing `computeFindings()`**
  (§5d).
- **Any flag beyond `OVERLAP`.** Taxonomy is a human gate; only `OVERLAP` was
  authorised.
- **More than two `schedule_templates` rows per camp.** The `(camp_id, kind)`
  unique index is a required outcome, not an obstacle to route around.
- **Persisting findings or finding-dismissals** — settled by the flag/findings
  ADR; not reopened here.
- **More than two candidate schedules.** Two routes, two candidates. An
  arbitrary-N schedule library is a different, larger product decision.
- **Copy-from-one-route-to-the-other** ("start my manual build from the
  generated one"). Plausible and deliberately deferred: it is a new product
  behaviour, not a defect fix, and it reintroduces exactly the coupling T15
  reports if designed carelessly.
- **New per-route setup.** Setup stays single (§4.9).
- **Migrating, rewriting or deleting any existing `template_slots` or
  `schedule_snapshots` row.**

---

## 9. Routing decision (Article VII)

> ### AMENDED — A2/A3. Task class and Security.
>
> **This is a Database/sync task, not merely an Architecture one.** The
> governance index's Database/sync row therefore governs, and adds three
> non-optional requirements to the gate list:
>
> 1. **Integration tests — mandatory.** They must assert that `kind`
>    **replicates** across devices, not merely that two rows coexist locally.
> 2. **Migration and rollback plan** — recorded, including the ADR's finding that
>    rollback after any manual placement requires explicit director consent.
> 3. **Fresh-vs-migrated schema equivalence check.** Note for the implementer:
>    `initSchema()` runs `schema.sql` *and then* every version block, so a fresh
>    database **does** already get `idx_schedule_templates_camp`. **Do not go
>    looking for a pre-existing divergence — there isn't one.** The check is
>    required because v23 mutates schema on both paths.
>
> **Security is now DISPATCHED.** The omission recorded below is void by its own
> stated terms ("void the moment Architect's ADR proposes a schema change"), and
> that condition has occurred. Per Article I it is superseded here in writing
> rather than quietly reinterpreted.

### Selected

| Agent | Why this work needs it |
|---|---|
| **Architect** | Mandatory. Plural candidate schedules per camp is a new persistent data shape other code depends on, changes the template-id contract, and touches sync scoping. Writes the ADR answering §5a–5d. Phase 2.5 criteria are met three times over. |
| **Designer** | The view toggle now carries two coexisting routes that must be distinguishable at a glance without either looking primary, and findings must read identically in both. That is an interaction and visual specification problem, and §7 is substance only. |
| **Maker** | The only agent that writes production code. |
| **Code Reviewer** | Highest-value reviewer here. The specific failure mode is a consumer that silently reads the wrong candidate — a reading defect, found by reading, not by running. |
| **Security** | **Dispatched (amendment A3).** Migration v23 alters a synced entity's schema and its projection. Point it specifically at: the pre-v23 LAN peer silently dropping the manual candidate (§5a), `applyRemoteOp` swallowing projection failures with no observability, and the absence of any schema/protocol version gate on the wire. |
| **Verifier** | Mandatory. Gates are `npm test`, `npm run lint`, `npm run build` against the §2 baseline, **plus the mandatory integration suite and the fresh-vs-migrated schema equivalence check** (amendment A2). Note the §5d evidence rule changed: `buildSchedule.test.js` **gains** a span-counting regression test, so "passes unchanged" is no longer the rule — a green suite with no new test is UNVERIFIED, not a pass. |
| **Tester** | Predicates 1–8 are director's-eye behaviours in the running app. Predicates 5 and 10 cross persistence and must be exercised under `npm run electron:dev`, not the browser mock. |
| **Red Hat** | The assumption everyone believes safe is "the two routes cannot leak into each other". Its job is to break that: mid-generate route switch, restore-into-the-wrong-route, a device that has only ever seen one candidate, `find`-by-first-match survivals. |
| **Grader** | Scores the four opinion reports. |

### Omitted, with rationale

| Agent | Why omitted |
|---|---|
| ~~**Security**~~ | ~~Omitted. No change to auth, tokens, device trust, or the authorization surface. `schedule_templates`, `template_slots` and `schedule_snapshots` are already in `permissions.js` and `campScopedEntities.js`; a second row of an already-permissioned, already-parent-scoped entity introduces no new threat surface and no `SECURITY.md` tradeoff is touched.~~ **VOID — the escape condition fired.** The omission was conditional on no schema change being proposed; the accepted ADR proposes migration v23 and a projection change. **Security is dispatched** (see Selected, above). Retained struck-through rather than deleted so the reasoning that failed is visible: the rationale was sound for the design as it was then imagined, and was invalidated by the `UNIQUE(camp_id)` index the spec had not checked for. |

Red Hat is deliberately *not* omitted despite this being framed as a defect fix.
The whole design rests on an isolation claim, and Article II rule 1 says
evidence outranks confidence.

---

## 10. Human-approval gates (Article IV)

Drawn from Article IV's exhaustive list. Work stops at each.

1. **An architecture change without an accepted ADR.** **CLEARED.**
   [`2026-07-28-plural-candidate-schedules-per-camp.md`](../../adr/2026-07-28-plural-candidate-schedules-per-camp.md)
   is accepted by the product owner.
1a. **Database/sync: ADR + migration and rollback plan.** *(New, amendment A2.)*
   The ADR carries both. **Partially cleared** — the plan exists, and it records
   that rollback is clean only *before* the manual route is used. Rollback after
   any manual placement would require deleting a director's work and is a **fresh
   Article IV stop** if it is ever reached; it is not an operation an agent may
   perform unattended.
2. **A product-judgement question, including terminology and what "done" means
   to a director.** **CLEARED** for §5b, §7 copy, and §6.0's confirmations — all
   answered by the product owner. **Re-opened once**, at §6.1 (export).
2a. **Flag taxonomy** (governance index, Scheduling-engine row). **CLEARED** —
   the product owner named `OVERLAP` and removed `UNFILLABLE` from the manual
   route. No further taxonomy change is authorised.
2b. **Session-counting semantics.** **CLEARED** — a span counts once. This
   changes what the engine reports to directors and was therefore the product
   owner's to decide, not an agent's.
2c. **OPEN — §6.1, the export chooser.** The only gate still blocking dispatch.
3. **Any destructive or irreversible operation on stored data.** Hit **only if**
   an implementation clears or rewrites existing `template_slots` /
   `schedule_snapshots` rows. The recommended design in §5a is specifically
   chosen so this gate is **never reached**: the manual route writes new rows
   under a new template id and touches nothing existing. If Maker or Architect
   finds a path that requires clearing existing rows, that is a stop and an
   escalation, not a snapshot-then-clear.
4. **Code found to contradict a standard (Article I).** Standing. Notably
   `ScheduleScreen.jsx:234-235`'s first-match template selection, if it turns
   out any other consumer depends on that behaviour: report it, do not silently
   amend either side.
5. **Verifier FAIL or UNVERIFIED at round 2.** Standing, per Article VII.

Gates **not** hit, stated so their absence is deliberate rather than
overlooked: no change to an accepted `SECURITY.md` tradeoff (Security is
dispatched to *confirm* that, not because one is known to be touched); no agent
added, renamed or removed; no standard needs to change to accommodate this work.

**Gate 3 remains the live constraint on implementation.** Migration v23 is
additive by construction and touches no `template_slots`, `template_overlays` or
`schedule_snapshots` row. If Maker finds itself needing to clear or rewrite
existing rows — including any variant of snapshot-then-clear — **that is a stop
and an escalation**, not a judgement call.

---

## 11. Ticket-sized breakdown

Ordered, and **the order is load-bearing** (amendment A7). Each ticket is
independently reviewable and states its own evidence. T15 is closed by T15.7
passing, not before.

**T15.0 — ADR: plural candidate schedules per camp** *(Architect; gate 1)*
**DONE — accepted 2026-07-28.**

**T15.0b — OPEN GATE: the export chooser decision** *(product owner; §6.1)*
**Blocks dispatch.** Not an agent task. Governor recommends option A.

**T15.1a — PREREQUISITE: renderer derives its template id** *(T7 ADR slice 2)*
**Must land, and be reviewed, before any second row can exist.** Not parallel
work. Replace `crypto.randomUUID()` at `ScheduleScreen.jsx:290` and `:703` with
the derived id, and replace `templates.find(x => x.camp_id === campId)`
(`:234-235`) with resolution by derived id. Import the existing
`electron/ops/scheduleTemplateId.js` — **do not create a copy under `src/`**.
*Why first:* the moment a second row exists, `find()` first-match silently
elects a winner and predicate 11 fails. Landing this after T15.1b means shipping
that defect, however briefly.
*Evidence:* a camp with one row still resolves exactly as today; a unit test that
the one-argument `deriveScheduleTemplateId(campId)` returns
`schedule-template:${campId}` byte-identically; no `crypto.randomUUID()` remains
at either template-mint site.

**T15.1b — Migration v23 and route-aware template identity** *(Database/sync)*
Add the `kind` column, backfill `'generated'`, swap the unique index to
`(camp_id, kind)`, **and register `kind` in `PROJECTIONS.schedule_templates`
fields and `ensureExists`**. Extend `deriveScheduleTemplateId` with an additive
second argument. Lazy creation of the manual row on first use.
*Evidence:* **integration tests are mandatory** — two rows coexist per camp; a
third is still rejected; and **`kind` replicates to a second device** (a local-only
assertion is not sufficient — a `NULL` `kind` reintroduces the v21 fork).
Fresh-vs-migrated schema equivalence. Migration and rollback plan recorded,
including that rollback after any manual placement needs director consent.
*Also:* `npm rebuild better-sqlite3` before `npm test`; `npx electron-rebuild`
before `npm run electron:dev`.

**T15.2 — Route-scope the screen's state**
Add one `route` state (`'generated' | 'manual'`) and make `templateId`, `slots`,
`overlays` and `snapshots` **route-scoped while keeping their existing names and
shapes** — so the ~20 call sites that read them do not change and none can read
the wrong candidate by forgetting a parameter. **Do not introduce parallel
`manualSlots` / `manualTemplateId` variables**; that creates exactly the
wrong-candidate defect T15 reports. `ManualBuildView` reads the manual
candidate's slots. Manual Build tab always visible; no confirmation on switching.
**`loadAll()` must learn which route it is refreshing** — it currently resets
`slots`, stats, findings and dismissed findings unconditionally on every applied
op (`:112`, `:243-249`), which would clear a director's dismissals mid-build
because of an op on the route they are not looking at.
*Evidence:* predicates 1, 2, 3, 6.

**T15.3 — Manual route persistence**
Manual placements write through the existing `template_slots` op-log path under
the manual template id. Generate writes only to the generated template id.
`bulk_replace` scope stays `template_id` — **broadening it to `camp_id` would
turn Generate into a destroyer of manual work.**
*Evidence:* predicates 4, 5 — verified under `npm run electron:dev`.

**T15.4 — Span counting: one session, not two** *(§5d; test-first, engine seam)*
*(Replaces the withdrawn "`auditSlots` extraction" — nothing is extracted;
`computeFindings()` already exists and is used as-is.)*
Bring `scheduleCohort()`'s DISTRIBUTION pass (`:381-384`) into line with
`computeFindings` (`:445`) so a spanned activity counts once.
*Evidence:* a **new** regression test in `src/engine/buildSchedule.test.js` that
**fails before the change and passes after**, pinning the ADR's case (one group,
one 2-block `span_blocks: 2` activity, `prefer_before_day: 2,
prefer_before_day_min: 2`) and asserting `buildSchedule()` and
`computeFindings()` agree. A green suite with no new test is **UNVERIFIED, not a
pass** — the existing suite is green on this defect today. `buildSchedule()`'s
signature, determinism and seeded PRNG unchanged; predicate 14.

**T15.5 — Live findings on the manual grid, and OVERLAP**
Call the existing `computeFindings` on the manual route; same badges, rail,
legend and copy vocabulary as the generated route; recomputed as placements
change. **Findings show the moment the blank grid opens** (predicate 12), framed
as work remaining, never as errors made. Add the `OVERLAP` flag: a clashing drop
is **accepted and flagged**, never rejected (predicate 13) — replacing the
`locationFull` → `flags.UNFILLABLE` rejection at `:772-779` on the manual route
only. **No `UNFILLABLE` anywhere on the manual route.** `OVERLAP` does **not** go
into `buildSchedule()`'s `conflicts` array. Update
`slotCellConstants.js` `LEGEND_ENTRIES` and `legend.test.js` so the legend still
documents every treatment the grid renders.
*Evidence:* predicates 7, 9, 12, 13.

**T15.6 — Versions per route**
Save and restore scoped to the current route's template id. Existing snapshots
continue to restore into the generated route. **Assert
`snapshot.template_id === templateId` before the `bulkReplace`** —
`restoreSnapshot` re-stamps `template_id` from component state onto every row
(`:632`), so without the assertion one wrong id silently overwrites the other
route's entire week.
*Evidence:* predicate 10, including a pre-existing snapshot.
*Disclosed, not fixed:* `saveSnapshot`/`restoreSnapshot` drop `is_span_head` and
`is_released` in both directions (ADR blocking defect 1), so restore does **not**
return the week exactly as it was. Pre-existing. **No UI copy or affordance in
this work may rest on the claim that it does.**

**T15.6b — Export chooser** *(scope depends on T15.0b; do not start before it)*
If option A is chosen: Export to Excel asks the director which schedule to
export, every time, and does not remember the answer.
*Evidence:* predicate 11 against the live Export button.

**T15.7 — Director's-eye verification** *(Tester; the T15 closing evidence)*
Walk all **fourteen** predicates in the real app under `npm run electron:dev`,
including quit-and-reopen and a **two-device LAN check** for §5b — which must
include a peer that has *not* been upgraded past v22, since the ADR predicts it
silently drops the manual candidate with no error surfaced. Confirm no forbidden
term from §4 or §7 appears on screen.

**T15.8 — Documentation**
Update `docs/current/PLATFORM_STATE.md` (§schema for `kind` and v23, §engine for
session counting, §screens for the two routes) and the `CLAUDE.md`
schedule-routing paragraph to describe two candidate schedules. Close T15 with a
link to T15.7's evidence.

---

## 12. Known defects disclosed, not fixed by this work

Recorded under Article II rule 3 so none is silently converted into a passing
result. Each is verified in code and each needs its own ticket.

1. **Snapshot save/restore is lossy.** `is_span_head` and `is_released` are
   dropped in both directions (`:553-561`, `:630-640`), so a restored spanned
   activity returns as N duplicated cells and a released lock returns locked.
   Pre-existing; this work is the first to put load on it.
2. **Anchors are materialised into `template_slots` at build time and never
   refreshed** from `anchor_activities`. A Setup meal-time change therefore
   updates neither route, and the two routes drift from each other and from
   Setup. This partially qualifies predicate 9: setup is genuinely shared for
   activities and frequencies, but is a one-time copy for anchors.
3. **`applyRemoteOp` swallows projection failures with no observability, by
   design** (`electron/sync/syncClient.js:374-378`), and
   `sendFullSyncIfFirstPairing` never re-syncs a device that has synced once
   (`syncServer.js:151-153`). Together these mean a peer that silently failed to
   materialise the manual candidate is never repaired. There is no
   schema/protocol version gate on the wire.
