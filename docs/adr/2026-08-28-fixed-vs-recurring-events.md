---
title: "Fixed vs Recurring events: un-conflating anchor_activities (WS2 of the lifecycle-IA program)"
document_type: adr
authority: normative
status: proposed
date: 2026-08-28
supersedes: []
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
refines:
  - docs/work/specs/2026-08-28-lifecycle-ia-program.md (§6, §7)
related:
  - docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md
  - docs/adr/2026-08-23-unified-schedule-overlay-model.md (v42/v43 recurrence-axis slices)
  - docs/adr/2026-08-23-activity-recurrence-tiers-ingestion.md
implementation_state: not started
affects:
  - electron/db/schema.sql
  - electron/db/localDb.js
  - electron/sync/syncClient.js
  - electron/ops/projections.js
  - electron/ops/campScopedEntities.js
  - electron/ops/ingest.js
  - src/ingest/fixedEvents.js
  - src/localClient.mock.js
  - src/screens/AnchorsScreen.jsx
  - src/components/layout/navSections.js
---

# Fixed vs Recurring events: un-conflating anchor_activities

**DRAFT — for owner approval. No code authorized by this document.**

Resolves WS2 of `docs/work/specs/2026-08-28-lifecycle-ia-program.md` §6. This is
the program's declared long pole — "high risk," "start its thinking early, ship
it late and carefully."

---

## 1. Precise definitions + decision table

**Owner-confirmed model (2026-08-28):** the axis is scope, exactly as
proposed below. **Fixed = all-camp** (carpool, flagpole, mifkad — every
group, same slot, at once). **Recurring = group- or age-division-scoped,
primarily group** (lunch, meals — one group or division at a time, even
if every group eventually gets a lunch slot). **Meals/lunch are
Recurring, not Fixed** — an earlier pass of this ADR listed meals under
Fixed by mistake; corrected here. A meal is only "campwide" in the loose
sense that every group eats — structurally each group's lunch is its own
group-scoped slot, which is exactly the Recurring shape.

The spec's prose definitions (as corrected by the axis above):

- **Fixed event** — a campwide invariant: the *same slot, every group, at
  once*. Carpool, flagpole, mifkad.
- **Recurring event** — regular for *one group or division* on a cadence, not
  campwide-simultaneous. Division A swims every Tuesday, period 1; a
  group's daily lunch slot.

Translated into the columns `anchor_activities` already has (see §2 — the
scope columns are **not new**), the deciding test is **scope**, not name or
intuition:

| Signal | Fixed | Recurring |
|---|---|---|
| `is_all_groups` / no `unit_id` / no `group_ids` (resolves to *every* group) | ✅ required | must NOT be all-groups |
| `unit_id` set (one age division) | ✗ disqualifies | ✅ |
| `group_ids` set (a proper subset of groups) | ✗ disqualifies | ✅ |
| `recurrence_level` (`daily`/`weekly`) | either — orthogonal | either — orthogonal |
| `schedule_week_id` (bound to one named week) | see edge case below | orthogonal, common case |

**The decision is: scope width (all groups vs. one group/division), not
day/week cadence.** `recurrence_level` and `schedule_week_id` already answer
*when*; they say nothing about *for whom*, which is the actual conflation.

### Edge cases (all resolved by owner decision, 2026-08-28)

1. **"A meal only some divisions attend."** Scope-scoped (`group_ids` a
   subset, or per-group generally) → **Recurring**, exactly per the
   corrected examples above. The test is scope, never the activity's name
   or category. This is the case most likely to surprise a director
   mid-migration (see §5 backfill risk) — precisely because meals were
   the intuitive-but-wrong example in this ADR's own first draft.
