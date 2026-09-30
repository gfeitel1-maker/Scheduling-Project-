---
title: "Elective run durability pass — partial-snapshot detection, dangling-assignment persistence, the move picker's contract, and persisted eligibility/resource findings (v83)"
document_type: adr
status: accepted
approved: 2026-09-30 (owner, via the organizer session: "go for it" — accepted as written; recorded on the board as h-accept-adr-2026-09-30-durability)
authority: normative
implementation_state: in-progress
date: 2026-09-30
task_class: database-sync
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/WORK_RECORD_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
  - SECURITY.md
related_adrs:
  - docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md
  - docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-choice-export.md
related_specs: []
related_tickets:
  - docs/work/tickets/T320-elective-run-durability.md
---

# Elective run durability pass — partial-snapshot detection, dangling-assignment persistence, the move picker's contract, and persisted eligibility/resource findings (v83)

## Context

T243-T251/T197/T198 (the two related ADRs) built the elective run lifecycle, its outer-schedule
snapshot, and its machine-access surface. Four durability gaps survived that work, all discovered
against the live tree on 2026-09-29/30, not carried forward from memory:

1. **A finalized run's snapshot can be partially synced and is read/exported as if complete.**
   `finalizeElectiveRun.js` computes `snapshots.length` and returns it as `snapshotRows` but never
   stores it. `computeFinalizedAgainstStaleGeneration` compares `solver_generation` values, never
   row completeness — it answers "is this the right generation," not "did all of it arrive."
