---
title: "ADR: One-Screen Reconciliation — Grace-Window Undo (Seam 4, revised)"
document_type: adr
status: accepted
authority: normative
implementation_state: in_progress
date: 2026-08-17
decided: 2026-08-17
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
supersedes: []
extends: [docs/adr/2026-08-17-onescreen-reconciliation-projection.md]
depends_on_external: []
related_discovery: [docs/work/runs/2026-08-17-reconciliation-r1-gate-outcome.md]
program: ingestion-reconciliation-one-screen
---

# ADR: One-Screen Reconciliation — Grace-Window Undo (Seam 4, revised)

**Status: ACCEPTED for build (Governor, 2026-08-17) after THREE Red Hat passes. U1 sound from
pass 2; U2 mechanism sound + verified in pass 3; the one residual (registry completeness) is
closed at BUILD time by a mandatory mechanical scanner test — see the amendment below. This ADR
does not touch Seams 1–3 + 5, already shipped (`2026-08-17-onescreen-reconciliation-merge.md`).**

> **3rd Red Hat pass amendment (2026-08-17) — BINDING on the U2 build.** Pass 3 verified the U2
> MECHANISM sound (deletion op + `source:'human'` traced correct through `rejectedSlotKeys` for the
> undo-then-reimport case; two-pass batch; deletion order; `import_evidence` cleanup). It found the
> registry STILL incomplete — 3 live silent-orphan (`enforced:false`) convention edges the
> hand-search missed: **`template_slots.anchor_id → anchor_activities`** (contradicts the ADR's
> "into anchor_activities: NONE" — it's a v17 ALTER-added column; a placed anchor undo-deleted →
> silent blank label on the live schedule), **`anchor_activities.group_ids → groups`** (json array,
> same pattern as the registered `activities.eligible_group_ids`), **`template_overlays.unit_id →
> tiers`** (convention tier pointer). Root cause: a by-hand FK search cannot be exhaustive (it
> missed 3). **FIX (build-mandatory, not another design pass): (1) add these 3 edges to
> `UNDO_REFERENCE_CHECKS`; (2) the schema-parity test's convention-edge strategy becomes a
> NAMING-CONVENTION SCANNER — enumerate every column across EVERY table via `PRAGMA table_info`, and
> fail if any `*_id`/`*_ids`-named column pointing at a U2-deletable entity is not explicitly
> registered-or-accepted. This makes registry completeness a MECHANICAL INVARIANT, not human
> diligence.** The scanner test must be U2's FIRST build step and must be proven to catch a PLANTED
> missing edge before any deletion code lands. Pass 3 Resilience 2/5 (mechanism sound, registry
> methodology was the flaw); its explicit recommendation was "one targeted fix, not a re-review, not
> ship-U1-alone." No 4th design pass needed — the scanner IS the mechanized adversary; the
> code-review + Verifier on the build confirm it catches a planted edge.

## Context