2. **"An all-camp event that is NOT every day, on a repeating pattern"**
   (e.g. a campwide assembly bound to specific named weeks via
   `schedule_week_id`, or a weekly-not-daily `recurrence_level`).
   **Decided: stays Fixed.** Scope is the *sole* classifier; cadence
   (`recurrence_level`, `schedule_week_id`) is orthogonal and never
   disqualifies. A once-a-week, campwide, everyone-at-once event is still
   Fixed — "unchanging week-to-week" in the spec's prose was illustrative
   of the common case (flagpole/meals as originally, incorrectly, framed),
   not a second, independent test. **Locked, not open.**
3. **A `unit_id`-scoped anchor that happens to cover every group in the
   camp** (e.g. a camp with exactly one division). Structurally
   Recurring (it's a division-cadence row), even though today it's
   *numerically* campwide. Classification is by column shape, not by
   evaluating the current roster — otherwise adding a second division
   later would silently reclassify history. Kept Recurring.

### Non-goals / boundary

**WS2 is scoped to `anchor_activities` only.** Special events — field
trips, some-weeks-only events, anything already modeled by the
`special_days` / `events` / field-trip overlay layer — are explicitly
**out of scope** for this ADR and must not be absorbed into the Fixed/
Recurring axis. Those entities already have their own place/route
(overlay layer per `docs/adr/2026-08-23-unified-schedule-overlay-model.md`)
and their own classification concerns; WS2 does not touch them, redefine
them, or migrate them onto `kind`.

## 2. Current-state audit — where the conflation actually lives

This matters for scoping the fix correctly: **the scope columns already
exist and the engine already reads them correctly for placement.** The
conflation is not "the engine can't tell groups apart." It is narrower and
in three different places:

**a) Schema (`electron/db/schema.sql:500-515`).** `anchor_activities` already
carries `unit_id`, `is_all_groups`, `group_ids` — a full scope-resolution
triple — plus `recurrence_level` (v42) and `schedule_week_id` (v42) for the
*when* axis. There is **no column that says which of Fixed/Recurring a row
is** — scope is implicit in which of three nullable columns happens to be
set, resolved at read time by convention (`unit_id > is_all_groups >
group_ids`, `src/engine/buildSchedule.js:125-139`), never validated or
persisted as a fact.

**b) Engine (`src/engine/buildSchedule.js:110-167, 227-241`).** The engine
already resolves `groupList` per anchor from those columns and keys
`anchorLookup` by `groupId|dayId|blockId` — so a group-scoped anchor
*already* only blocks cells for its own groups, not campwide, and both
Fixed and Recurring anchors are placed the same way today: unconditionally
pre-placed (`anchorLookup.get(key)` is checked *before* the eligibility/
activity-placement pass, line 227-241), hard blocks with no contention, no
`min_per_week` counting, no swap/conflict awareness.

**Owner-confirmed (2026-08-28): this is correct, wanted behavior for
both kinds, not a gap.** The product owner does not want Recurring events
to contend like a regular activity — both Fixed and Recurring are meant
to be scheduled first, as hard pre-placement, identically. The north-star
spec's §6 phrase "still contends like an activity" was an error in that
document and will be corrected there separately; it does not describe
intended engine behavior. **WS2 therefore requires zero engine changes**
— see §4.

**c) Ingest (`src/ingest/truthStatus.js`).** Classifies an entirely
different axis — `activities.recurrence_truth_status`
(asserted/obligation/permission), about *how confidently the frequency
rule was inferred* from source data, on the `activities` table, not
`anchor_activities`. It has no opinion on Fixed-vs-Recurring scope and is
not a source of truth to reuse or extend for this ADR's distinction —
name-checked here only so a future reader doesn't conflate the two
classifiers.

**d) UI/nav (`src/components/layout/navSections.js:77`,
`src/screens/AnchorsScreen.jsx`).** One nav entry, `{ key: 'anchors', label:
'Recurring Events' }`, one screen, one list — both Fixed and Recurring rows
render together with no visual or filter distinction. Comment at
`navSections.js:67-68` still describes them as "camp-wide anchors" flatly,
confirming the mental model in code comments has not caught up even to the
scope columns that already exist.

