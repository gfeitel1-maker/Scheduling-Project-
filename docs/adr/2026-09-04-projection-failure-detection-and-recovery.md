---
title: "ADR: Projection failures must be detected as a distinct, queryable ledger and recoverable by entity-scoped replay from the op-log"
document_type: adr
status: accepted
authority: normative
implementation_state: proposed
date: 2026-09-04
deciders: [product-owner]
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs: []
related_tickets: []
related_adrs: [docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md, docs/adr/2026-08-12-drag-live-write-serialization.md, docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md, docs/adr/2026-08-15-locations-concurrent-create-collision.md]
supersedes: []
affects: []
---

# ADR: Projection failures must be detected as a distinct, queryable ledger and recoverable by entity-scoped replay from the op-log

**Status: ACCEPTED — design only, no code written yet.**

## Context

`applyRemoteOp` (`electron/sync/syncClient.js:525`) deliberately commits the op-log INSERT in its
own transaction *before* running `applyProjection` (`electron/ops/projections.js:838`), specifically
so a projection failure can never undo op-log durability (comment at `syncClient.js:526-533`). That
half of the design is sound and this ADR does not touch it.

The other half is not sound: when `applyProjection` (or `applyBulkReplaceProjection`) then throws,
the error is caught, `console.error`-logged, and execution moves on to the next op
(`syncClient.js:601-638`, two catch branches — one specific to a blocked `DELETE` at 616-621, one
general at 632-637). Nothing records *that* this happened anywhere the app can query. The comments
in that code already name the consequence explicitly: *"this device is now out of step for that
record... forever."*

Existing watermark machinery does not cover this. `devices.last_synced_seq`
(`docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md`) tracks **delivery** — did this
device receive and log the op — not **materialization** — did it actually land in the projected
table. A device can be fully caught-up on delivery while silently wrong in the projected tables it
serves to the UI. There is no `rebuildProjection`/`reproject`/`replayFromSeq` anywhere in the
codebase (confirmed by grep) — no recovery path exists at all today.

Two real incidents already trace to this failure class: the schedule-slot drag divergence
(`docs/adr/2026-08-12-drag-live-write-serialization.md`) and the `week_*_exclusions` silent-drop bug
(`electron/ops/projections.js:8-14`, fixed by a bespoke `ensureWeekJoinRow` reconstruction specific
to that one join-table shape — not a general answer).

**Hard constraint carried forward:** `docs/adr/2026-08-12-drag-live-write-serialization.md`
established that op replay must be **seq-ordered identically on every device** — the mutually-exclusive
field eviction step in `applyProjection` (`projections.js:895-901`) is explicitly built on that
invariant. This design does not change what an operation looks like on the wire or in the log, and
it preserves seq-order-per-entity for every replay it performs. No write-shape change proposed;
none required.

## Decision

### 1. Detect: a `projection_failures` ledger, not a per-entity success watermark

Track **failures**, not successes. A per-entity/per-op "last successfully projected" marker that
advances on every successful projection would grow with every op ever applied — for a mature camp
that's effectively the size of `operations` itself, duplicated. Projection failure is meant to be
rare (the two historical incidents are the only production cases on record); a ledger sized to
`O(failures)` rather than `O(all ops)` is the smaller, cheaper structure that still answers the
question this ADR exists to answer: "is this device out of step, and where."

New local-only table (schema version bump, `electron/db/schema.sql` + `localDb.js`
`CURRENT_SCHEMA_VERSION` 54 → 55):

```sql
CREATE TABLE IF NOT EXISTS projection_failures (
  op_id TEXT PRIMARY KEY REFERENCES operations(id),
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  error_message TEXT NOT NULL,
  failed_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_projection_failures_unresolved
  ON projection_failures(entity, entity_id) WHERE resolved_at IS NULL;
```

- `op_id` is the primary key: re-encountering the same failure (e.g. a repair attempt that fails
  again) is `INSERT ... ON CONFLICT(op_id) DO UPDATE SET error_message=?, failed_at=?` — idempotent,
  no duplicate rows.
