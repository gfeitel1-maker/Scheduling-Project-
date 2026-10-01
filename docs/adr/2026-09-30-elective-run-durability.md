---
title: "Elective run durability pass — partial-snapshot detection, dangling-assignment persistence, the move picker's contract, and persisted eligibility/resource findings (v83)"
document_type: adr
status: accepted
approved: 2026-09-30 (owner, via the organizer session: "go for it" — accepted as written; recorded on the board as h-accept-adr-2026-09-30-durability)
authority: normative
implementation_state: implemented
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
change needing its own ADR, not a per-entity patch.

> **CORRECTED 2026-09-30 by Part 2 of this ADR (owner folded the stub-seed fix in here rather than
> into a new ADR — see "Part 2" below).** Two corrections to the paragraph above. First, "this ADR
> does not fix it" no longer holds for the stub-seed class: Part 2 designs the tombstone-aware stub
> seed, in this document. Second, and more importantly, the `deleteElectiveRun.js` claim this
> paragraph leans on — "A DELETED RUN CAN BE RESURRECTED BY A CONCURRENT PEER WRITE" — is **wrong
> about the path it names**, as Part 2's item 1 shows by execution: `projectAll` is already
> two-phase (every upsert, then every delete-reconcile in reverse order,
> `electron/automerge/projector.js:717-718`), so a stub seeded by a child during the upsert phase is
> removed again before the same transaction commits. The resurrection is real, but it lives on the
> **same-device `appendOp` write path**, not the peer-merge path. Hazard A itself — an Automerge
> field-write-versus-`DELETE_FIELD` race on one derived occurrence id — is a genuine per-key LWW
> race in the *document* and is a different thing from the stub-seed class; it remains **accepted**
> as written, and Part 2 does not close it.

**Consequence, stated precisely**: if `O` is
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

