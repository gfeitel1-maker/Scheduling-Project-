# Merge-Path UNIQUE Collisions: Stop Dropping a Peer's Record

Date: 2026-09-23
Status: approved (owner), not yet implemented
task_class: database-sync (migration/rollback plan + mandatory integration gate)
Found by: audit of T205's closure (`docs/work/tickets/T205-days-of-operation-uniqueness-and-dedup-migration.md`, "Scoped OUT, deliberately")
Does NOT re-open: T205 (merged, schema v70, correctly closed)

## The defect

`electron/ops/operations.js`'s `UNIQUE_FIELD_ENTITIES` registry exists so a camp-scoped
UNIQUE collision becomes a typed, director-resolvable conflict instead of a raw
`SQLITE_CONSTRAINT_UNIQUE`. Its `detectUniqueFieldCollision` is invoked from exactly two
places — `electron/sync/localWriteClient.js:102` (this device's own writes) and
`electron/ops/restore.js:262`. It is **never** invoked from the Automerge merge-apply path.

`electron/automerge/projector.js`'s `upsertRow` wraps each row in a SAVEPOINT, so a
colliding row arriving from a peer is caught, skipped, written to `projection_failures`
and logged with `console.error`. The SQLite constraint holds. The peer's record never
materializes, no `conflicts` row is created, and the director gets **no signal that
another device's edit was discarded**.

Reachable trigger, verified: `src/hooks/useCrudScreen.js:57` (the generic add behind every
setup screen) and `src/screens/DaysScreen.jsx:209` (bulk import) both mint
`crypto.randomUUID()`. Two devices, offline, each interactively creating the same-named
record produce two document records that can never converge. Deterministic-id derivation
(`electron/ops/dayId.js`, `locationId.js`, `scheduleTemplateId.js`) covers seed and importer
paths but not interactive creates.

## Two findings that widen the brief

1. **The registry is a partial list of the real constraints.** `UNIQUE(camp_id, name)` also
   exists on `users`, `cohorts`, `groups`, `tiers`, `time_blocks`, `schedule_weeks` and
   `camp_maps(camp_id, kind)` — all document-projected, none registered. The silent-drop
   behaviour covers roughly twice the surface the audit named.

2. **Detecting this in the projector would be non-deterministic across devices.** The
   current conflict machinery (`electron/automerge/reconcile.js` + `conflictStore.js`) is
   *derived from the merged document*, which is exactly what makes "a choice that both need
   to see" free: every device derives the same conflicts from the same bytes. A collision
   caught in `upsertRow` depends on which row happened to reach SQLite first **on that
   device**, so two directors could be shown mirror-image prompts, or one shown nothing.
   Detection therefore belongs in the document layer, not the projection layer.

## The reframe

`UNIQUE(camp_id, name)` is not currently enforcing uniqueness. It is discarding a peer's
data to preserve an invariant a replicated document cannot hold. The projection's job is to
mirror the document faithfully. Uniqueness on a director-typed **name** is a product
preference and belongs in the flag vocabulary; uniqueness on a **structural key** is a real
invariant and stays a constraint.

## Success predicate

1. Two offline devices each create a location named "Gym" (different ids). After they sync,
   **both rows are present in SQLite on both devices**, and `projection_failures` has **zero**
   rows for either.
2. Each of the two rows carries a duplicate flag on the Locations screen, on both devices,
   derived — not stored, not broadcast.
3. The director renames or deletes one using the controls that screen already has. The flag
   clears on both devices with no resolution state replicated.
4. Two offline devices each create a `days_of_operation` row for Tuesday with different ids.
   After they sync, a typed conflict row exists under the `unique:` id namespace on **both**
   devices, carrying both records' values; the collision is never only a `console.error`.
5. `npm run verify` passes, including `npm run test:integration`.

## Non-goals

- Reference-aware merge ("keep this one, repoint every schedule slot at it"). Resolution is
  rename-or-delete with existing controls. A merge verb would need a new per-entity
  inbound-reference registry; spun out if duplicates prove common in practice.
- Extending deterministic-id derivation to interactive creates. It cannot cover
  rename-into-collision after creation, so it is not sufficient alone, and with the relaxed
  half in place it is no longer necessary. Not in this work.
- Any change to T205's v70 migration, its deterministic day ids, or its registry entry.
- New chrome. No banners (standing owner rule). The duplicate surfaces in the existing
  per-row flag vocabulary.

## Design

### A. Relaxed set — nine tables, duplicates allowed and flagged

`locations`, `activities`, `events`, `elective_sets`, `groups`, `cohorts`, `tiers`,
`time_blocks`, `schedule_weeks`.

The unique index becomes a plain index. Both rows project. A duplicate is **derived** from
the now-faithful projection (`GROUP BY camp_id, <field> HAVING COUNT(*) > 1`, name-normalized
consistently with `normalizeName`), exposed through IPC, and rendered as a per-row flag on
the screen that owns the record. Nothing about the duplicate is stored or replicated, so it
clears everywhere the moment the document stops holding two such rows.

### B. Hard set — four constraints kept, collisions made loud

| Constraint | Why it stays |
| --- | --- |
| `users(camp_id, name)` | `electron/auth/localAuth.js:568` resolves a login by `SELECT id, role FROM users WHERE camp_id = ? AND name = ?`. A duplicate would authenticate a director against an arbitrary one of two PIN/role pairs — a security defect, not a UX wrinkle. |
| `days_of_operation(camp_id, day_of_week)` | One row per weekday is a structural invariant the schedule engine and `deriveDayId` both assume. |
| `schedule_templates(camp_id, kind)` | Two routes, one row each. A fork is the bug v22 closed. |
| `camp_maps(camp_id, kind)` | Same shape as above. |

For these, a new **pure document-derived** derivation sits alongside `reconcile()`: it scans
for two records sharing a scoped unique value and emits a typed conflict through
`conflictStore.js` under a new `unique:` id namespace, carrying both records' values so the
director can see what the other device typed. Deterministically ordered and idempotent
across re-derivations — the same properties `reconcile()` already earns, for the same reason.
The `projection_failures` skip remains as the containment backstop it was designed to be; it
is no longer the *only* thing that happens.

### C. Unchanged, deliberately

`detectUniqueFieldCollision` stays exactly where it is on the local write path and in
`restore.js`. With the index relaxed it becomes what it already effectively was there: an
advisory pre-check that stops a director typing a name they already used. Duplicates then
arise only from a genuine merge — precisely the case this work chooses to tolerate rather
than drop.

### D. Name→id maps need a stated tie-break

Three sites build a name-keyed id map where a duplicate makes last-write-wins depend on row
order: `electron/ops/materializeImportedVersion.js:26`, `electron/ops/ingest.js:906`,
`electron/ops/ingest.js:912`. Each gets an explicit deterministic tie-break (lowest id
wins), so the same document produces the same import result on every device. The duplicate
flag is what tells the director to fix the underlying ambiguity.

No site in the relaxed set resolves a record by name with a single-row `.get()` — verified.

## Migration and rollback

**Forward (`v71`)**: drop the nine unique indexes, create plain indexes in their place.
Cannot fail on existing data — dropping a constraint is always satisfiable.

**Rollback (`v71_down`)**: recreates the unique indexes, which **fails if the relaxed period
produced duplicates**. It must refuse and name the offending rows rather than dedup silently.
A rollback that deletes a director's records to fit an index is worse than one that stops.
This asymmetry is inherent to relaxing a constraint and is stated here so it is an accepted
property rather than a discovered surprise.

Per `docs/governance/standards/` the migration guard form is `>= N-1 && < N`, not a bare
`< N`.

## Evidence plan

Fixtures driven through the **real write path**, never hand-inserted rows.

1. **Integration (relaxed)**: two documents, same name, different ids → merge → assert both
   rows in SQLite, duplicate flag derived on both devices, zero `projection_failures` rows.
2. **Integration (hard)**: two `days_of_operation` rows for Tuesday → assert a `unique:`
   conflict row on both devices, and that the loudness guarantee holds rather than a bare log
   line.
3. **Determinism**: the three name→id maps return the same answer regardless of insertion
   order.
4. **Migration**: v71 forward on a db holding duplicates-to-be; v71_down refuses with a
   message naming the blocking rows.
5. **Non-vacuity**: the new duplicate-flag guard gets a test planting a defect it was **not**
   designed for — a duplicate arriving via `bulkReplace` rather than a per-field merge, which
   bypasses the per-field path entirely. A guard's description is part of the guard; a
   non-vacuity test that plants only the expected defect proves nothing.
6. `npm run verify` green, and CI green as the gate of record.

## Open for Architect

- Whether the hard-set derivation is a new module or an extension of `reconcile()`'s return
  shape. It is a different *kind* of disagreement (cross-record, not same-field scalar), and
  `assertNoUnrecordedConflicts` is written around the scalar shape.
- Whether `ConflictsScreen` can render a `unique:` conflict without a new conflict kind in
  its UI, given its `ChoiceBox` is built around "keep this value" rather than "these two
  records collide".
- Exact schema-version number if another in-flight branch claims v71 first.
