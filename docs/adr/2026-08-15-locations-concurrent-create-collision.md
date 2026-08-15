---
title: "ADR: Concurrent-create collisions on locations.UNIQUE(camp_id, name) — reject at write time, not swallow or silent-merge"
document_type: adr
status: accepted
authority: normative
implementation_state: implemented
date: 2026-08-15
deciders: [product-owner]
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs: [docs/work/specs/2026-08-15-m3-locations-design.md]
related_adrs: [docs/adr/2026-08-15-camp-locations-entity.md]
supersedes: []
affects: []
---

# ADR: Concurrent-create collisions on `locations.UNIQUE(camp_id, name)`

**Status: ACCEPTED — implemented.** D1–D5 landed in the original round; the addendum below (Findings
A–F) landed in the consolidated remediation round. Confirmed by Red Hat during Locations M3b work.
This ADR fixes the op-log/sync-layer defect; item 7 of the remediation round additionally added a
minimal offline-rejection notice in the renderer, by owner decision (see the addendum's Open Question 3).
T12 (below, in the remediation ticket list) closed a follow-up MEDIUM gap Red Hat's re-review found in
Finding A: the crash fix shipped correctly, but the director-facing refusal message stayed misleading
until T12 threaded `field`/`existing` all the way to `TrashScreen`.

## Context

`locations` has `UNIQUE(camp_id, name)`, case-sensitive, exact-match
(`electron/db/schema.sql:592`, added by `docs/adr/2026-08-15-camp-locations-entity.md`). A location
"create" in the UI is a sequence of field-level ops on a fresh row id — `camp_id`, then `name`, then
`capacity`/`notes`/`sort_order` — via `setupCrudRepository.createRecord`
(`src/data/setupCrudRepository.js:39-50`), which already exists for the M3a Locations setup screen
and will be reused by any future create entry point (a M3b picker inline-create, a future CSV import —
neither is built yet; only M3a has shipped, per the current git history and
`docs/work/specs/2026-08-15-m3-locations-design.md:74-75` which places CSV import at M4).

Two devices concurrently creating a location with the same exact name mint **different uuids** for the
same **name**. This is not a data-quality question (that's M3c's near-duplicate merge, for *different*
spellings a human must judge) — it is a **write-time uniqueness collision**, structurally the same
class of problem as "username already taken." The existing machinery has two independent, silent
failure surfaces for it.

## Confirmed failure model — two distinct, independently-broken paths

### Path 1 — broadcast/replay swallow (`syncClient.js applyRemoteOp`)

A peer receives, via live push or catch-up replay, a `locations`/`name` op whose value collides with a
row that peer's local DB already has under a **different** `entity_id`.

1. `applyRemoteOp` durably inserts the op into `operations` in its own transaction
   (`electron/sync/syncClient.js:408-421`) — this insert is deliberately independent of projection
   outcome, "so the server already accepted and broadcast this op as canonical."
2. `applyProjection(db, op)` runs (`electron/ops/projections.js:490-...`). For `locations`,
   `ensureExists` first does `INSERT OR IGNORE INTO locations (id, camp_id, name) VALUES (id, camp, '')`
   (`projections.js:171-175` — name `''` never collides), then the field UPDATE
   `SET name = 'Pool' WHERE id = <new id>` runs and hits `SQLITE_CONSTRAINT_UNIQUE` against the
   already-existing "Pool" row.
3. The `catch` at `syncClient.js:441-465` only special-cases `DELETE_FIELD` + `SQLITE_CONSTRAINT_FOREIGNKEY`
   (logged via `console.error`). **Every other projection failure, including this one, is silently
   swallowed** — no log line, no signal anywhere (`syncClient.js:462-464`, comment: "there's no
   observability infra yet to surface it further").
4. Result: a permanent orphan row (blank `name`, real or default `capacity`) with the new `entity_id`,
   sitting alongside the real "Pool" row. Anything with `location_id` pointing at the orphan
   (`activities.location_id`, `week_location_exclusions.location_id`) renders blank. No conflict is
   ever recorded. The device is now silently, permanently divergent for that row set — worse, the
   op-log insert in step 1 means this device's log now disagrees with what a correct projection of
   that same log would produce, so a **future full replay of this device's own op-log would not
   reproduce its current state**.

### Path 2 — Host-submit rejection (`syncServer.js handleSubmitOp` → `appendOp`)

A Client submits a colliding create directly to the Host.

1. `deriveWriteAction`/`authorizeWs` pass. `detectConflict(db, incomingOp)`
   (`electron/ops/operations.js:482-495`) is keyed on `(entity, entity_id, field)`: it looks up the
   latest op for **this exact `entity_id`**, finds nothing (it's a brand-new id), and returns
   `{ conflict: false }`. It has no notion of a uniqueness constraint that spans *different*
   `entity_id`s for the same entity — this is the structural mismatch the task exists to resolve.
2. `appendOp(db, incomingOp)` runs (`operations.js:91-129`). Its `db.transaction()` wraps **both** the
   `INSERT INTO operations` **and** `applyProjection` in the **same** transaction. `applyProjection`
   throws `SQLITE_CONSTRAINT_UNIQUE` on the same UPDATE as Path 1 — but here the transaction has not
   yet committed, so SQLite **rolls back the whole thing, including the operations INSERT**. Unlike
   Path 1, the op is never durably logged at all — this is a genuinely different, and in one respect
   better (nothing spuriously canonical), failure than Path 1's.
3. The thrown exception propagates out of `appendOp`, out of `handleSubmitOp` (which has no try/catch
   of its own around line 603's `appendOp(db, incomingOp)` call), and is caught by the **outer**
   per-message try/catch at `syncServer.js:885-1006`, which calls `sendError(ws)`
   (`syncServer.js:104-114`) — a **generic, uncorrelated** `{ type: 'error', message: 'invalid request' }`
   with no entity/field/reason and no way for the Client to match it to the pending submission.
4. **The Client's message handler has no case for `msg.type === 'error'` at all**
   (confirmed: every handled type is enumerated at `syncClient.js:502-649`, `'error'` is not among
   them). The message is silently ignored. The `submitResolvers` entry for this submission is never
   resolved by any message — it can only resolve via its own **10-second timeout**
   (`DEFAULT_RESOLVER_TIMEOUT_MS = 10000`, `syncClient.js:24`; `withResolverTimeout`,
   `syncClient.js:728`), producing `{ status: 'timeout' }` — **indistinguishable from a dead
   connection**, from the interactive caller's point of view a 10-second hang.
5. If this write reached the Host via the **durable, persisted offline queue**
   (`insertPendingWrite`/`flushQueue`, `syncClient.js:1000-1169`), the consequence compounds:
   `flushQueue`'s loop treats `'timeout'`/`'disconnected'` as connectivity failure and `break`s the
   **entire batch** (`syncClient.js:1168`), leaving the item in the durably-persisted queue for retry.
   Because the collision is **deterministic** (same name, same still-existing winning row), **every
   future flush reproduces the identical failure, forever** — this is not a swallowed write, it is an
   **infinite retry loop that survives app restarts** (the queue is SQLite-backed) and, on every
   attempt, **head-of-line-blocks every other write queued behind it on that device** until the stuck
   item is somehow removed.

**Which path is actually reachable in normal operation.** This app has exactly one authoritative Host
per camp, and every accepting write for a Client (`performWrite` → `submitOpRemote`) round-trips
through that one Host's single, synchronous `handleSubmitOp`/`appendOp`. Because SQLite's own
`UNIQUE(camp_id, name)` constraint is enforced on that **one** canonical database inside **one**
synchronous transaction per submission, the Host's own canonical `locations` table can never durably
contain two rows with the same exact name — the second submission to reach it always hits Path 2. A
Client only ever locally applies an op the Host has echoed to it (live push or `sendMissedOps`
catch-up: no optimistic local apply before Host acknowledgment — `write()`'s `!authenticated` branch,
`syncClient.js:1000-1024`, durably queues the *request*, it does not touch the local `locations`
table). So **Path 2 (Host-submit rejection) is the path directly reachable by two devices racing to
create the same new name today, and it is the one that matters most for the ordinary "two staff members
add the same location name minutes apart" scenario.**

Path 1's swallow is real, broken code with a real blast radius, but its *reachability specifically via
a two-device concurrent-create race* requires the receiving device's local projection to already
disagree with the Host's canonical state at the moment the colliding op arrives — e.g. a Host role
change, a restored/merged DB, or any other future source of client/host projection skew, not just this
one race. Both paths are fixed by this ADR; the fix for Path 2 is the one that removes the everyday
defect, and the fix for Path 1 is defense-in-depth against the wider class of "a canonical, already-log
ged op still fails to project on some receiver" bugs this catch block was silently absorbing.

## The crux: why the existing conflict shape doesn't fit, and why it shouldn't be forced to

`conflicts.entity_id` is a single `NOT NULL TEXT` column (`electron/db/schema.sql:206-217`) — one row
communicates "op A and op B disagree about the value of one field on one entity." A same-name create
collision is not that: there are **two different, real entity_ids**, and there is no ambiguity about
*value* — the existing row's name is not in question, the *new* row simply cannot exist under that
name. Forcing this into `conflicts` (recording the losing entity_id inside `incoming_op`'s JSON, the
existing entity_id as `conflicts.entity_id`) is mechanically possible with zero schema change, but it
is **semantically wrong**: `conflicts` exists for genuine ambiguity a director must adjudicate ("which
edit is correct"). Here there is nothing to adjudicate — the schema's own constraint has already
decided that only one row may hold this name. Treating it as a conflict would mean building a second,
narrower conflict-resolution UX (a create's several fields, not the resolveConflict single-field model)
for a decision that has no real content to resolve.

## Options considered

- **(a) Record it as a real `op_conflict`.** Mechanically fits (see above) but is the wrong shape for a
  non-ambiguous situation, and it forces `resolveConflict`'s single-field-pick UX onto a multi-field
  create ("pick a side" doesn't cleanly express "apply my capacity onto the existing row instead").
  **Rejected** — over-general machinery for a decision that isn't actually a judgment call.
- **(b) Deterministic merge/dedupe** (lowest id / earliest seq wins; rewrite `activities.location_id`
  and `week_location_exclusions.location_id`; delete the loser). This is the exact "two rows, one
  place" shape M3c already owns (`docs/work/specs/2026-08-15-m3-locations-design.md` §3.1) — a
  **blocking modal, human-reviewed**, because `"Pool"`/`"pool"` near-duplicates carry genuine
  ambiguity (Art V). Building a **second**, silent, automatic merge mechanism for exact-name collisions
  risks confusing the two: a director could reasonably ask "why did the near-duplicate 'Pool'/'pool' I
  typed get a blocking review, but this one didn't?" **Rejected as a generalized merge mechanism** —
  but see the Decision below: the *reasoning* that exact-string collisions carry no real ambiguity (two
  people typing the literal same string at one camp are referring to the same place) is retained and
  used, not to silently merge two already-created rows, but to prevent the second row from ever being
  created in the first place.
- **(c) Surface to the director.** Necessary in any design — the question is *how*. A background
  notification risks being missed (this is real data the director typed disappearing); a blocking
  merge-review modal (M3c's shape) is the wrong weight for a decision with no real content.
  **Folded into the Decision** as an ordinary, immediate, inline create-time validation error — the
  same weight as any other "that name is taken" rejection in any CRUD app, not a deferred review queue.
- **(d) Deterministic entity ids for interactive creates** (`deriveLocationId(campId, trimmedName)`,
  reused from the migration backfill/restore, `electron/ops/locationId.js`). **Rejected — structural
  disqualifier, not a wrinkle.** `deriveLocationId` is safe for the migration backfill and for restore
  precisely because both are **one-time derivations from a fixed, historical name that is never
  revisited** (INV-1/INV-2, `docs/adr/2026-08-15-camp-locations-entity.md`). An interactive create's
  name is **not** fixed — the director can rename the row immediately after creating it. Concretely:
  create "Pool" → id `location:{camp}:Pool`; rename to "Swimming Pool" (an ordinary field UPDATE, id
  unchanged, since ids are immutable primary keys referenced by every op ever written against that
  row); a *later*, unrelated create of a location literally named "Pool" would derive the **same** id
  `location:{camp}:Pool` and **PRIMARY KEY-collide** with the renamed row. Unlike a `UNIQUE` violation,
  `ensureExists`'s `INSERT OR IGNORE` on that id **silently no-ops** (the row already exists), and the
  subsequent field UPDATEs (`name='Pool'`, `capacity=...`) then **silently overwrite the renamed row's
  fields** — no exception, no conflict, no rejection: this is **silent data corruption**, strictly
  worse than the defect this ADR fixes. Deterministic-from-current-name ids are only sound for an
  immutable-key derivation; a mutable `name` field on a live entity is exactly the case that breaks it.
  INV-1's derivation stays exactly as scoped (migration backfill, restore) — this ADR does not touch it.

## Decision

**D1 — Reject the colliding write explicitly, at the point of submission, before it is ever appended
to the op-log. Do not record a conflict; do not merge; do not touch entity-id derivation.**

The existing row always wins — this requires no tie-break logic, no clock comparison, and no
ambiguity: "already exists in the canonical DB" is unambiguous truth at the Host, and it is checked at
the one place the Host already serializes all writes to `locations`. The submitting device is told,
synchronously and specifically, that the name is taken, and surfaces this as an ordinary inline
create-time validation error ("A location named 'Pool' already exists") — not a deferred conflict, not
a merge review. The director decides what to do next in their own, still-open create flow: pick a
different name, or go edit the existing row. Nothing the director typed is silently discarded without
them being told; nothing is silently merged (Art V is satisfied because there is no merge — the second
row never comes into being).

**D2 — A small, registry-driven collision check, reused at both write-entry points, not new
observability infra, not a new op-log primitive.**

Add to `electron/ops/operations.js`, alongside `detectConflict` and mirroring the existing
`BULK_REPLACE_ENTITIES` registry pattern (`operations.js:219-248`):

```js
// Entities with an app-level uniqueness constraint detectConflict cannot see,
// because detectConflict is keyed on a single entity_id and this constraint
// spans different entity_ids. Checked only for the field the constraint is
// actually on — a normal field-level conflict on any OTHER field of an
// already-created row still goes through detectConflict unchanged.
export const UNIQUE_FIELD_ENTITIES = {
  locations: { table: 'locations', field: 'name', scopeColumn: 'camp_id' },
}

// Returns the colliding row's current { id, ...fields } if `op` would violate
// a registered UNIQUE(scopeColumn, field) constraint against a DIFFERENT
// entity_id, else null. Deliberately excludes op.entity_id itself so a
// legitimate no-op rewrite of a row's own current name is never flagged.
export function detectUniqueFieldCollision(db, op) {
  const config = UNIQUE_FIELD_ENTITIES[op.entity]
  if (!config || op.field !== config.field || op.value == null || op.value === '') return null
  const camp = getStmt(db, 'SELECT id FROM camps LIMIT 1').get()
  if (!camp) return null
  return (
    getStmt(
      db,
      `SELECT * FROM ${config.table} WHERE ${config.scopeColumn} = ? AND ${config.field} = ? AND id != ?`
    ).get(camp.id, op.value, op.entity_id) || null
  )
}
```

Call this **before** `appendOp` at both of the two places that currently call it without any
uniqueness awareness:

1. `syncServer.js handleSubmitOp` (`operations.js` call site at `syncServer.js:603`) — check
   immediately after the existing `detectConflict` check (same early-return shape), **before**
   `appendOp` runs, so the doomed transaction is never attempted at all.
2. `syncClient.js`'s host-local, no-`serverUrl` direct-write branch (`syncClient.js:~153`, the
   `appendOp(db, {...})` call for "genuinely local first-party writes") — same check, same
   before-`appendOp` placement, so a Host operator's own interactive create gets a clean, typed
   rejection through the normal IPC promise instead of an unhandled thrown `SQLITE_CONSTRAINT_UNIQUE`
   propagating raw to `main.js`'s `write()` handler and the renderer.

**D3 — One new wire message, `op_rejected`, handled exactly like `op_conflict` is handled today —
not silence, not a bare timeout.**

`syncServer.js handleSubmitOp`: on a `detectUniqueFieldCollision` hit, send
`{ type: 'op_rejected', op: incomingOp, reason: 'unique_field', field: incomingOp.field, existing: { id, name, capacity, notes } }`
(structured enough for the UI to show *what* already exists, matching the level of detail
`op_conflict` already carries) and return — **never call `appendOp`**.

`syncClient.js` message handler: add a case alongside the existing `op_conflict` handler
(`syncClient.js:634-649`) that drains `submitResolvers` with
`{ status: 'rejected', reason: msg.reason, existing: msg.existing }` — mirroring exactly how
`op_conflict` already drains its resolver, no `recordConflict` call (there is nothing to persist; the
write never became canonical).

`performWrite` (`syncClient.js:789-821`): treat `'rejected'` as **terminal**, the same tier as
`'conflict'` — return `{ status: 'rejected', reason, existing }` to the caller. `setupCrudRepository`
needs **zero changes** for the interactive/online path: `writeFields`
(`src/data/setupCrudRepository.js:22-30`) already throws on any `result.status` other than `'applied'`/
`'queued'`, so a `'rejected'` name-write already stops the sequential field loop before `capacity`/
`notes` are ever sent, and `createRecord`'s existing best-effort cleanup already fires. **Verify (Maker
requirement) that the locations create call orders `name` first in `orderedFields`** — the sequential-
await loop only protects the fields that come *after* the rejected one.

**D4 — The offline-queue companion fix: purge sibling queued writes for a rejected entity_id, not just
the one that failed.**

D3 alone is not sufficient for the **offline-queued** path. `write()`'s `!authenticated` branch
(`syncClient.js:1000-1024`) returns `{ status: 'queued' }` **synchronously, before any network
round-trip**, for every field — so for an offline-initiated create, `name`, `capacity`, and `notes` are
all durably queued up front, before anyone knows `name` will collide. When `flushQueue`
(`syncClient.js:1112-1169`) later processes them in order and gets `'rejected'` for `name`, its current
logic (`'timeout'`/`'disconnected'` → `break`; everything else → implicit `continue`, item stays
queued) would let the **subsequent, sibling** `capacity`/`notes` items for the **same doomed
`entity_id`** proceed to the Host next — and because those fields are not the `UNIQUE`-constrained one,
`ensureExists`'s `INSERT OR IGNORE` would happily create the blank-name orphan row anyway, reproducing
the exact defect this ADR closes, just via a different field.

**Required:** on `status === 'rejected'`, `flushQueue` must, in the same pass, also splice out of
`queue` and `deletePendingWrite` for **every other still-queued item sharing the same
`(entity, entity_id)`** as the rejected one — not only the rejected item itself — and surface the
rejection once via a new `notifyOpRejected` callback (mirroring `notifyOpConflict`/`notifyOpApplied`)
so the renderer can inform the director even though the original interactive call, if there was one,
has long since returned (this is the offline case — there may be no live caller waiting at all).

**D5 — Harden, don't rebuild: `applyRemoteOp`'s blanket swallow gets a log line, nothing more.**

Independent of D1–D4 (which structurally prevent the colliding op from ever becoming canonical, and so
prevent Path 1 from firing *for this specific defect*), the catch at `syncClient.js:441-465` still
silently swallows **every** non-`DELETE_FIELD`/non-FK projection failure with zero trace. The file's
own stated convention is "no observability infra yet" — this ADR does not introduce any (no new table,
no telemetry pipeline). It extends the **exact pattern already used two lines above it**: the
`DELETE_FIELD`+`SQLITE_CONSTRAINT_FOREIGNKEY` branch already does `console.error` with a specific,
actionable message. Add an `else` branch that does the same for anything else:

```js
} else {
  console.error(
    `applyRemoteOp: projection failed for ${op.entity}/${op.entity_id}.${op.field} — op is logged but not materialized on this device`,
    err
  )
}
```

This is a one-line, zero-infrastructure change that turns "nothing anywhere says so" into "at least the
Electron log says so" for the entire class of future replay-time failures this catch was built to
absorb — cheap, and directly requested as a broad-robustness question to weigh. It is not a substitute
for D1–D4; it is what remains once the specific defect is closed.

## Files/functions changed (exact seams)

| File | Change |
|---|---|
| `electron/ops/operations.js` | Add `UNIQUE_FIELD_ENTITIES` registry + `detectUniqueFieldCollision(db, op)`, exported alongside `detectConflict` |
| `electron/sync/syncServer.js` | `handleSubmitOp`: call `detectUniqueFieldCollision` before `appendOp`; on hit, send `op_rejected`, return without appending |
| `electron/sync/syncClient.js` | (1) host-local no-`serverUrl` write branch: same check before its own `appendOp` call, return structured rejection instead of throwing. (2) message handler: new `op_rejected` case draining `submitResolvers` with `{status:'rejected', reason, existing}`. (3) `performWrite`: treat `'rejected'` as terminal, return it through. (4) `flushQueue`: on `'rejected'`, purge sibling queued items for the same `(entity, entity_id)`, not just the failed one; add `notifyOpRejected`. (5) `applyRemoteOp`'s catch: add the `else { console.error(...) }` branch (D5) |
| `src/data/setupCrudRepository.js` | No code change required — confirm via test that `'rejected'` already falls through `writeFields`'s existing non-`applied`/`queued` failure branch |
| `src/screens/LocationsScreen.jsx` | Verify (do not assume) `orderedFields` for create puts `name` first; if not, fix the ordering. Optionally use `err`/rejection detail for a friendlier inline message ("A location named 'Pool' already exists") — polish, not required for the fix to be correct |
| `src/localClient.mock.js` | Mirror the new `'rejected'` status shape in the dev mock's write path (per the project's established mock-parity requirement — see `ipcSurfaceParity.test.js`) so dev and packaged behavior don't diverge |
| `electron/main.js` | Wires `syncClient.onOpApplied`/`onOpConflict`/`onOpRejected` to `webContents.send`; `sanitizeOpRejectedForIpc` (Finding E, T8) sanitizes `op_rejected`'s `op` the same way `op-applied`/`op-conflict` already are |
| `electron/preload.js` | Exposes `onOpRejected` on `window.shoresh`, mirroring `onOpConflict`'s exact shape |
| `src/localClient.js` | Thin `onOpRejected` passthrough to `shoresh.onOpRejected`, mirroring `onOpConflict` |
| `src/App.jsx` | `AppShell`'s `onOpRejected` subscription — owner decision (remediation round, item 7): a minimal, dismissible banner (reusing `S.errorBanner`'s visual language) replaces the original console-only handler, so an offline-rejected create is visible to the director, not just logged |

No schema change. No new table. No change to `conflicts`, `PROJECTIONS`, `DIRECT_CAMP_ENTITIES`, or any
of the nine locations registries from `docs/adr/2026-08-15-camp-locations-entity.md` — this ADR is
additive at the sync/protocol layer only.

## Test strategy

This is a sync/replay seam; characterization and integration tests are load-bearing here, not optional.

1. **Unit — `detectUniqueFieldCollision`** (`operations.test.js`): no collision when name differs;
   collision detected against a different `entity_id` with the same name; **no false positive** when
   `op.entity_id` matches the existing row (an ordinary rename/no-op write to a row's own current name
   must not self-collide via the `id != ?` exclusion).
2. **`syncServer.js handleSubmitOp`**: a colliding `submit_op` → assert `op_rejected` is sent (not
   `op_applied`), assert **no new row** exists for the new `entity_id`, assert the `operations` table
   gained **no row** for the rejected submission, assert the winning row is byte-unchanged.
3. **`syncClient.js` message handling**: receiving `op_rejected` drains the correct `submitResolvers`
   entry with `{status:'rejected', ...}` — assert `performWrite` returns promptly (not after the 10s
   timeout) and does not throw.
4. **`flushQueue` cascade (D4)** — the test most directly targeting the regression found in this ADR:
   queue `name` + `capacity` for the same doomed `entity_id`; assert **both** are purged from the
   durable `pending_writes` table after one flush pass, assert neither is retried on a subsequent
   flush, and assert an **unrelated** queued item (different entity_id) in the same batch is still
   processed normally (D4 must not regress the existing per-item independence `flushQueue` already
   has for genuine `'error'`/`'lock_contention'` outcomes).
5. **Host-local direct-write path**: same collision, submitted via the no-`serverUrl` branch; assert a
   structured rejection is returned to the IPC caller, not an unhandled `SQLITE_CONSTRAINT_UNIQUE`
   exception surfacing raw to the renderer.
6. **Two-client integration** (real `syncServer` + two real `syncClient` instances against one Host
   DB, matching the shape of the project's `test/integration/run.js` LAN-sync scenarios — the actual
   test for this ADR lives in `electron/sync/syncClient.test.js`, in the `'two-client race'` test
   inside `describe('locations UNIQUE(camp_id, name) collision rejection (D2/D3/D4/D5)')`, not under
   `test/integration/`, since it needed the same real-Host/real-Client harness that file's other
   collision tests already use): Device A creates "Pool" and it applies; Device B concurrently creates "Pool"; assert
   B's create is rejected (not hung, not silently ghost-created); assert A's row is untouched; assert
   **zero** orphan/blank-named rows exist on either device once both are flushed. This is the direct,
   end-to-end reproduction of the confirmed defect, now proven closed.
7. **Regression**: every existing `detectConflict`/`conflicts` test continues to pass unmodified — this
   ADR is additive alongside the existing same-entity_id conflict path, not a replacement of it.
8. **D5 observability**: a non-DELETE/FK projection failure in `applyRemoteOp` now calls
   `console.error` (spy/mock assertion) instead of doing nothing.

## M3c coordination note

M3c's near-duplicate merge (`docs/work/specs/2026-08-15-m3-locations-design.md` §3.1) is a **human-
reviewed, blocking-modal merge of different spellings found during migration** — a genuine judgment
call under Art V. This ADR's fix is a **write-time rejection of an exact-string collision at create
time** — never a merge, no human judgment involved (the schema's own constraint already says only one
row may hold that exact name; there is nothing to adjudicate). The two do not share code, a UI, or a
review queue, and they must not: M3c's merge acts on **two already-existing rows** the migration
surfaced; this ADR's fix ensures a **second row is never created** in the first place. If a future
slice ever wants "auto-suggest the existing row when a director types an exact match" as a UX
convenience during create, that is additive polish on top of the D3 rejection payload (which already
carries the existing row's id/name/capacity) — it does not require touching M3c's mechanism, and this
ADR does not design it.

## Migration / repair decision for already-diverged rows

**Forward-only. No blocking data migration.** Evidence: only the M3a setup screen has shipped
(`git log`: "feat(locations): Locations setup screen + readiness promotion (M3a)"); the M3b picker
inline-create and CSV import entry points named in this defect's own reproduction are **not yet built**
(no picker component exists under `src/`; `docs/work/specs/2026-08-15-m3-locations-design.md:74-75`
explicitly places CSV import at M4). The two-device race this ADR closes therefore has had, at most, a
narrow window (M3a-only, single create entry point) to have actually fired against real data, and dev
and packaged builds use separate databases (`CLAUDE.md`, `electron/db/userDataPath.js`) so no
development activity could have touched a real camp's data.

**Recommended, cheap insurance (not a migration):** before shipping this fix, run a one-time, read-only
diagnostic against any existing camp DBs (dev or early pilot) —
`SELECT camp_id, name, COUNT(*) FROM locations WHERE name = '' GROUP BY camp_id` for the specific
blank-name orphan signature Path 1 produces — to confirm the count is zero. If it is (expected), no
further action. If it is not, handle the specific rows found by hand (delete the orphan, verify/re-point
any `activities.location_id`/`week_location_exclusions.location_id` referencing it) rather than building
automated repair machinery for a problem space that is very likely empty — building a repair migration
for zero known-affected rows would be exactly the premature generality `karpathy-guidelines` warns
against.

## Consequences

- **Positive:** the everyday two-device same-name race (Path 2) is closed at its source — the
  colliding write is rejected synchronously with an actionable reason, not silently discarded and not
  left to rot as an infinite, queue-blocking retry. The rarer replay-skew swallow (Path 1) gets a
  permanent, zero-infrastructure log line so it is at least discoverable going forward. No new UI
  paradigm, no schema change, no interference with M3c.
- **Costs / risks:** the offline-queue cascade fix (D4) is the one genuinely new piece of logic beyond
  "add a check and a message type" — it must be tested directly (test 4 above) or the fix is
  incomplete for the offline path specifically, silently reproducing the defect via the second field
  instead of the first. `flushQueue`'s existing per-item independence contract changes shape slightly
  (a rejection now removes more than one item) and must not regress the existing `'error'`/
  `'lock_contention'` per-item semantics.
- **Explicitly not built here:** any UI for choosing "use the existing row instead" (D3's payload makes
  this a small, later, additive UX improvement, not required for correctness); any change to INV-1's
  deterministic-id scheme; any generalized cross-entity merge primitive.

## Ticket decomposition

Dependency-ordered. Red Hat is mandatory (stored-shape-adjacent: op-log/protocol/queue behavior).

| Slice | Scope | Gate notes |
|---|---|---|
| **T1 — Registry + detection** | `UNIQUE_FIELD_ENTITIES` + `detectUniqueFieldCollision` in `operations.js`, unit-tested per test 1 above. No behavior change yet (not wired anywhere). | Small, isolated, safe to land first |
| **T2 — Host-submit rejection** | Wire T1 into `handleSubmitOp` (D3's Host side); new `op_rejected` message. Tests 2, 6 (integration). | Red Hat: confirm no path still lets `appendOp` throw for this case |
| **T3 — Client handling + offline cascade** | Wire T1 into the host-local no-`serverUrl` branch; add the client `op_rejected` case; `performWrite` terminal handling; **D4's `flushQueue` sibling-purge** (the one genuinely new piece of logic). Tests 3, 4, 5. | Red Hat mandatory — this is the queue-behavior-changing slice |
| **T4 — Observability hardening (D5)** | `applyRemoteOp`'s catch: add the logging `else` branch. Test 8. | Trivial, independent, can land in parallel with T2/T3 |
| **T5 — Mock parity + UI polish** | `src/localClient.mock.js` mirrors the new `'rejected'` status; verify/fix `LocationsScreen.jsx` field ordering; optional friendlier inline message using D3's `existing` payload. | Mock-parity test (`ipcSurfaceParity.test.js`) is the hard gate for the first half; the UI message is polish |
| **T6 — Pre-ship diagnostic** | Run the read-only orphan-count query against any existing camp DBs per "Migration / repair decision" above. Not a code ticket — a one-time check, record the result in the work log. | Confirms the "forward-only" call was correct before this ships |

## Confidence

**High** on the core recommendation (D1: reject at write time, don't merge, don't conflict-record,
don't touch entity-id derivation) and on rejecting option (d) — the rename/recollision hazard for
deterministic interactive-create ids is a structural, not incidental, disqualifier, verified against
the actual mutable-`name` field and the actual `ensureExists`/`INSERT OR IGNORE` behavior that would
turn a PK collision into a *silent* overwrite. **High** on D2/D3's shape being the smallest correct fix
— it reuses the existing early-check-before-appendOp pattern `detectConflict` already establishes, adds
one wire message with an existing structural sibling (`op_conflict`) to copy, and required zero schema
change. **Medium-high** on D4's exact mechanism (purge siblings by `(entity, entity_id)` on rejection)
— the *need* for it is proven by tracing `writeFields`'s field-order dependence through the offline
`write()`'s up-front-queuing behavior; the purge-on-reject shape is the natural fix but is the one place
in this design a Maker should re-verify against `flushQueue`'s current exact control flow before
implementing, since it is the piece most likely to interact with other in-flight queue work. **Medium**
on the Path-1-reachability analysis (that Path 2 dominates in normal two-device racing, and Path 1
requires a broader skew scenario) — this is a reasoned architectural argument from the code as it
stands today, not something exercised by a live repro in this session; D5's fix is cheap enough that
this uncertainty doesn't change the recommendation either way.

**Evidence behind this confidence:** direct reading of `electron/ops/operations.js`,
`electron/ops/projections.js`, `electron/sync/syncServer.js`, `electron/sync/syncClient.js`,
`electron/ops/locationId.js`, `electron/db/schema.sql`, `src/data/setupCrudRepository.js`, and the M3
locations design/ADR docs — line-cited throughout this document, not summarized from memory or from the
task's own framing alone.

---

## Addendum — post-implementation review remediation (2026-08-15)

D1–D5 above were implemented (uncommitted at base `a93b81e`) and passed Security (5/5) and Code Review
(faithful to the design). Red Hat's Resilience pass (3/5) and Code Review found six gaps the "both call
sites" framing in D2/D3 missed — a third, unguarded `appendOp` call site; a latent create-ordering hazard
D4's own comment names but does not close; a real edit-data-loss bug in D4 as shipped; a non-atomic purge;
an unsanitized IPC field; and an unversioned-protocol question. This section decides each, closing the
ones that need code and explicitly accepting the one that doesn't. Confirmed against the actual diff
(`git diff a93b81e`) and the current file contents, not against the original design intent alone.

### Finding A (HIGH, CONFIRMED) — restore is a third, unguarded `appendOp` call site

**Decision: reuse `detectUniqueFieldCollision` a third time, inside `restoreEntity`, before its
`db.transaction()` opens — return a structured `{ error: 'unique_field', field, existing }`. The existing
`restore_result`/`requestRestore`/`runDrainPass` plumbing already knew how to carry the bare error
*string* end-to-end without a crash; carrying `field`/`existing` all the way to the director's screen
needed two further, small changes — one in `requestRestore`, one in `TrashScreen` — closed by the T12
follow-up documented at the end of this section, not by the original remediation round.**

This is not a new error channel. `restoreEntity` already returns `{ error: <string> }` for four other
refusal reasons (`not-restorable`, `no-history`, `not-deleted`, and the allowlist check), and every layer
above it already treats `error` as terminal and forwards it unchanged:
`handleRestoreRequest` (`electron/sync/syncServer.js:781`) does
`send(ws, { type: 'restore_result', request_id, error: result.error })`; the Client's
`requestRestore` (`electron/sync/syncClient.js:~1149`) does `if (reply.error) return { error: reply.error }`;
and `runDrainPass`'s offline-queue branch (`electron/sync/syncClient.js:~1030-1040`) already treats *any*
truthy `reply.error` other than `'not-deleted'` as terminal via `recordRestoreError(db, item.pendingId, reply.error)`
— it does not enumerate the three known strings in code, only in a comment, so a new `'unique_field'`
*string* flows through the **queued** path with zero additional Client-side changes, and `TrashScreen`'s
`OUTCOME_COPY.unique_field` entry (T12) covers that path with an honest, generic, permanent-block message
— no `pending_restores` schema change needed, since the queued item never carries `existing`.

The **interactive** path is different, and this is where the original remediation round undersold the
work. `requestRestore`'s `if (reply.error) return { error: reply.error }` forwarded the bare string only,
so `field`/`existing` — needed to name the colliding record — never reached `TrashScreen`, which fell back
to its generic, misleading "try again in a moment" copy for a refusal that is actually deterministic and
permanent. Red Hat's re-review caught this as a MEDIUM gap; T12 closed it by also spreading `field`/
`existing` through `requestRestore` (conditionally, so the other four error strings stay byte-identical)
and adding the honest `unique_field` copy to `TrashScreen`. So the crash fix was, as designed, entirely
inside `restore.js` on the Host — but making the refusal legible to the director needed the additional
Client and renderer changes T12 shipped.

Exact seam, `electron/ops/restore.js`, `restoreEntity`:

```js
import { UNIQUE_FIELD_ENTITIES, detectUniqueFieldCollision, appendOp, DELETE_FIELD, BULK_REPLACE_FIELD } from './operations.js'
// ...
// after `if (!fields.has('camp_id')) return { error: 'no-history' }`,
// before `const ordered = [...]` / before db.transaction() opens:
const uniqueConfig = UNIQUE_FIELD_ENTITIES[entity]
if (uniqueConfig && fields.has(uniqueConfig.field)) {
  const collision = detectUniqueFieldCollision(db, {
    entity,
    entity_id,
    field: uniqueConfig.field,
    value: fields.get(uniqueConfig.field),
  })
  if (collision) {
    return {
      error: 'unique_field',
      field: uniqueConfig.field,
      // Field-picked, not `SELECT *` passthrough — matches D3's existing
      // `{ id, name, capacity, notes }` shape exactly, so this payload is
      // safe to forward through IPC unchanged (see Finding E: the discipline
      // that closes E is "never forward a raw row," and this seam follows it
      // from the start rather than needing a second sanitization pass).
      existing: { id: collision.id, name: collision.name, capacity: collision.capacity, notes: collision.notes },
    }
  }
}
```

Why before the transaction and not a try/catch around it: matches D1's own stated principle ("reject...
before it is ever appended to the op-log") — a caught-and-converted exception would still have let the
doomed transaction run to the point of throwing, which is fine functionally (SQLite still rolls back
correctly) but is inconsistent with the pattern D2 already established at the other two sites, and this
addendum should not introduce a third pattern.

**Registry-driven, not `locations`-specific.** `UNIQUE_FIELD_ENTITIES` currently has one entry, but
`RESTORABLE_ENTITIES` has nine — checking `UNIQUE_FIELD_ENTITIES[entity]` generically (rather than
hardcoding `entity === 'locations'`) means a future second registry entry (whatever it is) gets restore
protection for free, the same way it gets D2/D3 protection for free at the other two sites.

**No new wire message.** `restore_result` already carries `error`; this only adds two optional fields
(`field`, `existing`) to the payload the Host sends on the existing error branch, mirroring how D3 added
fields to `op_rejected` rather than inventing a new type.

**Confidence: High.** The error-propagation plumbing this reuses is not hypothetical — it is the exact
code already handling `restoreEntity`'s four existing refusal reasons, read directly at the cited lines,
and `runDrainPass`'s generic `if (reply.error)` branch (not a switch over known strings) means the new
value requires no Client-side change to reach the director's pending-restores list on the **queued** path.
The **interactive** path needed one more: `requestRestore`'s own `if (reply.error) return { error: reply.error }`
also had to forward `field`/`existing`, or the director-facing detail would be dropped even though it had
already crossed the wire. This was missed in the original remediation round and caught by Red Hat's
re-review as a MEDIUM gap, closed by T12. The things a Maker had to verify, not assume: that
`send(ws, { type: 'restore_result', ... })` at `syncServer.js:781` forwards the whole `result` object's
extra fields (it does — `error: result.error, ...(result.field && { field: result.field }), ...(result.existing && { existing: result.existing })`
— and this part shipped correctly in the original remediation round), and that `requestRestore` forwards
them too, which did not ship until T12.

### Findings B + C (decided together, as instructed) — name-first invariant + D4 sibling-purge scope

These interact through the same fact: **D4's purge, as shipped, cannot distinguish "this rejected field
was part of a create" from "this rejected field was part of an edit to an already-existing row,"** and
that ambiguity is the root of both findings — B is "what if a future create doesn't put the unique field
first," C is "what if the current purge over-fires on an edit." One piece of information resolves both:
**whether a materialized row for `(entity, entity_id)` already exists locally at the moment the rejection
is processed.**

This works because of a fact already true and load-bearing elsewhere in this ADR: `write()`'s
`!authenticated` branch (`syncClient.js:1000-1024`) queues every field **without touching the local
table** — "no optimistic local apply before Host acknowledgment" is already this ADR's own stated
invariant (Context, Path 2 discussion). So at the moment `flushQueue` processes a rejected item:

- **Create case:** no row for this `entity_id` exists locally (it was never optimistically applied) —
  `SELECT 1 FROM locations WHERE id = ?` returns nothing.
- **Edit case:** a row for this `entity_id` already exists locally (synced in from an earlier create,
  by this device or another) — the same `SELECT` returns a row.

This is the identical pattern `stillDeletedLocally` (`syncClient.js:~980`) already uses for the restore
queue — "answered from the materialized row, not the op log, precisely because [this device] may not hold
the [full] history." No new primitive; the same technique applied to a second queue.

**Decision C — narrow the purge to the create case only.**

`electron/sync/syncClient.js`, in `flushQueue`'s `result.status === 'rejected'` branch (`~syncClient.js:1247`):
before computing `siblings`, check whether the rejected item's row already exists locally:

```js
const rowExistsLocally = !!db.prepare(
  `SELECT 1 FROM ${PROJECTIONS[item.entity].table} WHERE ${PROJECTIONS[item.entity].key} = ?`
).get(item.entity_id)

if (!rowExistsLocally) {
  // Create case (today's behavior, unchanged): the whole entity_id is doomed
  // — no valid row can ever exist under it — so every sibling queued for it
  // must be purged too, or a later field (capacity/notes) creates the exact
  // blank-name orphan this ADR closes, just via ensureExists on a different
  // field (see Finding B below for why this alone isn't sufficient defense).
  const siblings = queue.filter((q) => q.entity === item.entity && q.entity_id === item.entity_id)
  for (const sibling of siblings) { /* existing purge loop, unchanged */ }
} else {
  // Edit case (the gap Finding C found): the row is real and already exists.
  // Only the rejected field (e.g. a colliding rename) is invalid — a sibling
  // field on the SAME already-existing row (e.g. a legitimate capacity
  // change batched in the same edit) is an independent, valid write and must
  // be allowed to proceed normally on this or the next flush pass. Purging
  // it here would silently discard director-entered data with no signal
  // beyond a console.error — the exact "your capacity edit vanished" bug
  // Finding C describes.
}
```

`PROJECTIONS[entity].table`/`.key` is the existing generic accessor already used by `stillDeletedLocally`
— no per-entity special-casing required, so this stays correct if `UNIQUE_FIELD_ENTITIES` ever grows a
second entry on a different table.

**Decision B — close the ordering hazard with a cheap client-side guard at the one identified reuse
choke point, and explicitly accept the remaining Host-side gap as documented residual risk (do not build
atomic multi-field creates now).**

Of Red Hat's four options: (ii) is rejected on Red Hat's own evidence — gating `ensureExists` on
`field === config.field` converts today's *silent orphan* failure into a *silent lost-field* failure for
the ordinary, currently-working, non-colliding case (a `capacity` op arriving before `name` on a
successful create would `UPDATE 0 rows` and vanish) — trading one silent-corruption class for another is
not a fix. (iii) alone is rejected too: the ADR's own Context section states plainly that
`setupCrudRepository.createRecord` "already exists for the M3a Locations setup screen and will be reused
by any future create entry point (a M3b picker inline-create, a future CSV import...)" — `createRecord`
is *named as the intended single choke point* for every future locations create, so a documentation-only
answer leaves the actual future risk (M4's CSV import) completely open; a comment does not stop a CSV
importer's field order from being whatever the parser happens to emit.

(i), adapted to respect the renderer/Electron boundary, is the smallest fix that closes the one
enumerable, in-repo risk:

Add to `src/data/setupCrudRepository.js` (renderer-side, zero DB/Electron imports — this file already
has none):

```js
// The renderer-side half of electron/ops/operations.js's UNIQUE_FIELD_ENTITIES
// (not imported directly — that module pulls in better-sqlite3/node:crypto and
// cannot cross into the renderer bundle). Kept in sync by
// uniqueFirstFieldRegistryParity.test.js, which imports BOTH modules under
// Vitest (same runner, no bundler involved) and fails if a key is added to
// one registry without the other — same guard shape as restore.js's own
// RESTORE_DECISIONS-must-cover-every-PROJECTIONS-key test.
const UNIQUE_FIRST_FIELD = { locations: 'name' }

async function createRecord(entity, id, orderedFields) {
  const requiredFirst = UNIQUE_FIRST_FIELD[entity]
  if (requiredFirst && Object.keys(orderedFields)[0] !== requiredFirst) {
    throw new Error(
      `createRecord(${entity}): "${requiredFirst}" must be the first field — got "${Object.keys(orderedFields)[0]}". ` +
      `A create on this entity has an app-level UNIQUE constraint (docs/adr/2026-08-15-locations-concurrent-create-collision.md); ` +
      `writing any other field first can create a permanently orphaned row if the constrained field is later rejected.`
    )
  }
  // ...existing body, unchanged
}
```

This is a **programmer-error guard**, not a user-facing error path — it should never fire given correctly
written callers, and it converts a silent, remote, Host-side canonical-DB orphan (discoverable only by
the pre-ship diagnostic query D1's ADR text already describes) into an immediate, local, loud exception
the moment a *new* call site — specifically the M4 CSV importer this ADR's own Context section names as
the next caller — gets the order wrong, in dev/test, before it ships. `LocationsScreen.jsx`'s existing
`buildCreateFields` comment (confirmed present, `LocationsScreen.jsx:173-183`) already asserts this
invariant in prose; this makes it a structural assertion instead of a comment a future editor can miss.

**Explicitly accepted, not built:** this guard does not protect against a device that bypasses
`createRecord` entirely and submits a non-name-first field order directly over the wire (a misbehaving or
future third-party client) — the Host has no way to distinguish "capacity for a create" from "capacity
for an edit" at the point `ensureExists` runs, short of making a locations create one atomic multi-op
transaction the way `restoreEntity` already does for restores (`db.transaction()` wrapping multiple
`appendOp` calls). That is a genuinely larger change — a new "atomic multi-field create" wire primitive —
and is **out of scope for this addendum**, for the same reason the original ADR declined to build repair
migration machinery for the (expected-zero) already-diverged-rows case: no known call site can currently
trigger it (only `createRecord`, now guarded, exists), and building preventive infrastructure for a
problem space with zero known instances is the premature generality `karpathy-guidelines` warns against.
**Recommended, not required:** extend the ADR's existing one-time "pre-ship diagnostic" (blank-name-row
query) into a *standing* check re-run before releases, as continued cheap insurance against this specific
residual gap, exactly mirroring the risk posture the original ADR already chose for the analogous
already-diverged-rows question.

**Confidence: High** on C (the materialized-row-existence check is a direct reuse of an already-proven
pattern, and it strictly narrows today's over-broad purge — it cannot make D4 miss a case it currently
catches, since the create-case behavior is unchanged). **Medium-high** on B's scope decision (the
guard closes the one real, enumerable risk named in this repo's own docs; the explicit accept of the
Host-side gap is a judgment call about effort-vs-currently-zero-instances, not a technical constraint —
Governor/product should confirm this tradeoff is acceptable, see Open Questions).

### Finding D (LOW) — purge not atomic

**Decision: wrap the (now create-case-only, per Decision C) sibling purge loop in one `db.transaction()`.**
Cheap, matches the pattern already used everywhere else multi-row durability matters in this codebase
(`appendOp`, `restoreEntity`, `deleteRecord` all wrap their multi-statement writes in one transaction).
Narrowing the purge to the create-case (Decision C) also narrows this finding's blast radius — a crash
mid-purge can now only leave a surviving sibling of a *doomed, never-valid* entity_id (bad, but inert:
the row can never become real either way), not a surviving sibling of a row that matters. Fold the
transaction wrap into the same edit as Decision C, since both touch the identical loop.

**Confidence: High.** Mechanical, no design judgment involved.

### Finding E (MEDIUM, latent) — `op_rejected`'s `op` crosses IPC unsanitized

**Decision: reuse the existing `sanitizeOpForIpc` helper (`electron/main.js:108`) on `msg.op`, the same
way `op-applied` and `op-conflict` already sanitize every op that crosses into the renderer.**

```js
// electron/main.js, alongside sanitizeConflictForIpc:
export function sanitizeOpRejectedForIpc(msg) {
  if (!msg) return msg
  return { ...msg, op: sanitizeOpForIpc(msg.op) }
}
```

And in `wireOpApplied`'s `onOpRejected` wiring (`electron/main.js:196-201`):

```js
syncClient.onOpRejected((msg) => {
  const mainWindow = getMainWindow ? getMainWindow() : null
  if (mainWindow) mainWindow.webContents.send('shoresh:op-rejected', sanitizeOpRejectedForIpc(msg))
})
```

The existing comment at that call site ("No PIN-bearing fields exist on the `existing` payload... so no
sanitization is needed") is **true of `existing`** (already field-picked to `{id, name, capacity, notes}`
by D3, confirmed in the diff) **but silent about `op`**, which is the full submitted op unchanged — that
gap is exactly what Code Reviewer found. Update the comment to state both halves explicitly, so the next
registry entry doesn't repeat the same reasoning gap.

**Also close it at the registry, not only at the consumer — this generalizes past `op_rejected`.** The
same field-picking discipline (`{ id, name, capacity, notes }`, never `SELECT *`) should be the stated
*contract* of `detectUniqueFieldCollision`'s callers, not an accident of what D3 happened to write. Add
one sentence to `UNIQUE_FIELD_ENTITIES`'s doc comment in `operations.js`: "any code that reads a
`detectUniqueFieldCollision` result and forwards it — to a wire message, to IPC, to a log line — must
field-pick, never spread/passthrough the raw row; a future entry on a sensitive field (e.g. anything on
`users`) inherits this obligation automatically only if every call site honors it, which is why this
sentence exists." This is documentation, not a schema change — `detectUniqueFieldCollision` itself stays
`SELECT *` (it needs the full row to let a *caller* choose what to expose; the discipline lives at the
edges, matching how `sanitizeOpForIpc`/`IPC_PIN_FIELDS` already work — a boundary-layer filter, not a
query-layer one).

**Test:** mirror `main.test.js:1025` (the existing `op_conflict` sanitization test) for `op_rejected`:
construct a raw `op_rejected` message whose `op.field`/`op.value` simulates a PIN-shaped value, assert
`sendSpy`'s forwarded payload does not contain it and `sentMsg.op` lacks `value` the way `sentMsg.incomingOp`
already must.

**Confidence: High.** This is a direct, minimal reuse of an existing, already-tested helper — no new
sanitization logic, no design judgment beyond "apply the pattern that already exists two call sites away."

### Finding F (LOW-MED) — mixed-version fleet (old client + new host)

**Decision: accept, as a documented, pre-existing rolling-upgrade characteristic of this protocol — do
not build a version handshake.**

Confirmed: no version field exists anywhere in the pairing, login, or WebSocket message handshake (read
`electron/sync/syncServer.js`'s connection setup and `electron/sync/syncClient.js`'s `authenticate`/
connect path — no `protocol_version`, no capability negotiation, nothing an old Client could use to even
learn a new message type exists). This is not specific to `op_rejected`: `op_conflict` had the exact same
exposure when it was introduced, and remains exposed today, and no work item exists anywhere in this
repo's history to retrofit one. Building a handshake now, scoped to only this one message type, would
fix an instance of a general property while leaving the general property itself unaddressed — inconsistent
coverage that looks fixed but isn't. A real fix is a protocol-wide versioning primitive, which is its own
architectural decision (new ADR-scale work: what a version mismatch should DO — refuse to sync? warn and
degrade? — is a product question, not something to decide as a side effect of this addendum).

**Recorded consequence, not swept under D1-D5's "no new failure mode" framing:** an old Client racing a
same-name create against a new Host will hang 10s, then queue-retry forever, identically to the *pre-fix*
behavior this whole ADR exists to close — the fix is real for a fully-upgraded fleet and absent for a
mixed one. This is an accepted, known gap during any rolling upgrade window, not a regression this
addendum introduces.

**Confidence: Medium-high** on the accept decision itself (consistent with this protocol's own established
precedent, and scoping a fix to one message type while the general problem stays open is not defensible
engineering). **Lower** on how large the real-world exposure is — this repo has no telemetry on how long a
camp's fleet typically stays mixed-version after an update ships, so "how often does this actually bite
someone" is genuinely unknown, not just unstated.

### Remediation ticket list (dependency-ordered)

| Ticket | Scope | Depends on | Gate notes |
|---|---|---|---|
| **T7 — Restore-path collision guard (Finding A)** | `detectUniqueFieldCollision` check in `restoreEntity` before its transaction; `handleRestoreRequest` forwards `field`/`existing` on the error branch. Unit test: colliding restore returns `{error:'unique_field', field, existing}`, zero ops appended, zero rows changed. | T1 (already shipped) | Independent of T8/T9 — different call site, can land in parallel |
| **T8 — Sanitize `op_rejected` across IPC (Finding E)** | `sanitizeOpRejectedForIpc` in `main.js`, applied at the `onOpRejected` wiring; doc-comment update on `UNIQUE_FIELD_ENTITIES`; mirror test of `main.test.js:1025`. | none | Independent, small, can land anytime |
| **T9 — B+C combined: name-first guard + purge-scope narrowing** | (a) `UNIQUE_FIRST_FIELD` guard + parity test in `setupCrudRepository.js`/`createRecord`. (b) `flushQueue`'s rejected-branch: check local row existence before purging siblings; purge only on the create case (no local row); let edit-case siblings proceed. New tests: offline edit (rename+capacity, rename collides) keeps the capacity write queued and eventually applied; offline create (unchanged) still purges all siblings. | T1 | Red Hat re-review recommended — this is the queue-behavior-changing slice, same bar the original ADR set for T3 |
| **T10 — Atomic purge (Finding D)** | Wrap T9(b)'s (now create-case-only) purge loop in one `db.transaction()`. | T9 | Trivial, fold into the same PR as T9 |
| **T11 — Doc hygiene** | Flip ADR frontmatter `implementation_state` from `not-started`; fix "design only, no code written this round" body text; add `electron/main.js`, `electron/preload.js`, `src/localClient.js`, `src/App.jsx` to the "Files/functions changed" table; note the two-client race test lives in `electron/sync/syncClient.test.js` (`describe('locations UNIQUE(camp_id, name) collision rejection (D2/D3/D4/D5)')`, the `'two-client race'` test), not `test/integration/`. | T1-T10 land | Do this LAST, once T7-T10 are actually merged, so the flipped state is true when it's flipped |
| **T12 — Restore-refusal legibility (Finding A gap, Red Hat re-review, MEDIUM)** | `requestRestore`'s interactive branch now forwards `field`/`existing` alongside `error` (conditionally, so the other four error strings stay byte-identical); `TrashScreen`'s `OUTCOME_COPY` gained a `unique_field` entry with honest, permanent, actionable copy (names the collision when `existing.name` is present, generic-but-honest otherwise) covering both the interactive notice and the queued-restore list item, replacing the misleading transient-sounding fallback. No `pending_restores` schema change. Also: `App.jsx`'s offline-rejection banner z-index dropped below the modal overlay's (900 < 1000) so it never covers a modal's own controls; a comment notes the single-scalar "latest rejection wins" banner behavior is accepted, not a queue. | T7 | Confirmed the gap first: the crash fix (T7) shipped correctly, but the director-facing message stayed misleading until this closed |
| **(optional, not a ticket)** | Extend the ADR's one-time pre-ship blank-name-row diagnostic into a standing pre-release check, per Decision B's residual-risk acceptance. | — | Product/process decision, not code — raise with whoever owns the release checklist |

### Open questions for Governor

1. **Decision B accepts a residual Host-side gap** (non-`createRecord` callers could still trigger the
   ordering hazard) rather than building atomic multi-field creates now. This is an effort-vs-risk
   tradeoff with no currently known trigger — confirm this is an acceptable scope boundary for this
   addendum, or direct that atomic-create work be scoped as its own follow-up ADR.
2. **Finding F is accepted as-is** (no version handshake). If there is a near-term plan to ship a
   protocol-versioning primitive for other reasons, this decision should be revisited then rather than
   treated as a permanent design position.
3. The director-visibility question for an offline rejection (currently `console.error` only) is
   explicitly out of this addendum's scope per the task brief — noted here only so it isn't lost: T9's
   fix changes *which* writes survive a rejection, but does not change *whether* the director is told
   about a queued rejection at all. That remains open.