- This table is **local diagnostic state, never synced**: it must NOT be added to
  `DOMAIN_SNAPSHOT_TABLES` (`syncClient.js:33-47`) and must NOT be written through `appendOp`/the
  op-log. It answers "is *this device* out of step," which is inherently per-device information —
  syncing it would misrepresent one device's local failure as camp-wide state. Same category as
  `devices.last_synced_seq`: real, load-bearing, and deliberately unreplicated.
- Both existing catch branches in `applyRemoteOp` (`syncClient.js:616-621` and `632-637`) gain one
  write each: insert into `projection_failures` with the op's `id`/`entity`/`entity_id`/`field` and
  `err.message`. This is strictly additive to the existing `console.error` calls — it does not change
  when or whether a projection failure is caught, only what happens after.
- Read side: a `checkProjectionHealth()` query (`SELECT * FROM projection_failures WHERE resolved_at
  IS NULL`) is the detection primitive. Cheap, indexed, safe to run on app boot or on-demand.

### 2. Recover: entity-scoped replay, not full-log rebuild

**Recommendation: targeted (entity-scoped) rebuild, not a full replay from seq 0.** The prompt asks
whether full rebuild is acceptable as v1 "if partial/targeted rebuild is materially harder" — it is
not materially harder here, and it is strictly safer, so targeted is the v1 design, not a deferred
optimization.

Why it's safe: `idx_operations_entity ON operations(entity, entity_id, field)`
(`schema.sql`) already lets `SELECT * FROM operations WHERE entity = ? AND entity_id = ? ORDER BY seq
ASC` run as an indexed range scan, bounded by that one entity's op history — not the whole log.
Replaying exactly that ordered sequence through `applyProjection` reproduces the row's current state
by construction: `ensureExists` recreates the row if a prior `DELETE_FIELD` op removed it and a later
op recreates it, sequential field `UPDATE`s land in the same order they did originally, and the
mutually-exclusive eviction step (`projections.js:895-901`) still runs seq-ordered *within this
entity*, which is the exact scope its own correctness argument depends on — nothing about it assumes
other entities' ops are interleaved in the replay.

Why *not* full-log replay as the default: full replay from seq 0 must also preserve global seq order
to stay correct (per the same load-bearing invariant), which means truncating and rebuilding every
projected table from empty, in one pass, before any of them are queryable again — a stop-the-world
operation. Its cost scales with total `operations` row count, and **this project cannot currently
state that count for a mature camp** — there's no existing instrumentation or production data to
extrapolate from, and guessing a row-count threshold here would be exactly the kind of unverified
claim `org-source-verification` flags. Recommendation: don't gate on a guessed number — ship the
entity-scoped path as the only recovery mechanism for v1, and treat "do we ever need whole-db
rebuild" as a question to answer later from real `SELECT COUNT(*) FROM operations` telemetry once a
camp's log is old enough to matter, not from a number picked now. Named as a follow-up, not built.

Recovery primitive:

