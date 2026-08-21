---
title: "Elective cell: atomic content-kind + mutual exclusion — design"
document_type: spec
status: draft
created: 2026-08-20
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs:
  - docs/adr/2026-08-20-electives-authoring.md
  - docs/adr/2026-08-12-drag-live-write-serialization.md
related_tickets: [docs/work/tickets/T111-elective-cell-atomic-content-and-mutual-exclusion.md]
archive_when: T111 ships and this is folded into PLATFORM_STATE, or superseded by a ratified ADR
---

# Elective cell: atomic content-kind + mutual exclusion — design

**Revision note (round 2, post-Red-Hat 3/5):** the core `applyProjection` eviction mechanism was
verified sound (transaction scope, seq-ordering, dedup-by-id) but the scope boundary was drawn one write
path short. This revision: (1) extends the invariant's coverage to `bulkReplace`, the second write path
that never goes through `applyProjection`; (2) resolves the span head/tail orphaning question explicitly;
(3) documents `full_sync` as considered-and-verified-safe; (4) adds a derived, dismissible UI flag per
Governor's revised UX call (no longer silent); (5) strengthens the test spec with a span-tail race test,
a `DELETE_FIELD` interaction test, and the N-device induction argument. Nothing in the round-1 mechanism
is discarded — this is additive coverage, not a redesign.

## Problem (restated with the real code in view)

`template_slots.activity_id` and `template_slots.elective_set_id` are registered as two independent
fields in the `template_slots` projection (`electron/ops/projections.js:638-674`, `fields` array
includes both). `applyProjection` (`electron/ops/projections.js:696-740`) applies each field op with an
unconditional `UPDATE ... SET {field} = ? WHERE id = ?` — there is no cross-field awareness at apply
time. Today's comment at `projections.js:652-655` says the two "are mutually exclusive, enforced by the
(UI-driven) write path in a later slice, not here" — **this ticket is that later slice.**

Conflict detection (`conflicts` table, `resolveConflict`) is keyed per-`(entity, entity_id, field)`, so
`activity_id` and `elective_set_id` are two separately-arbitrated last-write-wins values on the same row.
A UI mutation that "sets one, clears the other" emits two ops. Because op-log replay is seq-ordered
(arrival order, not gesture-recency order — established by `2026-08-12-drag-live-write-serialization`),
two devices' paired writes can interleave such that both fields converge non-null, with neither column
having a uniqueness constraint to catch it and no conflict ever recorded.

## Deterministic evidence gathered

### Candidate (i) blast radius — typed `content_ref`

Grepped every non-test file touching `template_slots.activity_id` or `elective_set_id`:

```
30 files reference .activity_id (repo-wide, includes non-slot usages e.g. anchors/activities catalog)
10 files reference elective_set_id
```

Narrowed to files that specifically read/write `template_slots` rows (engine, screen state, hooks,
components, repository, IPC ops, sync, export) — **24 distinct files, ~65 occurrences**:

- `src/engine/buildSchedule.js`, `src/engine/weekCatalog.js`
- `src/screens/ScheduleScreen.jsx`, `src/screens/schedule/{useSlotMutations,useScheduleData,useSnapshots,useGeneration,useClipboardSelection,dragHandlers,gridGeometry,findingHighlight}.js`
- `src/components/schedule/{ManualBuildView,ScheduleGroupView,ScheduleDayView,ScheduleActivityView,ActivityPalette}.jsx`
- `src/data/scheduleRepository.js`, `src/localClient.mock.js`
- `src/utils/{exportSchedule,computeOverlaps,computeWeekClosures}.js`, `src/screens/snapshotMatchesSchedule.js`
- `electron/ops/{projections,duplicateWeek,undoReferences,deleteRecord,operations,campScopedEntities,deleteElectiveSet}.js`
- `electron/sync/syncClient.js`, `electron/db/rollback/v35_down.js`

Every one of these would need to change from reading a plain FK column to parsing/branching on a typed
string (`activity:<id>` | `elective:<id>` | `null`). Two specific costs beyond raw count:

1. **`src/engine/buildSchedule.js` is bound by T69 ("engine purity" — merged 39320b1, zero
   `JSON.parse`, no string-encoded domain values inside the engine).** A typed `content_ref` string
   would either violate that constraint directly, or require a decode step at the engine's input
   boundary (`buildSchedule({ slots, ... })`) — which itself needs to be threaded through
   `weekCatalog.js` and every caller that assembles the `slots` array passed in. Not fatal, but it is a
   second migration inside the one migration, and it re-opens a settled ADR-class decision (T69) as a
   side effect of an unrelated ticket.
2. **The read-migration is a genuine ripple, not a mechanical rename.** Call sites don't uniformly do
   `slot.activity_id` — some do truthiness checks (`!s.is_anchor && s.activity_id`), some do equality
   joins (`s.activity_id === act.id`), some do SQL-level filtering (`WHERE activity_id = ?` in
   `scheduleRepository.js`/`projections.js` bulk paths), some serialize for export. A typed field
   changes the *shape* of all four patterns, not just the field name — this is why "count of files" is
   necessary but not sufficient evidence; it is a genuine multi-week refactor risk for a ticket whose
   actual defect is narrow.