2. **`DANGLING_MANUAL_ASSIGNMENT` is session-scoped, not durable.** It rides only
   `commitElectiveRun`'s response (`electron/ops/commitElectiveRun.js`), rendered by
   `AssignmentPanel.jsx`'s `useState` and only while `viewRun.id === committedInfo?.runId`
   (`AssignmentPanel.jsx:1143`) — invisible on a cold-reopened run. The root cause is that nothing
   prunes `elective_occurrences` on regeneration: `commitElectiveRun.js` writes every currently-
   derived occurrence but never deletes a previously-recorded one that regeneration no longer
   produces, so the table accumulates the union of every generation's occurrences
   (`getElectiveRun.js:108-115`'s own comment states this explicitly).
3. **The only shipped remedy for a dangling row (release lock) cannot resolve it.**
   `setElectiveAssignment.js` writes `source:'manual'` unconditionally; the dangling finding is
   keyed on `source`, not `is_locked` (`DraftRunView.jsx:268-284`'s own comment already says so).
   `deriveElectiveAssignmentId(runId, camperId, occurrenceId)` includes `occurrence_id`
   (`electron/ops/electiveDerivedIds.js:572`), so moving a camper to a different occurrence is a
   *different* derived row — `setElectiveAssignment` alone cannot move a placement across
   occurrences without leaving the dangling row behind.
4. **Eligibility and resource exceptions are permanently empty in the export.**
   `src/screens/elective/export/exportRunExceptions.js` ships `not_computed: ['eligibility',
   'resource']` by design (its own header comment) — `buildElectiveAssignments.js`'s
   `UNSUPPORTED_LINKED_CHOICE` findings are produced only at generation time and never persisted;
   `findRouteConflicts`'s `OUTER_RESOURCE_CONFLICT` is produced only at finalize time, as a
   **refusal** — a run that finalizes successfully has zero of them by construction.

All four are coupled through the same run lifecycle and the same schema version — one ADR, one
bump (v83), per the dispatching brief.

## Candidate approaches considered

Per item, following this ADR family's own established practice of diverging per sub-decision
(`docs/adr/2026-09-23-...md` does this explicitly) rather than once for the whole document.

**Item 1 — what shape detects a partial snapshot.**

(1) *Row-count only* — one `INTEGER` column recording the expected row count at finalize time;
a reader compares it against `COUNT(*)`. Cheapest, and gives a legible "N of M rows" number for
copy. **Rejected as insufficient, not merely as non-preferred**: this codebase's own projection
layer stub-seeds a row on first-field-arrival (`INSERT OR IGNORE ... VALUES (id, run_id, ...)`,
`electron/ops/projections.js`'s `elective_run_outer_snapshots` entry, confirmed by reading it) —
a row can exist in SQLite with only its four identity columns populated while
`activity_name`/`location_name`/etc. are still `NULL`, because `appendOp` writes **one op per
field**, not one op per row, and per-field ops can arrive out of order across a sync. A row-count
comparison sees that stub-seeded row as "present" and reports the snapshot complete when it is
not.

(2) ★ *Content digest only* — a SHA-256 over a canonical serialization of every expected snapshot
row, computed at finalize time and compared against the same serialization of currently-held rows
at read time. Detects both a fully-missing row **and** a partially-arrived one (the stub-seed
case above), because a `NULL` field changes the serialized string. Cost: it cannot say *how many*
rows are missing, only that something disagrees — a materially worse UI message ("this snapshot
may be incomplete" vs. "waiting on 4 of 62 rows").

(3) ★★ *Row-count and digest together, both derived from the same array finalize already builds
in one pass* — chosen. See "Decision" below for the reasoning; the two are complementary, not
redundant, and computing both costs one extra pass over an array that is already in memory at
finalize time (this run's outer schedule, bounded by camper count × day/block count — not a large
number even for a big camp).

**Recommendation: (3), medium-high confidence.** The insufficiency of count-only is a *specific,
demonstrated* mechanism in this codebase (the stub-seed pattern), not a hypothetical — that raises
confidence above a generic "belt and braces" justification. The residual uncertainty is only
whether a director-facing message needs both numbers or just the boolean; that is a Designer/copy
question, not a data-shape question, and the data shape supports either.

**Item 4 — persisted findings table vs. read-time recomputation, per category.**

Diverged as one question in the brief, but the two categories (eligibility, resource) turn out to
have **different correct answers**, discovered only by tracing where each finding is actually
computed today — stated plainly rather than forcing one shape on both for symmetry's own sake:

*Eligibility (`UNSUPPORTED_LINKED_CHOICE`).* (1) *Re-run `buildElectiveAssignments` at read time
against current data* — rejected, and this is a correctness rejection, not a cost one:
`buildElectiveAssignments` is a **solver**. Calling it again does not re-check what was committed,
it computes a **new hypothetical solve**, which can legitimately produce a different assignment
(and therefore different findings) than the one actually on disk — re-running it at read time
would silently answer a different question than "what did this run's actual commit find." (2) ★
*Persist the findings `buildElectiveAssignments` already returns, at the same commit/regenerate
point `DANGLING_MANUAL_ASSIGNMENT`'s detection already runs, in the same transaction* — chosen;
this is the exact discipline this feature family already uses everywhere else (compute once at
the authoritative point, persist, filter by generation at read time; never re-derive with a
different mechanism, per `electiveGenerationPredicate.js`'s "one fragment" precedent).

*Resource (`OUTER_RESOURCE_CONFLICT`).* (1) *Persist at finalize time, alongside eligibility* —
rejected as **trivially vacuous**, stated plainly rather than built anyway: `findRouteConflicts`
is invoked at finalize **only as a hard refusal gate** (`finalizeElectiveRun.js` step 2) — a run
that successfully finalizes has, by construction, zero resource conflicts to persist, and a draft
run never calls `findRouteConflicts` at all today. Persisting an always-empty bucket for final
runs and never populating it for draft runs would ship a table that looks like it discharges the
category without doing so. (2) ★ *Re-run `findRouteConflicts` live, at read time, scoped to the
run's occurrences, for a draft run only* — chosen. Unlike the eligibility case, this re-run is
**safe**: `findRouteConflicts` is a pure, deterministic function of already-committed schedule
state (`template_slots`, `activities`, `locations`, etc.), not a solver making a new decision — it
is the *exact same call* `finalizeElectiveRun.js` already makes, just invoked one point earlier in
the lifecycle (draft-read time instead of finalize time), mirroring how
`getElectiveRunOuterScheduleHandler`'s own draft branch already re-derives live rather than
reading a stale table. For a `final` run, skip the call and return `[]` directly — it is provably
empty by construction (the finalize gate that already ran).

**Recommendation: eligibility persisted, resource computed live for drafts and skipped for
finals — medium-high confidence on eligibility (same mechanism as item 2/3's precedent), medium
confidence on resource** (the "provably empty for final" reasoning is sound, but it does mean the
`resource` bucket in a finalized run's export can never show anything even in principle under this
design — stated as a limitation below, not hidden).

## Decision

### Item 1 — partial-snapshot detection

**New columns on `elective_assignment_runs` (v83, additive to an existing genesis-pinned entity —
same posture the 09-26 ADR used for its own three new `elective_run_outer_snapshots` columns:
already registered everywhere that table is registered; only the column set grows):**

```sql
ALTER TABLE elective_assignment_runs ADD COLUMN snapshot_expected_rows INTEGER;
ALTER TABLE elective_assignment_runs ADD COLUMN snapshot_digest TEXT;
```

Both `NULL` until a finalize writes them; both immutable thereafter (same posture as
`finalized_at`/`finalized_by` — no other code path ever touches them).

**New module `electron/ops/electiveRunSnapshotCompleteness.js`:**

```js
import { createHash } from 'node:crypto'

// Field order is the contract — the SAME array (order-independent, since rows
// are sorted by id first) must be used by both the "expected" computation
// (finalize time, in-memory rows) and the "held" computation (read time,
// SELECT from elective_run_outer_snapshots) or the digest is meaningless.
// solver_generation is DELIBERATELY EXCLUDED: a generation mismatch is
// FINALIZED_AGAINST_STALE_GENERATION's own, separate concern
// (finalizedAgainstStaleGeneration.js) — folding it into this digest would
// make an ordinary, already-detected staleness ALSO register as
// "incomplete," conflating two different findings with two different
// remedies (revise the run vs. wait for sync to finish).
const DIGEST_FIELDS = [
  'id', 'camper_id', 'day_id', 'time_block_id', 'activity_id', 'activity_name',
  'location_id', 'location_name', 'span_blocks', 'cell_kind', 'choice_id',
  'is_linked_choice', 'choice_label',
]

function digestOf(rows) {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const hash = createHash('sha256')
  for (const row of sorted) {
    hash.update(DIGEST_FIELDS.map((f) => `${f}=${row[f] ?? '\0NULL'}`).join('|'))
    hash.update('')
  }
  return hash.digest('hex')
}

// Called by finalizeElectiveRun.js with the SAME `snapshots` array it already
// builds, BEFORE writing — this is the single source of truth for "what the
// export should contain."
export function computeExpectedSnapshotDigest(rows) {
  return digestOf(rows)
}

// Called by getElectiveRun.js / getElectiveRunOuterSchedule.js with the
// CURRENTLY-HELD rows for this run.
export function computeHeldSnapshotDigest(db, runId) {
  const rows = db.prepare(
    `SELECT id, camper_id, day_id, time_block_id, activity_id, activity_name,
            location_id, location_name, span_blocks, cell_kind, choice_id,
            is_linked_choice, choice_label
       FROM elective_run_outer_snapshots WHERE run_id = ? ORDER BY id`
  ).all(runId)
  return digestOf(rows)
}

// Shared by every reader (getElectiveRun.js, getElectiveRunOuterSchedule.js,
// electiveRunProjectionInput.js via those two) — one fragment, per
// electiveGenerationPredicate.js's own precedent, so no reader can drift.
export function computeSnapshotCompleteness(db, run) {
  if (run?.status !== 'final') {
    return { expectedSnapshotRows: null, heldSnapshotRows: null, snapshotIncomplete: false }
  }
  const expected = run.snapshot_expected_rows
  // A legacy/pre-v83 final run (or a final run whose snapshot predates this
  // column existing) has nothing to compare against — same "no snapshot
  // generation" posture computeFinalizedAgainstStaleGeneration already takes
  // for its own no-snapshot-rows case. Not incomplete; simply unknown.
  if (expected == null) {
    return { expectedSnapshotRows: null, heldSnapshotRows: null, snapshotIncomplete: false }
  }
  const held = db
    .prepare('SELECT COUNT(*) c FROM elective_run_outer_snapshots WHERE run_id = ?')
    .get(run.id).c
  const heldDigest = computeHeldSnapshotDigest(db, run.id)
  const incomplete = held !== expected || heldDigest !== run.snapshot_digest
  return { expectedSnapshotRows: expected, heldSnapshotRows: held, snapshotIncomplete: incomplete }
}
```

**`finalizeElectiveRun.js` change** (minimal — reuses the existing `snapshots` array, no new
derivation): add `snapshot_expected_rows: snapshots.length, snapshot_digest:
computeExpectedSnapshotDigest(snapshots)` to the existing `write('elective_assignment_runs',
runId, {...})` call alongside `status`/`finalized_at`/`finalized_by`.

**Reader changes.** `getElectiveRun.js` and `getElectiveRunOuterSchedule.js` each call
`computeSnapshotCompleteness(db, run)` and merge its three fields
(`expectedSnapshotRows`, `heldSnapshotRows`, `snapshotIncomplete`) into their return object.
`electron/ops/electiveRunProjectionInput.js` (already calling `getElectiveRun`) threads
`ui.expectedSnapshotRows`/`ui.heldSnapshotRows`/`ui.snapshotIncomplete` into its `input` object —
three passthrough lines, no new call.

**Exact new read-contract field names:** `expectedSnapshotRows` (number|null),
`heldSnapshotRows` (number|null), `snapshotIncomplete` (boolean, always `false` for a draft run or
a legacy final run with no recorded expectation).

**Export refusal semantics — the owner's exact constraint ("must NOT produce a complete-looking
artifact from partial rows") is read as a hard refusal, not a carried flag.** Every renderer-side
export builder that reads `elective_run_outer_snapshots`-derived rows for a **final** run
(`exportChildSchedule.js`, the new `exportActivityRoster.js`/`exportRunExceptions.js`/
`exportRunSummary.js` from the 09-26 ADR, `exportElectiveRunProjection.js`,
`exportElectiveRunWorkbook.js`) gains a leading guard:

```js
if (run.status === 'final' && run.snapshotIncomplete) {
  return { ok: false, error: 'SNAPSHOT_INCOMPLETE',
    expectedSnapshotRows: run.expectedSnapshotRows, heldSnapshotRows: run.heldSnapshotRows }
}
```

**Rejected alternative: carry the flag through and still emit the document** (the pattern this
ADR family already used for `finalizedAgainstStaleGeneration`). Rejected here specifically because
(a) it directly contradicts the owner's literal words ("must NOT produce a complete-looking
artifact"), and (b) unlike staleness — where the data is fully present, merely possibly
out-of-date — this is data that is **actually absent**: a blank cell in a printed child schedule
reads as "no elective this period," which is a materially different and more actionable-wrong
statement than "this schedule might be stale." The run's own on-screen state (below) is where the
flag belongs, because it is seen **before** a director chooses to export, not buried in a JSON
field a person holding a printed page will never open.

**Where this reaches a human.** `snapshotIncomplete`/`expectedSnapshotRows`/`heldSnapshotRows`
render in the run's own inline run-state area on the Final-run screen — the same surface and
pattern `finalizedAgainstStaleGeneration` already uses (per the 2026-09-24 amendment to the 09-23
ADR: never a banner, the run's own displayed state). The run screen itself does **not** refuse to
render — only export/print is blocked; a director can still see and act on the run
(e.g., wait for the other device to sync, or start a revision) without being locked out of the
screen.

**`format_version` implications — verified, not assumed.** `exportChildSchedule.js` is at
`format_version: 2` (T197's bump) and `exportElectiveRunProjection.js` is at `format_version: 2`
(T318's bump, confirmed by reading both files directly). Item 1's change does **not** alter the
shape of a document that is actually emitted — a refusal is a distinct `{ok:false, ...}` control
response, never format-versioned, exactly as `commitElectiveRun`/`finalizeElectiveRun`/
`setElectiveAssignment` already draw that line — so **no format_version bump is required for item
1 alone.**

### Item 2 — durable dangling-assignment detection, via pruning stale occurrences

**Prune location: inside `commitElectiveRun.js`'s existing `runAtomic` transaction, immediately
before the existing `for (const occ of occurrences) write('elective_occurrences', occ.id, ...)`
loop.** The "did not re-derive" set is computed from data already in scope at that point in the
function: `occurrenceIds` (the `Set` of this regeneration's freshly-derived occurrence ids,
already computed and already used by the existing `DANGLING_MANUAL_ASSIGNMENT`-finding query) and
a new pre-transaction read of the run's currently-recorded occurrence ids:

```js
// Read alongside the existing pre-transaction reads (findings/lockedRows),
// using the SAME occurrenceIds Set that query already relies on.
const existingOccurrenceIds = new Set(
  db.prepare('SELECT id FROM elective_occurrences WHERE run_id = ?').all(runId).map((r) => r.id)
)
const occurrencesToPrune = [...existingOccurrenceIds].filter((id) => !occurrenceIds.has(id))
```

Inside `runAtomic`, before the existing occurrence-write loop, following `deleteElectiveRun.js`'s
exact op-log delete discipline (import `DELETE_FIELD` alongside the existing `appendOp`/
`runAtomic` import):

```js
const del = (entity, entity_id) =>
  appendOp(db, { entity, entity_id, field: DELETE_FIELD, value: 1, author_user_id: authorUserId, device_id: deviceId })
for (const id of occurrencesToPrune) del('elective_occurrences', id)
```

**What is pruned and what is deliberately not.** Only `elective_occurrences` rows. **Not
cascaded** into `elective_preferences`/`elective_assignments` — a `source='manual'` row that
pointed at a pruned occurrence is left exactly as it is today (its `occurrence_id` now names a row
that no longer exists) — that dangling state **is** the finding this item exists to make durable,
not a defect to clean up in the same pass. A `source='solver'` row pointing at a pruned occurrence
needs no action either: it is already excluded from every reader by the existing
generation-visibility predicate (`electiveGenerationPredicate.js`), since its `solver_generation`
is stale the moment regeneration mints a new one — this item does not change that. `elective_
preferences` rows pointing at a pruned occurrence are out of scope for this item (untouched before
this change, untouched after).

**Durable `getElectiveRun.js` derivation, replacing the session-scoped read as the source of
truth:**

```sql
SELECT a.id, a.camper_id, a.occurrence_id
  FROM elective_assignments a
 WHERE a.run_id = :runId AND a.source = 'manual'
   AND NOT EXISTS (SELECT 1 FROM elective_occurrences o WHERE o.id = a.occurrence_id)
```

**Finding shape — must be byte-identical to what `commitElectiveRun.js` already returns and
`DraftRunView.jsx`/`ElectiveRunViews.test.jsx` already render/assert**
(`{ kind: 'DANGLING_MANUAL_ASSIGNMENT', assignment_id, camper_id, occurrence_id, message }`), with
the exact message string:

> "A placement made by hand sits in a period this schedule no longer has, so nobody will see it on
> the grid — move it to a period that still exists, or remove it."

**Extract the message/finding-building into one shared function**,
`electron/ops/danglingManualAssignmentFinding.js` exporting `buildDanglingManualAssignmentFinding(row)`,
imported by **both** `commitElectiveRun.js` (replacing its inline `.map(...)`) and the new
`getElectiveRun.js` query — the same "one fragment, no second copy" discipline
`electiveGenerationPredicate.js` already established, so wording cannot drift between the two call
sites the way `DraftRunView.jsx:271-274`'s own comment already flags as a past regression risk.

`getElectiveRun.js`'s return object gains `danglingFindings: Array<Finding>` (same shape). Whether
`commitElectiveRun.js`'s own response field of the same name stays, is unclear from code alone —
**flagged as an open question below** rather than decided unilaterally; the response contract is
consumed by `AssignmentPanel.jsx`'s immediate post-commit toast, which this ADR does not have full
sight of the refresh timing for.

**`src/localClient.mock.js` parity.** The mock's `commitElectiveRun` already fully replaces
`state.elective_occurrences` for `runId` on every commit (`localClient.mock.js:1915-1916` —
`filter(o => o.run_id !== runId)` then append the new set), which is a *stronger* prune than
production needs (it drops and re-inserts the whole set rather than diffing) but produces an
**identical end state** for the durable-dangling-derivation purpose, so no mock change is required
for the prune itself. The mock's `getElectiveRun` must gain the same `NOT EXISTS`-style filter
(implemented as an array `.filter()` over `state.elective_occurrences`, mirroring the SQL) to keep
`test/governance.test.js`'s mock/client parity pin satisfied — the mock currently has **no**
occurrence-diff pass and its `commitElectiveRun` explicitly degrades `findings: []` (see the
comment at `localClient.mock.js` around the commit return value) — that comment must be corrected:
`findings` can now be non-degraded for the dangling case specifically, since the mock's occurrence
replacement already produces the correct input for the new `getElectiveRun` filter, even though it
still cannot compute `DANGLING_MANUAL_ASSIGNMENT` **at commit time** the way the real handler does
(no occurrence-diff pass at commit) — the mock's `getElectiveRun` read-time filter closes that gap
without needing one.

**Sync hazards (named, not silently accepted).**

*Hazard A — a peer merges a pruned occurrence's tombstone after its own regeneration wrote fresh
ops for the same derived occurrence id.* Device A regenerates, occurrence `O` is no longer
derived, A tombstones it. Device B, not yet having synced A's underlying template edit, regenerates
independently and still derives `O` (legitimately, from B's still-current view of the template) —
B's regeneration writes ordinary field ops for `O`'s row. Whichever op — A's `DELETE_FIELD` or B's
field writes — the projection replays **later** determines whether `O` ends up tombstoned or
resurrected on both devices after merge. **This is the identical, already-documented,
already-accepted gap `deleteElectiveRun.js`'s own header comment names for the whole shared
stub-seed/`ensureExists` pattern** ("A DELETED RUN CAN BE RESURRECTED BY A CONCURRENT PEER WRITE")
— this item inherits that class of risk for occurrences rather than introducing a new one, and
this ADR does not fix it for the same reason `deleteElectiveRun.js` does not: the real fix is a
tombstone-aware stub-seed at the shared projection choke point, which is a separate architecture
change needing its own ADR, not a per-entity patch. **Consequence, stated precisely**: if `O` is
resurrected, a manual row pointing at it stops being reported as dangling on the device that
resurrected it, until that device's next regenerate re-prunes it (self-healing, bounded by "next
regenerate," not permanent). **Accepted** — same eventual-consistency "detect what's cheap, name
what isn't" posture this ADR family already takes for H2/H3, and no cheaper detection exists here
than there.

*Hazard B — a peer's regeneration re-derives the same occurrence id a tombstone removed, as a
genuinely independent, legitimate fact (not a stale-template artifact).* E.g., a slot is removed
then re-added within the sync window by two different directors on two different devices. This
converges as an ordinary derived-id LWW race on that entity's fields — **by design**, not a bug:
this is exactly what D4's derived-id scheme exists to produce (two devices minting "the same fact"
converge on one row rather than duplicating). **Accepted, not a hazard this ADR needs to guard
against** — it is the scheme working as intended.

### Item 3 — the move-picker contract

**Extend `setElectiveAssignment` with one new optional parameter, `replacesAssignmentId`, rather
than a remove+create pair of IPC calls or a new op module.** Rejected alternatives and why:

- *Remove+create pair* (two IPC calls: a new remove handler, then the existing
  `setElectiveAssignment`) — rejected: not atomic across the two calls (two separate
  `runAtomic` transactions), so a dropped connection between them leaves the camper in **neither**
  occurrence with no single well-defined retry (does the caller retry call 1, call 2, or both? The
  answer depends on which one landed, which the caller cannot know from a dropped connection alone
  — exactly the "unknown outcome" case `org-interface-contracts` flags).
- *A new op module* (e.g. `moveElectiveAssignment.js`) — rejected as not smaller: it either
  duplicates `setElectiveAssignment`'s existing eligibility/capacity/confirmed-offering validation
  for the destination, or forces an awkward shared-helper extraction for no benefit over extending
  the existing function, which already means "set this camper's assignment for this run."

**Exact signature:**

```js
/**
 * @returns {{ok:true, assignmentId:string|null, removed?:string}
 *  | {ok:false, error:'RUN_NOT_DRAFT'}
 *  | {ok:false, error:'OCCURRENCE_FULL', capacity:number, filled:number}
 *  | {ok:false, error:'INVALID_CAPACITY', activityId:string, setActivityId:string, message:string}
 *  | {ok:false, error:'CAMPER_INELIGIBLE'}
 *  | {ok:false, error:'ASSIGNMENT_NOT_FOUND'}
 *  | {ok:false, error:string}}
 */
export function setElectiveAssignment(db, {
  runId, camperId, occurrenceId, activityId, locked = false,
  replacesAssignmentId = null,   // NEW
  authorUserId = null, deviceId,
}) { /* ... */ }
```

**Two shapes of call, one signature:**

1. **Move** — `occurrenceId`/`activityId` given, `replacesAssignmentId` given. All of today's
   existing destination validation runs unchanged (`RUN_NOT_DRAFT`, occurrence-exists,
   `CAMPER_INELIGIBLE`, confirmed-offering, capacity). Additionally, before committing: verify
   `replacesAssignmentId` names a row that exists and belongs to `{runId, camperId}`
   (`SELECT run_id, camper_id FROM elective_assignments WHERE id = ?`); a mismatch or missing row
   returns `{ok:false, error:'ASSIGNMENT_NOT_FOUND'}` rather than silently ignoring the parameter.
   On success, **inside the same `runAtomic` transaction** that writes the destination row's
   fields: if `replacesAssignmentId !== assignmentId` (a genuine cross-occurrence move), tombstone
   the source row via `DELETE_FIELD`, exactly as item 2's prune does.
2. **Remove-only** — `occurrenceId: null, activityId: null, replacesAssignmentId` given ("remove
   the placement, no new occurrence"). A guard at the top of the function short-circuits all
   destination validation (there is no destination) and, after the same `ASSIGNMENT_NOT_FOUND`
   ownership check, tombstones `replacesAssignmentId` inside `runAtomic`. Returns
   `{ok:true, assignmentId:null, removed:replacesAssignmentId}`.

**Idempotency.** A move retried identically re-derives the same destination `assignmentId` (a
harmless re-write of identical field values, per-field LWW) and re-issues the same `DELETE_FIELD`
tombstone on the source (idempotent — re-tombstoning an already-deleted row is a no-op, the same
guarantee `deleteElectiveRun.js`'s own doc comment already states: "retrying after a successful
delete is therefore safe"). A remove-only retry is likewise idempotent.

**Concurrent-retry / two-device hazard, named rather than assumed away.** Two devices
independently moving the **same** dangling row to **two different** destination occurrences: the
source tombstone converges cleanly (both write the same idempotent `DELETE_FIELD`), but the two
destination writes have **different derived ids** (different `occurrence_id` components) and both
survive the merge — the camper ends up placed in both new occurrences, with no per-field conflict
to catch it. This is not a new hazard this contract introduces; it is the **same class** of gap
the 09-23 ADR's Red Hat H3 already documented as a residual, accepted risk for ordinary unlocked
moves (`elective_run_outer_snapshots`... no — `getElectiveRunHandler`'s own `overCapacityOccurrences`
detection, which *does* catch this if the destination is capacity-limited; if it is not, the
result is a silent double-booking with no finding, exactly as H3 already accepted for the general
case). Stated here as inherited, not newly introduced, and not fixed by this ADR.

**Why the finding clears mechanically, not by special-casing.** After a move, item 2's durable
query (`source='manual' AND NOT EXISTS (occurrence)`) no longer matches: the old (dangling)
assignment id is gone (tombstoned, so it drops out of the `elective_assignments` scan entirely),
and any new destination row points at an occurrence the write path already validated exists before
writing it. No new logic is needed to make the finding disappear — it falls out of the same query
that made it appear.

### Item 4 — persisted eligibility findings, live resource findings

**New table `elective_run_findings` (v83), eligibility-class only this slice:**

```sql
CREATE TABLE IF NOT EXISTS elective_run_findings (
  id TEXT PRIMARY KEY,          -- deriveElectiveRunFindingId(run_id, solver_generation, kind, camper_id, choice_id, occurrence_id)
  run_id TEXT NOT NULL,
  solver_generation TEXT NOT NULL,
  kind TEXT NOT NULL,           -- 'UNSUPPORTED_LINKED_CHOICE' this slice; see open question below
  camper_id TEXT,
  choice_id TEXT,
  occurrence_id TEXT,
  message TEXT NOT NULL
);
```

**New module `electron/ops/deriveElectiveRunFindingId.js`**, following
`deriveElectiveRunOuterSnapshotId.js`'s exact opaque/length-prefixed-join pattern (not imported
from it, same "separate small module" precedent that file itself set), keyed on
`(run_id, solver_generation, kind, camper_id ?? '', choice_id ?? '', occurrence_id ?? '')` — two
devices computing the identical finding from the identical commit converge on one row (D4
discipline).

**Written at commit time, inside `commitElectiveRun.js`'s existing `runAtomic` transaction**, from
the **same** `buildElectiveAssignments` findings array the function already receives and returns
today — no new derivation, no re-solve. Scoped to an explicit eligibility-kind allowlist exported
from the new id-derivation module's sibling (or the same module):
`ELIGIBILITY_FINDING_KINDS = ['UNSUPPORTED_LINKED_CHOICE']` for this slice (see open question
below on whether other `buildElectiveAssignments` finding kinds — e.g. any `NO_CAPACITY`-class
finding — count as "eligibility" for product purposes; this design does not guess).

**Not pruned on regeneration, unlike occurrences — filtered by generation at read time instead,
and the asymmetry is deliberate, not an oversight.** Item 2's occurrence prune exists because
**non-existence is the signal** dangling detection depends on. A finding row has no such
requirement — nothing hand-edits or "locks" a finding the way a manual assignment can be locked
(there is no H3-style exemption to preserve), so an ordinary `WHERE run_id = ? AND
solver_generation = ?` filter, mirroring the *pre-H3* (pre-manual-exemption) generation predicate
this ADR family used before that exemption was added, is fully sufficient and simpler than adding
a second prune pass. The table grows unboundedly across a run's regenerations within its
lifetime — accepted, matching this project's stated pre-production/no-shim posture, and bounded in
practice by how many times a director regenerates one run before finalizing.

**Resource findings — computed live, not persisted.** New module
`electron/ops/electiveRunResourceConflicts.js` exporting `computeElectiveRunResourceConflicts(db,
run, recordedOccurrences)`, extracting the scoping logic (`mapTemplateSlot`, `cellKeys`,
`scopedSlots`, the `findRouteConflicts` call) that today lives inline in
`finalizeElectiveRun.js` step 2, called by **both** `finalizeElectiveRun.js` (replacing its inline
copy) and `getElectiveRun.js` — same "one fragment" discipline as
`electiveGenerationPredicate.js`/`deriveElectiveRunOuterRows`. `getElectiveRun.js`: if
`run.status !== 'final'`, call it against the run's live `elective_occurrences`; if
`run.status === 'final'`, return `[]` directly with a comment stating why (provably empty by
construction — the finalize gate already refused any run that would have had a conflict) rather
than paying the cost of a call whose answer is already known.

**Stated plainly, per the task's own instruction: the `resource` bucket in a *finalized* run's
export can never be non-empty under this design, by construction, not because nothing was
found.** This is not a gap this ADR leaves silently — it is the correct, provable consequence of
`OUTER_RESOURCE_CONFLICT` being a refusal gate rather than a soft finding. A director who wants to
see a resource conflict must see it on the **draft** run, before finalizing, which this design now
makes possible for the first time (today, nothing calls `findRouteConflicts` for a draft run at
all).

**Export wiring.** `exportRunExceptions.js` gains two new input parameters,
`eligibilityFindings = []` and `resourceConflicts = []`, mapped into the `eligibility`/`resource`
output arrays (shape: `{kind, camper_id, choice_id, occurrence_id, message}` for eligibility, the
existing `findRouteConflicts` finding shape unchanged for resource). **`not_computed` becomes `[]`
always** (kept as a field, not removed — removing it is a larger, unnecessary shape change; `[]`
communicates "both categories are now discharged," which is exactly what the field's own existing
doc comment says it exists to communicate).

**`format_version` — must bump, and the reason is subtle enough to state explicitly rather than
assume Maker will catch it.** `exportElectiveRunProjection.js` (the document that bundles
exceptions per the 09-26 ADR §4, currently `format_version: 2`, confirmed by reading the file)
must bump to **`format_version: 3`**. The JSON **shape** of `eligibility: []`/`resource: []` does
not change — but its **meaning** does: before this change, an empty array meant "not computed";
after, it means "computed, zero findings." A consumer that branched on `not_computed.includes(...)`
before this change and now doesn't check it will silently misinterpret an old cached export
against a new empty result, or vice versa — exactly the silent-semantic-drift `format_version`
exists to flag even when the wire shape is byte-identical. `exportRunSummary.js` has **no
independent `format_version` of its own** (verified — it is one of several builder functions
bundled into the one `exportElectiveRunProjection.js` document per the 09-26 ADR's §4) so there is
only one bump point, not two.

## Schema (v83), full DDL and guard

```sql
-- elective_assignment_runs: two additive columns, item 1.
ALTER TABLE elective_assignment_runs ADD COLUMN snapshot_expected_rows INTEGER;
ALTER TABLE elective_assignment_runs ADD COLUMN snapshot_digest TEXT;

-- new table, item 4.
CREATE TABLE IF NOT EXISTS elective_run_findings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  solver_generation TEXT NOT NULL,
  kind TEXT NOT NULL,
  camper_id TEXT,
  choice_id TEXT,
  occurrence_id TEXT,
  message TEXT NOT NULL
);
```

`schema.sql`'s fresh-install DDL gets both changes directly (the two new columns on
`elective_assignment_runs`'s `CREATE TABLE`, and the new `elective_run_findings` table), so fresh
and migrated installs produce identical `PRAGMA table_info` output, per this schema's own standing
fresh-vs-migrated equivalence convention.

**Migration guard form** (per this repo's standing gotcha, and the exact form named in the
dispatching brief): `getSchemaVersion(db) >= 82 && getSchemaVersion(db) < 83`, never a bare
`< 83`. `CURRENT_SCHEMA_VERSION` (electron/db/localDb.js) bumps `82` → `83`.

**Rollback: `electron/db/rollback/v83_down.js`**, modeled on `v82_down.js`'s exact structure and
disclaimers (registry-membership is not restored by a schema-only rollback; this entity
replicates, so dropping the table is a local un-projection, not a fleet erasure; data-loss stated
as a consequence, not a row count):

```js
export function rollbackV83(db) {
  const discarded = { findings: 0 }
  if (hasTable(db, 'elective_run_findings')) {
    discarded.findings = db.prepare('SELECT COUNT(*) c FROM elective_run_findings').get().c
    db.exec('DROP TABLE elective_run_findings')
  }
  // The two elective_assignment_runs columns are NOT dropped: SQLite's
  // DROP COLUMN requires a recreate-and-copy (v51_down's shape, v80_down's
  // concern), and unlike v82's dedicated table, elective_assignment_runs is
  // a large, heavily-registered, replicated entity — recreating it in a
  // narrow rollback script risks far more than it fixes. The columns are
  // left in place, NULL-valued once schema_migrations drops below 83, which
  // is harmless: no code at schema version < 83 reads them.
  db.prepare('DELETE FROM schema_migrations WHERE version >= 83').run()
  return { ok: true, discarded }
}
```

**Migration posture.** No shim, no backfill, matching the 09-26 ADR's own precedent for this exact
table family: this repo has no live camps on this run type yet. A `final` run finalized before v83
has `snapshot_expected_rows`/`snapshot_digest` both `NULL` — `computeSnapshotCompleteness` treats
that as "unknown, not incomplete" (stated explicitly above), so a pre-v83 final run is never
falsely flagged; it simply gets no benefit from this detection until re-finalized.

## Full registry edit list (item 1 and item 4 combined)

**Item 1 (`elective_assignment_runs`, existing registered entity — column set grows only):**
- `electron/ops/projections.js` — extend the existing `elective_assignment_runs` entry's `fields`
  array with `snapshot_expected_rows`, `snapshot_digest`. No new entry.
- No `campScopedEntities.js`/`undoReferences.js`/`campDocument.js`/`permissions.js` change —
  `elective_assignment_runs` is already registered everywhere those files care about (same
  conclusion, same reasoning, the 09-26 ADR already reached for its own analogous
  `elective_run_outer_snapshots` column additions).

**Item 4 (`elective_run_findings`, new table):**
1. `electron/db/schema.sql` — fresh-install `CREATE TABLE`.
2. `electron/db/localDb.js` — migration block, `CURRENT_SCHEMA_VERSION = 83`.
3. `electron/db/rollback/v83_down.js` — new file, per above.
4. `electron/ops/projections.js` — new entry: `table: 'elective_run_findings'`, `key: 'id'`,
   `fields: ['run_id','solver_generation','kind','camper_id','choice_id','occurrence_id','message']`,
   with a stub-seed `ensureExists`-style apply function mirroring the `elective_run_outer_snapshots`
   entry's shape exactly (`INSERT OR IGNORE` keyed on the identity columns on first-field-arrival).
5. `electron/ops/campScopedEntities.js` — add to `PARENT_SCOPED_ENTITIES`:
   `elective_run_findings: { table: 'elective_run_findings', parentTable: 'elective_assignment_runs', parentKey: 'run_id' }`,
   positioned after `elective_run_outer_snapshots` per the file's existing ordering; add the
   matching U2-deletable-target comment-list line in the same position.
6. `electron/ops/undoReferences.js` — add `{ fromTable: 'elective_run_findings', fromColumn:
   'choice_id', toEntity: 'elective_choices', kind: 'scalar', enforced: false }` (same posture as
   `elective_run_outer_snapshots.choice_id`, v76). **`occurrence_id` — verify against the file
   directly before Maker starts, do not assume**: it is not established from the files read during
   this design pass whether `elective_occurrences` itself is a registered U2-deletable-target
   entity anywhere in this scanner (the existing `elective_run_outer_snapshots` entries reference
   `days_of_operation`/`time_blocks`/`activities`/`locations`/`elective_choices` as targets, never
   `elective_occurrences` — this may mean occurrence ids are structurally exempt from this
   scanner's target-entity set, or it may mean no prior table needed to say so). `camper_id` needs
   no entry — no sibling elective table registers `camper_id` as a soft U2 reference either.
7. `electron/automerge/campDocument.js` — add `elective_run_findings` to both
   `PARENT_SCOPED_ENTITIES` and `GENESIS_ENTITIES`, in alphabetically-sorted position: between
   `elective_preferences` and `elective_run_outer_snapshots` (`'elective_run_findings' <
   'elective_run_outer_snapshots'` lexically, since `f` < `o`).
8. `electron/auth/permissions.js` — add `'elective_run_findings'` to `ENTITIES`, same posture as
   its siblings (access is gated by the existing `elective_assignment_runs.read`/`.write` actions,
   not a per-entity action name — verify this reading against the file directly, per
   `org-source-verification`, before Maker treats it as settled).
9. `electron/ops/mergeActivity.js` — no change: this table has no `activity_id` column
   (unlike `elective_run_outer_snapshots`, which does) — but **verify directly, do not assume**,
   per the 09-26 ADR's own instruction for its structurally identical case.
10. `electron/ops/restore.js` — **not verified during this design pass; read directly before
    Maker starts**, per the 09-26 ADR's own explicit flag for this exact file ("should be read to
    confirm it doesn't hand-enumerate columns").
11. `src/localClient.mock.js` — mirror `elective_run_findings` the same full-replace-by-`run_id`
    way the mock already handles `elective_choices`/`elective_preferences` on commit; degrade
    generation-filtering at read time to "return all" if the mock has no cheap way to filter (same
    "additive-degradation discipline" the file's own header comments already establish elsewhere);
    add `elective_run_findings` clearing to `deleteElectiveRun`'s cascade (mirroring the pattern at
    `localClient.mock.js:2773`).
12. **Schema-scanner test family — run the whole family, not a hand-picked subset** (per this
    project's own standing lesson: "A Chosen Subset Is Not the Gate" — three reviewers and
    Verifier green missed three registry gaps a full scanner run caught): extend
    `electron/ops/projectionsEntityParity.test.js`, `electron/ops/undoReferences.schemaParity.test.js`,
    `electron/auth/permissionsEntityParity.test.js`, and `electron/ops/electivesRegistries.test.js`.

## Interface-contract checklist (per `org-interface-contracts`)

| Contract | Idempotent? | Concurrent-retry safe? | Unknown-outcome handling | Error shape | Scope boundary |
|---|---|---|---|---|---|
| `finalizeElectiveRun` (extended, items 1) | Yes — `snapshot_expected_rows`/`snapshot_digest` are written once, in the same transaction as `status='final'`; `ALREADY_FINAL` still gates a retry | Unchanged from the 09-23 ADR's own analysis; the two new columns add no new race — they are derived from data already committed in the same write | Unchanged | Unchanged (`{ok:false, error}`) | Unchanged (`elective_assignment_runs.write`) |
| `commitElectiveRun` (extended, items 2, 4) | Yes — occurrence pruning is a diff-and-tombstone against deterministic derived ids; a retried commit re-derives the identical prune set and re-issues idempotent `DELETE_FIELD` ops; finding-row writes use deterministic derived ids, so a retry re-writes the same rows | Yes, with the item-2 sync hazards named above (Hazard A/B) as inherited, accepted, pre-existing-class risk, not new | A dropped connection mid-commit is answered the same way the existing whole-transaction discipline already answers it: the transaction either committed fully or not at all (`runAtomic`), so a retry sees either the old or the new state, never a partial prune | Unchanged | Unchanged (`elective_assignment_runs.write`) |
| `setElectiveAssignment` (extended, item 3) | Yes — see "Idempotency" under item 3 above | Yes for a single row's LWW; the cross-destination double-placement case is named and accepted, not silently assumed safe | A dropped connection mid-move: the destination write and the source tombstone are in the same `runAtomic` transaction, so either both landed or neither did — a retry with the same arguments is safe either way (re-derives the same destination id, re-issues the same idempotent tombstone) | New code `ASSIGNMENT_NOT_FOUND` added to the existing `{ok:false, error}` shape; all existing codes unchanged | Unchanged (draft-only, `RUN_NOT_DRAFT` gate preserved) |
| `getElectiveRun` (extended, items 1, 2, 4) | N/A (read) | N/A | N/A | Unchanged (throws on missing/invalid args) | Unchanged (`elective_assignment_runs.read`) |
| `getElectiveRunOuterSchedule` (extended, item 1) | N/A (read) | N/A | N/A | Unchanged | Unchanged |
| Export builders (extended, items 1, 4) | N/A (pure functions) | N/A | N/A | New `{ok:false, error:'SNAPSHOT_INCOMPLETE', ...}` refusal shape, additive to what were previously always-succeeding pure functions — every caller of these builders must now check `.ok` before treating the result as a document | No new IPC — renderer-side pure functions over already-authorized, already-loaded data, same posture the 09-23/09-26 ADRs already established |

**Data crossing a trust boundary:** none of this ADR's changes accept data from outside this app's
own writes. `setElectiveAssignment`'s new `replacesAssignmentId` is validated against this run's
own `elective_assignments` rows already in the projection — the existing "don't re-validate our
own writes" case, not a new trust boundary, per the same reasoning the 09-23 ADR already applied to
this handler's other parameters.

## Reused vs. new

**Reused:** `runAtomic`/`appendOp`/`DELETE_FIELD` (item 2's prune, item 3's tombstone — both follow
`deleteElectiveRun.js`'s exact cascade discipline, not a new mechanism); `findRouteConflicts`
unmodified (item 4's live resource computation — the same call `finalizeElectiveRun.js` already
makes, extracted into a shared module rather than forked); the derived-id discipline (D4) extended,
not reinvented, for `elective_run_findings`' id; the `electiveGenerationPredicate.js`/
`deriveElectiveRunOuterRows` "one shared fragment" pattern, applied to two new fragments
(`electiveRunSnapshotCompleteness.js`, `electiveRunResourceConflicts.js`); the
`{ok:false, error}` refusal shape every prior handler in this feature family already established;
the stub-seed `ensureExists` projection pattern (new `elective_run_findings` entry mirrors
`elective_run_outer_snapshots`'s exactly); `deriveElectiveAssignmentId`'s existing signature
(item 3 adds a parameter to the *handler*, not to the id derivation itself).

**New:** `elective_assignment_runs.snapshot_expected_rows`/`.snapshot_digest` columns;
`elective_run_findings` table; `electron/ops/electiveRunSnapshotCompleteness.js`;
`electron/ops/deriveElectiveRunFindingId.js`; `electron/ops/electiveRunResourceConflicts.js`;
`electron/ops/danglingManualAssignmentFinding.js`; the occurrence-prune step inside
`commitElectiveRun.js`; `setElectiveAssignment`'s `replacesAssignmentId` parameter and
`ASSIGNMENT_NOT_FOUND` refusal code; the `SNAPSHOT_INCOMPLETE` export refusal shape;
`exportRunExceptions.js`'s two new input parameters and populated `eligibility`/`resource`
buckets.

## Tests — add or change, and which is which

**New:**
- `electron/db/electiveRunDurability.migration.test.js` (or folded into a v83-named file) —
  modeled on the 09-26 ADR's own tripwire pattern: `expect(CURRENT_SCHEMA_VERSION).toBe(83)`,
  full column list on a fresh install, fresh-vs-migrated `table_info` equality, rollback
  round-trip via `rollbackV83`.
- A cross-handler fixture test (new file or added to `electiveRunOuterSchedule.integration.test.js`)
  asserting `getElectiveRun` and `getElectiveRunOuterSchedule` report **identical**
  `snapshotIncomplete`/`expectedSnapshotRows`/`heldSnapshotRows` for the same fixture — same
  "MEDIUM-4" cross-handler-parity discipline the 09-23 ADR already mandated for the generation
  predicate.

**Extend, asserting the NEW truth (never loosened):**
- `electron/ops/commitElectiveRun.test.js` — assert occurrence pruning on regenerate; assert
  eligibility findings are persisted to `elective_run_findings`, not only returned in the
  response.
- `electron/db/migrationDomainState.test.js` — add the v83 case.
- `src/screens/elective/run/ElectiveRunViews.test.jsx` — add a case proving
  `DANGLING_MANUAL_ASSIGNMENT` survives a **cold reopen** (render `DraftRunView` from a fetched
  `getElectiveRun` state object, not from local commit-response state, and assert the row still
  renders) — this is the assertion that actually distinguishes "durable" from the existing
  session-scoped test, which must keep passing unmodified alongside it, not be deleted.
- `electron/electiveAcceptance*.integration.test.js` (T251 suite) — extend to cover: a regenerate
  that prunes a stale occurrence and the dangling row surviving a simulated cold reopen; a
  finalize with a simulated partial snapshot sync (insert only some expected rows, or null a field
  to simulate the stub-seed case) asserting `snapshotIncomplete: true` and export refusal;
  eligibility findings surviving a cold reopen; live resource-conflict detection on a draft run
  with a synthetic route conflict.
- `electron/electiveRunFinalizedProjectionParity.integration.test.jsx` (T198 parity) — extend to
  assert the new fields thread identically through `electiveRunProjectionInput.js`, the UI path,
  and the MCP/CLI path (the existing three-surfaces-agree requirement, applied to the new fields).
- `electron/electiveAcceptanceSurfaces.integration.test.jsx` — extend for the machine-access
  surface, same fields.
- `electron/ops/projectionsEntityParity.test.js`, `electron/ops/undoReferences.schemaParity.test.js`,
  `electron/auth/permissionsEntityParity.test.js`, `electron/ops/electivesRegistries.test.js` — all
  four, not a subset, per the registry list above.

## ADR required: yes

Per the constitution's three triggers, all apply: this introduces a new persistent table
(`elective_run_findings`) and two new columns other code will depend on
(`elective_assignment_runs.snapshot_expected_rows`/`.snapshot_digest`); it changes an already-
shipped IPC contract's callable surface (`setElectiveAssignment` gains a parameter and a refusal
code that changes its atomicity guarantees; the export builders gain a refusal branch that changes
their return contract from "always succeeds" to "may refuse"); and it makes a tradeoff that is not
obviously reversible in the direction made (hard refusal, not a carried flag, for an incomplete
final-run export — reversing this later to "carry the flag" would mean re-auditing every export
consumer that came to depend on the refusal never happening silently).

## Open questions for Governor

1. **Does `commitElectiveRun`'s own `findings` response field (the `DANGLING_MANUAL_ASSIGNMENT`
   entries it already returns today) stay as-is, get removed now that `getElectiveRun` is
   durable, or become explicitly redundant-but-kept?** This design does not have full sight of
   `AssignmentPanel.jsx`'s post-commit refresh timing (does it immediately re-call
   `getElectiveRun` after a successful commit, or rely on the commit response alone until the
   director navigates away and back?) to make this call safely. Recommendation, low-medium
   confidence: keep the response field for backward compatibility with any script/CLI consumer,
   but switch `DraftRunView`/`AssignmentPanel`'s **rendering source** to the durable
   `getElectiveRun`-returned `danglingFindings`, with the commit-response value used only as an
   immediate pre-refresh fallback if a refetch has genuine latency.
2. **Which `buildElectiveAssignments` finding kinds count as "eligibility" for `elective_run_
   findings`, beyond `UNSUPPORTED_LINKED_CHOICE`?** This design scopes the allowlist to that one
   kind, matching `exportRunExceptions.js`'s own header comment naming it as the example; a
   `NO_CAPACITY`-class finding might or might not belong in the same bucket depending on product
   intent for what "eligibility" means to a director reading the export. Do not let Maker guess —
   this is the same posture the 09-26 ADR already took for its own analogous open question on the
   camper universe.
3. **`undoReferences.js`'s `elective_run_findings.occurrence_id` entry (registry item 6 above)** —
   genuinely unresolved from this design pass; needs a direct read of `undoReferences.js`'s
   U2-target-entity set before Maker writes that line, not an assumption either way.
4. **A pre-existing, out-of-scope gap noticed while reading `projections.js`**: the
   `elective_run_outer_snapshots` entry's `fields` array (13 entries) does not include
   `choice_label`, even though `finalizeElectiveRun.js` writes a `choice_label` field on every
   snapshot row and the column exists in `schema.sql` (added after the v76 bump, per
   `localDb.js:3440-3441`). If true, a synced `choice_label` write from another device would be
   silently dropped by the projection replay — the same class of defect this whole ADR's item 1
   is designed to catch for *outer-snapshot* rows, but on a column this ADR does not otherwise
   touch. Flagged for a separate, narrowly-scoped fix — out of this ADR's four items, not folded
   in here to keep this bump to exactly what the dispatching brief asked for.

_Implementation state, 2026-09-30: part 1 — snapshot completeness, occurrence pruning, re-place picker, persisted eligibility findings — merged; part 2 — tombstone-aware stub seed, refuse commit onto a final run, camper with neither preference nor assignment visible to cold regenerate — not started. Normalised from `partial (part 1 — snapshot completeness, occurrence pruning, re-place picker, persisted eligibility findings — merged; part 2 — tombstone-aware stub seed, refuse commit onto a final run, camper with neither preference nor assignment visible to cold regenerate — not started)` to `in-progress` for the `WORK_RECORD_STANDARD.md` enum._
