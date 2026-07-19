# Users/Camps Cross-Machine Sync — Design

**Date:** 2026-07-19
**Status:** Approved — implementation plan to follow

## Context

During Task 8's review loop (GOVERNOR multi-agent loop building Shoresh's local-first architecture — see `docs/superpowers/specs/2026-07-19-local-first-desktop-architecture-design.md` and `docs/superpowers/plans/2026-07-19-local-first-desktop-architecture.md`), a real gap surfaced: a Client machine's local SQLite `users`/`camps` tables are never populated from the Host. The `operations` table (Task 2) only ever gets written to — nothing projects an op's effect onto the actual domain table it describes (`users`, and eventually `template_slots` etc.). `verifyPin` (Task 3) reads `users` directly, so without this, login on a fresh Client machine can never succeed.

This spec covers the fix: making user accounts genuinely sync across Host/Client machines, peer-editable like schedule data, plus a one-time full-sync mechanism so a newly-paired Client isn't stuck waiting for incremental ops to slowly repopulate a table that starts out empty.

## Decisions Locked In

- **Auth model:** `users` rows are peer-editable — any device (Host or Client) can create/edit accounts, even offline, with conflicts resolved the same way schedule data is (online lock via Task 4/5, offline branch-and-merge via Task 2's op-log and Task 10's merge screen).
- **Projection mechanism:** general-purpose, not users-only. A small registry maps entity names to `{ table, key }`; both `appendOp` (local writes) and `syncClient.js`'s remote-op handler consult it and, after logging an op, also update the real table row. `users` is registered now; other entities (`template_slots`, etc.) register the same way whenever a later task needs them — one mechanism, not two.
- **PIN conflict display:** when a conflict is on `users`/`pin_hash` or `users`/`pin_salt`, the merge screen shows "PIN changed on Device A vs Device B" (device/author/timestamp only) — never a raw hash or plaintext. `name`/`role` conflicts show the actual conflicting values as normal.
- **Camps:** stays a simple directly-replicated row, not collaboratively edited. Created once via the existing `shoresh:bootstrap-camp` handler (Task 8 round 2), transferred to Clients via the full-sync message below. There's exactly one camp row per install and it rarely changes, so peer-edit machinery would be overhead with no real benefit.
- **New-device bootstrap:** a full-sync mechanism, separate from incremental op-log sync, transfers the Host's current `users`/`camps` table contents to a Client the first time it successfully authenticates. Ongoing changes after that flow through the normal op-log.

## Components

