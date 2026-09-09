---
title: "Retiring six WebSocket integration scenarios — the reasons, one per scenario"
document_type: evidence
status: active
created: 2026-09-08
task: docs/work/plans/2026-09-07-stage6-cutover-plan.md
archive_when: the WS layer is removed and these files are deleted with it
---

# Retiring six WebSocket integration scenarios

The Stage 6 plan is explicit that this is a decision to record, never a silent deletion:

> Scenarios that test WS-specific mechanics … either map onto a libp2p equivalent or are explicitly
> retired with a stated reason — **retiring a scenario is a decision to record, never a silent
> deletion.**

So: one section each, with what the scenario protected, why it has no libp2p equivalent, and where
that protection now lives. **Every claim below was checked against the code, not inferred from the
scenario's title** — one of them (12) turned out to be a different kind of retirement than expected
once checked.

**Status of the 27.** 20 are covered by the 17 ported libp2p scenarios. 6 are retired here. 1
(scenario 18, restore) is **deferred, not retired** — see the end.

---

## 03 — "Host applies an op exactly once even when the client retries"

**Protected:** `handleSubmitOp`'s idempotency path — a client retrying a submission with the same
`client_write_id` must not produce two rows.

**No equivalent, because there is no submission.** A device does not send operations for the Host to
apply once; it merges documents. Automerge changes are content-addressed, so re-delivering the same
change is inherently a no-op.

**Checked, not assumed:**

```
after 1 delivery  : {"name":"Swim"}
after 3 deliveries: {"name":"Swim"}
changes recorded  : 2      (not 4 — the repeats added nothing)
```

**Where the protection lives now:** in the data model rather than in a code path, which is why there
is nothing left to test. `client_write_id` itself becomes vestigial when the op-log goes.

---

## 09 — "Duplicate and out-of-order messages"

**Protected:** server-side deduplication of two `pending_writes` sharing a `client_write_id`, and
correct handling of messages arriving out of order.

**No equivalent, for two separate reasons.** Duplicates: same as 03 above. Ordering: the Automerge
sync protocol is a stateful per-peer conversation that tracks what each side has acknowledged — it
does not depend on messages arriving in order, and where ordering *within* a conversation matters,
`transport.js` serialises sends per peer (added after a real out-of-order bug found earlier in this
migration).

**Where the protection lives now:** `syncProtocol.test.js` for the exchange, and the per-peer send
chain in `transport.js`.

---

## 06 — "Client hundreds of ops behind — Host catches it up"

**Protected:** the catch-up path — a Host computing which ops a returning client had missed, from a
delivery watermark.

**No equivalent, because there is no backlog to compute.** There is no per-client watermark and no
"missed ops"; the sync protocol derives what the other side lacks from its own state, every time,
whether it has been away for a minute or a season.