**e) Sync/projection.** `anchor_activities` is a normal camp-scoped entity
(`electron/ops/campScopedEntities.js:22,149`), full-column-replicated via
`electron/sync/syncClient.js:55`'s explicit field allowlist, and
`electron/ops/projections.js:276` handles create/ensureExists. No special
treatment exists or is needed today beyond keeping the allowlist in sync
with any new column (§6).

## 3. Proposed data model

### Candidate approaches considered

Diverged across five frames (regulator/compliance, inversion, logistics,
remove-the-assumption, 3am-on-call) before converging. Full pool available
in-session; the load-bearing clusters:

- **Compiled/derived-only kinds** — never store Fixed/Recurring as a fact;
  derive from scope columns at every read (regulator, inversion, remove-
  assumption frames each independently converged on rejecting this).
  **Rejected — trap.** Inversion frame's finding is decisive: "derive
  classification by re-inspecting current placement state" is exactly how
  a future engine refactor silently reclassifies rows with no trail. The
  spec asks for a *modeled distinction*, and Constitution Art. I treats an
  undeclared inference as a silent decision, not a design.
- **Full calendar-layer / RRULE rebuild** — dissolve `anchor_activities`
  into a layered campwide/division/elective calendar model, or replace
  `recurrence_level` with a general recurrence expression (remove-the-
  load-bearing-assumption frame). **Rejected — trap, wrong altitude.**
  Correctly named as removing an assumption, but the assumption ("daily
  vs weekly is a real category") is not what's broken; nothing in the
  spec or this workstream needs arbitrary recurrence expressions, and a
  calendar-layer rewrite touches ingest, engine, sync, and every screen
  that reads `anchor_activities` for a distinction expressible in one
  column. Karpathy: three similar rows beat a premature abstraction layer.
- **Hub-and-spoke / JIT-generated recurring instances** — Fixed events as
  a hub, Recurring placements computed just-in-time per week and never
  stored as rows (logistics frame); or materialized future instances
  written into the placement table so cadence is never computed twice
  (3am frame). **Rejected.** This assumes Recurring needs a different
  *placement mechanism* from Fixed — it does not (§2b, owner-confirmed:
  both are identical hard pre-placement). An engine-behavior redesign
  aimed at a gap that turns out not to exist is exactly the kind of
  premature abstraction Karpathy's guidance warns against. The 3am
  frame's own strongest idea from this cluster survives in a smaller
  form and is worth keeping as a design note: "no engine code path
  should ever fork on `kind`" — true here for the right reason, because
  both kinds place identically, not because a shared facts-view papers
  over a real difference.
- **Explicit, validated `kind` column reusing the existing scope columns
  as its enforcement, not its substitute** — regulator's "reject inserts
  where the same slot resolves differently per group," inversion's "give
  scope its own non-nullable column instead of overloading a nullable
  one," and 3am's "make Fixed mean campwide by a constraint, not a
  settable boolean that can lie" all converge on the same shape: **a
  small, closed, DB-enforced fact, additive to the existing columns.**
  **Selected.**

### The chosen design: additive `kind` column + a CHECK invariant, one table, no new entity

Add one column to `anchor_activities`:

```sql
kind TEXT NOT NULL DEFAULT 'fixed' CHECK (kind IN ('fixed', 'recurring'))
```

Plus a table-level `CHECK` (or, if SQLite's `CHECK` proves too limited for a
cross-column condition — SQLite `CHECK` constraints *can* reference other
columns in the same row, so this is expected to work) enforcing the
decision table from §1 as a stored invariant, not an app-layer convention:

```sql
CHECK (
  kind = 'recurring'
  OR (kind = 'fixed' AND is_all_groups = 1 AND unit_id IS NULL
      AND (group_ids IS NULL OR group_ids = '[]'))
)
```

This directly answers the regulator-frame finding ("fixed-ness is a
cross-row invariant... nothing today checks that all groups actually
agree") for the *single-row* half of that invariant — a `kind='fixed'` row
cannot be saved scoped to less than all groups. (The cross-*row* version —
"do all currently-fixed rows for the same slot actually agree with each
other" — is not a concern under this design, because Fixed by construction
means all-groups-at-once on one row; there is no second row to disagree.)

**Why one table, not two entities** (the option explicitly asked for in
the brief): a second table (`fixed_events` / `recurring_events`) would
require the engine, ingest, sync allowlist, projections, and every UI list
to fork on which table to query — exactly the "engine forgets to check the
second table" risk the 3am frame named as the *real* 3am-page cause, not
the schema. It would also duplicate every column shape both kinds already
share (day/time-block binding, span, location, notes) for a distinction
that is one enum value wide. `elective_sets` already mirrors
`anchor_activities`'s binding columns as a sibling table for a genuinely
different entity (offerings vs. instances) — Fixed and Recurring events are
not a genuinely different entity, they are one entity with two values on
one axis. Two tables is the textbook, obvious-in-30-seconds answer; it
fails Karpathy's bar here because nothing about Fixed and Recurring differs
in shape, only in one scope-derived fact.

**Why not rename the table.** `anchor_activities` stays the table name.
Renaming is pure churn across every file in §2's audit for a label change
the UI-facing rename (§7) already absorbs without touching the schema
identifier. (Constitution Art. V discipline: don't let a UI word become a
storage word.)

**Redundancy with existing columns is deliberate, not sloppy.** `kind`
duplicates information already derivable from `unit_id`/`is_all_groups`/
`group_ids`. That is the point, per the inversion-frame finding: a
persisted, independently-migrated fact that the CHECK constraint keeps in
sync with its own derivation is exactly what stops "derived at render
time" drift. The column is redundant with the *scope*, not with anything
narrative — it is the classification that scope currently only implies.

### Reused vs. new

- **Reused as-is:** `unit_id`, `is_all_groups`, `group_ids`,
  `recurrence_level`, `schedule_week_id`, `location_id`, `span_blocks` —
  every existing column keeps its exact current meaning and the engine's
  existing scope-resolution order (`unit_id > is_all_groups > group_ids`)
  is untouched.
- **New:** the `kind` column and its CHECK constraint. Nothing else in the
  schema changes in this ADR's scope.

## 4. Engine implications

**No engine change, now or planned.** WS2 is classification-only. The
engine already blocks all-camp vs. group-scoped cells correctly from the
existing scope columns (`unit_id`/`is_all_groups`/`group_ids`, §2b), and
both Fixed and Recurring are meant to remain identical hard
pre-placements — that is the owner-confirmed intended behavior, not a gap
to close. `groupList` resolution already produces the right cell set for
either kind; adding `kind` makes the classification *legible and
enforced*, and changes nothing about what gets scheduled or how.

No engine code path should branch on `kind` — if a future Maker finds
themselves adding an `if (anchor.kind === 'recurring')` inside
`buildSchedule.js`, that is a sign the brief has been misread, not a sign
the engine needs updating. The north-star spec's §6 line describing
Recurring events as "contending like an activity" was an error in that
document, corrected by the owner during this ADR's review; no future
engine work should cite it as a rationale without checking the spec has
actually been amended.

Multi-block/span interaction (`span_blocks`, `_isSpanHead`,
`anchorLookup` tail-block registration, lines 143-165): unaffected —
`kind` carries no span semantics and the existing span-head/tail
mechanism is orthogonal to scope.

## 5. Migration plan — the highest-risk part

**Schema version:** next is v51 (`CURRENT_SCHEMA_VERSION = 50` currently,
`electron/db/localDb.js:16`).

**Guard form (load-bearing, per this repo's own documented incident):**

```js
if (getSchemaVersion(db) >= 50 && getSchemaVersion(db) < 51) {
  ...
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (51, ?)').run(...)
}
```

**Never** a bare `< 51` — this repo has a recorded incident (bug #194,
documented inline at `localDb.js:1911-1916` on the v50 block) where a bare
lower bound let a migration fire from any earlier version and stamp past
an unstamped predecessor, silently skipping that predecessor's
data-safety cleanup. The `>= 50 && < 51` form is mandatory, not stylistic.

**Rollback file:** `electron/db/rollback/v51_down.js`, following the
existing `v49_down.js`/`v50_down.js` pattern (both handled a
`CREATE TABLE ... RENAME` recreate; this migration is a plain `ADD COLUMN`,
so its rollback is simpler — drop the column via the same
recreate-and-copy shape SQLite requires for `DROP COLUMN` prior to a
version that supports it directly, or `ALTER TABLE ... DROP COLUMN` if the
bundled SQLite is new enough; confirm SQLite version before Maker writes
this file).

**Backfill rule — the actual risk.** `ADD COLUMN kind TEXT NOT NULL DEFAULT
'fixed'` populates every existing row as `'fixed'` for free (the same
free-backfill mechanism the v42/v43 `recurrence_level DEFAULT 'daily'`
migrations already used, per the schema.sql comments at lines 486-489 and
788-791). **This default is correct for the engine's current behavior**
(§2b: every anchor row is placed as an unconditional hard block today,
which *is* Fixed semantics), **but it is not necessarily correct against
the §1 decision table** — any existing row that is `unit_id`- or
`group_ids`-scoped (a division-cadence row that today behaves like a hard
block, but by the new scope test is actually Recurring) would be
mis-backfilled to `'fixed'` and immediately **violate the new CHECK
constraint**, since `'fixed'` requires `is_all_groups=1`.

This is not a hypothetical edge case — it is expected to be common. Any
camp using `unit_id`/`group_ids` scoping today (which the columns exist
specifically to support) has rows this backfill gets wrong.

**Required migration shape, in order, inside the v51 transaction:**

1. Add `kind` with `DEFAULT 'fixed'` — but **without** the CHECK
   constraint yet (SQLite `ALTER TABLE ADD COLUMN` cannot add a
   cross-column CHECK to an existing table without a recreate; this
   migration needs the same recreate-and-copy shape v49/v50 already used
   for `locations`/`camp_maps`, not a bare `ALTER TABLE ADD COLUMN`).
2. During the same recreate-and-copy: for every existing row, set
   `kind = 'fixed'` **only if** `is_all_groups = 1 AND unit_id IS NULL AND
   (group_ids IS NULL OR group_ids = '[]')`; every other existing row gets
   `kind = 'recurring'`. This is a real backfill rule (not a free
   DEFAULT), computed from data already in the row — deterministic, no
   guessing, no UNKNOWN bucket needed, because scope is a hard fact
   already stored on every row (per the inversion-frame finding in §3:
   classification must be an immutable input, and here it can be, because
   the input already exists).
3. Recreate the table with the CHECK constraint from §3 attached from the
   start, so no row can ever have entered the table already violating it.
4. **No op-log write** for this backfill — same precedent as the v32
   `locations` backfill (schema.sql comment, "Emits NO op — a DDL-time
   side effect"). This is a local schema fact, not a director-authored
   change; it must not appear in `operations`/sync as a phantom bulk edit.

**Data-safety verdict:** with step 2's rule, **zero rows are lost or
silently misclassified** — every row's `kind` is a deterministic function
of columns it already has. The risk is not "we don't know how to
classify," it is "the free-DEFAULT shortcut used in every prior
`recurrence_level`-style migration is wrong here and must not be reused
uncritically" — flagging that explicitly is this ADR's main contribution
to migration safety.

**Cross-device replay:** the migration runs independently on each device
against its own local DB (per this codebase's established per-device
migration model — no migration op replicates through the op-log). Because
step 2's backfill rule is a pure function of already-synced columns
(`is_all_groups`, `unit_id`, `group_ids` — all regular replicated fields),
every device computes the **same** `kind` for the **same** row
independently, without needing to be online or in sync order. This is the
correctness property this migration depends on — verify it with a dedicated test
(§8) rather than assuming it.

## 6. Sync/projection + ingest

- **`electron/sync/syncClient.js:55`** — append `'kind'` to the
  `anchor_activities` field allowlist. This is the one hand-maintained
  list that silently drops a column from replication if forgotten; call
  it out explicitly in the Maker brief as a required, easy-to-miss edit
  (mirrors this repo's own prior incidents with hand-maintained
  allowlists).
- **`electron/ops/projections.js:276-292`** — `ensureExists` inserts with
  an empty `name`; no `kind`-specific handling needed since the CHECK
  constraint's `DEFAULT 'fixed'` (still valid for a *freshly created*
  all-groups row) covers the ensureExists path. Confirm in review that no
  writer path can create a `group_ids`/`unit_id`-scoped row without
  explicitly setting `kind = 'recurring'` in the same write — the CHECK
  constraint is the actual backstop, but the UI (§7) is what should choose
  correctly by construction (a director should never manually toggle
  `kind`; it should be implied by which of the two screens/forms they
  used, then written by the app, then merely enforced by the constraint).
- **`electron/ops/campScopedEntities.js`** — no change; `anchor_activities`
  already listed at lines 22 and 149, and this ADR adds a column, not a
  new entity or sync scope.
- **Ingest classifier — code path located.** Imports do create anchors,
  and the scope classification already happens at two points, both of
  which need the identical, mechanical `kind` addition (same scope test
  as §1, applied at ingest time instead of at migration time):
  - **`src/ingest/fixedEvents.js`, `inferFixedEvents`** — the scope
    classifier at lines 297-311 already decides `is_all_groups` vs. an
    explicit `groups` list per inferred event. Attach `kind` to each
    emitted event object here (`kind = isAllGroups ? 'fixed' :
    'recurring'`), so it rides through `plan.fixedEvents` alongside the
    scope fields it's derived from.
  - **`electron/ops/ingest.js`, commit side** — the `isAll` derivation at
    line 1775 is the same test, re-run (or re-read from the plan object)
    at commit time; add `kind` to the fields object built at lines
    1909-1926, next to `is_all_groups`/`group_ids`, using the same
    `isAll` boolean.
  - **`src/localClient.mock.js` (~line 996)** — the dev-mock mirror of
    the commit path must be updated in lockstep or the dev/mock
    environment silently diverges from the real one (this repo's
    established mock-drift risk; see the dev-mock precedent already
    called out in `AnchorsScreen.jsx`'s own comments for other fields).

  **Asymmetry to carry into the Maker brief:** `unit_id` is **never**
  written by ingest — only `is_all_groups` and `group_ids` are set at
  import time. `unit_id` (division-level scoping) exists only in (a) the
  engine's scope-resolution order (§2a-b) and (b) the hand-authoring path
  in `AnchorsScreen.jsx`/`AnchorModal`. **The ingest-side `kind` test is
  therefore purely `is_all_groups` vs. `group_ids`** — it never needs to
  consider `unit_id`, because ingest never produces a `unit_id`-scoped
  row. The hand-authoring path (§7) is the only place a director can
  create a `unit_id`-scoped Recurring row, and its `kind` derivation must
  cover that third case even though ingest's does not.

## 7. UI/nav

Both stay under **Sprouts** per the lifecycle spec (§3 stage table already
names "Fixed Events" and "Recurring Events" as two distinct Sprouts
contents — this ADR is what makes that distinction real underneath).

- **Nav label revert** (`src/components/layout/navSections.js:77`):
  `{ key: 'anchors', label: 'Recurring Events' }` reverts to two entries
  — `Fixed Events` and `Recurring Events` — per the spec's explicit
  instruction in §6 ("Revert the name to 'Fixed Events'"). Exact routing
  (two nav keys into one filtered screen, vs. two screens) is a WS1-
  adjacent IA decision, not this ADR's call — flagged for Governor/
  Designer in §9.
- **`AnchorsScreen.jsx`** gains a `kind` filter/tab (Fixed / Recurring) at
  minimum; whether the create/edit form (`AnchorModal`) branches its
  fields by `kind` (e.g. hiding `unit_id`/`group_ids` entirely on the
  Fixed side, since the CHECK constraint requires them null) is a
  Designer-owned decision. Recommended default: yes — the form should make
  an invalid Fixed row *unrepresentable* in the UI, not just rejected by
  the DB constraint after a save attempt, so a director never hits the
  CHECK as a runtime error.
- **This is UI-touching work; DESIGN_STANDARD.md applies to the Maker
  brief**, not to this schema/engine-heavy ADR itself. §5 (motion/feedback)
  and §8 (transitions) govern the AnchorModal's Fixed/Recurring toggle and
  any tab-switch inside AnchorsScreen — name them explicitly in the
  Designer brief when WS2's UI slice is scoped, including the
  reduced-motion equivalent for whatever transition marks the toggle.
- **No explainer/instructional copy** (north-star spec §7, non-negotiable)
  — the Fixed/Recurring split must read from structure (two nav entries,
  two form shapes, a filter), never from a caption explaining the
  difference.

## 8. Test-first seams — name these before Maker writes implementation

1. **Migration canary + backfill test** (new
   `electron/db/anchorKindSplit.migration.test.js`, mirroring
   `anchorRecurrence.migration.test.js`'s fresh-vs-migrated shape): seed a
   v50 DB with (a) an all-groups anchor, (b) a `unit_id`-scoped anchor, (c)
   a `group_ids`-scoped anchor covering a proper subset, (d) a
   `group_ids`-scoped anchor that happens to list every group id in the
   camp (§1 edge case 3). Migrate to v51. Assert exact `kind` per row per
   the §5 step-2 rule, assert the CHECK constraint rejects a
   hand-constructed invalid insert, assert `schema_migrations` has no
   entry that emitted an op-log row for the backfill.
2. **CHECK-constraint enforcement test.** Attempt to insert/update a
   `kind='fixed'` row with `group_ids` set; assert SQLite rejects it. This
   is the regulator-frame invariant made executable.
3. **Engine placement parity test** (extend
   `src/engine/buildSchedule.test.js`): with `kind` present, assert
   Phase-1 output is byte-identical to pre-migration output for a fixture
   containing both kinds — proves this migration truly changes nothing about
   placement, only classification. This is the regression gate that lets
   WS2 ship without touching the engine's most heavily-tested module.
4. **Ingest classification test** covering both located sites (§6):
   `src/ingest/fixedEvents.js`'s `inferFixedEvents` (assert `kind` on the
   emitted event objects matches the `is_all_groups`/`groups` shape) and
   `electron/ops/ingest.js`'s commit path (assert the fields object
   written at lines 1909-1926 carries the same `kind`, derived from the
   same `isAll` boolean as `is_all_groups`). Table-driven over the §1
   decision table's rows plus the resolved edge cases. Also assert
   `src/localClient.mock.js`'s mirror produces the same `kind` as the
   real commit path for the same input, so dev/mock parity is a tested
   fact, not an assumption.
5. **Sync manifest test** — extend
   `electron/sync/syncServer.test.js`'s existing `anchor_activities`
   coverage (lines ~937, ~1994) to assert `kind` round-trips through a
   full sync cycle Host→Client and Client→Host.
6. **Cross-device backfill determinism test** — run the migration
   independently against two DB fixtures seeded with the *same*
   `anchor_activities` rows in different insertion order; assert both
   produce identical `kind` values (§5's "same device-independent
   function" claim, made executable rather than asserted).

## 9. Red Hat risks

- **Existing-data misclassification (the primary risk, addressed in §5).**
  A free `DEFAULT 'fixed'` backfill (the pattern every prior similar
  migration in this codebase used) is *wrong* for scoped rows here. §5's
  step-2 rule fixes this, but it is exactly the kind of shortcut a Maker
  under time pressure could silently revert to "since that's how v42/v43
  did it" — call this out explicitly and by name in the Maker brief, not
  just in this ADR.
- **CHECK constraint false confidence.** SQLite enforces CHECK constraints
  only on rows written *after* the constraint exists, and only through
  paths that go through SQLite itself — a raw `bulkReplace` projection
  path (`electron/ops/operations.js`, `isBulkReplaceOp`) or a
  hand-crafted `INSERT` in a test fixture could still violate it if that
  path bypasses normal validation. Verify `bulkReplace` respects table
  constraints before relying on the CHECK as the sole backstop; if it
  doesn't, the UI-level "can't represent an invalid row" recommendation in
  §7 becomes required, not merely recommended.
- **Cross-device replay of the migration itself.** Confirmed
  deterministic *in design* (§5) because the backfill rule is a pure
  function of already-synced columns — but this must be proven by the
  test in §8.6, not assumed. If any device has a row that failed to sync
  before migration runs on it (a genuine possible state — sync is
  eventually consistent, not transactional across devices), that device
  computes `kind` from incomplete data and could disagree with a peer
  until the next sync. Since `kind` itself is never synced as a
  new fact requiring convergence (it is deterministically re-derivable,
  not authored), a transient mismatch self-heals the next time that row's
  underlying columns replicate — but confirm this is actually true rather
  than asserting it, since `kind` becomes a stored column, not a live
  computation, once this migration ships.
- **Engine determinism — not a risk for WS2.** No engine change is
  authorized or planned (§4); the seeded-PRNG determinism guarantee
  `buildSchedule.js` provides is untouched. Recorded here only so a
  future reader doesn't reintroduce the "recurring contends like an
  activity" idea from an earlier draft of this ADR (§4) without
  re-confirming with the owner first — that framing was corrected during
  this ADR's review and should not resurface as an assumed follow-on.
- **Span-tail interaction with `kind`.** Not believed to be a risk (§4)
  because `kind` carries no placement-order semantics — but
  the parity test (§8.3) is exactly the mechanism that would catch it if
  this belief is wrong. Do not skip that test on the assumption that "the
  column is inert."
- **Silent data loss: none identified**, contingent on the
  backfill rule in §5 being implemented as specified (not the free-DEFAULT
  shortcut) and the parity test in §8.3 passing before merge.

## 10. Open questions for Governor

**Resolved during owner review (2026-08-28), recorded for the trail —
no longer open:**

- ~~§1 edge case 2 (all-camp, not-every-day event)~~ — **decided: stays
  Fixed.** Scope is the sole classifier; cadence is orthogonal and never
  disqualifies. Locked (§1).
- ~~§6 ingest integration point~~ — **located.** `src/ingest/fixedEvents.js`
  (`inferFixedEvents`, lines 297-311) and `electron/ops/ingest.js` (lines
  1775, 1909-1926), with `src/localClient.mock.js` (~line 996) as the
  required lockstep mirror. See §6.
- ~~Phase 2 / engine-contention sequencing~~ — **dropped, not deferred.**
  The owner confirmed both Fixed and Recurring are meant to be identical
  hard pre-placements; there is no Phase 2 to sequence. See §4.

- ~~§7 nav routing~~ (two nav keys into one filtered `AnchorsScreen`, vs.
  two separate screens under Sprouts) — **deferred to the Designer when
  WS1's IA is scoped** (owner decision, 2026-08-28). It is a product/IA
  call, not a technical one, and does not block this ADR; the Maker slice
  for the data model (column, constraint, migration, ingest, sync) can be
  briefed independently of the eventual nav shape.

**Still open:** none. All questions resolved or deferred as noted above.