| Component | Responsibility |
|---|---|
| `electron/ops/projections.js` (new) | `PROJECTIONS = { users: { table: 'users', key: 'id' } }` registry. `applyProjection(db, op)`: if `op.entity` is registered, runs `UPDATE <table> SET <field> = ? WHERE <key> = ?` with `op.value`/`op.entity_id`. |
| `electron/ops/operations.js` (modify, additive) | `appendOp` calls `applyProjection(db, op)` after logging the op, before returning. |
| `electron/sync/syncClient.js` (modify) | `applyRemoteOp` calls `applyProjection(db, op)` after the existing `INSERT ... ON CONFLICT DO NOTHING` into `operations`. New: handle a `full_sync` message — validate shape (arrays of user/camp row objects with expected string/known fields, same defensive pattern as `op_applied`), then `INSERT OR REPLACE` each row into local `users`/`camps`. |
| `electron/auth/localAuth.js` (modify) | `createUser` no longer does a single direct `INSERT`. It generates a new user id, then calls `appendOp` once per field (`name`, `pin_hash`, `pin_salt`, `role`, `camp_id`), each with `parent_op_id: null`. `applyProjection` (triggered inside `appendOp`) is what actually creates the row. Duplicate-name detection (Task 3's `UNIQUE(camp_id, name)` index) now surfaces as a constraint violation during the `name` field's projection `UPDATE`/insert path rather than a single `INSERT`'s constraint violation — same user-facing error, different code path. |
| `electron/sync/syncServer.js` (modify) | After a connection's `authenticate` succeeds, check `devices.last_synced_at IS NULL` for that device. If so, send `{ type: 'full_sync', users: [...], camps: [...] }` (current full row contents from the Host's tables) before any other traffic, then update `devices.last_synced_at`. |
| `electron/db/schema.sql` (modify, additive migration) | Add `last_synced_at TEXT` column to `devices` (via a new `schema_migrations` version, using Task 1's versioning hook). |
| Merge screen (Task 10, not yet built) | When `conflict.incomingOp.entity === 'users'` and `field` is `pin_hash`/`pin_salt`, render "PIN changed on [author A] vs [author B]" instead of the raw values. Other fields render normally. |

## Data Flow

**Creating/editing a user:** `createUser`/an edit call → one `appendOp` per changed field → each op is logged to `operations` and immediately projected onto the real `users` row via `applyProjection` → if connected to a sync server, each op also goes through the existing lock-then-broadcast path (Task 4/5) so other connected devices receive and apply it the same way.

**Client pairing for the first time:** Client connects → sends `authenticate` → Host verifies token → Host checks `devices.last_synced_at IS NULL` for this device → sends `full_sync` with current `users`+`camps` contents → Client bulk-loads them via `INSERT OR REPLACE` → Host marks `last_synced_at` → normal incremental op-log sync (`op_applied`/`op_conflict`) proceeds for everything after.

## Error Handling & Edge Cases

- **Malformed `full_sync` rows:** validate each row's shape individually (same lesson as Tasks 5/6's `op_applied` validation) — skip a malformed row rather than failing the whole batch or crashing the process.
- **Duplicate `full_sync` delivery** (e.g. a `last_synced_at` bug re-triggers it): `INSERT OR REPLACE` makes this idempotent — a redundant full-sync is harmless, not a duplicate-row error.
- **Two devices create a new user with the same name offline:** the second device's `name`-field op hits the existing `UNIQUE(camp_id, name)` constraint during projection — this surfaces as a real, user-visible conflict requiring a rename, not a crash; same underlying protection Task 3 already built, just reached via the op path now instead of a direct `INSERT`.
- **A field-level op arrives for an entity not yet locally known** (e.g. a `role` op for a user id the local device has never seen, because `full_sync` hasn't happened yet or was skipped): `applyProjection`'s `UPDATE ... WHERE id = ?` simply affects zero rows — no crash, but the field is silently not materialized. This is expected to be rare given full-sync always precedes ordinary op traffic for a new device; not solved further in this design.

## Testing Strategy

- Unit tests for `applyProjection`: registered entity produces the expected `UPDATE`; unregistered entity is a no-op; a field op for a nonexistent row affects zero rows without throwing.
- `createUser`'s existing test suite (`localAuth.test.js`) should continue passing unchanged — behavior is observably identical from the caller's perspective (a user row exists afterward with the right fields), only the internal mechanism (ops vs direct insert) changes.
- `full_sync`: a real client+server round-trip test (server has existing users/camps, a fresh client connects, authenticates, and ends up with matching local rows) plus defensive-validation unit tests for malformed row shapes (mirroring the `op_applied` test pattern from Task 6).
- Duplicate-name-via-op-path test: two `appendOp` calls for `name` with the same `camp_id`+value, confirm the second surfaces a constraint violation rather than succeeding silently.

## Out of Scope

- A general "snapshot transfer for all entities" mechanism (the original architecture spec's Data Flow section mentions this conceptually for future entities like `template_slots`, but building that out is Task 9/10's concern when they need it — this spec only builds the users/camps-specific full-sync message, using the same `PROJECTIONS` registry those later tasks will also register into).
- Camp-level editing/renaming UI or op-log integration for `camps` beyond the one-time bootstrap+full-sync transfer.
- Revoking/deleting user accounts, and any cascade behavior for it (still an open, separately-tracked gap from Task 3/4's reviews — staff turnover, `ON DELETE` policy).