**Where the protection lives now:** ported scenario **02** (a device writes offline and converges on
reconnect) and ported scenario **13** (the Host vanishes mid-exchange; both sides' work survives).
Those are the behaviour a director experiences; the watermark was the mechanism.

---

## 10 — "Lock holder crashes, lock expires"

**Protected:** the lock manager — a device holding a field lock, and that lock being released when
its WebSocket closed.

**No equivalent, and the module goes with the transport.** Checked: `electron/sync/lockManager.js`
has exactly **one** caller in the whole tree, `syncServer.js`. It is WebSocket machinery, not a
domain feature, and it is deleted along with the WS layer in 6c.

The product need it served — two people not editing the same cell at once — is now met differently
and better: concurrent edits are allowed, and a genuine disagreement is surfaced for a human
(`docs/adr/2026-09-08-crdt-conflict-reconciliation.md`) rather than prevented by a lock that a
crashed device could hold.

---

## 12 — "Schema migration with pending writes"

**Retired for a different reason than expected, which is why it was checked.** The assumption was
that this tested a schema handshake between devices. It does not — **neither transport has ever
handshaked schema versions.** Grepping `syncServer.js`/`syncClient.js` and the whole
`sync/automerge/` tree for a schema version returns nothing on either side.

**What it actually tests** is `openLocalDb` running migrations correctly when writes are pending —
local database behaviour that has nothing to do with sync. The "pending writes" half is the op-log
queue, which is going.

**Where the protection lives now:** the dedicated migration tests, which are more thorough than this
scenario was — `localDb.migrations.test.js` plus ~30 per-migration test files in `electron/db/`.

---

## 24 — "Device FK seeding, delivery-watermark truth, and Host-local broadcast"

**Partially retired**, and the split matters.

**Retired:** the delivery watermark and the Host-local broadcast. Both are WebSocket bookkeeping —
there is no watermark, and a "Host-local broadcast" is meaningless when every peer is symmetric.

**NOT retired — deferred, and it comes back:** the device FK seeding half. Its concern was that a
row referencing a `device_id` with no `devices` row causes an FK error. That does not arise today,
because nothing writes op rows from a received merge. **It arises again the moment the local history
ledger is built** (the agreed narrowing of 6d), which will write op rows from merges and therefore
needs the peer-to-device mapping to be sound.

**Recorded so it is not lost:** the ledger slice must cover it, and `devices.libp2p_peer_id` is the
mapping it will use.

---

## Deferred, not retired: 18 — "Restoring a deleted record from a Client"

`18-restore-queue.automerge.js` is written, correct, and **fails** — on a real gap rather than
anything it can fix. `trash.js` and `restore.js` answer their questions by querying the `operations`
table, so a device that RECEIVED a deletion has no rows for it and cannot restore it. That is broken
today and would be broken worse by removing the op-log.

It is left in the tree and out of the runner. It is the exit criterion for the history-ledger slice.
See `docs/current/CRDT_SECURITY_GAPS.md` item 7.

---

## Four more, found late: the `*.sync.test.js` files

These were not on the original list of 27. They are Vitest files living in `electron/sync/` that
stood up a real `syncServer` + `syncClient` pair, so they could not survive the transport either.

They were missed by the first dangling-import sweep after the deletion, because its regex required a
`sync/` path prefix and these files import their siblings as `'./syncServer.js'`. A peer session's
unrelated warning about `grep` prompted a re-sweep that found them. Recording the miss because the
lesson is the sweep, not the files: **a negative search result is a claim, and this one was wrong.**

| File | What it proved | Where that lives now |
|---|---|---|
| `scheduleE2E.sync.test.js` | a schedule survives a Host→Client round trip | ported scenarios 11, 17, 19 |
| `bulkReplace.sync.test.js` | a scope replacement replicates atomically | scenarios 11 and 19 both drive `applyBulkReplace` across two devices |
| `provenance.s2a.test.js` | a Client could not forge `import` provenance | **nowhere — see below** |
| `restore.sync.test.js` | a restore on a Client matches one on the Host | **nowhere — see below** |

### Two of those four are genuine coverage gaps, not retirements

Saying so plainly rather than letting the table imply otherwise.

**`provenance.s2a.test.js`** tested the op-log's Security V1: the Host FORCED `source: 'human'` on
every submitted op, so a Client could never inject `import`. There is no CRDT equivalent, and the
reason is bigger than the test — the document carries no provenance at all. Recorded as item 8 in
`docs/current/CRDT_SECURITY_GAPS.md`, where the consequence is a director's hand edit being silently
reverted by a later re-import.

**`restore.sync.test.js`** is the same ground as deferred scenario 18. Restore on a receiving device
is broken today, and this file was the last thing testing it. Its exit criterion is the history
ledger, and it should be rewritten against libp2p as part of that slice rather than left implied.

---

## What retiring these does NOT mean

The WS scenario files were deleted with the transport in 6c, and this document is what explains
their absence. `SHORESH_SYNC_ENGINE=oplog` is no longer selectable: there is no second engine to
select. What remains of the op-log is the `operations` table, kept as a LOCAL history ledger for
Trash and record history — same table, different job, and only the sync mechanism retired.
