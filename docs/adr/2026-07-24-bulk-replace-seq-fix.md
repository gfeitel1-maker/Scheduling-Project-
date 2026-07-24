# Bulk-replace conflict detection must compare Host-canonical seq, not raw local seq

**Status:** accepted

## Context

`operations.seq` is `INTEGER PRIMARY KEY AUTOINCREMENT` — a counter local to each device's own SQLite file, not a shared numbering space. `detectBulkReplaceConflict` (Host-side) and `computeBasedOnSeq` (Client-side) both call `latestScopeOpSeq`, which does `MAX(seq)` against whichever db it's invoked on. The Client sends its local `based_on_seq` to the Host, which compares it against its own `MAX(seq)`. These are two unrelated counters compared as if they were one — they only coincide by accident. Confirmed effect: building then regenerating a schedule (`bulk_replace`, same scope, same client) spuriously conflicts almost always, because the Host's op-log always has bootstrap/user/group/activity ops ahead of the first schedule op that the Client's own local numbering never had.

The project already hit a version of this problem once: `flushQueue`'s reconciliation compares op history using `parent_op_id`/`id` chains, not raw `seq`, specifically because two SQLite files' autoincrement counters aren't the same space. That precedent could argue for abandoning seq-comparison here too. But `flushQueue`'s problem is reconciling two independently-diverging write histories with no single source of truth between them — a genuine two-counter arbitration problem, which is why a linear chain comparison was needed. `bulk_replace`'s conflict check is not that: it always executes on the Host's own db, comparing against a value the Client is merely reporting back. There is exactly one authoritative numbering space (the Host's) — the bug is that the Client's copy of "the last op I saw" was never actually the Host's number, because `applyRemoteOp` let SQLite mint a fresh local `seq` for every incoming op instead of keeping the Host's real value. Chain-based scope-level conflict detection was also already considered and rejected once (see the round-2 design comment above `BULK_REPLACE_FIELD` in `electron/ops/operations.js`): a bulk_replace's "scope" spans multiple entity_ids (the scope_id itself, plus every row id currently in the scope), which has no single linear parent chain the way a per-field op does — that's why `based_on_seq`/`MAX(seq)` was chosen there in the first place.

## Decision

Keep seq-based scope comparison, but make it correct by giving the Client an accurate copy of the Host's canonical seq instead of a fresh local number. Add a nullable `host_seq` column to `operations`. Host-authored rows (via `appendOp`/`appendBulkReplaceOp`, always on the Host's own db) leave it `NULL` — the Host's own local `seq` is already canonical in its own db. `applyRemoteOp` on the Client, which currently discards `op.seq` (the Host's real value, already present in the `op_applied` message) when inserting an incoming op, must instead persist it into `host_seq`. Every query that previously did `MAX(seq)`/compared raw `seq` for bulk_replace scope purposes now uses the effective value `COALESCE(host_seq, seq)`, which degenerates to plain `seq` on the Host (where `host_seq` is always `NULL`, since the Host never runs its own ops through `applyRemoteOp`) and equals the true Host-assigned number on the Client.

## Consequences

- Schema change: `operations.host_seq INTEGER`, migration version 18 in `electron/db/localDb.js`.
- `applyRemoteOp`'s INSERT and `isValidRemoteOp` must both change to carry and validate `op.seq`.
- `latestScopeOpSeq` changes its `MAX(seq)` to `MAX(COALESCE(host_seq, seq))`.
- On the Host's own db this is numerically a no-op (host_seq is always NULL there), so `detectBulkReplaceConflict`'s existing `WHERE seq = ?` row lookups (operations.js, syncServer.js) remain correct unchanged, since they only ever run against the Host's db.
- `detectConflict` (plain field-level path, keyed on `parent_op_id`/`id` equality) is untouched — it never compared raw `seq` across dbs.
- `sendMissedOps`'s `devices.last_synced_seq` watermark logic is untouched — it only compares the Host's own `seq` against a watermark the Host itself previously wrote, entirely within the Host's own db; not part of this bug family.
