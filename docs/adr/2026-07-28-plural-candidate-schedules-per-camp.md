---
title: "Plural candidate schedules per camp: the manual and generated routes are separate outputs"
document_type: adr
authority: normative
status: accepted
date: 2026-07-28
supersedes: []
implementation_state: not-started
affects:
  - docs/work/specs/2026-07-28-separate-manual-and-generated-flows.md
  - docs/adr/2026-07-28-first-pairing-domain-sync-and-template-identity.md
  - docs/adr/2026-07-28-schedule-flag-findings-reshape.md
---

# Plural candidate schedules per camp: the manual and generated routes are separate outputs

> **CORRECTION 2026-07-29 — read this before trusting any statement in this
> document about the generated template's id.** Every claim below that the
> pre-existing generated `schedule_templates` row keeps a "byte-identical"
> deterministic id is **FALSE for a real population of camps**. The affected
> sentences are left in place unaltered, as a recorded gap rather than a silent
> amendment (Constitution Art. I); the full correction is at the end of this
> document under [Correction 2026-07-29](#correction-2026-07-29-the-generated-templates-id-is-not-byte-identical).


**Status: ACCEPTED by the product owner, 2026-07-28.** Article IV's requirement of
explicit acceptance before Maker is dispatched is satisfied. All four questions
this ADR refused to settle have been answered by the product owner and are
recorded below — including the live span-counting defect found while writing it,
and a flag-taxonomy change (OVERLAP) the product owner authorised by naming it.

Resolves T15.0. Answers §5a–5d of
[`docs/work/specs/2026-07-28-separate-manual-and-generated-flows.md`](../work/specs/2026-07-28-separate-manual-and-generated-flows.md).

**Three of that spec's stated premises are contradicted by the code.** They are
recorded in Context below rather than quietly designed around, per Article I
("code found to contradict a standard is a recorded gap, not a silent
amendment") and Article II rule 2. The most consequential is that the spec's
§5a recommendation — *"No new table and no new column"*, *"nearly free"* — is
**not implementable as written**: a database constraint added yesterday makes a
second `schedule_templates` row per camp impossible.

---

## Context

### What the product owner settled

Two coexisting, equally legitimate routes to producing a schedule — the manual
route (the Excel replacement) and the generated route (engine proposes, director
edits by drag-and-drop). Both tabs always reachable, switching non-destructive,
each producing its own schedule, sharing one camp setup and one flag vocabulary.
**No canonical schedule**: the app never elects a winner, never designates one as
active, and asks the director at the moment exactly one must be acted on.

### Verified current state

Confirmed by reading the code on this branch today.

- `src/screens/ScheduleScreen.jsx` holds one `templateId` and one `slots` array.
  `view` is local `useState` (`'manual' | 'group' | 'day' | 'activity'`).
  `ManualBuildView` (`:1669`) reads the same `slots` every other view reads —
  the T15 defect.
- The Manual Build tab renders only when `hasSchedule` (`:1409`). The genuine
  from-scratch entry is `placeAnchors()` (`:695`), which calls
  `buildSchedule({..., anchorsOnly: true})` and `bulkReplace`s the result onto
  the **same** template id, then sets `view='manual'`.
- `template_slots`, `template_overlays` and `schedule_snapshots` are already
  parent-scoped to `schedule_templates`
  (`electron/ops/campScopedEntities.js:28-49`), and every `bulkReplace` is
  already invoked per `template_id`. Sync, authorization and op-log projection
  therefore already carry a template-id dimension end to end. `schedule_templates`
  is already in `DIRECT_CAMP_ENTITIES` and in `electron/auth/permissions.js:23`.
- `schedule_snapshots` (`electron/db/schema.sql:326-337`) is an immutable
  point-in-time JSON blob keyed to a `template_id`, carrying an explicit schema
  comment forbidding generalization of the pattern to actively-edited tables.
- There is no export, print, PDF or CSV surface anywhere in the app today.

### Three premises in the approved spec that the code contradicts

**(1) A second `schedule_templates` row per camp is currently impossible.**
Migration v21 (`electron/db/localDb.js:853`) ends with:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_templates_camp
  ON schedule_templates(camp_id);
```

Every database — fresh or migrated — runs this migration, so the constraint is
universal. The spec's §5a claim of "no new table and no new column" and "nearly
free" is therefore **false as written**. Giving each route its own row *requires*
a schema change and a migration. This moves the work into the governance index's
**Database/sync** row: ADR **plus** migration and rollback plan, **plus**
mandatory integration tests. It also **voids the spec §9 omission of Security**,
whose rationale is explicitly self-cancelling ("void the moment Architect's ADR
proposes a schema change"). Security must be dispatched.

**(2) The renderer does not yet derive the template id, and still mints random
UUIDs.** The spec §2 states `ScheduleScreen.jsx` resolves via the deterministic
id. It does not. `generate()` (`:288-292`) and `placeAnchors()` (`:701-705`)
both still do `tid = crypto.randomUUID()`, and `loadAll()` (`:234-235`) still
does `templates.find(x => x.camp_id === campId)` — first match wins. This is
**slice 2 of the accepted T7 ADR, deliberately held back** "until a parallel UI
branch lands". This is that branch. The renderer-side write-gate on
`first_sync_completed_at` is likewise unlanded (the column and the main-process
half exist; no `src/` consumer reads it). Slice 2 is therefore a hard
prerequisite of this work, not an optional tidy-up: the moment a second row
exists, `find()` silently elects a winner, violating predicate 11.

**(3) The audit-only function the spec asks to create already exists — and the
extraction the spec mandates would silently change engine behaviour.**
Spec §5d calls `auditSlots` a "new capability required by this work" and
instructs that finding computation be extracted from `scheduleCohort()` so
`buildSchedule()` calls it. But `computeFindings({slots, groups, activities, days})`
is already an exported, pure, placement-free function
(`src/engine/buildSchedule.js:417`) with eight unit tests, already consumed by
`loadAll()` (`:247`) and `restoreSnapshot()` (`:674`). It takes exactly the
snake_case persisted-row shape a manual grid has.

It is **not** an extraction, however — it is a hand-written second copy
("Mirrors the aggregate-findings logic in scheduleCohort's Pass 3"), and the two
copies **disagree**. `scheduleCohort`'s DISTRIBUTION counts
`resultSlots.filter(s => s.type === 'activity' && ...)` with **no
`is_span_head` filter** (`:381-384`), so a spanned activity is counted once per
block it occupies; `computeFindings` filters to heads only (`:445`), counting it
once. Demonstrated on identical data — one group, one 2-block `span_blocks: 2`
activity with `prefer_before_day: 2, prefer_before_day_min: 2`:

| | DISTRIBUTION findings |
|---|---|
| `buildSchedule()` | `[]` — counts the Monday span as 2, goal met |
| `computeFindings()` | one finding — counts it as 1, goal missed |

Live consequence today, independent of T15: a director generates a schedule and
sees "all clear", then reloads the app and sees a finding appear on the very same
schedule. `buildSchedule.test.js` does not cover this case, so **the spec's
stated evidence rule for T15.4 — "`buildSchedule.test.js` must pass unchanged" —
would not detect the behaviour change it exists to prevent.** Spec §5d's own
instruction applies: *"If Architect concludes the extraction cannot be
behaviour-preserving, that is an Article IV stop, not a judgement call."* It
cannot be. This is that stop.

---

## Decision

### 1. Each route gets its own `schedule_templates` row, distinguished by a new `kind` column

Two rows per camp, ids derived deterministically so no two devices can fork:

| Route | Derived id | `kind` |
|---|---|---|
| generated | `schedule-template:${campId}` — **byte-identical to today** | `generated` |
| manual | `schedule-template:${campId}:manual` | `manual` |

`deriveScheduleTemplateId(campId)` gains an optional second argument. The
one-argument call keeps returning today's exact string, so migration v21's
re-keying and every existing row remain correct with no data touched.

That helper **already exists** at `electron/ops/scheduleTemplateId.js:19` and is
already imported by `electron/db/localDb.js:7,844` inside migration v21. Two
consequences the implementer must not miss: (i) do **not** create a second copy
under `src/` — the renderer imports the existing `electron/` module, as that
file's own header comment sanctions; (ii) editing it changes **migration**
behaviour on real databases, not only renderer behaviour, so the additive
second-argument constraint is a hard requirement rather than a style preference.
What is genuinely unlanded is the renderer half only: `ScheduleScreen.jsx` still
mints `crypto.randomUUID()` template ids, so T7 slice 2 remains a prerequisite
of T15.1.

**A `kind` column is added, and it is load-bearing rather than cosmetic.** The
route must be recoverable from the row itself — not inferred from `name` (which
is director-editable display text) and not by string-parsing the id (which makes
the id format a parsing contract). `kind` is also what lets the v21 constraint be
*preserved in strength* rather than dropped, below.

Rejected sub-option: distinguishing routes by `name` only, as spec §5a suggests
("`schedule_templates.name` already exists and distinguishes the rows"). Rejected
because `name` is user-facing text with no integrity guarantee — a director
renaming a schedule would change which route the app believes it belongs to.

### 2. The v21 uniqueness invariant is narrowed, not removed

Migration v23:

1. `ALTER TABLE schedule_templates ADD COLUMN kind TEXT`
2. Backfill every existing row to `'generated'`
3. `DROP INDEX idx_schedule_templates_camp`
4. `CREATE UNIQUE INDEX idx_schedule_templates_camp_kind ON schedule_templates(camp_id, kind)`
5. Add `'kind'` to `PROJECTIONS.schedule_templates.fields`
   (`electron/ops/projections.js:206`, today `['camp_id','name']`) and to
   `ensureExists`, or the column will never materialize from a replayed op and
   will silently stay `NULL` on every device but the one that wrote it.

**No row is deleted. No `template_slots`, `template_overlays` or
`schedule_snapshots` row is read, rewritten or migrated.** Article IV's
destructive-operation gate is not reached, by construction.

Step 4 preserves the v21 invariant at full strength rather than weakening it: at
most one row per camp *per route*, so a regression reintroducing
`crypto.randomUUID()` is still blocked exactly as v21 intended. Per v21's own
recorded Consequences the constraint's remaining job is defense-in-depth against
such a regression — narrowing its key keeps that job intact while permitting the
second legitimate row.

The **fresh-vs-migrated schema equivalence** check the governance index mandates
for this task class still applies. An earlier draft of this ADR justified it by
claiming fresh databases skip the index because it is created by migration rather
than `schema.sql`. That reason is **wrong and is withdrawn**: `initSchema()`
executes `schema.sql` and then runs every `if (getSchemaVersion(db) < N)` block,
including v21 at `electron/db/localDb.js:853`, so a fresh database does get
`idx_schedule_templates_camp`. The check is required because v23 mutates schema
on both paths, not because the paths already differ — an implementer must not go
looking for a divergence that does not exist.

### 3. The screen keys its existing state by route rather than duplicating it

`ScheduleScreen.jsx` gains one `route` state (`'generated' | 'manual'`), and
`templateId`, `slots`, `overlays` and `snapshots` become **route-scoped** — held
per route and re-loaded on switch — while keeping their existing names and
shapes.

This is the specific reason for the design: roughly twenty call sites
(`editSlotSave`, `swapSlots`, `addOverlay`, `expandSlot`, `splitSlot`,
`saveSnapshot`, `restoreSnapshot`, `placeActivityManual`, …) read `templateId`
and `slots` directly. Keying the existing variables means **none of them
changes**, and no consumer can read the wrong candidate by forgetting a
parameter. Introducing parallel `manualSlots`/`manualTemplateId` variables
alongside the existing ones is rejected: it creates exactly the failure mode
Code Reviewer is dispatched to hunt — one consumer silently reading the other
route's data — and it is the same shape of mistake T15 reports.

Route selection is **local UI state and does not sync** (§5b): `view` is already
local, and replicating it would mean a director's tab click changes what a
counsellor on another laptop is looking at. Both candidate schedules replicate to
every device via the existing `DIRECT_CAMP_ENTITIES`/parent-scoped paths with no
sync change at all.

### 4. `computeFindings` is the audit path. Nothing is extracted, and `buildSchedule()` is not touched

The manual route calls the existing `computeFindings` — the same function the
generated route already calls on load and restore. One implementation, one
vocabulary, structurally shared, satisfying predicates 7 and 9 **without
modifying `src/engine/buildSchedule.js` at all**. Its algorithm, signature,
determinism and seeded PRNG are untouched; `buildSchedule.test.js` passes
unchanged because nothing it tests is edited.

`auditSlots` is **not** created. Creating a third name for a function that
already exists and already works would be duplication, not a capability.

**The `buildSchedule`/`computeFindings` span-counting divergence is NOT fixed
here.** It is a pre-existing defect, it predates this work, it is not required by
any of the eleven predicates, and reconciling it means changing what the engine
reports — a flag-semantics question reserved to the product owner by Article IV
and by the governance index's Scheduling-engine row. It must be filed as its own
ticket with the evidence in Context §(3). Folding it into T15 would be exactly
the silent scope expansion Article II rule 2 forbids.

### 5. Versions are not candidate schedules, and get plurality for free

Two distinct concepts, kept distinct:

- A **candidate schedule** is actively edited, field-level synced and op-logged.
- A **Version** (`schedule_snapshots`) is an immutable JSON blob of one candidate
  at one moment.

Modelling the manual route as "a snapshot you can edit" is rejected: it would
contradict that table's own recorded schema decision and destroy field-level sync
granularity. Because `schedule_snapshots.template_id` already exists and is
already parent-scoped, **each route inherits its own independent Versions history
with no new mechanism** — predicate 10 is satisfied by scoping save and restore
to the current route's template id. Existing snapshots point at the generated id
and keep restoring into the generated route.

### 6. Export, when it exists, asks the director

No export surface exists today, so this is a forward constraint, not a change.
Any future export, print, or "show this on the counsellor's device" feature
**must present an explicit choice of which candidate schedule to act on, at that
moment, and must not remember the answer as a default.** No newest-wins, no
generated-wins, no manual-wins. Nothing in either route's chrome may assert that
it is the one that counts. This is Article V at the architecture level.

---

## Considered options

- **One template, a `route` column on `template_slots`.** Rejected. Every
  existing consumer, every `bulkReplace` call and the snapshot payload shape
  would need a route filter retrofitted, and any consumer that forgot one would
  silently mix the two routes — precisely the defect T15 reports. It also cannot
  give each route its own Versions history without further work, whereas the
  two-row design gets that for free.
- **Drop `idx_schedule_templates_camp` outright instead of narrowing it to
  `(camp_id, kind)`.** Rejected. It is simpler by one column but discards a
  defense-in-depth invariant an accepted ADR installed one day earlier
  specifically to stop templates forking across devices. Narrowing costs one
  nullable column and keeps the protection.
- **Model the manual route as an editable `schedule_snapshots` row.** Rejected —
  contradicts that table's explicit schema comment and breaks field-level sync
  granularity (§5).
- **Extract `auditSlots` from `scheduleCohort()` and have `buildSchedule()` call
  it, per spec §5d.** Rejected on evidence: the target function already exists,
  and the extraction cannot be behaviour-preserving because the two copies
  genuinely disagree on span counting (Context §3). Performing it would change
  what the engine reports to directors while the mandated evidence rule
  ("tests pass unchanged") registered green.
- **Clear the grid on entering Manual Build, snapshotting first** (T15's original
  recommended shape). Rejected — superseded by the product owner's two-route
  decision, which removes the destructive operation entirely rather than guarding
  it. Predicate 3 fails under any variant of it.

---

## Consequences

- **This is a Database/sync change.** Migration v23 plus rollback plan plus
  **mandatory integration tests**, plus fresh-vs-migrated schema equivalence.
  **Security is dispatched** — the spec §9 omission is void by its own terms.
- **Rollback is safe only before the manual route is used, and this must be
  stated plainly rather than assumed.** Reverting the code alone is clean: the
  `kind` column is additive and ignored by older code paths. But restoring the
  original `UNIQUE(camp_id)` index **fails if a manual row exists**, and forcing
  it would require deleting that row and its slots — a destructive operation on
  a director's real work. Rollback after any manual placement therefore requires
  explicit director consent (Article IV), and is not an operation an agent may
  perform unattended. The migration is otherwise fully reversible.
- **A `kind` value that never materializes is the sharpest new failure mode.**
  If step 5 of the migration is missed, `kind` stays `NULL` on every device
  except the writer, the unique index treats distinct `NULL`s as non-conflicting
  in SQLite, and a camp can accumulate multiple "manual" rows across devices —
  reintroducing the exact fork v21 was written to prevent. The integration tests
  must assert `kind` replicates, not merely that two rows can coexist locally.
- **Two devices can be looking at different candidate schedules while both
  believe they are looking at "the schedule".** This is the real operational risk
  of §5b and it is mitigated by labelling, not by forcing agreement — forcing
  agreement would elect a winner. **This is a product-judgement question, not
  settled here** (Open questions, below).
- **The generated route's behaviour is unchanged**, including drag-and-drop
  editing in Group and Daily View (predicate 8), and the generated template id
  is byte-identical, so no existing camp's data moves.
- **T15.1 must land T7 slice 2** (deterministic ids at both mint sites,
  resolution by derived id rather than `find()`, and the renderer write-gate).
  This is a prerequisite, not a parallel task, and it should be sequenced and
  reviewed as such.
- **The engine's post-generate findings remain inconsistent with the findings
  shown after a reload**, for spanned activities only. Disclosed, not fixed, not
  converted into a passing result (Article II rule 3). It is a separate ticket.

---

## Blocking defects found by adversarial review, each verified in code

These were raised against an earlier draft of this ADR and **each was confirmed
by reading the code**, not accepted on assertion. They are recorded here because
they contradict claims made above and elsewhere in the approved spec. None is
fixed by this ADR; each must be answered before Maker is dispatched.

1. **The snapshot safety net is lossy, so "nothing is lost because we snapshot
   first" is overstated.** `saveSnapshot` (`src/screens/ScheduleScreen.jsx:553-561`)
   serialises only `group_id, day_id, time_block_id, activity_id, anchor_id,
   is_anchor, flags`, and `restoreSnapshot` (`:630-640`) writes rows with the
   same set. `is_span_head` and `is_released` are **dropped in both directions**.
   Because readers compare `s.is_span_head === false`, a restored spanned
   activity returns as N independent cells with the activity duplicated, and a
   released lock returns locked. Pre-existing, but T15 is the first design to put
   load on it. Any UI copy or button-affordance decision that rests on "restore
   returns your week as it was" is currently unsupported.

2. **A not-yet-upgraded LAN peer silently drops the entire manual candidate.**
   On a pre-v23 peer the still-present `UNIQUE(camp_id)` index absorbs the manual
   template row via `INSERT OR IGNORE` (`electron/ops/projections.js:206-212`),
   every subsequent `template_slots` op then violates the `template_id` foreign
   key, and `applyRemoteOp` (`electron/sync/syncClient.js:374-378`) **swallows
   projection failures with no observability by design**. `sendFullSyncIfFirstPairing`
   (`electron/sync/syncServer.js:151-153`) returns early unless
   `devices.last_synced_at` is `NULL`, so no later re-sync repairs it. There is
   no schema/protocol version gate on the wire. The `kind`-projection mitigation
   in Decision 2 does **not** cover this: the failure is on the *old* peer, which
   has neither the column nor the relaxed index.

3. **`restoreSnapshot` is not route-safe by construction.** It re-stamps
   `template_id: templateId` from component state onto every row
   (`:632`) and then `bulkReplace`s. Route scoping would be enforced only by the
   Versions list filtering in the UI. An assertion that
   `snapshot.template_id === templateId` before the `bulkReplace` is required,
   or one wrong id overwrites the other route's entire week with no snapshot of
   what it destroyed.

4. **`loadAll()` is a global reset, not a route-scoped one.** It is fired on
   every applied op (`:112`) and unconditionally calls `setSlots`, `recalcStats`,
   `setFindings` and `setDismissedFindingKeys(new Set())` (`:243-249`). With two
   candidates, an op belonging to the route the director is *not* viewing clears
   their dismissed findings mid-manual-build. The comment at `:222-227` records
   that this class of unconditional reset already caused defect T10. Decision 3's
   "~20 call sites unchanged" understates this: `loadAll` must learn which route
   it is refreshing.

5. **Export is live today, so the export chooser belongs to this change.**
   `src/screens/ScheduleScreen.jsx:1476` wires `Export to Excel` to
   `exportToExcel({ slots, … })` over the shared `slots` array. The moment
   `slots` is route-scoped, Export silently elects whichever route is on screen —
   predicate 11 violated by omission. The approved spec's non-goal "no export
   surface exists today" is false and needs amending **by the product owner**,
   not by an agent (Article II rule 2).

6. **Anchors are materialised into `template_slots` at build time and never
   refreshed** from `anchor_activities`. With two candidates a Setup meal-time
   change updates neither route, and the routes drift from each other and from
   Setup silently. This partially undercuts the brief's consequence 4, "one camp
   setup consulted by both routes": setup is genuinely shared for activities and
   frequencies, but is a one-time copy for anchors.

7. **`generate()` is structurally safe, and must stay that way.** `bulk_replace`
   is delete-then-reinsert scoped by `scope_id` (`electron/ops/operations.js:126-167`)
   and `generate()` passes the template id, so generating cannot wipe the manual
   route's rows. Any change broadening that scope to `camp_id` would turn
   Generate into a destroyer of manual work.

---

## Product-owner decisions recorded 2026-07-28

Answered directly by the product owner. These are no longer open.

- **Versions and schedules are separate concepts.** Confirms Decision §5. A saved
  version is a point in time you can go back to; a candidate schedule is an idea
  you are working on. They do not merge into one mechanism.
- **Deterministically derived ids are approved.** Confirms Decision §1 — the
  generated route keeps `schedule-template:${campId}` byte-identical to today,
  the manual route derives `schedule-template:${campId}:manual`. This carries
  with it the `kind` column and migration v23, which the product owner accepts as
  the cost of the approach.
- **Question 2 — what the manual grid shows when first opened: show the findings.**
  Product owner: "when they open manual grid, flag system can say so." A blank grid
  therefore reports every under-target activity immediately, as an honest to-do
  list rather than a wall of failures. This is the Article V answer and the useful
  one: the director sees what the week still owes them before placing anything.
  Copy and tone must carry that framing — this is work remaining, not errors made.
- **Question 3 — per-device route selection is accepted.** It is the only option
  consistent with the product owner's own standing decision that no schedule is
  canonical: a designation concept is precisely what predicate 11 forbids.
- **Route naming: "Manual" and "Generated" for now.** Product owner: "manual and
  generated work for noow" — explicitly provisional, not a final terminology
  decision. Do not spend design effort renaming; do not treat this as settled
  vocabulary either.

## Open questions — product judgement, not settleable by an agent (Article IV)

Two of the original four remain. Maker must not be dispatched until these are
answered.

### Question 1 — ANSWERED: there is no "unfillable" on the manual grid

Product owner, verbatim:

> "there would not be any unfillable on the manual grid, it would be not filled
> yet. if someone is building their own, everything can be placed as they want.
> the other flags - overlap, underserved, etc, are more important here"

This resolves the three-meanings problem by removing the word from the route
entirely rather than choosing between its meanings:

- **An empty manual cell is "not filled yet".** Neutral. It is not a problem, it
  is work remaining. `UNFILLABLE` is an engine verdict — *I could not place
  anything here* — and the engine does not run on this route, so the verdict has
  no author and must not appear.
- **The director is not blocked.** "Everything can be placed as they want" is the
  governing sentence. On the manual route the app does not refuse a placement; it
  accepts it and tells the truth about the consequence. This is Article V exactly:
  surface the conflict, never resolve it silently, and leave the director in
  control.
- **Predicate 7 needs narrowing.** It says unfillable cells are marked "in both
  routes, same words". That is now wrong for the manual route. The two routes
  share a flag *vocabulary*, not an identical flag *set*. The spec must be
  amended; per Article I this is recorded here rather than quietly reinterpreted.

**This entails a flag-taxonomy addition, which is a human gate the product owner
has now authorised by naming it: OVERLAP.** Verified current state — there is no
overlap flag today. `max_groups_per_slot` exists on activities and
`ScheduleScreen.jsx:772-773` computes `locationFull` at drop time to *reject* a
placement. The manual route needs the opposite behaviour: accept the placement and
flag the overlap. The engine's `conflicts` array (`buildSchedule.js:18, 524`) is
always `[]` and reserved for Sub-project 3 multi-cohort work — OVERLAP must not be
smuggled into it.

Manual route flag set: **OVERLAP, UNDERSERVED, DISTRIBUTION.** Not UNFILLABLE.
Generated route is unchanged.

### Question 4 — ANSWERED: a span counts as one session

Product owner selected: a 2-block activity counts **once**, not twice. A double-length
swim is one swim — the director scheduled swimming once, it simply ran long.
`min_per_week` / `max_per_week` and "twice before Wednesday" style goals therefore
count *sessions*, not blocks occupied. This fixes a live defect and must be applied
consistently to both routes, with a regression test at the counting seam.

---

<details>
<summary>Original wording of questions 1 and 4, retained for the record</summary>

1. **What "unfillable" means on a manual grid.** On a generated schedule
   `UNFILLABLE` means *the engine could not place anything here*. On a blank
   manual grid every cell is empty, but empty is not unfillable — and
   `placeActivityManual` (`:757`) already writes `UNFILLABLE` with a **third**
   meaning: *this placement you just attempted is invalid* (ineligible group, or
   location full). Predicate 7 says unfillable cells are marked in both routes
   "with the same words". Three meanings currently share one word. Which one a
   director should see on the manual grid is a flag-semantics question reserved
   to the product owner.
2. ~~What the manual grid shows when first opened.~~ **ANSWERED** — show the
   findings. See Product-owner decisions above.
3. ~~Is per-device route selection acceptable.~~ **ANSWERED** — yes. See above.
4. **The span-counting divergence** (Context §3): which count is correct for a
   2-block activity against a "twice before Wednesday" goal — one placement, or
   two? This decides a live defect and belongs to the product owner.

</details>

**All four open questions are now answered. This ADR is accepted.**

---

## Migration and rollback

Added 2026-07-29 by Architect, as required by the governance index's Database/sync
row and by Consequences above. This section is normative for T15.1b. It specifies
migration engineering only; it does not reopen any accepted decision. Where it
tightens a detail sketched in Decision §2 (the column is `NOT NULL DEFAULT
'generated'` rather than bare `TEXT`), the reason is recorded inline and the
weaker form is named as rejected, not silently replaced.

### 1. Migration v23, exactly

`CURRENT_SCHEMA_VERSION` (`electron/db/localDb.js:14`) goes 22 → 23. The block
follows the shape of every prior migration: one `db.transaction(() => {…})`,
guarded by `table_info` so it is idempotent and safe on a fresh database (which
runs `schema.sql` and then every version block, per Decision §2).

```sql
-- 1. the column, guarded by a table_info check like v22's
ALTER TABLE schedule_templates ADD COLUMN kind TEXT NOT NULL DEFAULT 'generated';

-- 2. backfill is implicit for existing rows (see §2), and made explicit
--    for safety on a re-run:
UPDATE schedule_templates SET kind = 'generated' WHERE kind IS NULL OR kind = '';

-- 3. narrow the v21 invariant
DROP INDEX IF EXISTS idx_schedule_templates_camp;
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_templates_camp_kind
  ON schedule_templates(camp_id, kind);
```

`schema.sql:310-314` gains `kind TEXT NOT NULL DEFAULT 'generated'` **as the last
column of the table**. Column position is load-bearing for the equivalence check
in §4: `ALTER TABLE ADD COLUMN` always appends, so a fresh database only matches a
migrated one if `schema.sql` declares it last. The declared type, nullability and
default must be byte-identical in the two places for the same reason.

**Why `NOT NULL DEFAULT 'generated'` rather than the bare `TEXT` sketched in
Decision §2.** Consequences above names a NULL `kind` as "the sharpest new failure
mode": SQLite treats distinct NULLs as non-conflicting in a unique index, so a
nullable `kind` leaves `(camp_id, kind)` unable to block the very fork v21 exists
to prevent. `NOT NULL DEFAULT 'generated'` removes that state from the schema
rather than relying on every writer to remember. SQLite permits adding a NOT NULL
column when a non-null default is supplied, so no table rebuild is required. The
default also makes the migration's own backfill (§2) a no-op by construction and
keeps every pre-existing `INSERT` statement that does not mention `kind` — the
projection bootstrap, migration v21's re-key insert — valid and correct without
edit.

**Invariant preserved, and what is given up.** v21's guarantee was *at most one
`schedule_templates` row per camp*, installed as defense-in-depth against a
regression that reintroduces `crypto.randomUUID()` and forks a camp's schedule
across devices. v23 preserves that guarantee **per route** — at most one row per
`(camp_id, kind)` — so a random-id regression is still blocked exactly as before:
a second `generated` row for a camp is still rejected by the database. What is
given up is the ability to assert "a camp has one schedule" at the storage layer;
the app must now say "a camp has one schedule *per route*", and any code that
assumed a camp's template could be found by `camp_id` alone is now wrong. That
assumption exists today at `ScheduleScreen.jsx:234-235` and is why T15.1a is a
hard prerequisite rather than parallel work.

**Projection registration** (`electron/ops/projections.js:206`), without which the
column never materialises from a replayed op:

- `fields: ['camp_id', 'name', 'kind']`.
- `ensureExists` inserts `kind` explicitly:
  `INSERT OR IGNORE INTO schedule_templates (id, camp_id, name, kind) VALUES (?, ?, '', ?)`
  where the value is the op's own `value` when `field === 'kind'`, and
  `'generated'` otherwise.
- **Required write ordering:** the renderer must write `kind` **first** when
  creating a manual template row, exactly as `day_override_template_slots` and
  `schedule_snapshots` already require `…_template_id` first (the precedent is
  recorded in that file's own comments). Op replay is ordered by `seq`, so
  ordering at the write site is ordering at every replica. This ordering is what
  makes the `'generated'` fallback safe: it can only ever be reached by an op
  stream that predates this change or belongs to the generated route, which is
  precisely today's behaviour preserved.
- If the ordering is ever violated, the row materialises as `generated`, collides
  with the real generated row under the new unique index, and is absorbed by
  `INSERT OR IGNORE` — the manual candidate vanishes silently on that device.
  This is the failure the integration test in §4 must pin, and it is why the
  ordering is stated as a contract here rather than left to the implementer.
- **Rejected:** recovering the route inside `ensureExists` by parsing the `:manual`
  suffix off the id, even via an inverse helper exported from
  `electron/ops/scheduleTemplateId.js`. Decision §1 explicitly refuses to make the
  id format a parsing contract. Recorded as rejected rather than quietly adopted
  (Article I). If write ordering proves unworkable in implementation, that is an
  escalation to Governor, not a licence to take this route.

`deriveScheduleTemplateId` gains an **additive** optional second argument
(`kind = 'generated'`), the one-argument call returning `schedule-template:${campId}`
byte-identically. That file is imported by migration v21 at
`electron/db/localDb.js:7,844`, so any non-additive edit changes migration
behaviour on real databases.

### 2. Backfill: what happens to every existing camp

Every existing camp has exactly one `schedule_templates` row — guaranteed by v21,
which deduplicated and then re-keyed it to `schedule-template:${camp_id}`. On
upgrade:

- That row's `id` is **not touched**. It stays byte-identical, so every
  `template_slots`, `template_overlays` and `schedule_snapshots` row keeps
  pointing at it and no director's schedule moves, is rewritten, or is re-keyed.
- It acquires `kind = 'generated'` — supplied by the column default at ALTER time
  for every existing row in one statement, with the explicit `UPDATE` in step 2
  as a belt-and-braces no-op that also covers a partially-applied re-run.
- No manual row is created by the migration. The manual candidate is created
  **lazily, on first use** of the manual route, by the renderer through the normal
  op-log path. A camp that never opens Manual Build has exactly one row forever,
  and its database is functionally identical to today's.
- **No row in any table is deleted, rewritten, or migrated.** Article IV's
  destructive-operation gate is not reached. If an implementer finds themselves
  writing a `DELETE` or an `UPDATE` against `template_slots`, `template_overlays`
  or `schedule_snapshots` in this migration, that is a stop and an escalation.

### 3. Rollback

**A code revert alone is not a rollback, and shipping one would brick the app.**
`openLocalDb` (`electron/db/localDb.js:905-909`) refuses to open a database whose
recorded version exceeds the running build's `CURRENT_SCHEMA_VERSION`. Any device
that has run v23 will therefore be *unable to start* on a reverted v22 build — it
does not degrade, it fails closed at launch. This is correct behaviour and it means
rollback must be a deliberate, scripted downgrade run on **every device in the
camp**, not a release-channel roll-back.

**Preferred response to a bad v23: forward-fix at v24.** Rollback below is the
contingency, and its cost should be weighed against a forward fix every time.

Downgrade procedure, in order, per device:

1. **Copy the database file (and its `-wal`/`-shm`) to a timestamped backup
   beside it.** Nothing else in this procedure may run until the copy exists. This
   is a precondition, not the plan.
2. **Inspect before deciding:**
   `SELECT t.id, (SELECT COUNT(*) FROM template_slots s WHERE s.template_id = t.id) AS slots,
   (SELECT COUNT(*) FROM schedule_snapshots n WHERE n.template_id = t.id) AS versions
   FROM schedule_templates t WHERE t.kind = 'manual';`
3. **If any manual row has a non-zero count — STOP.** Downgrading requires deleting
   that row, and the original `UNIQUE(camp_id)` index cannot be restored while it
   exists. Deleting it destroys a director's real work: an **Article IV stop
   requiring explicit director consent**, and not an operation an agent may perform
   unattended. The honest options at that point are (a) stay on v23 and forward-fix,
   or (b) obtain consent, export or otherwise preserve the manual week first, then
   proceed. There is no third option in which the work survives a downgrade.
4. **If every manual row is empty** (or consent per step 3 has been obtained):
   `DELETE FROM schedule_templates WHERE kind = 'manual';`
   `DROP INDEX IF EXISTS idx_schedule_templates_camp_kind;`
   `CREATE UNIQUE INDEX idx_schedule_templates_camp ON schedule_templates(camp_id);`
   `DELETE FROM schema_migrations WHERE version >= 23;`
   all in one transaction. The index re-creation is the step that fails loudly if
   step 2 was skipped — treat a failure there as proof that a manual row still has
   children, and go back to step 3.
5. **Leave the `kind` column in place.** `DROP COLUMN` is available in this SQLite
   build but buys nothing: every write in the codebase names its columns explicitly,
   the column has a non-null default, and a v22 build ignores it entirely. Leaving
   it also keeps a later re-upgrade clean, because the v23 ALTER is `table_info`-guarded.
6. **The op-log is not rewritten.** `operations` rows for the manual template and
   for `kind` fields remain, and remain canonical. On a v22 build `kind` is not in
   `PROJECTIONS.schedule_templates.fields`, so those ops project to nothing; the
   manual template's own ops are absorbed by `INSERT OR IGNORE` under the restored
   `UNIQUE(camp_id)` index. This is deliberate: it makes a re-upgrade to v23
   recoverable via the repair step in §5 rather than lossy.
7. **A partially-downgraded fleet is exactly the mixed-version failure in §5.** A
   v22 device and a v23 device on the same LAN will not error; the v22 device will
   silently lack the manual candidate. Downgrade all devices or none.

### 4. Fresh-vs-migrated schema equivalence

**Precedent to follow, verbatim in shape:** `electron/db/localDb.migrations.test.js:496`
— *"fresh db (schema.sql) and a pre-v10 db upgraded via the migration block end up
with IDENTICAL schema"*. It builds two databases with `freshDb()`, rebuilds the
affected tables on one to their pre-migration shape (rename → create-old → copy →
drop, never `DROP COLUMN`), does `DELETE FROM schema_migrations WHERE version >= N`,
re-runs `initSchema`, and compares `pragma('table_info(t)')` normalised to
`{name, type, notnull, dflt_value, pk}`.

The v23 test follows that structure with two additions, both mandatory:

1. **Column comparison** of `schedule_templates` as above — this is what catches a
   `schema.sql` declaration whose type, default, nullability or *position* differs
   from the `ALTER`.
2. **Index comparison**, which the v10 precedent does not need and v23 does,
   because v23's whole invariant lives in an index rather than a column. Compare,
   between fresh and migrated: `pragma('index_list(schedule_templates)')` normalised
   to `{name, unique, origin, partial}`, `pragma('index_info(<name>)')` for each,
   and `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='schedule_templates'`.
   Assert positively that `idx_schedule_templates_camp_kind` exists and is unique on
   `(camp_id, kind)` in **both**, and that `idx_schedule_templates_camp` exists in
   **neither**.
3. `expect(getSchemaVersion(migratedDatabase)).toBe(23)`, and the same for the
   fresh database.

Behavioural tests that belong beside it (the "mandatory integration tests" of
Consequences), stated so they are not reduced to schema-shape checks:

- Two rows per camp coexist (`generated` + `manual`); a **third** is rejected, and a
  **second `generated`** is rejected.
- **`kind` replicates.** Assert on a *second device* that the manual row exists with
  `kind = 'manual'` after sync — a local-only assertion is explicitly insufficient
  per Consequences.
- The write-ordering contract: an op stream that writes `kind` first materialises a
  manual row on the receiving device; the reversed order is pinned as the known
  silent-loss case (§1) so a future change to `ensureExists` cannot quietly
  reintroduce it unnoticed.
- Existing single-row camps are unchanged: id byte-identical, children intact,
  `kind = 'generated'`.

`npm rebuild better-sqlite3` before `npm test`; `npx electron-rebuild -f -w
better-sqlite3` before `npm run electron:dev`.

### 5. What replicates, and what an older device does

**Replicates:** both `schedule_templates` rows including the `kind` field (the
entity is already in `DIRECT_CAMP_ENTITIES` and `electron/auth/permissions.js:23`),
and all `template_slots`, `template_overlays` and `schedule_snapshots` rows, which
are already parent-scoped by `template_id`
(`electron/ops/campScopedEntities.js:28-49`). **No sync-layer change is required.**

**Does not replicate:** which route a device is looking at. It is local UI state
(Decision §3), and replicating it would let one director's tab click change what a
counsellor on another laptop sees.

**A peer still on ≤ v22 receiving manual-route ops** — the failure most likely to
bite a real camp mid-season, restated here with its full chain because it is the
reason this section exists:

1. The `schedule_templates` op for the manual row arrives. `ensureExists` runs
   `INSERT OR IGNORE`; the old peer still has `UNIQUE(camp_id)`, which already holds
   the generated row, so the insert is **silently ignored**.
2. `kind` is not in that build's `fields`, so it is ignored too.
3. Every subsequent `template_slots` / `template_overlays` / `schedule_snapshots` op
   for that template violates the `template_id` foreign key.
4. `applyRemoteOp` (`electron/sync/syncClient.js:374-378`) **swallows projection
   failures by design**, with no logging infrastructure to surface them.
5. `sendFullSyncIfFirstPairing` (`electron/sync/syncServer.js:151-153`) returns early
   unless `devices.last_synced_at` is `NULL`, so no later sync repairs it.
6. There is no schema or protocol version gate on the wire, so nothing detects the
   mismatch. **Net effect: the old device shows no manual schedule and no error.**

Two things make this survivable, and both must be implemented:

- **The op-log entry is inserted *before* projection is attempted and is
  unconditionally durable** (`syncClient.js`, the `insert()` above the `try`). The
  old peer therefore *has* every manual-route op on disk; only the projected tables
  are missing. Nothing is lost — it is unmaterialised, which is repairable.
- **Migration v23 ends with a bounded, additive repair pass.** In `seq` order,
  re-project every logged op whose entity is `schedule_templates` and whose
  `entity_id` has no row in `schedule_templates`, then every
  `template_slots` / `template_overlays` / `schedule_snapshots` op belonging to the
  template ids so recovered (including `bulk_replace` ops via
  `applyBulkReplaceProjection`). **Scope it strictly to templates that are currently
  absent.** Rows that already projected successfully are not read, not deleted and
  not rewritten — the pass can only add what is missing, which keeps it clear of
  Article IV. Log the recovered count. An unbounded "replay everything" variant is
  rejected: it would rewrite correctly-projected `template_slots` rows via
  delete-then-reinsert, converting a repair into a destructive operation.
  `electron/ops/projections.js` is under `electron/`, so importing it into the
  migration is packaging-safe.

Residual, disclosed and not fixed here: **the old device stays wrong until it is
upgraded**, and nothing on screen says so. Repair is automatic at upgrade; there is
no in-season detection. A schema/protocol version gate on the sync handshake, and
observability on swallowed projection failures, are the real fixes and are already
filed as follow-up (c) in the spec's §12. Directors upgrading mid-season should be
told to upgrade every device together — an operational instruction, not a code
change, and one this design does not remove the need for.


## Correction 2026-07-29: the generated template's id is not byte-identical

**What this document got wrong.** In at least six places (the `kind` table, and
the discussions of migration v23, of what v23 does not touch, and of the manual
row's lazy creation) this ADR asserts that a camp's pre-existing generated
`schedule_templates` row "keeps its byte-identical deterministic id", and
therefore that resolving a route by *deriving* that id is safe. Two code
comments repeated the same premise: `electron/db/localDb.js` (migration v23) and
`electron/ops/scheduleTemplateId.js`.

**Why it is false.** Migration v21 re-keys every `schedule_templates` row present
*at the moment it runs* to `deriveScheduleTemplateId(camp_id)`. It is a one-shot
data fix, and the *writer* was not fixed at the same time: the renderer went on
minting `crypto.randomUUID()` ids until the renderer half of the T7
deterministic-id work landed, which happened only on the plural-routes branch.
Any row created in that window carries a random UUID that no migration will ever
normalise.

**Evidence** (product owner's dev database, captured at
`scratchpad/repro.sqlite`): `schema_migrations` records v21 applied at
`2026-07-28T16:34:06.838Z`, while the `operations` rows that created
`schedule_templates` id `48485127-57b0-42d9-b889-61d05d639ae7` are timestamped
`2026-07-28T22:51:38Z` — six hours later. v21 had nothing to re-key; the table
was empty when it ran.

**The consequence this caused.** On such a camp the renderer derived
`schedule-template:<campId>`, found no row, and tried to insert one.
`UNIQUE(camp_id, 'generated')` was already held by the random-UUID row, the
`INSERT OR IGNORE` in `schedule_templates.ensureExists` absorbed the violation,
every subsequent field `UPDATE` matched zero rows — and `generate()` went on to
write 50 `template_slots` under the derived id (that table has no declared FK,
so they were accepted). Result: a director whose app would not generate, and an
invisible orphan week on disk.

**What supersedes the assumption.** Route resolution is now by
`(camp_id, kind)`, not by derived id — `resolveTemplateId` in
`src/screens/ScheduleScreen.jsx`. The derived id is still what gets **minted**
when a route has no row at all, which preserves the invariant deterministic ids
exist for (two devices independently creating a candidate must agree on its id);
determinism was only ever needed at mint time. `schedule_templates.kind` remains
the sole authority on which route a row belongs to (Decision §1) — nothing
recovers a route by parsing an id at runtime.

**Supporting changes.** `schedule_templates.ensureExists` now throws
`SCHEDULE_TEMPLATE_KIND_CONFLICT` when an insert is absorbed by a
`(camp_id, kind)` collision, so a future regression cannot be silent. Migration
**v24** adopts orphaned children onto the resolved row *only* where that row has
no rows of its own in that table — otherwise it leaves them exactly where they
are. It deletes nothing and re-keys nothing, and every move it makes is
journalled in `migration_v24_repoint_log` so the inverse
(`electron/db/rollback/v24_down.js`) is computed from data rather than guessed.

**Governance note for the next migration of this shape.** A migration that
normalises ids must not merge until the writer that mints them is normalised in
the same change. v21 fixed the data and left the writer producing the old shape;
that gap is the whole defect.

## Addendum 2026-07-29: route selection lives in the left sidebar, and the neutral entry asks

Settled by the product owner ("sidebar"). Route selection is no longer a tab
switcher above the grid. `Manual Schedule` and `Generated Schedule` are two
entries in the existing left sidebar, mapped in `src/App.jsx`'s `SCREENS` map
to the same `ScheduleScreen` with an `initialRoute` prop. The in-grid control
that remains is a **label** naming the week on screen, not a switch. The
first-run choice screen ("How do you want to build this week?") is unchanged:
choose once from one screen, then the two candidates live in the sidebar.

Two consequences of that shape, both handled here rather than left implicit:

1. **One mounted component, two candidates.** The sidebar entries do not
   remount the screen, so undo/redo, the clipboard, the current selection and
   the direct-manipulation modes would otherwise survive a route switch and let
   a paste or an undo write into the candidate the director is *not* looking at
   — the exact cross-candidate write this ADR exists to prevent. Switching
   routes therefore drops all of that transient state. Nothing persisted is
   touched: each route's week, findings, snapshots and stats are untouched.

2. **The neutral `schedule` entry asks.** `CampSetup` and `AnchorsScreen`'s
   "Next: Schedule" links supply no route. Falling through to a default would be
   the app picking a director's week for them, which Decision §6 forbids and
   which "defaults" do not carve out. With **both** candidates started, the
   neutral entry now renders "Which week do you want to open?" and navigates to
   whichever the director picks; the pick is not remembered. With one or none
   there is no choice to make and the normal screen (grid, or the first-run
   offers) is shown.

**Residual, recorded not claimed away.** `v24_down.js` restores the rows it
journalled, but `CURRENT_SCHEMA_VERSION` is 24 and `getSchemaVersion()` reads
`MAX(version)`, so the same app build re-applies v24 on the next launch. A
rollback only sticks if the binary is downgraded at the same time; the script
says so and prints a warning. v24 is also purely local (it appends no op), so
devices adopt independently as each upgrades.