```js
// electron/ops/projections.js (or a new electron/ops/projectionRepair.js)
export function repairProjectionForEntity(db, entity, entity_id) {
  const ops = db
    .prepare('SELECT * FROM operations WHERE entity = ? AND entity_id = ? ORDER BY seq ASC')
    .all(entity, entity_id)
  let lastError = null
  for (const op of ops) {
    try {
      if (isBulkReplaceOp(op)) {
        applyBulkReplaceProjection(db, op) // already a self-contained delete+reinsert
      } else {
        db.transaction(() => applyProjection(db, op))()
      }
      lastError = null
    } catch (err) {
      lastError = err // keep replaying later ops for this entity; don't abort the pass
    }
  }
  if (lastError) {
    db.prepare(
      `INSERT INTO projection_failures (op_id, entity, entity_id, field, error_message, failed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(op_id) DO UPDATE SET error_message = excluded.error_message, failed_at = excluded.failed_at`
    ).run(/* the op that failed last, for this entity */ ...)
    return { ok: false, reason: lastError.message }
  }
  db.prepare('UPDATE projection_failures SET resolved_at = ? WHERE entity = ? AND entity_id = ? AND resolved_at IS NULL')
    .run(new Date().toISOString(), entity, entity_id)
  return { ok: true }
}
```

Each op is applied in its own transaction (matching the existing `projectOnce` pattern at
`syncClient.js:591`), so a failing op mid-replay doesn't roll back the ops that succeeded before it
in the same pass — the loop keeps going and reports the *last* failure, mirroring the FK-delete
scenario the existing catch comment describes (something still refers to a row this device can't yet
delete; a later repair, run after that referrer is itself resolved, succeeds).

**Trigger points — decided.** `repairProjectionForEntity` runs automatically once a
`sendMissedOps` catch-up batch finishes applying (`syncClient.js`), scoped to just the entities that
had a row written during that batch. This is the moment a previously-blocked FK dependency is most
likely to have just arrived, and it needs no user action or new UI. It is **not** a director-facing
action in v1 (see Open Questions, now resolved below) — the only other caller is the Machine Access
Program's MCP surface, for support/debugging use, gated the same way `ingest_commit` already is
(`--allow-write`). Immediate retry inside the same `applyRemoteOp` catch block is still not proposed
— the blocking condition (missing parent, concurrent delete) won't have changed one line later within
the same batch.

### 3. Interface-contract checklist (`org-interface-contracts`)

Two new surfaces, both IPC (`window.shoresh.*`), both gated the same as other admin-facing calls:

- **`checkProjectionHealth()`** (read-only). No idempotency concern (pure read). Error shape:
  resolves to `{ failures: [...] }` or throws on genuine IO error, consistent with other read IPC.
- **`repairProjectionEntity(entity, entity_id)`** (mutating).
  - *Idempotency*: yes — replaying the same op sequence twice produces the same end state
    (`applyProjection` is idempotent by construction, per the confirmed evidence); a second call
    after a successful repair is a cheap no-op that re-derives the same rows.
  - *Concurrent retries*: better-sqlite3 is synchronous with a single writer connection per process
    and WAL mode (`localDb.migrations.test.js:379-381`); two `repairProjectionEntity` calls for the
    same `entity_id` in flight on one device serialize through that single connection — no separate
    locking needed. Two *different devices* independently repairing the same entity is safe by the
    same idempotency argument each is reconstructing from its own local op-log, not writing new ops.
  - *Unknown outcomes*: returns `{ ok: false, reason }` rather than throwing when replay still fails
    partway — matches `authorize()`'s established `{allowed: false, reason}` shape. A caller can
    retry safely; retrying doesn't compound partial state because each attempt fully re-derives the
    row from history rather than patching forward from wherever the last attempt stopped.
  - *Error shape*: as above — no bare throw, no silent `undefined`.
  - *Scope/authority boundary*: not exposed as a renderer-facing IPC call in v1 (see Product
    decisions #3) — invoked internally after catch-up sync and via the MCP support surface only,
    which uses the existing `--allow-write` gate rather than `authorize()`'s role model.
  - *Trust boundary*: `entity`/`entity_id` arguments are validated against `PROJECTIONS` (the same
    registry `applyProjection` already checks) before the query runs, so an invalid entity name is
    rejected rather than executing an unbounded scan.

### 4. Regression test (proves detection AND recovery)

Using the FK-delete scenario the existing code comment already names as the reachable case:

1. Seed two devices' worth of op-log state (or a single test db acting as a receiver) such that a
   `locations` row is referenced by some `template_slots` row the receiving device already has, but
   the Host's delete op for that location arrives before the referencing slot's own deletion.
2. Call `applyRemoteOp` with a synthetic remote delete op for that location. Assert:
   - the op-log row exists in `operations` (durability preserved, per existing behavior/tests).
   - a row now exists in `projection_failures` with `entity='locations'`, the right `entity_id`, and
     `resolved_at IS NULL`.
   - the `locations` row is still present in the projected table (delete did not silently "succeed").
3. Remove the blocking referencer (simulate the referencing slot's own delete op arriving, as would
   happen once that op replicates).
4. Call `repairProjectionForEntity(db, 'locations', <id>)`. Assert:
   - the location row is now deleted from the projected table.
   - the `projection_failures` row for that op now has `resolved_at` set (or the row is gone,
     whichever the implementation picks — pick one and assert it).
5. Negative case: a normal, successful remote op (no blocking condition) must NOT create any
   `projection_failures` row — asserts the instrumentation doesn't false-positive on the happy path
   that's already covered by existing `syncClient`/`projections` tests.

## Out of scope

- **Not proposing richer atomic domain operations** (e.g. a multi-row transactional op primitive
  replacing field-level ops). That's a separate, deferred concern per the repo owner and is
  explicitly not what this ADR addresses — this is detection and recovery *given* the existing
  field-level op shape, not a redesign of it.
- **Not proposing cross-device projection verification** (e.g. digest/merkle comparison between
  Host and Client materialized state). That would catch a class of divergence this design does not
  — silent data corruption with no thrown error at all — but adds a new sync-protocol message and
  device-coordination surface. Worth a future ADR if the failure-ledger approach in production shows
  drift this design's error-catching can't see (i.e. divergence with no exception ever thrown).
- **Not proposing UI surfacing** of unresolved `projection_failures` rows. Decided (see Product
  decisions below): stays a backend/MCP-observable state in v1, not director-facing.
- **Not building the IPC handlers, migration, or tests** — this ADR names them; Maker builds them
  from a Governor-issued brief.

## Product decisions (resolved 2026-09-04)

The three open questions below were decided by the product owner rather than left to Maker's
discretion, per this repo's workflow rule that consequential choices get a stated recommendation and
an explicit decision, not silent implementation judgment.

1. **UI surfacing: support/debug-only, not director-facing, in v1.** No banner, no settings-screen
   indicator. `projection_failures` rows are visible only via `checkProjectionHealth()` reached
   through the Machine Access Program's MCP surface (`docs/current/PLATFORM_STATE.md`'s
   `list_entities`-style tooling), for use during dogfooding and support. Rationale: this app has no
   live camps yet (see `feedback_preproduction_bias_bold`) and zero production incidents of this
   failure mode to date — building director-facing chrome for a problem with no observed real-world
   frequency is speculative UI. Revisit once dogfooding or a live camp actually produces a row here.
2. **Escalation on repeated failure: none built for v1.** No retry-limit, no alerting, no
   human-visible escalation path. An unresolved `projection_failures` row that repair cannot clear
   (e.g. the blocking referencer was created offline and never submitted) simply stays unresolved as
   a queryable diagnostic breadcrumb. Rationale: same as above — this is designing a safety net for a
   failure-of-a-failure-recovery scenario with no recorded incidents; add it if and when dogfooding
   produces a stuck row, not speculatively now.
3. **Repair trigger and authority: automatic, after catch-up sync, not director-facing.** As specified
   above — `repairProjectionForEntity` fires automatically for entities touched by a completed
   `sendMissedOps` batch. The only manual entry point is the MCP surface (support-tooling authority,
   `--allow-write` gated), not a renderer-facing IPC call. `authorize()`'s role model is therefore
   unaffected for v1: `repairProjectionEntity` is not exposed to `window.shoresh.*` at all yet. Add
   the director-facing/renderer IPC path only if decision 1 is revisited later.

## Reused vs. new

- **Reused**: `idx_operations_entity` (existing index, no schema change needed for the read side of
  recovery), `applyProjection`/`applyBulkReplaceProjection` (unchanged — replay is just calling them
  again in order), the existing two catch sites in `applyRemoteOp` (instrumented, not restructured),
  `authorize()` (existing IPC gate, no new authority model).
- **New**: `projection_failures` table (schema v55), `repairProjectionForEntity` function,
  `checkProjectionHealth`/`repairProjectionEntity` IPC handlers.