### Candidate (ii) — is the per-cell write queue cross-device?

`docs/adr/2026-08-12-drag-live-write-serialization.md` states this explicitly and unambiguously about
`cellQueueRef`: **"A new per-hook-instance `cellQueueRef` (in-memory only, never persisted, never
synced)."** It is owned by `useSlotMutations`, a React hook instance — one per open renderer window, on
one device. It orders writes *issued by this tab* before they leave for `repo.writeSlotFields`. It has
no visibility into, and cannot order, writes issued by a **different device's** `useSlotMutations`
instance.

**Finding, stated plainly: the per-cell write queue does not, and structurally cannot, prevent the
cross-device interleave T111 is about.** It solves same-tab/same-device gesture ordering (its own
stated problem, the T91/DnD race). It is orthogonal to this ticket's race, not a partial solution to it.
Treating it as "half the fix" for D4 would be a category error — two different races, two different
mechanisms, and conflating them is exactly the kind of trap this design pass exists to catch.

This is decisive: **the "(ii) = write queue + apply-time invariant" framing in the ADR/ticket is really
two independent ideas bundled together, only one of which (the apply-time invariant) actually touches
the cross-device case.** The write queue is irrelevant to D4 and should not be built or extended for
this ticket.

### Does an apply-time invariant close the race by construction?