_Implementation state, 2026-09-30: part 1 — snapshot completeness, occurrence pruning, re-place picker, persisted eligibility findings — merged (PR #668, schema v83). Part 2 — the tombstone-aware stub seed (extended to `elective_sets`), the refused commit onto a final run, the sheet-named camper in the run's universe, and the folded-in false `FINALIZED_AGAINST_STALE_GENERATION` — merged in one PR with no schema change; the schema stays at v83. The three Part 2 open questions below were not decided and remain open._

**Dated note, 2026-10-01 (board item 9b round 3), under item 4.** `BUNDLE_TIER_NOT_COVERED`
(a `commitElectiveRun.js`-own finding, not an engine `solverFindings` entry) now also persists into
`elective_run_findings`, alongside `UNSUPPORTED_LINKED_CHOICE`. It does **not** go through
`ELIGIBILITY_FINDING_KINDS` — that allowlist gates the engine's `solverFindings` array specifically
(open question 2 above, still otherwise unresolved); `BUNDLE_TIER_NOT_COVERED` comes from
`commitElectiveRun`'s own D6 bundle-scope resolution (`resolveWriteChoiceId`/`noteMismatch`) and is
written by its own parallel loop, same table, same generation-filtered read, same derived-id scheme.
No schema change — the existing five columns are sufficient. `tier_id` is deliberately **not**
persisted: there is no column for it, and `groupBundleTierNotCoveredFindings`
(`src/screens/elective/run/runStateCopy.js`) already had the fallback this relies on for a finding
missing it — re-derive via `makeCamperIdentityResolver` against the CURRENT roster. That is a real
tradeoff, not a free lunch: the live, same-session finding carries the commit-time tier; the
persisted, cold-reopened one re-derives against whatever the roster looks like at read time, so a
roster edit between commit and reopen can name a different division than the one the mismatch was
actually generated against. This note records the decision; it does not reopen or change the ADR's
status or Decision section above.

---

## Part 2 (2026-09-30) — the tombstone-aware stub seed, a refused commit onto a final run, and a true camper universe

**Status of this section.** Part 1 (PR #668, schema v83) shipped items 1-4 above. This section is
the design for the three items the frontmatter names as part 2, written 2026-09-30 after Part 1
merged. **It is an addition to this ADR, not a new one**: the owner ruled (2026-09-30, "go for it")
that the tombstone-aware stub seed — which item 2's Hazard A note above called "a separate
architecture change needing its own ADR" — is folded in here. That ruling also **overrides**
`docs/work/tickets/T320-elective-run-durability.md`'s "Not in scope" line excluding the
tombstone-aware stub seed; the ticket is not edited here (Governor updates it at close-out).

**No schema change. The schema stays at v83.** Every item below is satisfied by existing tables,
existing columns and existing registries. Verified before designing: `CURRENT_SCHEMA_VERSION = 83`
(`electron/db/localDb.js:42`), the newest rollback module is `electron/db/rollback/v83_down.js`, no
worktree declares 84, and the one open PR (#673) is a governance/gate change carrying no schema
version.

### Part 2, item 1 — the stub seed refuses to re-create a parent whose last recorded act was its own deletion

#### What is actually broken, established by execution rather than by reading the comment

`electron/ops/deleteElectiveRun.js`'s header block states the gap as "A DELETED RUN CAN BE
RESURRECTED BY A CONCURRENT PEER WRITE". **That sentence names the wrong path.** Two facts settle
it, both read out of the tree and then confirmed by running the code:

1. **`projectAll` is already two-phase, and the phases are ordered so a stub ghost cannot survive
   one.** `projectAll` (`electron/automerge/projector.js:712-721`) runs *every* entity's upserts in
   forward `MODELED_ORDER`, and only then *every* entity's delete-reconcile in **reverse**
   `MODELED_ORDER`. `elective_assignment_runs` precedes all six of its children in
   `DOMAIN_SNAPSHOT_ORDER` (`electron/ops/campScopedEntities.js:298-305`), so in the reversed
   delete-reconcile pass the parent is reconciled **last** — after any ghost a child's
   `ensureExists` seeded during the upsert phase. `deleteReconcileEntity`
   (`projector.js:553-571`) then deletes it, because its id is absent from `listRecordIds(doc,
   'elective_assignment_runs')`. The delete does not trip `foreign_keys = ON` even with orphan
   children still present, because every child declares `run_id TEXT NOT NULL` with **no**
   `REFERENCES` (`electron/db/schema.sql`, the six `elective_*` child tables) — the soft-reference
   discipline this family already follows.
2. **Every merge projects through that two-phase pass.** `syncNode`'s shared post-merge step calls
   `projectAll(db, merged)` (`electron/sync/automerge/syncNode.js:150`), and its `applyLocal`
   test/adversarial path does the same (`syncNode.js:751`).

Executed against this worktree (a throwaway probe, not committed): seed a doc with `run-1` and a
preference child; fork a peer doc and write a *second* preference child onto `run-1`; delete the run
on the first doc; merge. Result: `elective_assignment_runs` is **empty** after `projectAll` of the
merged doc, and the peer's orphan preference row survives — which is correct convergence, since the
doc holds the child and not the parent.

**The path that really does resurrect is the same-device `appendOp` path.** `appendOp` calls
`applyProjection` directly, and `liveDoc.recordLocalWrite` deliberately runs **no** `projectAll`
(`syncNode.js:783` states why). So on any device whose SQLite no longer has the run — the device
that deleted it, or a peer that merged the delete — a *local* write to one of that run's children
re-creates the parent as a blank-named row and nothing cleans it up until the next merge-triggered
`projectAll`. Executed probe: after a local `__deleted__` op on `run-1`, a subsequent local
`elective_preferences.run_id = 'run-1'` write left
`elective_assignment_runs = [{ id: 'run-1', name: '' }]`.

This matters in practice because the reachable trigger is real: a director on device B has
`DraftRunView` open for a run device A has just deleted, and presses Commit or Regenerate.

#### The decision

**Guard the shared stub seed with an op-log recency predicate, behind one function, with a registry
that says which parents are guarded.** In `electron/ops/projections.js`:

```js
// The last thing the op-log recorded about this record — DELETE_FIELD when the
// record's most recent act was its own deletion. `operations` is indexed on
// (entity, entity_id, field) (idx_operations_entity, schema.sql:355), so this is
// a short indexed prefix scan over the handful of ops one record ever has.
function lastRecordedField(db, entity, id) {
  const row = getStmt(
    db,
    'SELECT field FROM operations WHERE entity = ? AND entity_id = ? ORDER BY seq DESC LIMIT 1'
  ).get(entity, id)
  return row ? row.field : null
}

// Which stub-seeded PARENTS carry the guard. Deliberately a registry and not a
// blanket rule over every ensureExists in this file: the predicate costs one
// indexed read per child field op, and the import loop pays it per row (the
// write-cost lesson T309 closed). Widening it is one line here plus one test line.
const TOMBSTONE_GUARDED_STUB_PARENTS = new Set(['elective_assignment_runs', 'elective_sets'])

// The ONE place a child's ensureExists may conjure its parent. Refuses when the
// parent's most recent recorded act was its own deletion; otherwise seeds.
export function ensureParentStub(db, parentEntity, parentId, seed) {
  if (typeof parentId !== 'string' || parentId.length === 0) return
  if (
    TOMBSTONE_GUARDED_STUB_PARENTS.has(parentEntity) &&
    lastRecordedField(db, parentEntity, parentId) === DELETE_FIELD
  ) {
    return
  }
  seed()
}
```

`DELETE_FIELD` is already declared at module scope in `projections.js` (the local literal at the
bottom of the file, kept separate from `operations.js` to avoid the import cycle its own comment
names). Referencing it from a function declared above that `const` is safe: module evaluation
completes before any `ensureExists` closure is ever called, so the temporal dead zone is never
entered. Maker does **not** need to move the declaration.

`ensureRunStub` becomes a caller of it, and so do the three inline `elective_sets` seeds:

```js
function ensureRunStub(db, runId) {
  ensureParentStub(db, 'elective_assignment_runs', runId, () => {
    const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
    getStmt(
      db,
      "INSERT OR IGNORE INTO elective_assignment_runs (id, camp_id, name) VALUES (?, ?, '')"
    ).run(runId, camp?.id ?? null)
  })
}
```

The three `elective_sets` stub seeds inside `PROJECTIONS.elective_set_activities.ensureExists`
(`projections.js:585`), `PROJECTIONS.elective_bundles.ensureExists` (`projections.js:617`), and the
`elective_bundle_periods`/`elective_bundle_tiers` pair that reach `elective_sets` through their own
parent chain, are extracted into a sibling `ensureSetStub(db, setId)` with the identical shape, so
there is exactly one seed function per guarded parent rather than three copies of one INSERT.

#### Why this predicate, and why not the four alternatives the brief named

- **The `tombstones` table (T233 signed purge tombstones) — rejected, and this is the one to state
  loudest**, because it is the strongest-looking reuse. `TOMBSTONE_DENYLISTED_ENTITIES`
  (`projector.js`) is a *fleet-wide erasure* mechanism: a signed purge tombstone means "this record
  must never be visible on any device again", it is verified against a signing key, and it is
  scoped to camper PII. An ordinary director delete of a run is **not** that. Minting a signed purge
  tombstone for every run delete would put ordinary content into the erasure channel, where it
  cannot be un-said, and would give the erasure vocabulary a second meaning. Rejected on semantics,
  not cost.
- **The document's AUTHOR collection marker** (`campDocument.js:666`,
  `authorKey(entity, id, DELETE_FIELD)`) — rejected. It is cleared on any later write to that record
  (`campDocument.js:716`), which is precisely the situation the guard exists for: the child write
  that races the delete is exactly what erases the evidence. A tombstone that a concurrent write
  deletes is not a tombstone.
- **A projector-supplied liveness signal** (handing `ensureExists` the doc's `listRecordIds` set)
  — rejected as unnecessary, and this is the finding that makes it so. The projector path is the one
  path that is **already correct** (two-phase `projectAll`, proven above). Paying for a signature
  change to `ensureExists` (`(db, id, field, value, knownRow)`) and to `applyProjection`'s op shape,
  to fix a path that is not broken, buys nothing.
- **Restructuring `projectAll` into two phases** — rejected because it is already done. This was the
  brief's "genuinely different shape", and reading `projector.js:712-721` retires it: the
  interleaved-pass premise it was built on is not the code's current shape. Its comment at line
  702-711 states the FK reasoning for why the two phases run in opposite orders.
- **The op-log predicate — chosen.** It works exactly where the defect is (the `appendOp` path),
  the signal is reachable from inside `ensureExists` with no signature change, and on a peer device
  the `__deleted__` row is present too: `appendReceivedOps`
  (`electron/automerge/historyLedger.js:51-140`) writes op rows for changes that arrived by merge,
  and its `DELETE_FIELD` handling is explicit (the `continue` at line 114 is inside the *camp_id
  derivation* loop only, not the insert loop; the insert loop has two dedicated `e.field ===
  DELETE_FIELD` branches).

#### Why "last recorded field is the delete" and not "a delete op exists"

A bare "does a `__deleted__` op exist" predicate strands a legitimate re-creation, and this is not
hypothetical. `deriveImportedElectiveRunId(campId, sourceSha256)`
(`electron/ops/electiveDerivedIds.js:348`) is content-derived: re-importing the identical sheet
after deleting its run derives the **same** run id. Under a bare-existence predicate the stub seed
would refuse forever.

The recency form is self-correcting. It is also belt-and-braces rather than load-bearing for that
case, because the legitimate re-create never goes through the stub at all:
`commitElectiveRun`'s transaction writes the parent row **first**
(`electron/ops/commitElectiveRun.js:516`, inside `runAtomic` at line 504), through
`PROJECTIONS.elective_assignment_runs.ensureExists` (`projections.js:1026`) — a *different* function
from `ensureRunStub`, and deliberately left unguarded. The guard sits only on the child-triggered
seed. By the time any child in that same transaction reaches `ensureRunStub`, the row exists and
the `INSERT OR IGNORE` was a no-op anyway.

#### Why the guard cannot strand a live parent

Both guarded parents are **non-restorable by explicit ruling**:
`elective_assignment_runs: 'refused: a run is regenerated, never restored (ADR D5/D6)...'`
(`electron/ops/restore.js:109`) and
`elective_sets: 'refused: no setup UI yet (T41 slice 1 is data-shape only)...'`
(`restore.js:62`). `restoreEntity` returns `{ error: 'not-restorable' }` before reading any history
(`restore.js:269`). So there is no shipped path that un-deletes either parent in place and then
depends on a child's stub seed to rebuild it.

#### The honest bound — what this does NOT cover

- **A peer with no `devices` row for the sender.** `appendReceivedOps` skips the whole batch when
  `SELECT id FROM devices WHERE libp2p_peer_id = ?` finds nothing (`historyLedger.js:65-86`, which
  states why inventing a row would be worse). On such a device no `__deleted__` row exists, so a
  subsequent *local* child write can still seed a ghost. Bounded: the very next merge-triggered
  `projectAll` removes it, per the two-phase proof above. Named, not fixed.
- **Hazard A above (the occurrence-level LWW race) is untouched.** That is a race between a
  `DELETE_FIELD` and a field write on the same derived id **inside the Automerge document**, and no
  SQLite-side predicate can arbitrate it. It remains accepted, as amended in the note in item 2.
- **Every other stub-seeding parent in `projections.js`** (`schedule_weeks`, `special_days`,
  `events`, `cohorts`, `groups`, …) stays unguarded. Each is either not deletable through a shipped
  UI (see their `RESTORE_DECISIONS` entries, most of which say "no delete UI yet") or has no
  cascade-delete path, so the trigger does not exist for them today. `TOMBSTONE_GUARDED_STUB_PARENTS`
  is the place a future one is added.

#### Registry edits (item 1)

One, and it is new in this diff rather than an existing registry: `TOMBSTONE_GUARDED_STUB_PARENTS`
in `projections.js`. No `PROJECTIONS` entry, no `MODELED_ENTITIES`, no `DOMAIN_SNAPSHOT_ORDER`, no
permissions, no rollback module — no new entity and no new column.

### Part 2, item 2 — `commitElectiveRun` refuses a commit onto a final run

#### The gap

`commitElectiveRun` detects immutability only *after the fact*: T244 round 2 stopped it
**re-asserting** `status`/`name`/`source_filename` on an existing row
(`electron/ops/commitElectiveRun.js:151-215`), but nothing refuses the commit itself.
`DraftRunView.jsx`'s `guardedRegenerate` (`src/screens/elective/run/DraftRunView.jsx:448-483`) says
so in its own comment and mitigates it with a best-effort `listElectiveRuns` status re-read, scoped
to the cold path only.

#### The decision

**Return `{ ok: false, error: 'RUN_IS_FINAL' }` before any write.** Inserted immediately after the
`existingRun` read (`commitElectiveRun.js:213-215`) and before `runAtomic` opens at line 504:

```js
  // T320 part 2 — a finalized run is immutable (ADR 2026-09-23 decision (a):
  // "no reopen IPC exists"). T244 round 2 stopped this function REASSERTING
  // status/name/source_filename onto an existing row; it never refused the
  // commit. DraftRunView's guardedRegenerate carries a best-effort
  // listElectiveRuns status re-read precisely because this refusal did not
  // exist. The re-read stays (it is the courtesy: it stops the solve before the
  // director waits for it); THIS is the guarantee.
  if (existingRun?.status === 'final') return { ok: false, error: 'RUN_IS_FINAL' }
```

#### The refusal vocabulary — a sibling of `describeElectiveRunRefusal`, not a member of it

`describeElectiveRunRefusal(parsed)` is deliberately **db-free**: its whole reason for existing is
that a preview can say "this would be refused, and why" without opening a transaction or a db at all
(`commitElectiveRun.js:47-53`, and `scripts/preferenceSheetCli.js:346` is the caller that depends on
it). `RUN_IS_FINAL` requires a db read of `elective_assignment_runs.status`. Putting it inside
`describeElectiveRunRefusal` would force a db handle into a function whose contract is that it needs
none. **Sibling, not member.**

It also belongs in a different vocabulary. `describeElectiveRunRefusal` returns **prose**, rendered
verbatim, because its refusals name specific rows of the director's own sheet. `RUN_IS_FINAL` is a
**code**, and that is the established shape for this run's lifecycle refusals — `finalizeElectiveRun`
already returns `{ ok: false, error: 'ALREADY_FINAL' }`, and `DraftRunView.jsx` already holds the
code→copy map (`REFUSAL_COPY`, `DraftRunView.jsx:83-93`, with `ALREADY_FINAL`,
`FINALIZED_ELSEWHERE`, `STALE_OUTER_SCHEDULE`, `OUTER_RESOURCE_CONFLICT`). `RUN_IS_FINAL` joins that
map; nothing new is invented.

#### Surfacing it — structured, not prose, at all four doors

| Door | Change |
|---|---|
| `src/screens/elective/run/DraftRunView.jsx` | Add to `REFUSAL_COPY` (line 83-93 block): `RUN_IS_FINAL: "This run was finalized, so it can't be regenerated. Reload it to see the final version."` Leave `guardedRegenerate` exactly as it is — the comment at lines 448-462 is corrected to say the refusal now exists and the re-read is the courtesy, not the guarantee. |
| `src/screens/elective/assignment/AssignmentPanel.jsx` | The commit call at line 933 already does `if (!out.ok) { onError?.(out.error); setPhase('preview'); return }`. `out.error` would be the bare code, which must not reach a director as a code. Map it before handing it up: `onError?.(out.error === 'RUN_IS_FINAL' ? RUN_IS_FINAL_COPY : out.error)`, with `RUN_IS_FINAL_COPY` imported from `DraftRunView.jsx`'s exported `REFUSAL_COPY` rather than a second string (the two must not drift). |
| `scripts/preferenceSheetCli.js` | The commit outcome is returned at the `outcome = commitElectiveRun(...)` site (line 379ff). A machine door must not emit a bare code either: map `RUN_IS_FINAL` to `error: 'run <id> is already finalized and cannot be re-committed'` with `exitCode: 1`, alongside the existing `{...report, ok:false, error, exitCode:1}` shape. |
| `scripts/mcp/tools.js` | No change. `preferenceSheetCommitTool` (line 116) delegates wholly to `runPreferenceSheetCli`, so it inherits the CLI's mapping. State this in the commit message so a reviewer does not read the absent edit as an omission. |
| `src/localClient.mock.js` | **Parity required.** The mock's `commitElectiveRun` (line 1884) already mirrors the two `describeElectiveRunRefusal` refusals and already mirrors `finalizeElectiveRun`'s `ALREADY_FINAL` (line 2107). Add, right after the `existing` lookup at line 1909: `if (existing?.status === 'final') return { ok: false, error: 'RUN_IS_FINAL' }`. Without it, browser-dev lets a regenerate through that `electron:dev` refuses — the exact divergence the T229 parity note at line 1899 exists to prevent. |

#### Concurrency — this refusal is LOCAL, and saying so is part of the design

Two devices, one finalizes, the other commits: the commit device's SQLite may not yet hold
`status = 'final'`, so this guard does not fire and the commit proceeds. **That is not what stops
`final` being reverted.** T244 round 2's field-level guard does: `status` is only ever asserted on a
run's **first** commit (no existing row), so a late-arriving regeneration op carries no
`status = 'draft'` write to lose the race with (`commitElectiveRun.js:151-180` and the comment
block above `existingRun`). `RUN_IS_FINAL` is a **local, best-effort, same-device** refusal that
closes the single-device window the code comments already identified. It is not a distributed
guarantee and must not be described as one.

### Part 2, item 3 — a camper who was on the sheet with neither a preference nor an assignment

#### What is actually persisted today — checked first, per the brief

`commitElectiveRun` already writes a `campers` row for **every** entry in `parsed.campers`,
including one who ranked nothing (`commitElectiveRun.js:554-560`, inside the same transaction). So
the camper is not lost; what is missing is the durable link "this camper was in scope for **this
run**". `getElectiveRun`'s camper query is `WHERE c.id IN (preferences ∪ assignments for this run)`
(`electron/ops/getElectiveRun.js:209-228`) and its own comment names the gap.

`#672` ("no preference row is dropped silently") does **not** close it. That commit fixed one
specific drop — a camper a bundle's scope does not cover now keeps their row against an ordinary
minted choice (`commitElectiveRun.js:628-645`) — which is a camper who *did* rank something. A
camper who ranked nothing still produces no `elective_preferences` row, because the writer loops
`parsed.preferences`, not `parsed.campers`. Nothing in `source_filename`/`source_sha256`, the
ingest ledger, or `elective_run_findings` records the roster today.

#### The decision — reuse `elective_run_findings`, which Part 1 shipped for exactly this shape of fact

**`commitElectiveRun` writes one `elective_run_findings` row, kind
`SHEET_CAMPER_WITHOUT_PREFERENCE`, for every camper in `parsed.campers` that this commit wrote
neither a preference nor an assignment for. `getElectiveRun`'s camper query gains a third UNION arm
reading those rows. No schema change.**

Everything it needs already exists: the table has a nullable `camper_id` column
(`schema.sql`, `elective_run_findings`), it is registered in `PROJECTIONS`
(`projections.js`, the T320 v83 entry) and in `src/localClient.mock.js`'s
`MOCK_WRITE_ALLOWLIST` (line 620), it has a `RESTORE_DECISIONS` ruling already
(`restore.js:119`, refused), it is positioned in `DOMAIN_SNAPSHOT_ORDER`
(`campScopedEntities.js:305`), and `deriveElectiveRunFindingId(runId, generation, kind, camperId,
choiceId, occurrenceId)` already encodes a non-null `camper_id` with a null choice and occurrence
(`electron/ops/deriveElectiveRunFindingId.js`).

Crucially, findings rows are **not pruned across generations** — Part 1's item 4 chose to filter by
generation at read time instead (`commitElectiveRun.js:771-777`, `getElectiveRun.js:247-253`). A
roster wants exactly that: the union over every generation, so a camper first recorded on generation
1 is still in the universe after a regenerate mints generation 2. The roster arm therefore does
**not** filter on `solver_generation`, and that asymmetry is deliberate.

The exact write, placed in the same transaction immediately after the existing
`solverFindings` loop (`commitElectiveRun.js:787-808`):

```js
      // T320 part 2 item 3 — THE RUN'S CAMPER UNIVERSE, MADE TRUE.
      // getElectiveRun derived it as (preferences ∪ assignments), so a camper
      // who was on the sheet and ranked nothing was invisible to a cold
      // regenerate. This is the durable record of "in scope for this run",
      // written where the fact is known — and it is a genuine finding in its own
      // right, not a roster table wearing a disguise: a child appeared on the
      // director's sheet and this run has nothing for them, which is exactly the
      // kind of thing Art. V says we surface rather than absorb.
      // NOT filtered by solver_generation at read time (unlike the eligibility
      // kinds above) — a roster is cumulative across generations by definition.
      const placedOrRanked = new Set([
        ...preferencesWritten,           // camper ids this commit wrote a preference row for
        ...assignments.map((a) => a.camper_id),
      ])
      for (const c of parsed.campers ?? []) {
        if (placedOrRanked.has(c.id)) continue
        const findingId = deriveElectiveRunFindingId(
          runId, solverGeneration, 'SHEET_CAMPER_WITHOUT_PREFERENCE', c.id, null, null
        )
        write('elective_run_findings', findingId, {
          run_id: runId,
          solver_generation: solverGeneration,
          kind: 'SHEET_CAMPER_WITHOUT_PREFERENCE',
          message:
            'This camper was on the sheet but has no ranked choice and no placement on this run. ' +
            'They are still counted when it is regenerated.',
          camper_id: c.id,
          choice_id: null,
          occurrence_id: null,
        })
      }
```

`preferencesWritten` is a `Set` Maker adds alongside the existing `preferencesHeld` array, populated
at the `write('elective_preferences', ...)` call (`commitElectiveRun.js:670-700`) and **also** at the
`heldPreference` `continue` above it — a held row is still a row this run has for that camper, so
it counts. Field ORDER in the `write` call matters and is preserved above:
`run_id`/`solver_generation`/`kind`/`message` are the four columns
`PROJECTIONS.elective_run_findings.ensureExists` waits on before it stub-inserts the row, and a field
written before the stub exists UPDATEs zero rows and is silently lost (the trap Part 1's own comment
at `commitElectiveRun.js:794-798` already names).

`SHEET_CAMPER_WITHOUT_PREFERENCE` is **not** added to `ELIGIBILITY_FINDING_KINDS`
(`deriveElectiveRunFindingId.js`). That allowlist filters findings *passed in* from the solver;
this one is computed by `commitElectiveRun` itself from `parsed`, so it bypasses the allowlist by
construction. Adding it there would be wrong twice over — it is not a solver finding, and it would
change what the export's eligibility bucket means.

#### The read side

`getElectiveRun.js:209-228` — the camper query gains a third arm, and the "KNOWN GAP" comment above
it is replaced (the exact replacement is in the Maker edit list below):

```sql
        WHERE c.id IN (
          SELECT camper_id FROM elective_preferences WHERE run_id = :runId
          UNION
          SELECT camper_id FROM elective_assignments WHERE run_id = :runId
          UNION
          SELECT camper_id FROM elective_run_findings
           WHERE run_id = :runId AND kind = 'SHEET_CAMPER_WITHOUT_PREFERENCE'
             AND camper_id IS NOT NULL
        )
```

`getElectiveRun.js:247-253`'s `eligibilityFindings` read gains
`AND kind != 'SHEET_CAMPER_WITHOUT_PREFERENCE'`, so the eligibility bucket (and through it
`exportRunExceptions.js`) keeps exactly the meaning Part 1 gave it. The roster kind is surfaced
instead as its own returned field, `sheetOnlyCampers` — the camper ids from the arm above — so a
screen can name the count without re-reading.

#### The disclosure text in `DraftRunView.jsx` must become true

`src/screens/elective/run/DraftRunView.jsx:728-738`, the `data-testid="run-cold-regenerate-note"`
block, currently reads:

> Regenerating a reopened run reconsiders every camper who has a preference or a placement on it.

That sentence is what the old derivation could honestly claim. Its exact replacement, which Maker
substitutes verbatim (the surrounding JSX and `styles.actionsHint` are unchanged):

> Regenerating a reopened run reconsiders every camper this run's sheet named — including anyone
> with no ranked choice and no placement.

The `{/* T250 A3 ... */}` comment immediately above it is replaced with a T320-part-2 note saying the
roster is now the sheet's own, sourced from `elective_run_findings`, rather than "not the original
sheet's full roster".

#### The alternatives, and why each is worse

- **(a) A new per-run roster table** — rejected. It is a v84 bump plus the full registry burden the
  brief itemises (`PROJECTIONS`, `MODELED_ENTITIES`, permissions/entity parity, `undoReferences`
  schema parity, the parent-scoped and projector registries, `rollback/v84_down.js`, the
  `>= 83 && < 84` migration guard, `localClient.mock.js`, the schema-scanner test family) — all of
  it to store a `(run_id, camper_id)` pair that an existing, already-registered, already-ruled-on
  table with exactly those two columns can hold.
- **(b) Derive from `campers` filtered by the run's tier/division scope** — rejected on correctness.
  `elective_assignment_runs.tier_id` is only non-null when the run's occurrences span exactly one
  tier (`commitElectiveRun.js:283-285`: `distinctTierIds.size === 1 ? ... : null`), so for a
  multi-tier run the filter degrades to "every camper in the camp". Even when it is populated it
  answers a different question — "who *could* have been on this sheet" — and would pull in campers
  the sheet never mentioned. That is a different wrong answer, not a fix.
- **(c) Something already persisted** — checked, and the honest answer is "the `campers` row, but
  with no run link" (above). Reusing `elective_run_findings` is the smallest way to add exactly the
  missing link.
- **(d) An abstention `elective_preferences` row** (`rank_kind: 'none'`, null choice) — genuinely
  tempting, since those three columns are all nullable in `schema.sql` and it would make the
  existing UNION correct with no read-side change at all. **Rejected on blast radius, established by
  reading rather than assumed.** `deriveElectivePreferenceId`'s `derivedChoiceId(choiceId)` throws on
  a null or empty choice id (`electron/ops/electiveDerivedIds.js`), so it needs a change to a module
  carrying frozen id vectors; and a null-choice preference row flows straight into
  `getElectiveRun`'s `preferences` payload (`getElectiveRun.js:145-160`), from there into
  `AssignmentPanel`'s cold-open hydration (`AssignmentPanel.jsx:1099-1110`, which joins `choice_id`
  to a label) and into the solver's input. Changing what a row in that table *means* is a far larger
  change than adding a row to a findings table that already carries `camper_id`.

#### Two consequences of putting `camper_id` into `elective_run_findings` — both must ship in this change

1. **PII gating.** `TOMBSTONE_DENYLISTED_ENTITIES` (`electron/automerge/projector.js`) gates
   `campers`, `elective_preferences` and `elective_assignments` by `camper_id` against a T233 signed
   purge tombstone. `elective_run_findings` is not in it. Once this design writes a real
   `camper_id` there, a purged camper's id would survive in a table the erasure sweep does not
   touch. **Add** `elective_run_findings: { idField: 'camper_id', tombstoneEntity: 'campers' }`.
   No schema change; it is a registry line plus the two-part sweep `upsertEntity` already performs
   for the other three (`projector.js:427-457`).
2. **The delete cascade.** `deleteElectiveRun.js`'s cascade (its own header lists the seven steps,
   load-bearing order) predates v83 and does **not** delete `elective_run_findings`. Rows already
   orphan today; once they carry `camper_id` they orphan *PII*. **Add** `elective_run_findings` as
   cascade step 1 (before `elective_run_outer_snapshots`; it has no children and nothing references
   it, so the position is unconstrained and first keeps the "widest/leafmost first" reading of the
   list), and update the header's numbered cascade comment to eight steps.

### Interface-contract checklist for Part 2 (per `org-interface-contracts`)

| Contract | Idempotency | Concurrent retries | Unknown outcome | Error shape | Authority boundary |
|---|---|---|---|---|---|
| `ensureParentStub` (new, internal to `projections.js`) | Yes — a pure guard in front of an `INSERT OR IGNORE`; running `projectAll`/`rebuildProjectionFromDocument` repeatedly reaches the same state, and the predicate reads committed `operations` rows only | Yes — the predicate is a read; two concurrent replays both refuse or both seed, and `projectAll`'s delete-reconcile settles either way | N/A — no network, no transaction of its own; it runs inside the caller's | None. A refusal is a **silent skip**, matching every other `ensureExists` early return in this file (`projections.js:1035`, `1048`, `1104`). A thrown error here would abort `projectAll`'s single shared transaction and roll back every other entity's legitimate projection — the exact failure mode `upsertCampsEntity`'s comment (`projector.js:196-200`) was written to avoid | None crossed. No IPC, no new entity, no `authorize()` surface |
| `commitElectiveRun` → `RUN_IS_FINAL` (changed) | Yes — refusal before any write; a retry re-reads the same row and refuses identically | Yes — refusal is read-only and leaves no partial state | A dropped IPC mid-commit is answered as before: `runAtomic` committed fully or not at all, and a retry sees a refusal or the same converged run | `{ ok: false, error: 'RUN_IS_FINAL' }` — the shape `finalizeElectiveRun`'s `ALREADY_FINAL` already established, distinguishable by the caller, mapped to copy at each door | Unchanged: `requireAuthorized(db, { action: 'elective_assignment_runs.write' })` (`electron/main.js:2075`) still runs first |
| `commitElectiveRun` → roster findings (changed) | Yes — `deriveElectiveRunFindingId` is deterministic on `(run, generation, kind, camper)`, so a retried commit re-writes the identical row ids | Yes — two devices computing the identical roster from the identical sheet converge on one row per camper (the D4 discipline Part 1 already relies on) | Same whole-transaction answer as every other write in `runAtomic` | Unchanged (the roster write cannot fail independently of the commit) | Unchanged (`elective_assignment_runs.write`); the new `camper_id` values are gated by the `TOMBSTONE_DENYLISTED_ENTITIES` addition above |
| `getElectiveRun` (changed shape) | Read-only | N/A | N/A | Adds `sheetOnlyCampers` to the returned object; `campers` widens, `eligibilityFindings` narrows by one kind. Additive plus one deliberate narrowing, both mirrored in `localClient.mock.js` | Unchanged |

### Files a Maker touches (Part 2)

| File | Change |
|---|---|
| `electron/ops/projections.js` | `lastRecordedField`, `TOMBSTONE_GUARDED_STUB_PARENTS`, `ensureParentStub`; `ensureRunStub` routed through it; new `ensureSetStub` replacing the three inline `elective_sets` seeds at lines 585 / 617 (and the bundle-period/bundle-tier chain) |
| `electron/automerge/projector.js` | `TOMBSTONE_DENYLISTED_ENTITIES` gains `elective_run_findings` |
| `electron/ops/deleteElectiveRun.js` | Cascade gains `elective_run_findings` as step 1; header comment: eight steps, and the "KNOWN GAP … CONCURRENT PEER WRITE" block rewritten to state what is now true (the gap is the `appendOp` path, it is guarded, and the residual is the unmapped-peer case) |
| `electron/ops/commitElectiveRun.js` | `RUN_IS_FINAL` refusal after `existingRun`; `preferencesWritten` set; the roster-findings loop |
| `electron/ops/getElectiveRun.js` | Third UNION arm; `eligibilityFindings` kind exclusion; `sheetOnlyCampers` returned; the "KNOWN GAP" comment replaced |
| `src/screens/elective/run/DraftRunView.jsx` | `REFUSAL_COPY.RUN_IS_FINAL` (exported); `guardedRegenerate`'s comment corrected; the cold-regenerate note text replaced verbatim |
| `src/screens/elective/assignment/AssignmentPanel.jsx` | Map `RUN_IS_FINAL` to copy before `onError?.` at the commit call (line 933ff) |
| `src/screens/elective/run/runStateCopy.js` | The refusal-copy map itself relocated here from `DraftRunView.jsx` — both `DraftRunView.jsx` and `AssignmentPanel.jsx` import it from this one module, so `RUN_IS_FINAL`'s copy cannot drift between the two doors that surface it |
| `scripts/preferenceSheetCli.js` | Map `RUN_IS_FINAL` to a machine-door sentence with `exitCode: 1` |
| `src/localClient.mock.js` | `commitElectiveRun` returns `RUN_IS_FINAL` on a final run; its `commitElectiveRun` writes the roster findings; `getElectiveRun`'s `campers`/`eligibilityFindings`/`sheetOnlyCampers` mirror the real shapes |

Not touched, and the reason stated so a reviewer does not read it as an omission: `scripts/mcp/tools.js`
(inherits the CLI's mapping), `electron/main.js` (`commitElectiveRunHandler` returns the refusal
object as-is, which its own comment at line 2080 already describes), `electron/preload.js`,
`electron/db/schema.sql`, `electron/db/localDb.js`, and every rollback module.

### Tests — new, changed, and the non-vacuity plants that must go RED first

**New file — `electron/ops/stubSeedTombstoneGuard.test.js`.** The item-1 guard, all four of Red
Hat's named attacks:
1. Local `appendOp` delete of a run, then a local child write → the run row stays absent. **This is
   the regression test; Maker must show it RED against unmodified `projections.js`** — the probe in
   this design already produced `[{ id: 'run-1', name: '' }]` there.
2. `projectAll` of a merged doc where the peer's child write races the delete → no ghost, orphan
   child survives. This one is **green before the change** and must be shown green before *and*
   after: it pins the two-phase self-healing so a future "optimization" of `projectAll` cannot
   silently remove it.
3. Idempotent replay: `projectAll` twice, then `rebuildFromDoc(db, doc)` → identical rows each time,
   guard included.
4. Legitimate re-create: delete a run, then `commitElectiveRun` with the **same derived** run id
   (`deriveImportedElectiveRunId` on identical bytes) → the run exists with its real name, not
   blank, and its children resolve. **Non-vacuity plant: change the predicate to bare existence**
   (`... AND field = '__deleted__' LIMIT 1`, dropping the `ORDER BY seq DESC`) and this test must go
   RED. If it stays green, the test is not exercising the recency rule.
5. Same pair for `elective_sets` via `elective_set_activities`, so the shared helper is proven at
   both guarded parents rather than only at the one the ticket names.

**New file — `electron/ops/commitElectiveRunFinalRefusal.test.js`** (or a new `describe` in
`electron/ops/commitElectiveRun.test.js`, Maker's choice — the existing file is already large):
`status = 'final'` → `{ ok: false, error: 'RUN_IS_FINAL' }`, **and no row changed**. Assert the
latter by capturing `SELECT max(seq) FROM operations` before and after and asserting equality —
asserting only the return value would pass against an implementation that refuses *after* writing.
**Non-vacuity plant: move the guard to after `runAtomic` opens** and the seq assertion must go RED.

**New file — `electron/ops/electiveRunCamperUniverse.test.js`.** A `parsed` with three campers, one
of whom appears in `parsed.campers` and in neither `parsed.preferences` nor `assignments`:
`getElectiveRun(...).campers` contains all three, and `sheetOnlyCampers` contains exactly the third.
**Maker must show this RED before the change** (it returns two campers today). Plus: regenerate the
run (new `solver_generation`) and assert the third camper is **still** present — the plant here is
**add `AND solver_generation = ?` to the roster UNION arm**, which must turn that assertion RED.
Plus: `eligibilityFindings` does **not** contain the roster kind.

**Changed — `electron/ops/restore.test.js`.** Its `RESTORE_DECISIONS` exhaustiveness assertion
(line 99ff) needs no change (no new entity), but confirm it still passes; if the schema-scanner
family flags `elective_run_findings`'s new denylist entry, that is the parity guard working.

**Changed — the projector's tombstone tests** (`electron/automerge/tombstoneProjection.test.js`):
add `elective_run_findings` to whatever enumerates the denylisted entities, and assert a purged
camper's finding row is deleted from the projection on the next pass — the same assertion the other
three entities already carry. **Non-vacuity: revert the `TOMBSTONE_DENYLISTED_ENTITIES` line** and
it must go RED.

**Changed — `test/governance.test.js`** mock/client parity, if and only if it flags the mock's new
`RUN_IS_FINAL` branch or the widened `getElectiveRun` return shape. Run it; do not pre-emptively
edit it.

**Changed — `electron/electiveRunDirectorFlow.integration.test.js`.** There is no
`deleteElectiveRun.test.js`; this integration file is the only test that exercises
`deleteElectiveRun`, so the cascade case belongs there: commit a run that produces at least one
`elective_run_findings` row (the roster kind above guarantees one for any sheet with a
no-preference camper), delete the run, assert `SELECT count(*) FROM elective_run_findings WHERE
run_id = ?` is 0. **Plant: remove the cascade line** and it must go RED.

### Part 2 open questions for Governor

1. **Should `SHEET_CAMPER_WITHOUT_PREFERENCE` be visible to the director as a finding, or only as a
   widened roster?** This design surfaces it as `sheetOnlyCampers` and keeps it out of the
   eligibility bucket, so today it changes only the roster and the cold-regenerate sentence. Whether
   `DraftRunView` should *also* list those campers by name ("3 campers on this sheet ranked nothing")
   is a product call, not a technical one.
2. **Does the run's export need the same widened universe?** `exportRunExceptions.js` reads the
   eligibility bucket, which this design deliberately leaves unchanged. If a director expects the
   export to name sheet-only campers, that is a second, separate slice.
3. **`elective_run_outer_snapshots` carries `camper_id` and is likewise absent from
   `TOMBSTONE_DENYLISTED_ENTITIES`** — a pre-existing PII-erasure gap this design noticed while
   adding `elective_run_findings`, not one it introduces. Out of scope here; flagged for its own
   ticket rather than folded in.

### Part 2, folded in: the false FINALIZED_AGAINST_STALE_GENERATION since v76

Board item `i-final-run-always-reads-out-of-date-since-v76`. Observed live 2026-09-30: a camp with
234 `elective_run_outer_snapshots` rows carrying `solver_generation = NULL` and 78 rows matching the
run's current generation — `getElectiveRunHandler` reported `finalizedAgainstStaleGeneration: true`
for that run immediately, on the same device that had just finalized it, with no concurrent write
from anywhere.

**Cause.** `computeFinalizedAgainstStaleGeneration` (`electron/ops/
finalizedAgainstStaleGeneration.js`) predates v76 (T197, `docs/adr/2026-09-26-elective-run-outer-
inheritance-and-linked-choice-export.md`): it reads every distinct `solver_generation` in a run's
snapshot rows and flags staleness if any value differs from the run's current one. v76 added
`cell_kind: 'inherited'` rows (a camper's group's non-elective `template_slots`, which have no
solver generation of their own) and deliberately wrote them with `solver_generation: NULL`
(`electiveRunOuterSchedule.js`'s inherited branch). A final run with any inherited cell therefore
always has a `NULL` sitting next to its real generation in the snapshot set, which the pre-v76
comparison reads as a mismatch, unconditionally.

**Fix.** Restrict the comparison to `cell_kind = 'elective'` rows: `AND cell_kind = 'elective'` on
the `SELECT DISTINCT`. An inherited row carries no generation by design and is not evidence of
anything.

**Why not also filter `solver_generation IS NOT NULL`.** No *elective* row is ever produced with a
NULL generation — one found here is a real mismatch, and silently excluding NULLs would discard that
signal rather than narrow the fix. Excluding exactly the by-design-NULL class (`cell_kind =
'inherited'`) is the narrowest change that removes the false positive without blinding the check to
a genuine one.

**Boundary against `SNAPSHOT_INCOMPLETE`.** `electron/ops/electiveRunSnapshotCompleteness.js`
already excludes `solver_generation` from its own completeness digest, for the mirror-image reason:
a generation mismatch is this module's finding, and folding it into the completeness digest would
make an ordinary already-detected staleness also register as "incomplete." The two findings keep two
different remedies — revise the run vs. wait for sync — and this fix does not change that boundary.

Test-first in `electron/ops/finalizedAgainstStaleGeneration.test.js` (new file): the live defect
(inherited NULLs + matching electives → false), a genuinely stale elective row (→ true), a mixed
case, final-run-only-inherited (→ false), draft (→ false), zero snapshot rows (→ false), and an
elective row with NULL generation against a non-null run generation (→ true, documenting the
deliberate non-filter). Plant check: dropping the `cell_kind = 'elective'` clause reproduces the live
defect's RED.

## Amendment (2026-10-01): digest map keys

**Defect.** `computeExpectedSnapshotDigestByCamper` keyed its per-camper map on raw
`camper_id`. That map is serialized into `elective_assignment_runs.snapshot_digest`, a
replicated TEXT field written once at finalize time. `elective_assignment_runs` is correctly
absent from both `TOMBSTONE_DENYLISTED_ENTITIES` and `purgeCamperRecord`'s delete set — it is
the run row, not camper data — and `seedAllFromSqlite` carries the field forward into a
freshly-regenerated post-purge document. A purged camper's id therefore survived in cleartext,
fleet-wide, indefinitely. The hash *values* were never the problem; the map *keys* were.

**Fix.** Each key is now `sha256(run_id + ':' + camper_id)`, hex. Scoping by `run_id` is
deliberate, not decorative: hashing `camper_id` alone would let the same hash recur in every
run that camper touches, making the hash itself a correlation handle across runs even without
recovering the underlying id. The hash is unkeyed — no HMAC, no secret, for the reason the next
paragraph gives. `computeExpectedSnapshotDigestByCamper` gained a
second parameter, `runId`, since the rows it is built from do not themselves carry `run_id`;
`finalizeElectiveRun.js` passes its already-in-scope `runId` at the call site.

**What this buys, and what it does not — the part an earlier draft of this amendment got wrong.**
That draft justified the unkeyed hash by asserting `camper_id` is a `randomUUID()` with 122 bits of
entropy. That premise is false, and the review round that caught it is the reason this paragraph
exists. On the elective-sheet import path, `deriveCamperId` (`electron/ops/electiveDerivedIds.js`)
returns a length-prefixed concatenation — its own comment says "NOT a hash" — whose `name` mode
embeds the canonicalized display name, and `commitElectiveRun.js` writes that string as
`campers.id`. Camper ids on that path are name-derived and low-entropy.

The unkeyed hash is nonetheless the right shape, because the weakness an HMAC would address is not
present and the one that is cannot be addressed at all here. Every device must recompute this key
from a `camper_id` it holds — that is what lets the read side look up held rows and subtract
tombstoned campers — so any derivation a device can perform, a camp peer can perform too. An HMAC's
key would have to be replicated to stay recomputable, which makes it equally readable; and no fleet
secret survives a genesis rebuild in this architecture regardless. A **confirmation oracle** is
therefore structural, not a property of sha256: a peer who guesses a purged camper's display name
can rederive the id, hash it, and confirm that camper was in this run. Because there is no
re-finalize path, the erased camper's key is never scrubbed from a stored map, so that oracle
persists for the life of the run row.

State the guarantee accordingly: this change removes a purged camper's id — and, on the import
path, their **name** — from cleartext in a replicated field that any peer could simply read, and
recovery now requires already knowing or guessing the name. It is not the unconditional "invisible
forever" that the tombstone gives the record itself. Closing the oracle would require making every
camper-creation path mint a high-entropy id, which is a camper-id format change well outside this
amendment, and is recorded here as a known limit rather than silently implied away.

**Read side — three branches, not two.** `computeSnapshotCompleteness` now distinguishes three
digest shapes rather than two:
1. Legacy plain-hex (`LEGACY_DIGEST_RE`) — unchanged, whole-set comparison.
2. A per-camper map whose keys are **not** all 64-lowercase-hex (`/^[0-9a-f]{64}$/`) — this is
   the raw-camper-id shape written in the dev-only window between PR #684 and this fix (no live
   users ever saw it). It is treated **exactly like legacy plain-hex**: whole-set comparison,
   never erasure-aware. There is no migration path for it and none is needed.
3. A per-camper map whose keys **are** all 64-lowercase-hex — the current, hashed-key shape.
   Erasure-aware comparison: each held row's `camper_id` and each tombstoned camper's id are
   hashed the same way (`run_id + ':' + camper_id`) before being looked up or subtracted.

The discriminator is checked once all map values already parse successfully
(`parsePerCamperDigestMap`); it only chooses between branches 2 and 3. An empty map (`{}`, a run
with zero snapshot rows) satisfies "all keys match" vacuously and falls into branch 3 — this is
deliberate, not an oversight of the regex: with zero entries, branches 2 and 3 behave
identically (nothing to compare, and any unexpectedly-held camper is still caught by the
existing "held camper not in expectation" check), so there is nothing to special-case.

**No migration, no schema change.** `snapshot_digest` is already TEXT and was already JSON; only
the key-derivation function and the read-side discriminator changed, both inside
`electiveRunSnapshotCompleteness.js`.

**What a future reader will most likely get wrong:** assuming `computeExpectedSnapshotDigestByCamper(rows)` is still a single-argument function, or that any 64-hex-char map key is interchangeable with the whole-digest `LEGACY_DIGEST_RE` check above it — they test different things (one tests the *entire* `snapshot_digest` string; the other tests *each key inside* a parsed JSON object) and must not be merged into one regex check.