`docs/adr/2026-08-17-onescreen-reconciliation-projection.md`'s Seam 4 proposed a compensating-
inverse undo: capture `invertibleOps` at commit time behind an opt-in `captureInverse` flag,
hold them in renderer memory for a grace window, and invert them via a fresh op-seq "touched
since" check. Red Hat's adversarial pass (`docs/work/runs/2026-08-17-reconciliation-r1-gate-
outcome.md`) found it unsound in three structural ways and the owner DECOUPLED it from the rest
of the one-screen initiative rather than accept it as designed:

1. **HIGH — Replace-mode undo → empty schedule.** `replaceScope` (`electron/ops/ingest.js:80-
   155`) tombstones prior rows via raw `appendOp(..., field: DELETE_FIELD, ...)` calls the
   two-shape (creation-tombstone / update-restore) mechanism never modeled — there is no
   inverse-of-a-deletion shape at all in the original design.
2. **HIGH — creation-row gate blindness.** The "touched since" check for a created row only
   compared the fields the import itself wrote, so a human filling a field the import left
   blank (e.g. `location_id` on an activity the import created without one) was invisible to
   the gate — the row still looked "fully import-owned" and a whole-row delete would silently
   destroy the human's addition.
3. **HIGH — no cross-entity referential check.** Two independently-correct per-row decisions
   can still corrupt the graph between them: undoing a *creation* deletes a row while an
   untouched (or independently touched) row elsewhere keeps referencing its id — Red Hat's
   example is deleting a location ("Lake") the import created while an activity ("Kayaking")
   still has `location_id` pointing at it, orphaning the reference.
4. **MEDIUM — device-local seq vs `COALESCE(host_seq, seq)`.** The gate's correctness depends
   on `seq` being a total order for a given `(entity, entity_id, field)` triple *on the device
   that captured `invertibleOps`*. `electron/ops/operations.js` has two different seq
   conventions in active use: `latestOp` (plain `seq`, used by `detectConflict`) and
   `latestOpSeq`/`latestScopeOpSeq` (`COALESCE(host_seq, seq)`, used where a Client db's locally
   auto-incremented `seq` is NOT the Host-canonical order — see the `host_seq` migration,
   schema v18). Undo must use the plain-`seq` convention and must never be "fixed" to the
   COALESCE form by someone pattern-matching on the other two functions.
5. **Edge cases treated as invariants, not afterthoughts:** where the captured `invertibleOps`
   state actually lives and how it is scoped; only one live grace window at a time; and
   distinguishing "already undone" from "someone else edited this" on a second undo attempt.

This revision closes all five. It also makes an explicit **complexity call**: rather than ship
"add-mode only" as one slice, it splits add-mode undo further into an updates-only slice (U1)
and a creation/deletion slice (U2), because the three HIGH findings live entirely in the
creation/deletion half of the mechanism — U1 ships with none of that risk surface at all.

Current code consulted directly (not the superseded citations in the split-out ADR):
`electron/ops/ingest.js` (`commitIngest`/`commitPlan`, `replaceScope` ~80-155, `INGESTIBLE_ENTITIES`,
`COMPARABLE_COLUMNS`), `electron/ops/projections.js` (`PROJECTIONS[entity].fields`,
`applyProjection` — a `DELETE_FIELD` op does a real `DELETE FROM table WHERE id=?`, not a soft
tombstone; the op-log entry is what survives), `electron/ops/operations.js` (`latestOp` — plain
`seq` — vs. `latestOpSeq`/`latestScopeOpSeq` — `COALESCE(host_seq, seq)` — and `detectConflict`),
`electron/ops/restore.js` (`restoreEntity`, `RESTORABLE_ENTITIES`, `lastKnownFields`,
`lastKnownFieldSources`).

**Load-bearing prior art this design reuses rather than re-invents:** `restoreEntity` already
exists and already solves "bring back a deleted row from the op-log, gated on it still being
genuinely deleted (`isDeleted`), with provenance preserved (`lastKnownFieldSources`), rejecting
a live-name collision (`detectUniqueFieldCollision`)." Every entity `replaceScope` tears down
(`activities`, `groups`, `time_blocks`, `days_of_operation`, `tiers`) is already
`RESTORABLE_ENTITIES: 'restorable'`. That is why Replace-mode undo is not "impossible," only
correctly out of scope for *this* slice (see Consequences' U3).

## Candidate approaches considered

1. **Snapshot-and-restore (rejected, unchanged from the split-out ADR).** A blind dump-and-
   rewrite of affected rows can clobber a concurrent peer edit. Still wrong for the same reason.
2. **One undo mechanism covering both add- and replace-mode in a single slice (rejected for
   v1).** This was the split-out ADR's implicit shape ("scope to add-mode only" was Governor's
   suggested fallback, not yet a design). Rejected here because add-mode's two failure classes —
   field-update inversion (safe, already well-precedented by `restoreEntity`'s field-restore
   logic) and row-creation inversion (unsafe until Findings 2+3 are fixed) — have very different
   risk profiles, and bundling them means Finding 2/3's fixes gate shipping ANY undo at all,
   including the safe half.
3. **Split add-mode undo into updates-only (U1) and creation/deletion (U2) slices (chosen).**
   U1 needs none of Finding 2/3's machinery — an update's inverse is a single field write, the
   same shape `restoreEntity` already performs per-field, with the same "touched since" gate
   already proven safe by this codebase's existing conflict-detection idiom. U2 carries the
   full-field creation gate and the referential skip check, ships second, and gets its own
   focused Red Hat pass rather than diluting review attention across both halves at once. This
   is the smallest-responsible cut: it ships real, safe, undo-a-mistaken-overwrite value before
   the harder row-lifecycle problem is solved, instead of gating all undo behind the hardest 20%.
4. **Live referential query vs. propagate-through-captured-rows only, for Finding 3 (chosen:
   live query).** Red Hat's own example (delete "Lake," keep edited "Kayaking") is a case where
   the REFERENCING row's inverse is skipped (Kayaking was touched-since) while the REFERENCED
   row's inverse (deleting Lake) was otherwise going to proceed — the orphan is created by an
   untouched or skip-inverted referencing row that isn't even necessarily part of the captured
   set. A check that only propagates skips among captured rows misses a referencing row from
   OUTSIDE this commit (e.g. a director manually created a second activity pointing at the same
   location after import, unrelated to the reconciliation). A live query against the current DB
   state — "does anything reference this id right now" — via a small hand-authored FK registry
   catches both cases with one mechanism, and is still single-hop (direct references only, no
   transitive graph walk), matching Red Hat's "single-hop is fine for v1" guidance.

## Decision

### Scope split

- **U1 — updates-only undo (this ADR's primary deliverable).** Reverts only *field-value*
  changes the commit made to rows that already existed before the import (`confirm_change`/
  `confirm_value` decisions, and `replaceScope`'s `weather_alternative_id` null-out is explicitly
  OUT — see Replace-mode below). No row is ever created or deleted by U1's undo.
- **U2 — creation/deletion undo (named follow-on, same initiative, gated by its own Red Hat
  pass before build).** Reverts *row creations* the commit made (deletes the row), using the
  full-projection-field gate (Finding 2) and the live referential check (Finding 3).
- **U3 — Replace-mode undo (named follow-on, deferred, NOT gated on U1/U2 landing first).**
  Reuses `restoreEntity` per row `replaceScope` tombstoned. Cheaper to build than U2 because the
  mechanism already exists and is already gated by `isDeleted`/`detectUniqueFieldCollision`, but
  deferred because a Replace commit's blast radius is the camp's entire importable setup — a
  wrong call here is much larger than a wrong call on a handful of triaged decisions, and a
  Replace is already a deliberate teardown-and-rebuild the director opted into. **v1 has no undo
  affordance on a Replace-mode commit at all — the button/timer is not rendered.** This matches
  Governor's recommendation and Red Hat's own suggested fix (a).

This means the FIRST shippable undo (U1) is smaller than "add-mode only" — it is "add-mode,
field-updates only." Recommendation: ship U1 alone as the undo slice for this initiative; treat
U2 and U3 as separately-planned, separately-reviewed follow-on tickets, not sub-steps of one PR.

> **OWNER DECISION (2026-08-17): v1 = U1 + U2 together (full add-mode undo, creations included).**
> The owner chose to deliver the "undo this whole import" mental model — undo removes newly-created
> records, not just field-overwrites — accepting the larger adversarial surface. This deliberately
> re-takes on Findings 2 (full-`PROJECTIONS[entity].fields` creation gate) and 3 (live single-hop
> referential-integrity check) that got undo split out; both are specified below and are the FOCUS
> of the mandatory 2nd Red Hat pass. **U3 (Replace-mode) remains deferred — no undo affordance on a
> Replace-mode commit in v1.** So the undo slice = U1 + U2, add-mode only; Red Hat reviews both,
> and U2's creation/deletion path gets the hardest scrutiny before any of it is built.

### U1 mechanism

**1. Capture at commit time — same opt-in flag as the split-out ADR, narrowed scope.**
`commitPlan` gains `captureInverse: boolean` (default `false`; every existing non-reconciliation
caller is unaffected). When `true`, on a `mode: 'add'` commit only (guarded at the top of
`commitPlan` — a `mode: 'replace'` commit with `captureInverse: true` throws rather than
silently capturing nothing, so a future caller can't ship U3 by accident without a design), a
local `trackedAppendOp` wrapper records, for every `appendOp` call whose `entity_id` is NOT the
first time that id has been captured this commit (i.e. it is an UPDATE to a row that already
existed pre-import — verified by querying whether any op existed for that `(entity, entity_id)`
BEFORE this commit's first write, not by call order within the commit):

```js
{ entity, entity_id, field, opId, seq, priorValue, prior_source }
```

`priorValue`/`prior_source` are read via the exact same `latestOp`-style lookup `commitPlan`'s
existing protection/staleness gates already perform before each write (no new query). Rows
where NO prior op existed (genuine creations) are recorded separately as
`outcome.createdEntityIds: [{entity, entity_id}]` — captured for U2's later use and for the
receipt copy ("N new records were also added; undo doesn't remove those yet"), but **U1's
undo never acts on them.**

`outcome.invertibleOps[]` (updates only) and `outcome.createdEntityIds[]` (informational) are
both additive to the existing `commitPlan`/`commitIngest` outcome shape.

**2. Inverse shape — one, not two.** Every U1-invertible entry is a field UPDATE. Its inverse is
`appendOp({ entity, entity_id, field, value: priorValue, source: prior_source, ... })` — this is
byte-identical in shape to what `restoreEntity` already does per field, just triggered by undo
instead of by a trash-restore action, and with `source` carried forward instead of hardcoded, for
the same provenance reason `restoreEntity`'s R2 fix exists (reverting to a pre-import state must
not launder that state's own provenance).

**3. "Touched since" gate — per field, at undo time.** For every captured
`{entity, entity_id, field, seq}`, undo re-runs `latestOp(db, entity, entity_id, field)` (the
PLAIN-`seq` function, see Invariant 4) fresh. If the current latest op's `seq` still equals the
captured `seq`, invert it. If it differs — a local or replicated peer write landed after this
import touched that field — skip it, and record it in the receipt as "kept: {name}'s {field},
changed since import." This is unchanged from the split-out ADR's mechanism; U1 has no creation-
row form of this gate to get wrong, because U1 never inverts a creation.

**4. Undo IPC — one new narrow method.** `ingestUndo(db, { invertibleOps, author_user_id,
device_id })` (naming/exact channel is Maker's call, per the split-out ADR's open question #1,
still open and still non-blocking). Runs the seq-check-and-invert loop **server-side, inside one
transaction**, so the undo write is atomic and appears as ordinary ops in the log — an undo IS
an import, auditable the same way, with no persisted "this was an undo" marker in v1 (unchanged
from the split-out ADR).

**5. Idempotency / double-undo (Edge case c, closed).** `ingestUndo` is itself given a
`client_write_id` per invocation (the existing idempotent-retry mechanism `appendOp` already
uses camp-wide) — a retried identical undo call returns the original result rather than
re-running. Separately, and more importantly for the UX case Red Hat named: after a first undo
succeeds, the SAME renderer-held `invertibleOps` list is not re-usable — the grace-window state
transitions to a terminal `used` status (see Invariant 5) the instant `ingestUndo` returns `ok`,
so a second click on the same affordance is a no-op at the UI layer before it ever reaches IPC
again. A field whose "touched since" check fails on a SECOND undo attempt via some other path
(e.g. a stale second tab, or a retried request after a crash) is reported as "kept: changed since
import" — the SAME wording a genuine peer edit gets, because from the op-log's point of view
they are indistinguishable in mechanism (both are "some other write happened first") and a
distinct wording would be lying about certainty the seq check cannot actually provide. The
receipt does not claim to distinguish "you already undid this" from "someone else edited it" —
it truthfully reports "kept, changed since import" either way, and that is the correct level of
honesty for what the mechanism can actually observe.

### U1's disposition of Findings 2 and 3

Both findings are about the creation/deletion half of the mechanism. **U1 does not build the
buggy version and defer fixing it — it does not touch that code path at all.** Findings 2 and 3
are closed for U1 by scope, not by a partial mitigation. They remain fully binding requirements
on U2's design (specified below so U2 doesn't have to re-derive them, but not part of U1's build).

### U2 mechanism (named follow-on — specified now so the fix is pinned, built later)

**Revision note (2026-08-17, closing the 2nd Red Hat pass).** The pass found the registry below
incomplete and asymmetric (derived from this ADR's own illustrative example rather than the
schema), found the anchor-creation path (`ingest.js:1337-1491`) undecided against U2's scope,
found the deletion op itself unspecified, found the batch-exclusion and deletion-order logic
missing, and found `import_evidence` an unaddressed residual. All five are closed below, plus a
sixth item (hold-back/confidence interaction) the pass flagged as previously unverified and asked
to be confirmed against `buildPlan.js`/`reconciliationReport.js` rather than assumed. **U1 is
untouched by this revision** — none of these findings touch U1's code path (Findings 2/3 of the
original three were always scoped to U2 only; see "U1's disposition of Findings 2 and 3" above).

**U2's deletable entity set, decided.** `INGESTIBLE_ENTITIES` (`cohorts`, `tiers`, `groups`,
`days_of_operation`, `time_blocks`, `locations`, `activities`) **plus `anchor_activities`.**
Fixed events are written via a raw `appendOp` loop inside the SAME `commitPlan` transaction
(`ingest.js:1337-1491`, specifically the per-field loop at 1475-1487) that U1's `trackedAppendOp`
wrapper already intercepts for every other entity — nothing about that call site is structurally
different from an ordinary entity create, and the owner's stated mental model ("undo removes
newly-created records," OWNER DECISION above) is exactly the case a fresh-camp onboarding hits
most: fixed events (lunch, swim period, etc.) are typically the FIRST thing a director's import
creates. Leaving anchors out would mean "undo this import" silently leaves behind every fixed
event it created — the opposite of what the owner asked for. Decision: **anchors are IN.** This
requires an explicit allowlist, not an ambient "capture every fresh entity_id" rule (see the
capture-scope fix below), and it requires confirming anchors' referential safety, which the
registry work below does.

**Capture-scope fix (closes the "silently includes anchors" half of the original finding).**
`trackedAppendOp`'s creation-detection (U1 step 1, unchanged) determines *update-vs-create* per
`entity_id`; a SEPARATE, explicit constant gates which entities U2 is even allowed to act on:

```js
// electron/ops/ingest.js — reused by commitPlan's trackedAppendOp AND by ingestUndo's delete loop
const U2_DELETABLE_ENTITIES = Object.freeze(new Set([...INGESTIBLE_ENTITIES, 'anchor_activities']))
```

`outcome.createdEntityIds` (U1's existing field, unchanged in shape) is filtered to
`U2_DELETABLE_ENTITIES` before being returned — a future entity added to the op-log through some
other raw-`appendOp` call site does NOT become undo-deletable merely by existing in the same
transaction; it has to be added to this constant deliberately, and the schema-parity test below
fails loudly if that constant and `UNDO_REFERENCE_CHECKS`'s entity coverage ever disagree.

**Finding 1+2 fix — `UNDO_REFERENCE_CHECKS` derived exhaustively from schema, not from example.**
The original 5-entry registry was reverse-engineered from this ADR's own "Lake/Kayaking"
illustration, not from `schema.sql`. Read exhaustively (every `REFERENCES` clause in
`electron/db/schema.sql`, plus every convention pointer column — `*_id`/`*_ids` with no DB-level
`REFERENCES`, cross-checked against schema comments that already document several of them as
deliberate, e.g. `activities.location_id`'s "nullable FK-by-convention... NO DB-level FOREIGN
KEY" comment at schema.sql:286-291), the real incoming-edge set into `U2_DELETABLE_ENTITIES` is:

```js
// electron/ops/undoReferences.js (new file — U2-only, not imported by U1's code path)
//
// Every entry is an edge INTO a U2-deletable entity. `enforced: true` means SQLite's own
// `PRAGMA foreign_keys = ON` (set by openLocalDb, electron/db/localDb.js:1807) throws
// `FOREIGN KEY constraint failed` on an unchecked delete — this already bit production once
// (localDb.js:333-347, the cohort-dedup migration that bricked app launch by deleting a
// referenced cohort). `enforced: false` means the pointer is convention-only: SQLite allows
// the delete, and an unchecked one produces a SILENT orphan, not a crash — equally wrong,
// harder to notice.
export const UNDO_REFERENCE_CHECKS = Object.freeze([
  // -- into cohorts --
  { fromEntity: 'tiers',                    field: 'cohort_id',           toEntity: 'cohorts',          kind: 'scalar',     enforced: true },
  { fromEntity: 'time_blocks',              field: 'cohort_id',           toEntity: 'cohorts',          kind: 'scalar',     enforced: true },
  { fromEntity: 'anchor_activities',        field: 'cohort_id',           toEntity: 'cohorts',          kind: 'scalar',     enforced: true },
  { fromEntity: 'day_override_templates',   field: 'cohort_id',           toEntity: 'cohorts',          kind: 'scalar',     enforced: true },
  // -- into tiers --
  { fromEntity: 'groups',                   field: 'tier_id',             toEntity: 'tiers',            kind: 'scalar',     enforced: false },
  { fromEntity: 'activities',               field: 'eligible_tier_ids',   toEntity: 'tiers',            kind: 'json_array', enforced: false },
  // -- into groups --
  { fromEntity: 'template_slots',           field: 'group_id',            toEntity: 'groups',           kind: 'scalar',     enforced: true },
  { fromEntity: 'week_group_exclusions',    field: 'group_id',            toEntity: 'groups',           kind: 'scalar',     enforced: true },
  { fromEntity: 'activities',               field: 'eligible_group_ids',  toEntity: 'groups',           kind: 'json_array', enforced: false },
  // -- into activities --
  { fromEntity: 'template_slots',           field: 'activity_id',         toEntity: 'activities',       kind: 'scalar',     enforced: true },
  { fromEntity: 'week_activity_exclusions', field: 'activity_id',         toEntity: 'activities',       kind: 'scalar',     enforced: true },
  { fromEntity: 'day_override_template_slots', field: 'activity_id',      toEntity: 'activities',       kind: 'scalar',     enforced: false },
  { fromEntity: 'activities',               field: 'weather_alternative_id', toEntity: 'activities',    kind: 'scalar',     enforced: false }, // self-referential — see batch note below
  // -- into days_of_operation --
  { fromEntity: 'anchor_activities',        field: 'day_id',              toEntity: 'days_of_operation', kind: 'scalar',    enforced: true },
  { fromEntity: 'template_overlays',        field: 'day_id',              toEntity: 'days_of_operation', kind: 'scalar',    enforced: true },
  { fromEntity: 'template_slots',           field: 'day_id',              toEntity: 'days_of_operation', kind: 'scalar',    enforced: false },
  // -- into time_blocks --
  { fromEntity: 'anchor_activities',        field: 'time_block_id',       toEntity: 'time_blocks',      kind: 'scalar',     enforced: false },
  { fromEntity: 'template_slots',           field: 'time_block_id',       toEntity: 'time_blocks',      kind: 'scalar',     enforced: false },
  { fromEntity: 'day_override_template_slots', field: 'time_block_id',    toEntity: 'time_blocks',      kind: 'scalar',     enforced: false },
  // -- into locations --
  { fromEntity: 'activities',               field: 'location_id',        toEntity: 'locations',         kind: 'scalar',    enforced: false },
  { fromEntity: 'week_location_exclusions', field: 'location_id',        toEntity: 'locations',         kind: 'scalar',    enforced: false },
  // -- into anchor_activities: NONE. No table's schema declares a column pointing at
  // anchor_activities(id), and restore.js's CHILD_LINKS (the analogous hand-maintained
  // registry for restore's cascade-reporting) never lists anchor_activities as a parent of
  // anything either. Recorded here as an explicit empty result, not an omission — the
  // schema-parity test below asserts this stays true.
])
```

This is 21 entries, not 5 — the gap Red Hat found was real and this large. Both `enforced: true`
and `enforced: false` rows are checked identically at undo time (the live query below does not
branch on `enforced` — that flag exists only to explain WHY skipping the check would fail
differently: a crash for `enforced: true`, a silent orphan for `enforced: false`, and to make the
severity legible to a reviewer, not to change behavior).

**Kept in sync: schema-parity test (mirrors the `permissionsEntityParity`/`campScopedEntities`
precedent).** A new test, `electron/ops/undoReferences.schemaParity.test.js`:
1. Parses `electron/db/schema.sql` for every `<column> ... REFERENCES <table>(id)` clause
   (regex over the DDL text — the same kind of source-of-truth read `campScopedEntities.js`'s
   design comment describes for why that registry was extracted in the first place). For every
   parsed edge whose target table is in `U2_DELETABLE_ENTITIES`, assert a matching
   `UNDO_REFERENCE_CHECKS` entry exists with `enforced: true`. This is fully mechanical — it
   can't miss a future DB-level FK, because it reads the DDL directly, not a copy of it.
2. Convention (`enforced: false`) edges cannot be derived from syntax (there is no `REFERENCES`
   keyword to find) — these stay hand-maintained, same idiom as `restore.js`'s `CHILD_LINKS`.
   The test instead asserts every `enforced: false` entry names a *real* column via
   `PRAGMA table_info(fromEntity)` (catches a typo/rename immediately) and documents, in a
   comment directly above the test, "adding a new `*_id`/`*_ids` column to any
   `U2_DELETABLE_ENTITIES` table or any table referencing one must add a case here" — the same
   discipline `CHILD_LINKS` already runs on, made explicit rather than assumed.
3. Asserts the anchor_activities-has-no-incoming-edges claim: no parsed schema edge and no
   hand-maintained convention entry targets `anchor_activities`.

**Finding 3 fix — live single-hop referential check, batch-aware (closes Finding 4/the two-pass
edge case together, since they are the same query).** Before deleting a creation-row
`{ entity: toEntity, entity_id }`, for every `UNDO_REFERENCE_CHECKS` entry whose `toEntity`
matches, query the LIVE table (current DB state — this is what catches a referencing row from
OUTSIDE this commit, per candidate-approach 4): does any row of `fromEntity` currently have
`field` equal to (`scalar`) or containing (`json_array`) this `entity_id`, **excluding rows whose
own `(fromEntity, id)` is itself a member of this undo's deletion set** (see batch computation
below)? If yes, skip the deletion, report "kept: {name}, still referenced by {N} other record(s)."
Single-hop by construction: checks direct references once, never re-derives whether the
referencing row is itself undo-eligible.

**Finding 4 fix — batch two-pass, computed set, and deletion order.**
1. **Compute the full deletion set first (D).** Run the Finding-2 full-projection-field gate
   (below) over every entry in `outcome.createdEntityIds` (already filtered to
   `U2_DELETABLE_ENTITIES`). Rows that pass form `D = {(entity, entity_id)}`. No deletion runs
   yet.
2. **Run the referential check against D, not against "nothing."** The live query in the
   Finding-3 fix above filters out any candidate referencing row whose own `(fromEntity, id)` is
   in `D` — this is what makes "location + activity both created and both being undone" resolve
   correctly (the activity is in `D`, so it no longer counts as a live blocker for the location).
   Rows that fail this check (referenced by something genuinely outside `D`) are removed from
   `D` and reported as "kept, still referenced"; this can cascade at most one further hop by
   construction (single-hop, per Finding 3), so the check runs once over the as-computed `D`,
   not iteratively.
3. **Delete in a fixed order: reverse of `INGESTIBLE_ENTITIES`, with `anchor_activities` first.**
   `INGESTIBLE_ENTITIES`'s order is already documented as normative — "a property of the schema"
   (`ingest.js:40-42`) — for creates, because `PRAGMA foreign_keys = ON` throws on a wrong order;
   the same reasoning reversed governs deletes. Concretely:
   `anchor_activities → activities → locations → time_blocks → days_of_operation → groups →
   tiers → cohorts`. Anchors go first because nothing points into them (item 3 of the schema-
   parity test); cohorts go last because everything that can point at a cohort is deleted before
   it. Given `D` is fixed before any delete runs and the order guarantees a row is only deleted
   after everything in `D` that could reference it is already gone, one upfront referential pass
   is sufficient — the decomposition below adds a dedicated test asserting this (the "Lake +
   Kayaking, both undone together" fixture Red Hat named).
4. **Self-reference note (`activities.weather_alternative_id`).** The same in-`D` exclusion in
   step 2 handles two created activities that reference each other as weather alternatives — if
   both are in `D`, neither blocks the other's deletion.

**Finding 2 fix — full-projection-field creation gate (unchanged in mechanism from the prior
draft, restated here for completeness now that it feeds the batch computation above).** A
creation's inverse (delete the row) may only proceed if EVERY field in
`PROJECTIONS[entity].fields` — not just the fields this commit actually wrote — has its current
`latestOp(db, entity, entity_id, field)` still equal to the value observed at commit time
(absent/undefined counts as "equal" only if it is STILL absent at undo time). Concretely: capture,
at commit time, `{ entity, entity_id, fieldSnapshot: Map<field, seq-or-null> }` for every field in
that entity's full projection (not just written ones) — one extra `latestOp` read per unwritten
field, bounded (activities has the largest field list, 17 entries, once per created row — cheap
relative to the transaction it rides inside; anchor_activities has 10). At undo time, if ANY
field's current seq differs from the snapshot (including a field that had NO op at commit time
but has one now — a human filling the blank the import left empty), skip the whole row and report
"kept: {name}, edited since import."

**Finding — the deletion op itself, specified.** `ingestUndo`'s delete loop, for each surviving
`{entity, entity_id}` in `D` (in the order from Finding 4 step 3):

```js
appendOp(db, {
  entity, entity_id, field: DELETE_FIELD,   // '__deleted__' — applyProjection ignores `value`
                                             // for this field (projections.js:563-565), ran as
                                             // `DELETE FROM <table> WHERE id = ?`
  value: null,
  source: 'human',
  author_user_id, device_id,
  parent_op_id: null,
  client_write_id: deriveUndoDeleteClientWriteId(ingestUndoClientWriteId, entity, entity_id),
})
```

- **`source: 'human'`, decided against both cited precedents.** `rejectedSlotKeys`
  (`ingest.js:841-859`) treats a `DELETE_FIELD` on `anchor_activities` with `source === 'human'`
  as a deliberate director rejection — a later reimport of the same fixed event will NOT
  recreate it. That is exactly the right behavior for an undo: the director asked to remove what
  the import created, so a reimport of the same source file should not silently resurrect it.
  `rejectedSlotKeys`'s own comment is explicit that `NULL`/legacy deletes are deliberately
  EXCLUDED from this treatment because they're ambiguous between director-rejection and
  import-teardown — an undo delete is not ambiguous (it is always a deliberate, attributable
  action), so it must not use `NULL`, and it is not an import-teardown, so it must not use the
  import source either. `source: 'human'` is the only correct label; it is also correct for
  every non-anchor entity for the same reason (attributes the delete honestly in the op log),
  even though no other entity has an analogous reimport-suppression consumer today.
- **Trash-restorability — accepted, not a backdoor.** Every entity in `U2_DELETABLE_ENTITIES` is
  already `RESTORABLE_ENTITIES: 'restorable'` in `restore.js`'s `RESTORE_DECISIONS`
  (`cohorts`/`tiers`/`groups`/`activities`/`days_of_operation`/`time_blocks`/`anchor_activities`/
  `locations` are ALL listed `'restorable'`). `restoreEntity` gates only on `isDeleted` — it has
  no way to distinguish "deleted by U2's undo" from "deleted by a director clicking delete," and
  is not meant to. This is not a new exposure U2 introduces: it is the SAME behavior every other
  delete in this app already has. Decision: accept it as-is — an undo-deleted row being
  Trash-restorable is a safety net (a director who undoes by mistake has a second recovery path),
  not a design flaw, and special-casing it would be inventing a new "restorable except when"
  rule this codebase does not otherwise have.
- **Idempotency, per row.** `ingestUndo`'s own outer `client_write_id` (U1 step 5, unchanged)
  covers the whole call; each row's delete additionally needs its OWN `client_write_id`,
  deterministically derived (not `randomUUID()` per attempt) so a retried `ingestUndo` call
  reuses the identical id per row rather than minting a new one each time — same
  derive-don't-randomize idiom as `deriveLocationId`/the INV-1 pattern already used elsewhere in
  this file, applied to `(ingestUndo's client_write_id, entity, entity_id)`.

**`import_evidence` residual — decided: clean up, not accept.** `writeEvidence`
(`ingest.js:268-288`) writes via raw `db.prepare`, never `appendOp`, so `trackedAppendOp` never
observes it and a U2 delete would otherwise orphan it. Unlike the app's other accepted host-local
residuals, this one is cheap and unambiguous to fix: `entity_type`/`entity_id` for every row in
`D` are already known at undo time, and `import_evidence`'s own unique key is exactly
`(camp_id, entity_type, entity_id, field)`. `ingestUndo`'s transaction adds, alongside each row's
`DELETE_FIELD` op, `DELETE FROM import_evidence WHERE camp_id = ? AND entity_type = ? AND
entity_id = ?` for that row — one indexed delete, bounded by `|D|`, in the same transaction. This
is deliberately NOT filed as an accepted residual: `listImportEvidence` degrading gracefully on a
dangling row would have been an acceptable fallback if cleanup were expensive or awkward, but
since the join key is already in hand, leaving debris would be avoidable sloppiness, not a
reasoned tradeoff.

**Hold-back/confidence interaction (attack #6) — verified, not a design gap.** Read
`src/ingest/buildPlan.js`, `src/ingest/reconciliationReport.js`, and `commitPlan`'s HELD
mechanism (`ingest.js:1221-1229`, `798`, `1509-1529`) directly to confirm this rather than assume
it:
- `commitPlan`'s hold is **whole-transaction, not per-decision.** Any `conflicts.length > 0`
  throws a sentinel that rolls back the ENTIRE `db.transaction()` callback — every write already
  made earlier in that same commit attempt, not just the conflicting item. There is no
  intermediate state where some decisions committed and a held one didn't; a held commit is
  atomically a full no-op (`ingest.js:1221-1224`'s own comment: "any conflict means the WHOLE
  commit writes nothing").
- The held-path return object (`ingest.js:1515-1529`) is a **separate literal**, built without
  referencing `invertibleOps`/`createdEntityIds` at all. Even though a JS array populated by
  `trackedAppendOp` earlier in the same closure is not automatically discarded by SQLite's
  rollback (only the DB rows are), the function's return contract already prevents a caller from
  ever seeing those partially-collected, not-actually-written entries — because the held branch
  never reads that array. **Requirement pinned for the implementer:** when U1's
  `invertibleOps`/`createdEntityIds` are added to the success-path `outcome` object (~line 1531
  onward), the held-path object above must NOT be touched to add them, and the held-path return
  site gets a code comment saying exactly that (a held commit wrote nothing; anything collected
  before the throw does not correspond to a real write and must never be returned).
- **A low-confidence create is not a conflict.** Reading the `'create'` case
  (`ingest.js:1158-1182`) confirms confidence/tag values (used only by `writeEvidence`, e.g.
  `writeActivityEvidence`'s `confidence = rule.eligibility_known ? 'high' : 'low'`) never feed
  the `conflicts` array — only `ambiguous_identity`/raw-name-collision resolution does. A
  low-confidence create proceeds through the ordinary `toCreate` → per-field `appendOp` path
  inside the same transaction as every other write, so `trackedAppendOp` captures it identically
  to a high-confidence one, and it is correctly U2-undoable.
- **Conclusion:** `invertibleOps`/`createdEntityIds` already can only ever reflect actual writes,
  by construction of the transaction/rollback boundary — no held decision's would-be write can
  leak into them. This closes attack #6 with a verified "already correct" rather than a design
  change; the one action item is the guard comment above, to keep it true under future edits.

### Replace-mode (U3, deferred, specified for completeness)

`replaceScope`'s `DELETE_FIELD` tombstones on `activities`/`groups`/`time_blocks`/
`days_of_operation`/`tiers` are, mechanically, ordinary op-log deletes on entities already in
`RESTORABLE_ENTITIES`. `restoreEntity(db, { entity, entity_id, ... })` (`electron/ops/restore.js`)
already: refuses if not `isDeleted` (a natural "touched since" gate — a field write after the
delete resurrects the row via `ensureExists`, which flips `isDeleted` false, which makes
`restoreEntity` itself refuse with `not-deleted` before any inverse write happens), preserves
per-field provenance (`lastKnownFieldSources`), and rejects a live unique-name collision
(`detectUniqueFieldCollision`). A U3 undo of a Replace commit would capture the list of
`{entity, entity_id}` pairs `replaceScope` tombstoned and call `restoreEntity` per row at undo
time, applying the SAME Finding-3 referential check (U2's `UNDO_REFERENCE_CHECKS` registry, since
a restored row can re-collide with something created after the Replace) before restoring. **Not
built now**, for the reason stated in Decision: full-camp-setup blast radius, needs its own
adversarial pass focused on "what does the current live state look like by the time the director
clicks undo on a Replace" (a Replace-then-undo gap could plausibly be minutes-to-hours, during
which the director may have started re-entering data by hand).

## Invariants (structural enforcement, not intention)

1. **Undo never blind-restores** (retained from the split-out ADR). Every inverse write is gated
   by a fresh op-seq comparison at undo time, per field. No inverse op is ever written from a
   stale in-memory snapshot.
2. **U1 never creates or deletes a row.** Enforced structurally, not by convention: the
   `trackedAppendOp` wrapper only records entries for `entity_id`s that already had a prior op
   before this commit; `outcome.invertibleOps` for a `captureInverse` commit therefore cannot
   contain a creation by construction, and `ingestUndo`'s inversion loop only ever calls
   `appendOp` with a field/value pair — never `DELETE_FIELD` — so there is no code path in U1
   capable of deleting a row even if a caller mis-assembled the payload.
3. **`mode: 'replace'` + `captureInverse: true` throws.** `commitPlan` refuses this combination
   outright rather than silently capturing an empty or partial `invertibleOps` list — a caller
   (renderer or test) that tries to wire undo onto a Replace commit before U3 exists gets a loud
   error, not a quietly-broken undo button.
4. **Device-local seq invariant (Finding 4, closed).** `ingestUndo`'s "touched since" comparison
   MUST use `latestOp` (plain `seq`), never `latestOpSeq`/`latestScopeOpSeq`
   (`COALESCE(host_seq, seq)`). This is only valid because undo always runs against the SAME
   device's db that captured `invertibleOps` in the first place — `invertibleOps` is renderer-
   memory-scoped (Invariant 5) and never crosses a device boundary, so there is no Client-vs-Host
   seq-numbering-space mismatch for it to fall into. **A code comment at the top of `ingestUndo`'s
   seq-check loop must say, verbatim in intent: "do NOT change this to COALESCE(host_seq, seq) —
   invertibleOps is never transmitted between devices; using the scope-seq convention here would
   silently break on a Client whose local seq numbering differs from the Host's."** A future
   change that tries to sync `invertibleOps` across devices (out of scope for any slice named
   here) would have to revisit this invariant explicitly, not inherit it by accident.
5. **`invertibleOps` is provably scoped to the mounted screen instance/session (Finding 5a,
   closed).** The capture list lives in a `useState`/ref owned by the reconciliation screen
   component (or a hook it owns), never in a module-level variable, a persisted store, or
   anything that survives the component unmounting. It expires — meaning the undo affordance
   stops rendering and the ref is cleared — on: navigation away from the screen, and a fixed
   grace-window timer (duration is Designer's call per the split-out ADR's open question #2,
   unchanged). Starting a NEW import while a grace window is live immediately clears the prior
   window's state (Finding 5b) — there is exactly one live undo affordance at a time, enforced
   by the same piece of state that holds `invertibleOps` being overwritten, not by a separate
   lock. A renderer reload or app close during the window forfeits it silently — the UI copy for
   the undo affordance says "for the next few minutes" or equivalent, not "always available,"
   so this is communicated honestly rather than implying durability the mechanism doesn't have
   (Finding 5c/Red Hat 1c).
6. **U1's `outcome.invertibleOps` contains only entries with a genuine prior op.** (Restated as a
   structural check, not just Invariant 2's consequence: the golden-ops parity test below asserts
   this directly, so a future refactor of `trackedAppendOp` that accidentally starts including
   creations fails a test before it fails a director's data.)

## Consequences

- `electron/ops/ingest.js`: `commitPlan` gains `captureInverse: boolean` (default `false`) and
  the `mode:'replace' && captureInverse` guard (Invariant 3). `trackedAppendOp` wraps the
  existing `appendOp` call sites for `mode: 'add'` only; U1 does not touch `replaceScope`'s call
  sites at all (they are unreachable when `captureInverse` is combined with replace mode, and
  irrelevant — untracked — otherwise).
- `outcome` shape (return value of `commitPlan`/`commitIngest`) gains `invertibleOps: Array<{entity,
  entity_id, field, opId, seq, priorValue, prior_source}>` and `createdEntityIds:
  Array<{entity, entity_id}>` (informational for U1, load-bearing input for U2). Both additive,
  default absent/empty when `captureInverse` is not passed — zero behavior change for every
  existing caller.
- One new narrow IPC method, `ingestUndo` (exact name/channel: Maker's call), electron/main.js +
  preload.js surface addition.
- No schema change. No new table. `invertibleOps` never persists past the renderer session
  (Invariant 5).
- Renderer: one new hook/state slice on the reconciliation screen holding `invertibleOps` +
  grace-window timer + `used`/`live`/`expired` status (Invariant 5, idempotency in mechanism
  step 5).
- **Follow-on U2** (creation/deletion undo, revised 2026-08-17): new file
  `electron/ops/undoReferences.js` holding the 21-entry `UNDO_REFERENCE_CHECKS` registry and
  `U2_DELETABLE_ENTITIES` (`INGESTIBLE_ENTITIES` + `anchor_activities`); new test
  `electron/ops/undoReferences.schemaParity.test.js` (mechanically parses `schema.sql`'s
  `REFERENCES` clauses for the DB-enforced subset, hand-checks the convention subset against
  `PRAGMA table_info`); `ingest.js` gains the full-projection-field capture at commit time,
  `writeEvidence`'s companion `import_evidence` cleanup at undo time, and the ordered/batch-aware
  delete loop in `ingestUndo`. Fully specified above; not built in this slice. Requires its own
  focused Red Hat pass before build (see "Flag for the third Red Hat pass" below), scoped to U2
  only — U1 does not reopen.
- **Follow-on U3** (Replace-mode undo via `restoreEntity` reuse): specified above; not built in
  this slice; deferred for blast-radius reasons, not mechanism-availability reasons.
- **Deliberately NOT this ADR's scope** (unchanged from the split-out ADR): a durable, synced
  `reconciliation_runs` audit-trail entity. `invertibleOps`'s shape is still additive-compatible
  with persisting it later, same reasoning as before.

## Decomposition into test-first sub-slices

1. **U1a — capture, no undo yet.** `commitPlan({ captureInverse: true, mode: 'add' })` returns
   `invertibleOps`/`createdEntityIds` correctly populated; `mode: 'replace'` + `captureInverse`
   throws (Invariant 3). Golden-ops parity test: `captureInverse: true` produces byte-identical
   writes to `captureInverse: false` for the same input — the flag changes only what's returned,
   never what's written. A second assertion: `invertibleOps` never contains an entry whose
   `entity_id` had no prior op (Invariant 6/2).
2. **U1b — the concurrent-write test (load-bearing, per §23 of the R0 handoff's behavior-level
   testing discipline).** Commit an import with `captureInverse: true`. Have a SECOND simulated
   device (a distinct `device_id`, writing directly via `appendOp`) touch one of the same
   `(entity, entity_id, field)` triples the import touched, bumping its `seq` past the captured
   one. Run `ingestUndo`. Assert: (a) the concurrently-touched field is NOT reverted, (b) every
   OTHER captured field IS reverted, (c) the skip is present in the returned receipt data with
   the correct field name. This is the test that PROVES Invariant 1, not just documents it — it
   must fail if someone "simplifies" the seq check into a blind restore.
3. **U1c — device-local seq invariant regression guard.** A focused unit test that asserts
   `ingestUndo`'s gate calls `latestOp` (plain seq) and NOT `latestOpSeq`/`latestScopeOpSeq` —
   either by a direct call-site assertion (spy/mock) or by constructing a db state where the two
   conventions would disagree (a row with a non-null `host_seq` diverging from its `seq`) and
   asserting the plain-seq behavior is what actually ran. Exists specifically so Finding 4 can't
   silently regress in a later refactor that "harmonizes" the two seq helpers.
4. **U1d — idempotency / double-undo.** First `ingestUndo` call succeeds and reverts N fields.
   Second call with the same `invertibleOps` payload (simulating a retried/duplicate request):
   every field reports "kept, changed since import" (because the first undo's own writes are now
   the latest op for each field) — assert the receipt wording, not just that nothing crashes.
5. **U1e — renderer-side state scoping.** Component test: navigating away from the reconciliation
   screen clears the undo affordance; starting a second import while a grace window is live
   replaces (not appends to) the held state, so only the second import's undo is ever offered.
6. **U1f — IPC surface + receipt.** End-to-end (or closest integration-test equivalent per this
   project's `test:integration` harness): commit an import, undo it, assert the plain-language
   receipt text matches what was actually reverted vs. kept.
7. **(U2, follow-on ticket, not this slice, revised 2026-08-17) — full decomposition now
   specified, not just named:**
   - **U2a — schema-parity test first.** `undoReferences.schemaParity.test.js` (Finding 1+2 fix)
     lands BEFORE `UNDO_REFERENCE_CHECKS` is consumed by anything — it is the guardrail the rest
     of U2 is built inside of, not a check added after the fact. Asserts every DB-enforced edge
     into `U2_DELETABLE_ENTITIES` has a registry entry, every convention entry names a real
     column, and no edge targets `anchor_activities`.
   - **U2b — full-projection-field capture + gate.** Commit-time snapshot of every
     `PROJECTIONS[entity].fields` value (not just written ones) for each created row; undo-time
     re-check. Regression fixture: a human fills a field the import left blank on a created row
     (e.g. `location_id`) — assert the row is skipped, not deleted.
   - **U2c — the "Lake + Kayaking, both undone together" fixture (load-bearing, Finding 4).**
     Import creates a location and an activity referencing it in the SAME commit;
     `captureInverse: true`; undo both. Assert BOTH are deleted (the in-`D` exclusion works) and
     the deletion order doesn't throw a `FOREIGN KEY constraint failed`. A second variant: the
     location is created by this import but a DIFFERENT, untouched pre-existing activity also
     references it — assert the location is KEPT ("still referenced") while the newly-created,
     unreferenced rows still delete.
   - **U2d — anchor inclusion.** A fixed-event import creates `anchor_activities` rows; undo
     deletes them; assert no `FOREIGN KEY constraint failed` (confirms the "nothing points into
     anchors" claim under `PRAGMA foreign_keys = ON`, not just by schema inspection) and that a
     reimport of the same source file after undo does NOT recreate the anchor (confirms
     `source: 'human'` correctly engages `rejectedSlotKeys`).
   - **U2e — `import_evidence` cleanup.** A created row with evidence (e.g. a low-confidence
     activity) is undone; assert its `import_evidence` rows are gone, not orphaned.
   - **U2f — hold-back non-leak (attack #6 regression guard).** A commit that both creates rows
     AND holds (mixed conflict) with `captureInverse: true`: assert the held-path return has no
     `invertibleOps`/`createdEntityIds` keys at all (not empty arrays — absent), and that a
     SEPARATE successful commit's capture is unaffected by an unrelated held one.
   - **U2g — idempotent per-row retry.** A retried `ingestUndo` call (same outer
     `client_write_id`) reuses the same derived per-row `client_write_id` for each delete rather
     than minting new ones.

## Flag for the second Red Hat pass

This ADR requires a second Red Hat pass on **U1 only** before build (U2/U3 get their own passes
when they're picked up). The re-review should specifically try to break:

1. **The "prior op existed before this commit" check for creation vs. update classification.**
   `trackedAppendOp` must determine "did this entity_id exist before THIS commit's transaction
   began," not "is this the first appendOp call this transaction has seen for this id" — a
   commit that both creates a row AND updates it later in the SAME transaction (does `commitPlan`
   ever do this for one entity_id in one pass? verify against current `buildPlan`/`commitPlan`
   flow) must not be misclassified as an update of a pre-existing row.
2. **Whether U1's exclusion of `replaceScope`'s field-value write** (the `weather_alternative_id`
   null-out inside `replaceScope`, which IS a field-value `appendOp`, not a `DELETE_FIELD`) is
   actually unreachable under the Invariant-3 guard, or whether there's a code path where
   `captureInverse: true` combined with `mode: 'add'` could still somehow observe a
   `replaceScope`-originated op in the same transaction (it shouldn't — `replaceScope` is only
   ever called for `mode: 'replace'` — but this is exactly the kind of "should be true" claim
   Red Hat exists to falsify with a concrete test, not accept from prose).
3. **The grace-window state-scoping claim (Invariant 5)** — try to find a path where
   `invertibleOps` survives a navigation-away (a memoized hook, a portal, a background timer that
   outlives the component) and produces a stale-but-still-offered undo affordance.
4. **The double-undo receipt honesty claim (mechanism step 5)** — confirm "kept, changed since
   import" is genuinely indistinguishable-in-mechanism from a real peer edit, and that no code
   path accidentally DOES distinguish them in a way that could then get the wording wrong (e.g.
   comparing `device_id` on the shadowing op — if that comparison exists anywhere, it needs its
   own review for whether it's reliable enough to change the copy).
5. **Whether the golden-ops parity test (U1a) is actually strong enough** to catch a future
   refactor of `trackedAppendOp` that changes captured `priorValue` semantics without changing
   the WRITTEN ops (which the parity test alone wouldn't catch, since parity only compares
   writes, not the captured-but-unwritten side channel).

## Flag for the third Red Hat pass (U2 only, added 2026-08-17)

This revision closes the six findings from the 2nd pass. It does not claim they're unbreakable —
it claims the specific breaks that were found are closed. The 3rd pass should specifically try to
break the NEW machinery this revision introduces, not re-litigate U1 (which is out of scope here)
or re-argue the six closed findings from first principles:

1. **Is `UNDO_REFERENCE_CHECKS`/the schema-parity test actually exhaustive, or just less wrong?**
   The 21-entry registry was built by direct inspection of `schema.sql` at one point in time.
   Try to find a column this pass still missed — in particular, any table this ADR didn't
   enumerate at all (the search was scoped to tables with an obvious `*_id`/`*_ids` column;
   confirm nothing was skipped) — and separately, confirm the schema-parity test's regex against
   `schema.sql`'s actual `REFERENCES` syntax variations (multi-line declarations, `REFERENCES
   x(y)` with unusual whitespace) actually matches every DB-enforced clause rather than silently
   under-matching and passing green on a false negative.
2. **Does the fixed deletion order actually never throw?** The order (`anchor_activities →
   activities → locations → time_blocks → days_of_operation → groups → tiers → cohorts`) is
   argued from `INGESTIBLE_ENTITIES`'s reversed creation order, not independently derived from
   the FK graph. Construct the FK graph from `UNDO_REFERENCE_CHECKS`'s `enforced: true` subset
   directly and confirm this fixed order is a valid topological sort of it — don't accept the
   analogy-to-creates argument without checking whether U2's actual edge set (which includes
   edges creates never had to worry about, e.g. `template_slots`/`week_*_exclusions` rows that
   aren't part of `INGESTIBLE_ENTITIES` at all) still respects it.
3. **The in-`D`-exclusion query, concretely.** Confirm the implementation Maker writes actually
   filters candidate referencing rows by `(fromEntity, id) ∈ D` and not by some looser proxy
   (e.g. "created in this same import," which is a superset of `D` once Finding-2's gate has
   removed touched-since rows from `D` — a row excluded from `D` by the field-gate must NOT also
   be excluded from the referential check, or a genuinely-kept referencing row could wrongly
   suppress a real orphan warning).
4. **`source: 'human'` on non-anchor entities — any other reimport-recognition consumer besides
   `rejectedSlotKeys`?** This revision confirmed `rejectedSlotKeys` is anchor-only by reading it
   directly, but did not exhaustively search every entity's recognition path for an analogous
   "does a DELETE_FIELD-with-this-source change future reimport behavior" check. If one exists
   for, say, `locations` or `activities`, confirm `source: 'human'` still produces the intended
   behavior there too (it should — it's the "director rejected this" signal — but that should be
   verified per-entity, not assumed to generalize from the one confirmed case).
5. **The `import_evidence` cleanup's own idempotency.** The delete is a plain `DELETE FROM
   import_evidence WHERE ...` with no `client_write_id` (it isn't an op-log write at all, since
   `import_evidence` was never op-log-backed). Confirm a retried `ingestUndo` running this delete
   twice is genuinely a no-op (it should be — `DELETE` on an already-absent row is inert — but
   confirm nothing downstream treats "zero rows deleted" as an error condition).
6. **Whether `deriveUndoDeleteClientWriteId` is actually collision-free** across two different
   `ingestUndo` calls (two different imports, each undone) that happen to undo an entity_id with
   the same string — entity_ids are UUIDs so this should be structurally impossible, but the
   derivation function's exact inputs should be checked, not assumed, given deterministic-id
   bugs are exactly the kind of thing that looks obviously safe and isn't (cf. the INV-1
   precedent this pattern is borrowed from, which had its own review history for exactly this
   reason).

## Open questions for Governor

1. **Undo IPC method naming/placement** — unchanged from the split-out ADR's open question #1,
   still non-blocking, still Maker's call within this mechanism.
2. **Grace-window duration and exact expiry trigger** — unchanged from the split-out ADR's open
   question #2, still Designer's call; the mechanism works under any duration.
3. **Whether U2 and U3 are scheduled as immediate follow-ons to U1 or deferred indefinitely** —
   a roadmap/priority call, not a technical one. This ADR fully specifies both so the decision to
   pick either up later doesn't require a third design pass, only implementation + its own
   Red Hat review.