Worked the interleave by hand against `applyProjection`. A paired write (A sets `activity_id=X` +
clears `elective_set_id`) becomes two ops with, in general, non-adjacent arrival seqs relative to a
racing device B's paired write (B sets `elective_set_id=Y` + clears `activity_id`). There exists an
arrival order — op-log delivery order is not guaranteed to preserve a single write's field-pair
adjacency across two concurrently-writing devices — in which the two "setting" ops (A's `activity_id=X`,
B's `elective_set_id=Y`) each land at a higher seq than the *other device's* clearing op for that same
field, e.g.: `A.elective_set_id=null` (seq1) → `B.activity_id=null` (seq2) → `B.elective_set_id=Y`
(seq3) → `A.activity_id=X` (seq4). Per-field last-write-wins: `activity_id` final = seq4 = X;
`elective_set_id` final = seq3 = Y. **Both non-null** — this is the exact race, confirmed reachable by
construction, not merely asserted.

Because op-log replay is seq-ordered identically on every replica (this codebase's own invariant,
restated in the 2026-08-12 ADR: "Op replay is seq-ordered, so the write-site order is the replica
order"), a check made **at apply time**, using only the row's current state and the incoming op, is
deterministic across devices: every replica applies the same ops in the same order and therefore reaches
the same corrected state, with no coordination needed between devices. This is what makes an apply-time
invariant sufficient — it does not need to know about "the other device's queue" at all; it only needs
to look at the row it is about to write, which is exactly what `applyProjection` already has in scope.

## Recommendation: modified (ii) — apply-time invariant only, no write-queue reuse. Confidence: high.

Reject candidate (i) (typed `content_ref`) for this ticket: its ~24-file/~65-occurrence blast radius is
disproportionate to the defect (a two-field race, not a modeling error — `activity_id` and
`elective_set_id` really are two different kinds of thing with different FK targets, and keeping them as
separate columns is not itself wrong), and it collides with the T69 engine-purity constraint in a way
that would force a second, unrelated migration. This is the smallest-responsible-solution call per
`karpathy-guidelines`: two columns are not a code smell here; the *race* is the defect, and the race can
be closed without touching either column's shape.

Reject the write-queue half of candidate (ii) as literally worded: it is a same-device mechanism applied
to a cross-device problem — confirmed above as ADR text, not inference — and building it here would be
effort spent on a mechanism that cannot close the race it's assigned to.

**Adopt an apply-time row invariant in `applyProjection`, and nowhere else.** No schema change, no
migration, no reader-side changes to any of the 24 files above — they all continue reading
`slot.activity_id` / `slot.elective_set_id` exactly as today; the invariant guarantees that at most one
is ever non-null by the time any reader observes the row.

## The invariant

Add a `MUTUALLY_EXCLUSIVE_FIELDS` map colocated with `PROJECTIONS` in `electron/ops/projections.js`:

```js
// Cells whose "kind" must be exclusive across two independently-conflict-tracked
// columns on the same row. See T111 / 2026-08-20-electives-authoring.md D4.
const MUTUALLY_EXCLUSIVE_FIELDS = {
  template_slots: {
    activity_id: 'elective_set_id',
    elective_set_id: 'activity_id',
  },
}
```

In `applyProjection`, immediately after the existing `UPDATE ... SET {op.field} = ?` (the line at
`projections.js:735-738`), and only when `op.value` is non-null:

```js
const exclusivePair = MUTUALLY_EXCLUSIVE_FIELDS[op.entity]?.[op.field]
if (exclusivePair && op.value != null) {
  getStmt(
    db,
    `UPDATE ${projection.table} SET ${exclusivePair} = NULL WHERE ${projection.key} = ? AND ${exclusivePair} IS NOT NULL`
  ).run(op.entity_id)
}
```

Properties:

- **Same-transaction, same-function scope.** No new IPC surface, no new op type, no new sync message
  shape. `applyProjection` already runs inside the caller's transaction (both the local-write path in
  `operations.js` and the remote-replay path in `syncClient.js` call it under one), so the corrective
  clear is atomic with the triggering write from the perspective of any concurrent reader on that
  device.
- **Deterministic across devices without coordination.** Every device replays the identical op
  sequence in the identical order (existing, load-bearing invariant of this codebase). Applying this
  rule at apply time therefore produces the identical final row on every device — it needs no knowledge
  of "who else is writing," only the current row and the op being applied, both of which are already in
  scope.
- **Silent, not synced.** The corrective clear is a **local side effect of replay**, not a new op
  appended to the log. It must not be re-appended as an op (that would create an infinite/duplicate-op
  loop across devices replaying each other's corrections) — it is purely a derived-state repair applied
  identically wherever the triggering op is replayed, exactly the same way a `CHECK` constraint would be
  enforced identically on every replica of a traditionally-replicated database.
- **Closes the race by construction, not by timing.** Re-run the worked example above with the
  invariant active: seq1 `A.elective_set_id=null` → apply, also clears nothing (value is null, guard
  doesn't fire). seq2 `B.activity_id=null` → same. seq3 `B.elective_set_id=Y` → apply, value non-null,
  clears `activity_id` on that row **right now** (at seq3, not deferred). seq4 `A.activity_id=X` →
  apply, value non-null, clears `elective_set_id` **right now** — overwriting B's seq3 value. Final
  state: `activity_id=X`, `elective_set_id=null`. Never both non-null, regardless of arrival order,
  because every non-null write to one column immediately and unconditionally evicts the other at the
  moment it lands, not at some reconciliation pass that could itself race.
- **No conflict-table involvement needed.** This is not a "genuine conflict requiring director
  resolution" in the `conflicts`/`resolveConflict` sense (two people disagreeing about what a cell
  should contain) — it is a structural invariant (a cell has exactly one kind of content), and the
  existing "last writer wins" semantics already answer "which kind wins" correctly once the invariant
  guarantees only one survives. Whichever write actually lands last (by seq) determines the cell's
  final kind — indistinguishable in outcome from what two devices editing the same cell already expect
  under LWW today for a single field.

## Coverage gap closed: `bulkReplace` never calls `applyProjection`

**Red Hat HIGH, confirmed.** `template_slots` has two independent write paths, not one:

1. Per-field ops through `appendOp`/`applyRemoteOp` → `applyProjection` (`electron/ops/projections.js`)
   — the path the round-1 invariant covers.
2. **Whole-scope replace** through `bulkReplace` (`localClient.bulkReplace` → IPC → `appendBulkReplaceOp`
   on the writing device, `applyBulkReplaceProjection` on every replaying device —
   `electron/ops/operations.js:390-459`). `scheduleRepository.js`'s generated-schedule save
   (`saveGeneratedSchedule`, `scheduleRepository.js:234`) and snapshot restore
   (`restoreSnapshotRows`, `scheduleRepository.js:240`) both go through this path. **Neither function
   calls `applyProjection` or consults `PROJECTIONS`/`MUTUALLY_EXCLUSIVE_FIELDS` at all** — confirmed by
   reading both functions: `appendBulkReplaceOp` does `DELETE FROM template_slots WHERE template_id = ?`
   then re-`INSERT`s the caller-supplied `rows` array verbatim inside its own transaction;
   `applyBulkReplaceProjection` (the replay side, called from `applyRemoteOp` for a `bulk_replace` op)
   does the identical delete+reinsert from `JSON.parse(op.value)`, also verbatim, also with no exclusive-
   field awareness.

This is not a *new* cross-device race of the same shape as the per-field one (a `bulk_replace` op is a
single atomic op with one seq — there is no "two ops interleaving" scenario within one bulk_replace call,
and two concurrent bulk_replace calls to the same scope are already arbitrated by
`detectBulkReplaceConflict`/`based_on_seq`, unrelated to this ticket). The actual exposure is narrower but
real: **`bulkReplace` is a bypass of the invariant, not a second instance of the race.** If the `rows`
array handed to `bulkReplace` already contains a both-non-null row — e.g. a snapshot taken before this
fix shipped and later restored, or any future bug in the row-construction code on either the generation
or snapshot path — it gets written and replicated as-is, with nothing to catch it. The round-1 design's
"no reader migration needed" claim is still true; what was missing is that the *write-side* guard has two
entry points, not one.

**Fix: extract a pure, exported sanitizer and call it at both `bulkReplace` insert sites, in addition to
`applyProjection`.**

```js
// electron/ops/projections.js — exported alongside MUTUALLY_EXCLUSIVE_FIELDS
export function sanitizeMutuallyExclusiveRow(entity, row) {
  const pairs = MUTUALLY_EXCLUSIVE_FIELDS[entity]
  if (!pairs) return row
  for (const [field, partner] of Object.entries(pairs)) {
    if (row[field] != null && row[partner] != null) {
      // Deterministic, order-independent tie-break: a fixed field-name
      // precedence (activity_id survives over elective_set_id) applied
      // identically on every device replaying the same bulk_replace op.value
      // JSON — no seq/ordering information exists within a single row object,
      // so determinism must come from the function being pure and total, not
      // from timing.
      return { ...row, [partner]: null }
    }
  }
  return row
}
```

`operations.js` already sits downstream of `projections.js` in the dependency graph (the existing
`DELETE_FIELD` comment in `projections.js` notes "operations.js already imports PROJECTIONS/
applyProjection from this file" — so `operations.js → projections.js` is an established edge; importing
one more named export introduces no new cycle).

Call sites — sanitize the whole `rows` array ONCE, up front, then use the sanitized array for **both** the
serialized op-log payload and the SQL insert. (Red Hat re-challenge, 2026-08-20: sanitizing only inside the
insert loop leaves the `operations.value` JSON — persisted to this device's op-log and broadcast to every
peer — carrying the raw both-non-null row; the row materializes clean on replay, but the stored/broadcast
payload is not the "already-clean" artifact this design and its test 3(a) require.)

- `appendBulkReplaceOp`: sanitize **before** `const value = JSON.stringify(rows)` (currently `operations.js:398`, before the loop at 408):
  ```js
  const sanitizedRows = rows.map(row => sanitizeMutuallyExclusiveRow(entity, row))
  const value = JSON.stringify(sanitizedRows)   // payload is clean, not raw
  // ...
  for (const row of sanitizedRows) { insert.run(/* read from row */) }
  ```
- `applyBulkReplaceProjection` (`operations.js:454-456`): sanitize each row before the insert in its
  `for (const row of rows)` loop (replay side re-parses `op.value` and re-sanitizes defensively regardless).
- `sanitizeMutuallyExclusiveRow` is a **no-op for any entity not in `MUTUALLY_EXCLUSIVE_FIELDS`** (e.g.
  `template_overlays`, also a bulk-replace entity): `const pairs = MUTUALLY_EXCLUSIVE_FIELDS[entity]; if (!pairs) return row`.

Because the sanitizer is a pure function applied identically to the same `rows` data on the writing
device (before the row is serialized into `op.value`) and on every replaying device (after
`JSON.parse(op.value)`, from the *same* serialized bytes), all replicas sanitize the identical input to
the identical output — no new coordination needed, matching the round-1 mechanism's determinism argument.
Applying it on the writing side too (not just replay) means a bad row is caught and corrected before it
is ever serialized into the op-log at all, which is strictly better than catching it only on replay.

## Coverage decision: span head/tail orphaning across an elective conversion

**Red Hat MEDIUM-HIGH, confirmed reachable in principle, resolved by scoping to the authoring path
(option b), not by cascading the apply-time invariant (option a).**

The round-1 eviction is deliberately row-scoped (`WHERE id = ?`, i.e. the single `template_slots` row
the incoming op targets). A multi-block activity's span **tail** rows are *separate* `template_slots`
rows (`is_span_head: false`, their own `activity_id` copy — `collectSpanTails`,
`src/screens/schedule/useSlotMutations.js:17-27`). If a head row is converted to an elective by a bare
single-field op that only targets the head's own row id, the head's `activity_id` is correctly evicted,
but the tail rows are untouched: they still carry the original `activity_id`, still have
`is_span_head: false`, and — per the engine's span-tail collision check (commit `8357447`, "engine
span-tail check must skip elective cells too") — still count toward that activity's session-credit/
location-capacity/activity-cap bookkeeping at their coordinates, with no head to make sense of them.

**Electives are single-block only** (no `span_blocks` concept anywhere in the electives ADR/design spec —
an elective offering is placed in one cell). So this scenario is specifically: *an existing multi-block
activity's span head cell is being converted into an elective*, not an elective itself spanning blocks.

**Decision: (b) — require T105 (elective authoring / the actual write path) to release the span before
converting its head to an elective, via the same multi-cell mechanism the codebase already uses for this
exact situation, and treat cross-device residual risk as inherited, not new.**

Reasoning: `replaceSlot` (`useSlotMutations.js:237-`) **already solves this precise problem** for the
already-shipped case of replacing a span head with a *different activity* — it calls `collectSpanTails`
to find the head's tail rows and clears them as part of one atomic multi-cell claim (the per-cell write
queue's multi-cell atomicity, `2026-08-12-drag-live-write-serialization`), so a span head is never
replaced without its tails being cleared in the same operation. Converting a span head to an elective is
the same class of write (replace this cell's content, and by doing so vacate whatever it was spanning) —
T105 should route it through the identical `replaceSlot`-shaped multi-cell write (claim head + tails
atomically, clear tails' `activity_id`/`is_span_head` alongside setting the head's `elective_set_id`),
not a lone single-field write to the head. This is authoring-path work, out of T111's scope (T111 is the
data-layer invariant; T105 owns the UI write path), but the requirement is concrete enough to hand off:
**T105 must not offer "convert to elective" as a write that only touches the head row when the head is a
span head with tails present** — either it releases the span (clearing tails) in the same atomic write,
or it must not allow the conversion until the director explicitly collapses the span first.

Rejected: (a) teaching the apply-time invariant to cascade-clear tail rows. This would require
`MUTUALLY_EXCLUSIVE_FIELDS` — deliberately a generic, entity-scoped, single-row primitive — to also
understand span/tail *topology* (which rows are whose tails, derived from `is_span_head` +
same-activity-id + block-adjacency, i.e. `collectSpanTails`'s own logic) inside `applyProjection`, which
today has no concept of spans at all. That's a materially larger, cross-row, domain-aware mechanism
bolted onto what is otherwise a two-line generic guard — disproportionate for a scenario the authoring
path can and, by existing precedent (`replaceSlot`), already knows how to prevent correctly at the point
of write.

**Residual, documented rather than closed:** if T105's multi-cell head+tails write itself races a
*second* device's concurrent edit to one of the tail cells specifically (not the head), the outcome is
governed by the same per-cell LWW and the same multi-cell-atomicity guarantees the 2026-08-12 ADR already
accepts as its own residual scope for any multi-cell operation — this is not a new hazard T111 introduces,
it is the pre-existing, already-accepted residual of the write-serialization design, inherited unchanged.
No new mechanism is owed for it here.

## Considered and verified safe: `full_sync`

`applyFullSync` (`electron/sync/syncClient.js`, ~lines 415-480) — the bulk device-join/catch-up path —
does **not** call `applyProjection` per-op; it materializes `template_slots` rows in bulk from the Host's
already-applied state. Verified safe by construction, not by inspection alone: the rows `full_sync`
transmits are read from the **Host's own database**, which has already had every op (including any
`bulk_replace`) pass through `applyProjection`/the sanitized `bulkReplace` paths above before being
persisted there. A joining/catching-up device receiving `full_sync` is receiving already-invariant-clean
rows — there is no code path by which `full_sync` could transmit a both-non-null row that the Host's own
data didn't already contain, and the Host's own data is guaranteed clean by the two write paths this
design covers. No change needed to `full_sync`; named here so the write-path coverage claim
("MUTUALLY_EXCLUSIVE_FIELDS covers every way this row's content can change") is not silently missing an
inventoried path.

## UX: corrective eviction is surfaced, not silent (Governor override of round-1 §Open Questions #1)

Round 1 proposed staying silent, matching plain LWW semantics for an ordinary single-field race. Governor
overrode this: **a vanishing elective set (an entire authoring mode) is categorically bigger than a
single-field flip**, and this app's standing ethos is to surface every write consequence
(`feedback_surface_every_write_failure` — every mutation path must surface write failures/consequences,
not swallow them). The corrective eviction is exactly this kind of consequence: a director's concurrent
edit was silently overridden by another device's, and staying quiet about it would mean a director
discovers "their" elective offering is gone only by noticing the cell looks different, with no
explanation.

**Design: a derived, dismissible, render-time-only marker, following the existing OVERLAP/UNFILLABLE flag
vocabulary but computed the way `useFlagChangeAck` already computes its own render-time diff — not a new
persisted op, and not a new DB column.**

Neither existing pattern is a perfect fit alone: `OVERLAP` is derived-and-never-dismissible (recomputed
fresh every render from current data with no memory of past state); `UNFILLABLE` is dismissible but via a
*persisted* `UNFILLABLE_dismissed` write. Governor's ask ("derived... render-time... not persisted") rules
out a persisted dismiss flag, so this needs a **local, ephemeral** dismiss — closer in mechanism to
`useFlagChangeAck`'s existing technique (`src/screens/schedule/useFlagChangeAck.js`) of diffing a cell's
observed state across renders using a `useRef` map, entirely client-side, never written to the DB.

**Mechanism — a new small hook, `useContentRaceFlag(slots)`, sibling to `useFlagChangeAck`:**

- Tracks, per cell key (`group_id|day_id|time_block_id`), the **content kind** (`'activity:<id>'` |
  `'elective:<id>'` | `'empty'`, derived read-only from `activity_id`/`elective_set_id` — this is a local
  derived label, not the rejected typed-`content_ref` storage change; nothing is written) this device most
  recently set via its *own* local write (recorded at the same point `useSlotMutations` already tracks
  optimistic state for undo, i.e. immediately after a local `replaceSlot`/inline-create call that touches
  `elective_set_id` or `activity_id`, before server ack).
- On every incoming `slots` update (sync push or reload), diffs the row's current kind against this
  device's last-known-own-write kind for that cell, **only for cells this device itself wrote to within a
  short local window** (e.g. the same `MAX_SINGLE_EDIT_CELLS`-scoped recency window `useFlagChangeAck`
  already uses to distinguish "one edit" from "a reload"). If they differ and the current row's content
  matches neither what this device set nor a plain "someone dismissed/cleared it" — i.e. the local write
  was overridden by a different kind, not simply superseded by an equally-local retry — mark the cell.
- Marked cells render a small dismissible badge/banner reusing `FLAG_SEVERITY`/`FLAG_COLORS`
  (`SlotCell.jsx`) under a new severity key, e.g. `CONTENT_RACE`, with copy such as "This cell's content
  was replaced by a concurrent edit on another device." Dismissal is a **local-only** `Set` of
  acknowledged cell keys held in the hook's own state (component-scoped, matching `useFlagChangeAck`'s own
  `useState`), cleared on route switch/unmount exactly like `useFlagChangeAck`'s map — never written to
  `slots.flags`, never synced, never persisted. Reopening the app or switching routes naturally clears the
  marker (a fresh render has no "own last write" memory to diff against), which is the correct behavior
  for a transient, session-scoped notice, not a claim of permanent record.
- This hook is genuinely new (T111 doesn't yet exist in the tree in any form), but its mechanism is not:
  it reuses `useFlagChangeAck`'s render-time-diff-against-a-ref technique, `SlotCell`'s existing
  flag-rendering vocabulary, and adds no schema, no op, no IPC surface — a UI-layer addition only.

**Scope note:** this hook is a UI concern that belongs to the T105 authoring-path ticket to wire into
`ScheduleScreen.jsx` alongside the actual authoring interactions it depends on (optimistic-write tracking
already lives in `useSlotMutations`); T111 (this ticket, the data-layer invariant) is the reason the
*guarantee* the flag reports on ("at most one kind ever persists") is dependable in the first place. Noting
the design here per Governor's instruction to "design it into the doc" — the hand-off boundary to T105 is
the same boundary the electives-authoring ADR already draws between D4 (this ticket) and the authoring UI.

## Required multi-device interleave test

This is the test a naive single-device-sequencing test would miss, because on a single device the UI
write path already clears the other field synchronously in the same client call — the race is invisible
until two independent writers interleave at the op-log/replay layer.

**Location:** `electron/ops/projections.test.js` (extending the existing `applyProjection`/`PROJECTIONS`
suite — no Electron, no real sync transport, direct calls against a test `better-sqlite3` instance,
matching this file's existing test style).

**Shape — replay-order interleave, not call-order:**

```js
test('template_slots: interleaved cross-device ops never leave both activity_id and elective_set_id non-null', () => {
  const db = /* test db with a template_slots row seeded, both fields null */
  const slotId = seedSlot(db)

  // Simulate device A's paired write (set activity, clear elective) and
  // device B's paired write (set elective, clear activity) arriving
  // op-log-interleaved — NOT in either device's own submission order.
  // This is the arrival order that produces both-non-null under plain
  // per-field LWW (see design doc worked example).
  const interleavedOps = [
    { entity: 'template_slots', entity_id: slotId, field: 'elective_set_id', value: null },   // A's clear, seq1
    { entity: 'template_slots', entity_id: slotId, field: 'activity_id', value: null },       // B's clear, seq2
    { entity: 'template_slots', entity_id: slotId, field: 'elective_set_id', value: 'set-1' },// B's set, seq3
    { entity: 'template_slots', entity_id: slotId, field: 'activity_id', value: 'act-1' },    // A's set, seq4
  ]

  for (const op of interleavedOps) applyProjection(db, op)

  const row = db.prepare('SELECT activity_id, elective_set_id FROM template_slots WHERE id = ?').get(slotId)
  const bothNonNull = row.activity_id != null && row.elective_set_id != null
  expect(bothNonNull).toBe(false)
  // The higher-seq setter (A's activity_id=act-1, applied last) determines
  // the surviving kind — this is the assertion that would fail under plain
  // per-field LWW with no invariant, and is the one a single-device-only
  // test (which never reorders ops relative to their own device's
  // submission order) cannot exercise.
  expect(row.activity_id).toBe('act-1')
  expect(row.elective_set_id).toBeNull()
})
```

A second permutation test (swap which device's setter lands last) should assert the mirror outcome
(`elective_set_id` survives, `activity_id` null), to prove the invariant is symmetric and not
accidentally order-dependent in the wrong direction. A third test should confirm the **same-device,
already-correct** case (sequential, non-interleaved ops from one write) is unaffected — a no-op change
in the common path, matching the "smallest responsible" bar.

### Induction argument: the 4-op/2-device proof generalizes to N devices

The worked example uses 2 devices/4 ops for concreteness, but the closure argument does not depend on
device count. State the invariant as: **after applying any op in seq order, at most one of
`{activity_id, elective_set_id}` is non-null on that row.**

- **Base case.** Before any op, both columns are `NULL` (a freshly-created row via `ensureExists`, which
  only ever inserts `id`/`template_id` — see `projections.js:670-673`) — the invariant holds trivially.
- **Inductive step.** Assume the invariant holds after applying ops `1..k`. Op `k+1` is applied by exactly
  one device (whichever device originally authored it — irrelevant to the transition), and is one of two
  shapes:
  - `op.value == null` (a "clear" write): the eviction guard's `op.value != null` condition does not
    fire; the row loses a non-null field (or stays as-is), never gains one — invariant preserved
    trivially.
  - `op.value != null` (a "set" write) on field `F`: the eviction guard fires **unconditionally on this
    transition alone** — it clears `F`'s exclusive partner in the same step, regardless of what device
    authored `F`'s op, what device (if any) authored the partner's current value, or how many other
    devices have written to this row so far. After this step, `F` is non-null and its partner is `NULL`
    — invariant holds for ops `1..k+1`.
- **Conclusion.** The transition rule at each step is a **pure function of (current row state, next op)**
  — it never references *which* device authored the op or *how many* devices are writing. Induction over
  the seq-ordered sequence therefore holds for a sequence produced by 2 devices, 20 devices, or a single
  device replaying its own paired writes out of order (e.g. a delayed retry) — the argument never uses
  device count as a variable. This is *why* 2 devices/4 ops is a sufficient concrete test: it exercises the
  one nontrivial transition shape (a "set" op) twice in the adversarial order; a 3rd, 4th, ... Nth device's
  ops would each individually reduce to the same two transition shapes already covered.

### Additional required tests (Red Hat round 2)

1. **Span-head-with-tails interleave (bulkReplace + apply-time invariant boundary).** Seed a span: head
   row (`is_span_head: true`, `activity_id: 'act-1'`) plus one tail row (`is_span_head: false,
   activity_id: 'act-1'`) at the adjacent block. Simulate a `bulkReplace` payload (as `saveGeneratedSchedule`
   or `restoreSnapshotRows` would submit) that converts the head to an elective (`elective_set_id: 'set-1',
   activity_id: null`) but — reproducing exactly the gap this design closes — leaves the tail row
   unmodified in the submitted `rows` array (`activity_id: 'act-1'` still present, no `elective_set_id`).
   Assert: (a) `sanitizeMutuallyExclusiveRow` leaves the head row correctly single-kind (it already was,
   in this payload) — this test is *not* about the head, it documents that **the sanitizer is row-scoped
   and does not and cannot fix a stale tail row's relationship to a converted head** — asserting that after
   `applyBulkReplaceProjection`, the tail row still independently satisfies the per-row invariant
   (`activity_id` xor `elective_set_id`, trivially true since it never had both) while explicitly asserting
   it is now an **orphaned tail** (`is_span_head: false`, `activity_id` set, but no head row at the
   preceding block owns that `activity_id` as a span head any longer) — proving in code that T111's
   invariant is row-local by design and does NOT silently paper over the orphaning scenario; it is a
   regression guard on the documented scope boundary, not a fix for it (the fix is T105's authoring-path
   requirement, out of this ticket's code).
2. **`DELETE_FIELD` sentinel interaction.** (a) Apply a `DELETE_FIELD` op to a `template_slots` row that
   currently has `elective_set_id` set — assert the row is deleted (existing behavior, `projections.js:700-703`,
   which `return`s before reaching the `fields.includes` check and therefore before the eviction guard;
   this test proves the guard is never reached on a delete, not merely assumed). (b) Immediately
   re-create the same `id` via a fresh op that triggers `ensureExists` (a `template_id` write) followed by
   an `activity_id` set — assert the eviction guard does not spuriously fire against stale pre-delete state
   (the freshly-inserted row has `elective_set_id: NULL` by column default, so the guard's `IS NOT NULL`
   condition is false and no eviction UPDATE runs) — proving delete-then-recreate cannot leave a dangling
   corrective side effect from the row's previous life.
3. **`bulkReplace` sanitizer tests** (new, `electron/ops/operations.test.js`, extending the existing
   `appendBulkReplaceOp`/`applyBulkReplaceProjection` suite): a `rows` payload containing one row with both
   `activity_id` and `elective_set_id` non-null is sanitized to `activity_id`-only (a) when submitted via
   `appendBulkReplaceOp` (the authoring device — assert the row as inserted into `template_slots` AND the
   `operations.value` JSON that gets persisted/broadcast are both already sanitized, so a bad row is never
   even serialized into the log) and (b) when replayed via `applyBulkReplaceProjection` from a raw
   `op.value` JSON string that itself contains a both-non-null row (simulating a pre-fix snapshot's stored
   JSON) — assert the replaying device's `template_slots` row ends up single-kind despite the malformed
   input JSON, proving the replay-side sanitizer is a real backstop, not merely relying on every writer
   being patched.

## Files/modules affected

- **Modify:** `electron/ops/projections.js` — add `MUTUALLY_EXCLUSIVE_FIELDS`, the eviction step in
  `applyProjection`, and the exported `sanitizeMutuallyExclusiveRow` helper; update the stale comment at
  `projections.js:652-655` ("enforced... in a later slice, not here") to point at this mechanism.
- **Modify:** `electron/ops/operations.js` — import `sanitizeMutuallyExclusiveRow` from `projections.js`
  (established dependency direction, no new cycle); call it inside the row-insert loops of
  `appendBulkReplaceOp` (~line 408) and `applyBulkReplaceProjection` (~line 454).
- **Test:** `electron/ops/projections.test.js` — the multi-device interleave test (3 cases: A-last,
  B-last, non-interleaved no-op), the `DELETE_FIELD` interaction tests (2 cases), the span-head-with-tails
  orphaning regression guard (documents, does not fix, the T105 hand-off boundary).
- **Test:** `electron/ops/operations.test.js` — the `bulkReplace` sanitizer tests (write-side and
  replay-side).
- **Considered, verified safe, no change:** `electron/sync/syncClient.js`'s `applyFullSync` (~lines
  415-480) — transmits already-invariant-clean Host rows, cannot introduce a both-non-null row on its own;
  see "Considered and verified safe: full_sync" above.
- **New (UI layer, owned by T105, designed here per Governor's instruction):** `useContentRaceFlag` hook
  (sibling to `src/screens/schedule/useFlagChangeAck.js`), a `CONTENT_RACE` severity in `SlotCell.jsx`'s
  existing `FLAG_SEVERITY`/`FLAG_COLORS` vocabulary. Not implemented by T111; T111 is what makes the
  guarantee this flag reports on ("at most one kind ever persists") true.
- **No changes** to `src/engine/buildSchedule.js`, `scheduleRepository.js`'s row-construction logic, any
  other screen/hook/component file, or any migration file. No schema change, no v36 addition beyond what
  T110 (the separate `is_reusable` marker ticket) already carries.

## Reused vs. new

- **Reused:** the existing `applyProjection` transaction scope, the existing seq-ordered replay
  guarantee (already load-bearing per the 2026-08-12 ADR), the existing `PROJECTIONS` registration
  pattern (`MUTUALLY_EXCLUSIVE_FIELDS` follows the same colocated-config style already used for `fields`
  and `ensureExists`), the established `operations.js → projections.js` import direction, the existing
  `replaceSlot`/`collectSpanTails` multi-cell-atomic-write pattern (handed to T105 rather than
  re-implemented), and `useFlagChangeAck`'s render-time-diff-against-a-ref technique (the basis for the
  new UI flag's mechanism, not its persistence).
- **Not reused:** the per-cell write queue (`cellQueueRef`) — confirmed above to be architecturally
  incapable of addressing this ticket's race; extending or invoking it here would be a wasted mechanism,
  not a partial fix.
- **New:** `MUTUALLY_EXCLUSIVE_FIELDS` map, its eviction branch in `applyProjection`, and the exported
  `sanitizeMutuallyExclusiveRow` helper reused across both `template_slots` write paths — a small,
  generic primitive (keyed by entity, not hardcoded to `template_slots`) that any future genuinely-
  exclusive field pair on any entity can reuse without new design work. `useContentRaceFlag` (UI, T105's
  to build).

## ADR required: no

This changes replay *behavior* (an evicting side effect during `applyProjection`) but not any stored
schema, wire/IPC shape, or externally-observable contract other modules rely on — every existing reader
of `template_slots.activity_id`/`elective_set_id` continues to see plain nullable FK columns with the
same meaning they have today; the only change is that a previously-possible-but-unintended state (both
non-null) becomes unreachable. This is a bug fix at the replay seam, not an architectural decision with
a hard-to-reverse tradeoff — it does not meet the ADR bar in `docs/adr/2026-08-20-electives-authoring.md`
D4's own framing (D4 deferred the *choice* between (i)/(ii) to this design pass; it did not require a
second ADR for whichever is chosen, and this resolution introduces no new persistent shape). The D4
decision record in the ADR already documents the two candidates and their tradeoff; this design doc is
the resolution artifact per the ticket's own instruction ("Architect design pass (ADR-level note)").

### Candidate approaches considered

- **(i) Typed `content_ref` field** — assumption: collapsing to one field removes the race by
  construction and conflict machinery already serializes single fields. Rejected for this ticket:
  ~24-file/~65-occurrence blast radius confirmed by grep, plus a direct collision with the T69
  engine-purity constraint (`buildSchedule.js` must stay free of encoded-string parsing) — disproportionate
  cost for a race that can be closed without any reader change.
- **(ii) as literally worded (write queue + apply-time invariant)** — assumption: the existing per-cell
  write queue contributes to closing the cross-device case. Rejected as worded: the queue is
  per-hook-instance/in-memory/never-synced (ADR's own words), so it has zero effect on the cross-device
  interleave this ticket is about; treating it as part of the fix would be a documentation-vs-reality
  trap.
- ★ **(ii) modified — apply-time invariant only, in `applyProjection`.** Non-obvious-but-viable pick:
  smallest possible surface (one function, no schema change, no reader migration), and proven
  deterministic-and-sufficient by hand-tracing the exact interleave against the actual seq-ordered
  replay guarantee this codebase already depends on elsewhere. This is the recommendation.
- **Trap avoided:** treating "(ii)" as a single bundled mechanism (queue + invariant) rather than
  interrogating whether both halves actually contribute — the queue half is a distraction inherited from
  the ADR's own shorthand, not a real candidate once traced against `2026-08-12-drag-live-write-serialization`'s
  explicit per-device scoping.

## Open questions for Governor

1. **T105 hand-off is now load-bearing, not optional.** The span head/tail decision (option b) makes
   T105's authoring path responsible for releasing a span before/while converting its head to an
   elective, via the existing `replaceSlot`/`collectSpanTails` multi-cell pattern. This should be an
   explicit, named requirement in T105's brief, not something Maker rediscovers — flagging so Governor
   carries it forward rather than it silently depending on this doc being re-read later.
2. **Scope of `MUTUALLY_EXCLUSIVE_FIELDS`.** This design registers only `template_slots.{activity_id,
   elective_set_id}`. If other current or planned dual-content-kind fields exist or are anticipated
   (none found in this pass), they'd reuse the same map — no action needed now, noting only that the
   primitive generalizes if asked for later.
3. **`CONTENT_RACE` flag copy/exact placement is a Designer-level UI decision**, not fully specified here
   — this design fixes the *mechanism* (derived, render-time, locally-dismissible, no persistence) per
   Governor's instruction, but exact wording, badge styling, and where in `SlotCell.jsx`'s render it
   appears relative to `OVERLAP`/`UNFILLABLE` should go through the normal Designer pass when T105 builds
   it, not be treated as locked by this data-layer design doc.
