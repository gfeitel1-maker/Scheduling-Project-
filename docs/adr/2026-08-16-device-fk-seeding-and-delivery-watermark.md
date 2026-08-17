---
title: "ADR: Device-authored ops must never FK-drop, and the delivery watermark must reflect receiver-applied truth, not sender-sent belief"
document_type: adr
status: accepted
authority: normative
implementation_state: completed
date: 2026-08-16
deciders: [product-owner]
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs: []
related_tickets: [docs/work/tickets/T85-devices-table-never-synced-cross-device-op-drop.md, docs/work/tickets/T86-device-management-handlers-not-host-gated-on-client.md, docs/work/tickets/T87-returning-client-never-reauthenticates-after-restart.md]
related_adrs: [docs/adr/2026-07-25-device-trust-revocation.md, docs/adr/2026-07-24-bulk-replace-seq-fix.md, docs/adr/2026-07-28-first-pairing-domain-sync-and-template-identity.md, docs/adr/2026-08-15-locations-concurrent-create-collision.md]
supersedes: []
affects: []
---

# ADR: Device-authored ops must never FK-drop, and the delivery watermark must reflect receiver-applied truth, not sender-sent belief

**Status: ACCEPTED — design only, no code written yet.** Fixes T85
(`docs/work/tickets/T85-devices-table-never-synced-cross-device-op-drop.md`), verified by Red Hat
during M6 review, 2026-08-16. Two independent, compounding defects in the op-log sync layer: (1) a
receiving device silently drops any op authored by a device it has no local `devices` row for, because
`devices` is never replicated and `operations.device_id NOT NULL REFERENCES devices(id)` is enforced
(`foreign_keys=ON`); (2) the reconnect catch-up watermark (`devices.last_synced_seq`) advances on
transport-send success, not receiver-apply success, so a dropped op is marked delivered and never
retried; (3) the Host's own local writes never broadcast to connected Clients at all. This ADR fixes
all three, at the protocol/application layer only — no schema change.

## Context

`operations.device_id` is `TEXT NOT NULL REFERENCES devices(id)` (`electron/db/schema.sql:173`), and
every device opens its db with `foreign_keys = ON`. `devices` is never replicated: it is absent from
`DOMAIN_SNAPSHOT_TABLES` (`electron/sync/syncClient.js:33-47`), and no production code ever inserts a
**peer's** device row on a receiver — the only inserts are self-registration on the Host
(`electron/sync/syncServer.js:361-363`) and a device's own row on its own machine
(`electron/main.js:163-165` `ensureDeviceRow`).

**Failure 1 — the op-log INSERT itself throws, and the throw is swallowed.** When a receiver applies a
broadcast or replayed op authored by a device it has no `devices` row for, `applyRemoteOp`'s op-log
INSERT (`electron/sync/syncClient.js:451-462`) throws `SQLITE_CONSTRAINT_FOREIGNKEY`. On the live
`op_applied` path, that throw propagates out of `applyRemoteOp` and is caught by the message handler's
`try/catch/finally` (`syncClient.js:684-695`) — caught, but never logged, never retried, never surfaced.
The op is neither logged nor projected: it silently ceases to exist on that device.

**Failure 2 — the watermark is driven by transport delivery, not receiver truth.**
`sendMissedOps` (`syncServer.js:273-321`) advances `devices.last_synced_seq` based on `sendWithAck`
(`syncServer.js:71-103`), which only confirms the underlying `ws.send()` callback fired without error —
i.e. the OS handed the frame to the kernel. It has no idea whether the receiving device's
`applyRemoteOp` actually ran, let alone succeeded. So a dropped op (Failure 1, or any other cause) is
marked "delivered" and is never retried — not on the next reconnect, not ever. Live broadcast
(`handleSubmitOp`/`broadcastOps`, `syncServer.js:557-636`, `753-764`) has no ack at all, but — load-bearing
fact used throughout this design — **the live path never touches the watermark either**; only
`sendMissedOps` does.

**Failure 3 — a Host's own local write never reaches its Clients.** The Host runs both `startSyncServer`
(`main.js:444`) and a no-`serverUrl` `createSyncClient` (`main.js:460`) for its own interactive writes.
That client's `write()`/`writeBulkReplace()` (`syncClient.js:173-219`) call `notifyOpApplied(op)` — a
renderer-only push — and never touch `wss.clients`. `broadcastOps` fires only from handlers for
**incoming** client messages.

Only a fresh full re-pairing recovers from Failure 1 today, because `applyFullSync` writes
**materialized** rows via `INSERT OR REPLACE` (`syncClient.js:410-412`), bypassing the FK entirely. The
project's own integration suite proves the gap: 7 scenarios (04/11/13/18/20/22/23) call a **test-only**
`registerDevice()` (`test/integration/harness.js:425-427`) to hand-insert peer device rows — production
has no equivalent, so the suite cannot exercise cross-device delivery without a workaround production
lacks.

## Divergent exploration

Per this project's `adhd` protocol, five isolated cognitive frames (regulator, adversarial/competitor,
logistics, inversion, ant-colony/emergent-systems) each independently generated candidate mechanisms for
both questions — "how does a receiver handle an op from an unknown device" and "how does the watermark
avoid lying" — without seeing each other's output. Full transcript available on request; the material
convergences and the one alternative that changed this design are summarized here.

**Strong independent convergence (4 of 5 frames), reinforcing the ticket's own Option C:** mint a bare
local stub `devices` row from the op's own `device_id` at the moment of receipt — id + a placeholder
name only, secret and trust columns left absent/NULL — so the FK is satisfiable immediately and
order-independently, with no dependency on any other message having arrived first. The regulator and
ant-colony frames both independently added the same refinement this ADR adopts: the stub's trust-status
value must be a value **outside** the four real `pairing_status` values, so it can never be
misinterpreted downstream as a real, awaiting-review pairing candidate.

**A real alternative that earned serious consideration: quarantine unresolved ops in a side table until
the device row resolves**, instead of seeding a stub inline (regulator, competitor, logistics, and
inversion frames all produced a version of this). **Rejected.** It is strictly worse on every axis that
matters here: it requires a new un-FK'd staging table (schema surface a stub-seed avoids entirely), a
drain/promotion mechanism, and — critically — it still needs the device row to arrive via **some**
channel, which reintroduces exactly the live-device-row-propagation machinery this design deliberately
avoids (see "Option A" below). It defers an op's applyability for no correctness benefit over immediate
stub-seeding, which already guarantees order-independent applyability with zero new schema. Named
explicitly because four independent frames reached for it — it looks like the "safe, defer judgment"
choice, which is exactly why it is worth naming and rejecting on the record rather than silently passing
over.

**A real alternative for the watermark: self-reported frontier instead of per-op ack.** The inversion
and logistics frames converged on "the watermark should be a read of the receiver's own truth, not the
sender's belief" — right, and this design adopts that principle — but their concrete mechanism (Client
periodically reports its own `MAX(seq)` as a high-water mark; Host clamps `last_synced_seq` to it) has a
correctness gap the frames didn't surface: `MAX(seq)` is not the same as "no gaps below this seq." A live
broadcast can apply a higher-seq op while a slower reconnect catch-up is still working through a run of
lower-seq ops, and after that race `MAX(seq)` legitimately overstates what has been contiguously applied.
Making this safe requires either a gap-scan (real cost on a large `operations` table, recomputed on every
report) or maintaining a separate contiguous-frontier counter — more moving parts than the sequential
per-op ack this ADR adopts instead, which sidesteps the gap problem by construction (see Decision, Part
2). Rejected as strictly more complex for no additional correctness the adopted design lacks.

**Rejected as disproportionate: per-op cryptographic signatures / device public-key fingerprints**
(regulator, competitor frames). This project's op-log has no per-op signing today — only the camp session
token is Ed25519-signed, once per session, by the Host
(`docs/adr/2026-07-25-device-trust-revocation.md`). Adding per-op signatures is a materially larger
architectural change than this defect warrants, and it solves a problem this app does not have: `op.device_id`
is already Host-attributed and trustworthy by construction before it ever reaches a receiver — see
Security, below.

## Decision

**Part 1 — Seed a minimal, secret-free stub `devices` row from the op's own `device_id`, inside the
same transaction as the op-log INSERT, unconditionally, for every remote op.** This is the ticket's
Option C, confirmed by independent divergent ideation as the correct minimal mechanism.

`electron/sync/syncClient.js`, `applyRemoteOp`, immediately before the existing `INSERT INTO operations`
inside the same `db.transaction()` (`syncClient.js:451-464`):

```js
db.prepare(
  "INSERT OR IGNORE INTO devices (id, name, pairing_status) VALUES (?, ?, 'unknown')"
).run(op.device_id, `Device ${op.device_id.slice(0, 8)}`)
```

- Same placeholder-name convention already used for Host-side self-registration
  (`syncServer.js:363`: `` `Device ${verified.deviceId.slice(0, 8)}` ``) — no new naming convention
  invented.
- `pairing_status = 'unknown'` is a **deliberate fifth value**, outside the documented four
  (`'pending' | 'authorized' | 'denied' | 'revoked'`, `schema.sql:87-88`) — chosen specifically so this
  row can never satisfy `listPendingPairingRequests`'s filter
  (`` pairing_status IS NULL OR pairing_status = 'pending' ``, `main.js:639`) and never be mistaken for
  a real, awaiting-review pairing candidate anywhere that filter (or an equivalent) is read. No `CHECK`
  constraint exists on this column (confirmed against `schema.sql:58-89`), so this is a safe,
  non-migrating value choice.
- `authorized_at`, `revoked_at`, `device_secret_identifier` are left NULL (column defaults) —
  never set, never inferred, never requested.
- `INSERT OR IGNORE` — if a real row for this id already exists (the device later pairs and is
  self-registered, or this device *is* the one Host that already knows it), this is a safe no-op; it
  never overwrites a real row with a stub, and nothing in this design ever overwrites a stub with more
  complete information later (see Non-goals).

**Part 2 — Gate the reconnect-catch-up watermark on a genuine per-op receiver-apply ack, not transport
delivery.** New Client→Host message `op_applied_ack`, `{ type: 'op_applied_ack', op_id }`.

`electron/sync/syncClient.js`, in the existing `op_applied` message-handler case (`syncClient.js:678-696`),
immediately after the existing `try { applyRemoteOp(msg.op); notifyOpApplied(msg.op) } catch (err) {
opError = err } finally { ... }` block:

```js
if (!opError && ws && ws.readyState === ws.OPEN) {
  ws.send(JSON.stringify({ type: 'op_applied_ack', op_id: msg.op.id }))
}
```

`opError` is non-null **only** when `applyRemoteOp` itself throws — i.e. the op-log INSERT failed. A
projection failure does **not** set it (`applyRemoteOp`'s own internal `catch`, `syncClient.js:484-521`,
already swallows and logs those without rethrowing) — matching this file's own established principle,
stated in its comments: the op-log entry is durable and canonical independent of projection outcome.
"Applied," for watermark purposes, means **the op-log row durably exists on this device** — nothing more,
nothing less. This ack fires identically for a genuinely-new insert and for a deduplicated replay
(`changes === 0`, `syncClient.js:465-469`) — both mean "this op is in my log."

`electron/sync/syncServer.js`, the per-connection WS message dispatcher, alongside the existing
`full_sync_applied` case (`syncServer.js:1032-1039`, which already uses the identical
single-pending-resolver-on-`ws` pattern this reuses):

```js
if (msg.type === 'op_applied_ack') {
  if (ws.pendingCatchupAckResolve) ws.pendingCatchupAckResolve(msg.op_id)
  return
}
```

`sendMissedOps` (`syncServer.js:273-321`), inside its existing per-op loop, add a second, sequential
await after the existing `sendWithAck` transport check:

```js
let lastSuccessSeq = since
for (const op of rows) {
  const sent = await sendWithAck(ws, { type: 'op_applied', op }, ackTimeoutMs)
  if (!sent) break
  const applied = await waitForApplyAck(ws, op.id, ackTimeoutMs)
  if (!applied) break
  if (op.seq > lastSuccessSeq) lastSuccessSeq = op.seq
}
if (lastSuccessSeq !== since) {
  db.prepare('UPDATE devices SET last_synced_seq = ? WHERE id = ?').run(lastSuccessSeq, ws.deviceId)
}
```

`waitForApplyAck(ws, opId, timeoutMs)` — a new helper, same file, modeled on this file's own
`sendWithAck` and on `syncClient.js`'s `withResolverTimeout`/`withKeyedResolverTimeout` idiom (a
resolver registered, a bounded `setTimeout` fallback, first-to-fire wins):

```js
function waitForApplyAck(ws, opId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      if (ws.pendingCatchupAckOpId === opId) {
        ws.pendingCatchupAckResolve = null
        ws.pendingCatchupAckOpId = null
      }
      resolve(result)
    }
    ws.pendingCatchupAckOpId = opId
    ws.pendingCatchupAckResolve = (matchedOpId) => { if (matchedOpId === opId) finish(true) }
    setTimeout(() => finish(false), timeoutMs)
  })
}
```

`sendWithAck` is kept as a fast-fail pre-check (an obviously-dead socket fails in well under
`ackTimeoutMs`, not the full apply-ack timeout) — not required for correctness after the apply-ack gate
exists, but free to leave in place; do not remove it.

**Why this is sufficient, not just usually-sufficient (the ordering/gap proof):** `sendMissedOps`'s loop
is strictly sequential and breaks on the first `false` — it never sends op N+1's catch-up message until
op N's apply-ack has been received, so within one catch-up pass, a gap below the watermark cannot occur
by construction. The **live** broadcast path (`handleSubmitOp`/`broadcastOps`) never touches
`last_synced_seq` at all, before or after this change — so a live-apply failure cannot cause the
watermark to falsely advance, because the watermark is never a function of live delivery in the first
place; it is only ever a function of the sequential catch-up ack chain. A live op that applies out of
order relative to an in-flight catch-up run is safe for the same reason every other out-of-order op
already is in this design: each op is validated and applied independently (`isValidRemoteOp`,
`ON CONFLICT(id) DO NOTHING`), and conflict/ordering semantics were already resolved Host-side, before
the op was ever accepted as canonical.

**Part 3 — Broadcast the Host's own local writes to connected Clients.** `startSyncServer` runs before
the Host's no-`serverUrl` `createSyncClient` in the same closure (`main.js:443-462`), so `syncServer.wss`
is already in scope at construction time.

`electron/sync/syncServer.js`: export the existing `broadcastOps(wss, ops)` (`syncServer.js:753-764`,
currently unexported) — no change to its body. Its own comment already anticipated this exact reuse:
"collapsed here so a future 6th caller can't reintroduce the deviceId/readyState guard incorrectly."

`electron/sync/syncClient.js`: `createSyncClient(db, { ..., wss = null })` — new, optional parameter,
read only inside the no-`serverUrl` branch. In `write()`, after the existing `notifyOpApplied(op)`:

```js
if (wss) broadcastOps(wss, [op])
```

Same addition in `writeBulkReplace()`, after its `notifyOpApplied(op)`.

`electron/main.js`, `chooseMode`'s `host` branch (`main.js:460`):

```js
syncClient = createSyncClient(db, { device_id: deviceId, author_user_id: null, wss: syncServer.wss })
```

**No double-broadcast risk.** This hook lives exclusively in the no-`serverUrl` client's own `write()`/
`writeBulkReplace()` — the Host's own interactive-write path, which never touches `handleSubmitOp` (that
function is reachable only from the WS dispatcher for an **incoming** `submit_op`/`submit_bulk_replace_op`
message from a **remote** device). The two paths are structurally disjoint; no op can travel both.

## Options considered (Half 1, per the ticket's own framing)

- **(A) Replicate a minimal `devices` projection, live + full_sync.** Necessary only if accurate peer
  device names/trust-status need to be visible on a Client — which nothing in `archive_when` requires.
  **Rejected as unneeded generality for this fix**, not merely deferred-for-later: it does not solve the
  ordering crux any better than Part 1 (a live device-row broadcast can still race a live op broadcast
  for the same brand-new device across the many independent op-producing code paths in this file, so
  correctness would still need an order-independent fallback identical to Part 1 anyway — making A pure
  addition, never a replacement). If a future need for accurate cross-device names ever arises: **schema-
  separate** the replicable columns (`id`, `name`, `pairing_status`, `authorized_at`, `revoked_at`) from
  the secret-bearing ones at the table level — an explicit registry/allowlist mirroring
  `DOMAIN_TABLE_COLUMNS` (`syncClient.js:54-73`) is *not* a strong-enough guarantee on its own (the
  locations-collision ADR's Finding E addendum found exactly this class of gap — a column allowlist
  enforced only by consumer discipline, not by schema shape); a two-table split (public shadow / host-only
  vault, the shape one `adhd` frame above independently proposed) is the safer contract if this is ever
  revisited. Out of scope here.
- **(B) Relax or repair the `operations.device_id` FK.** **Rejected — strictly worse than Part 1 on both
  axes that matter.** Security: no better, since `op.device_id` is already Host-attributed and
  trustworthy before it ever reaches a receiver (see Security, below) — relaxing the FK buys nothing B-
  specific there. Integrity: strictly worse — Part 1 **guarantees** a devices row exists for every op
  author (self-healing, enforced); relaxing the FK **removes enforcement entirely**, permanently, for a
  column every audit/provenance/"who did this" surface in the app reads. It is also the only option of
  the three requiring an actual schema change: SQLite cannot `ALTER TABLE ... DROP CONSTRAINT` — dropping
  or altering a `REFERENCES` clause requires rebuilding the table (create-new, copy, drop, rename), a
  materially larger and riskier migration than Part 1's zero-schema-change fix for a strictly worse
  outcome.
- **(C) Seed the author's device row on receipt — adopted as Part 1.** See Decision and Divergent
  exploration above.

## Files/modules affected

| File | Change |
|---|---|
| `electron/sync/syncClient.js` | `applyRemoteOp`: stub-seed `devices` row before the op-log INSERT, same transaction (Part 1). `op_applied` handler: send `op_applied_ack` on successful apply (Part 2). `createSyncClient`: new optional `wss` param; no-`serverUrl` `write()`/`writeBulkReplace()`: broadcast via `broadcastOps` after `notifyOpApplied` (Part 3). New import: `broadcastOps` from `./syncServer.js`. |
| `electron/sync/syncServer.js` | Export `broadcastOps` (no body change). New `waitForApplyAck` helper. `sendMissedOps`: gate `lastSuccessSeq` advancement on `waitForApplyAck`, not `sendWithAck` alone. New dispatcher case for `op_applied_ack` (mirrors `full_sync_applied`'s single-resolver-on-`ws` pattern). |
| `electron/main.js` | `chooseMode`'s `host` branch: pass `wss: syncServer.wss` into the no-`serverUrl` `createSyncClient` call. |
| `electron/db/schema.sql` | **No change.** |
| `electron/db/localDb.js` | **No change** — no new column, no new table. |
| `test/integration/harness.js` | No change required to the file itself; the 7 scenarios currently calling `registerDevice()` should be updated to exercise real pairing instead, per Test strategy below. |

## Reused vs. new

**Reused, unchanged:** the op-log's durability-independent-of-projection principle (`applyRemoteOp`'s
existing shape); the placeholder device-name convention (`syncServer.js:363`); the
resolver-with-bounded-timeout idiom used throughout both files (`withResolverTimeout`,
`withKeyedResolverTimeout`, `sendWithAck`); the single-pending-resolver-on-`ws` pattern
(`ws.pendingFullSyncAckResolve`, mirrored exactly by `ws.pendingCatchupAckResolve`); `broadcastOps` itself
(exported, not rewritten); `INSERT OR IGNORE` for idempotent self-registration (already the Host's own
pattern at `syncServer.js:361-363`).

**New:** one wire message type, `op_applied_ack` (Client→Host, `{type, op_id}`, no payload beyond an
already-known op id — nothing new is exposed). One new Host-side helper, `waitForApplyAck`. Two new
per-connection fields on `ws` (`pendingCatchupAckResolve`, `pendingCatchupAckOpId`), same shape as the
existing `pendingFullSyncAckResolve`. No new table, no new column, no new IPC surface, no renderer change.

## Security

**`device_secret_identifier` and `host_signing_key.private_key` never cross the wire in this design,
structurally, because no `devices` row — stub or real — is ever transmitted at all.** Part 1's
stub-seed is a **local-only** `INSERT OR IGNORE` executed by the receiver against its own database, driven
entirely by the op it already received (`op.device_id`); nothing about a device is ever read from, or
written to, the network in this design. Part 2's new message (`op_applied_ack`) carries only an op id, a
UUID already known to both sides. Part 3 introduces no new message type. This is a stronger guarantee
than "we remembered to exclude the secret column" — there is no code path here capable of serializing it,
because no devices-table SELECT ever feeds a `JSON.stringify` in this design at all.

**Does the stub row create a new trust-decision surface? No — verified, not assumed.** The only code that
makes a real authorization decision from `devices` state is `authorize()`/`handleAuthenticate`
(`electron/auth/authorize.js`, `syncServer.js:323-418`), and both run exclusively against the **Host's
own** database — never a Client's. A Client's local `devices` table is never consulted to authorize an
inbound connection (Clients do not run `syncServer` — they never accept WS connections from peers) or an
outbound write (`performWrite`/`submitOpRemote` carry no local trust check at all; trust is enforced
Host-side, on receipt, via `authorizeWs`/`authorize()`). A stub row's `pairing_status: 'unknown'`,
`authorized_at: NULL` is therefore inert data with no code path that reads it as a trust determination.

**Is `op.device_id` itself forgeable by a malicious peer? No — verified at the primary write path.**
`handleSubmitOp` never trusts a client-submitted `device_id`: `const incomingOp = { ...msg.op, device_id:
ws.deviceId, source: 'human' }` (`syncServer.js:570`) **overwrites** whatever the submitting client sent
with the Host-derived, already-authenticated connection's real device id. Every op this design's stub-seed
or watermark-ack logic ever sees was already Host-attributed before it became canonical — Part 1 does not
introduce a new forgery surface; it trusts exactly what the existing Host-side write path already
vouches for.

## Migration

**No schema change. No `localDb.js` ALTER. No rollback plan beyond a code revert** — this is entirely a
protocol/application-logic change layered on existing columns and an existing message type
(`op_applied`), plus one new, narrow, add-only message type.

**Rolling-upgrade window — new Host talking to an old (pre-fix) Client.** An old Client never sends
`op_applied_ack`. `sendMissedOps`'s `waitForApplyAck` will time out on the **first** op of every catch-up
batch and `break` — that Client's watermark will not advance at all during catch-up until it upgrades.
This is a deliberate, accepted, and safe consequence, not a silent regression: nothing is lost (the
un-acked ops remain candidates for the next reconnect, forever, until the Client upgrades), and it is
maximally *visible* (a Client that never seems to catch up, rather than one that silently loses
individual ops, which is today's actual behavior for that same old Client). Live broadcast delivery to an
old Client is unaffected by this ADR (unchanged code path) — it retains exactly its pre-fix behavior
(including Failure 1's silent-drop risk, since the FIX for that lives in the Client's own — old — binary).
This mirrors the project's own established precedent for this exact class of gap (no protocol-version
handshake exists anywhere in this file; see `syncClient.js:716-732` and the locations-collision ADR's
Finding F, which made the identical accept-don't-build-a-handshake call for `op_rejected`). Building a
version handshake now, scoped to this one message, would fix one instance of a general property while
leaving the general property itself unaddressed — explicitly out of scope (see Non-goals).

**New Client talking to an old Host.** An old Host never sends `op_applied_ack`'s Host-side handling (it
doesn't need to — that's Host-side logic this ADR adds) and never expects a stub-seed's device row (a
Client-local concern, invisible to the Host). No behavior change for this direction; a new Client against
an old Host behaves exactly as a pre-fix Client did — the fix is only as good as the newest device that
authored the op *and* the newest device receiving it, for the specific op-log-durability property; watermark
correctness specifically requires a new Host (it owns `sendMissedOps`).

## Non-goals

- **Live or full-sync replication of the `devices` table** (Option A) — not required by `archive_when`;
  see Options considered.
- **Upgrading a stub row's placeholder name/status once real information becomes available.** A stub
  stays a stub unless/until this device separately, independently learns the real row (e.g. it later
  becomes the Host and self-registers that device, or a future Option A ships). Not required for
  correctness; a UI-accuracy nicety, explicitly deferred.
- **A live (non-catch-up) apply-ack.** The live broadcast path's "no ack" gap is pre-existing, already
  documented in this file's own comments, and — per the ordering proof above — cannot cause a false
  watermark advance because the watermark is never a function of the live path at all. Building one adds
  a second, materially larger keyed-resolver surface (concurrent, cross-device, unbounded in count) for a
  benefit (closing the "device that never disconnects and never gets a next catch-up" edge case) not
  required by `archive_when`'s literal text.
- **A protocol-version/capability handshake.** Accepted rolling-upgrade gap, consistent with this
  protocol's existing, repeated precedent (see Migration).
- **Per-op cryptographic signatures / device public-key fingerprints.** Disproportionate; the existing
  Host-attribution trust boundary already covers what this would add. See Security and Divergent
  exploration.
- **Fixing the analogous, but separate, `author_user_id` FK-drop risk.** `operations.author_user_id TEXT
  REFERENCES users(id)` is nullable, so it is exempt from FK enforcement when NULL, but a **non-null**
  `author_user_id` for a user created moments ago on another device (users only replicate via full_sync,
  never live) could reproduce this exact defect class via a different column. Confirmed structurally
  analogous, **not confirmed as reachable in practice**, and out of this ADR's scope — flagged separately
  for Governor rather than folded in here (see the accompanying report).
- **Fixing `DeviceManagerScreen`'s reachability/behavior on a Client.** Discovered while tracing this
  defect: `listDevices`/`approveDevice`/`revokeDevice` (`main.js:642-696`) are not gated to
  Host-only the way `ingestCommit`/`confirmAliasHandler` explicitly are, and the sidebar does not appear
  to hide the `devices` nav item on a Client either — so a Client's own device-management screen already
  reads/writes only its own local `devices` table, invisibly to the Host and every peer, independent of
  this ADR. Pre-existing, unrelated to T85's root cause, out of scope here — flagged separately.
  **Now tracked as T86** (`docs/work/tickets/T86-device-management-handlers-not-host-gated-on-client.md`,
  merged to main via PR #80). **Ordering dependency, load-bearing:** Part 1's FK-stub seeding is exactly
  what *arms* T86 — once `'unknown'` stub peer rows exist in a Client's `devices` table, a `revokeDevice`
  against such a row becomes a silent no-op the director sees as "No longer allowed" while the device
  keeps syncing. This ADR mitigates the *visible* half of that in the same PR (stub rows are filtered out
  of the Device Manager list — see the T85 Risk-3a follow-up), but T86 owns the real write-path
  Host-gating and must land for the guarantee to be complete. Do not consider FK-stub seeding fully safe
  on the director-facing surface until T86 ships. (Frontmatter `related_tickets` link to T86 is wired.)

## Test strategy

This is a sync/replay seam; per `docs/governance/GOVERNANCE_INDEX.md` ("Concurrency" and
"Database / sync" rows), the integration harness is **mandatory**, and this is a **human-approval gate**
(any change to write-ordering or op-log replay semantics). Red Hat review is mandatory per the ticket.

1. **Unit — `applyRemoteOp` stub-seed:** an op from a never-before-seen `device_id` applies successfully
   (no thrown FK error); the resulting `devices` row has `pairing_status = 'unknown'`,
   `authorized_at`/`revoked_at`/`device_secret_identifier` all NULL; a **second** op from the same
   unknown `device_id` does not overwrite or duplicate the stub row (`INSERT OR IGNORE` idempotency); an
   op from an **already-known** device does not touch that device's existing row.
2. **Unit — watermark ack gating (`sendMissedOps`):** given a mock `ws` that acks transport-send but
   never sends `op_applied_ack` for op N, assert `last_synced_seq` advances only through N-1, not N or
   beyond, and the loop stops (ops after N in the same batch are not attempted).
3. **Multi-device integration, live broadcast — no `registerDevice()`:** real `syncServer` + two real
   `syncClient` instances, paired through the **actual** pairing flow (`pairing_request` →
   `onPairingRequest` → `approveDevice` → `pairing_approved`), both live-connected. Device B writes a
   field op; assert Device C receives it via `op_applied`, applies it durably (row present in C's own
   `operations` table with `device_id` = B's real id), and a stub `devices` row for B now exists on C —
   this is the direct proof the ordering crux (op arrives before any device-row propagation) is closed,
   because no propagation mechanism exists in this design at all.
4. **Multi-device integration, reconnect catch-up:** disconnect Device C; Device B writes several ops
   while C is offline; reconnect C; assert all ops are delivered and `last_synced_seq` on the Host lands
   exactly at the true max applied seq (not a transport-send-only value). **Negative case within the same
   scenario:** force `applyRemoteOp` to fail for one op in the middle of the batch (e.g. inject a
   deliberately malformed op past `isValidRemoteOp`, or stub a DB error); assert `last_synced_seq` stops
   **before** that op's seq, assert that op is re-delivered (not permanently lost) on the **next**
   reconnect, and assert ops **after** the failed one in the original batch are not marked delivered
   either (ordering proof, not just "some ops eventually arrive").
5. **Host-local broadcast (Part 3):** Host writes a field directly via its own no-`serverUrl` client,
   with Client B live-connected; assert B receives it via `op_applied` and applies it. This is the literal
   regression test for Failure 3 — today this path never fires at all.
6. **Negative security test:** capture every wire message sent during scenarios 3–5 (`full_sync`,
   `op_applied`, `op_applied_ack`, `pairing_approved`, everything); assert the serialized text of every
   message never contains the Host's actual `device_secret_identifier` value(s) or `host_signing_key`
   value for any paired device, and specifically assert no message of type `op_applied_ack` or any
   devices-table-shaped payload ever appears (there should be none — proving the "no devices row is ever
   transmitted" design property directly, not just the absence of one specific field within one).
7. **Regression — drop the workaround where it matters:** the existing integration scenarios (04, 11, 13,
   18, 20, 22, 23) that call `registerDevice()` should be updated to pair devices through the real flow
   instead and continue to pass — this is the direct, end-to-end proof that production code, not a test
   harness, now closes the gap. `registerDevice()` itself may remain in the harness for other, narrower
   unit-level uses if any exist; it must not remain load-bearing for proving cross-device delivery.
8. **Mixed-version note:** no test is required proving old-Client/new-Host catch-up "stalls safely," since
   that is an accepted, documented consequence (Migration) rather than a behavior this ADR claims to make
   graceful — but Maker should confirm by inspection that an unacked op is never removed from
   `sendMissedOps`'s candidate set and remains re-deliverable indefinitely.

## Consequences

- **Positive:** the everyday 3+-device deployment (Host + Client tablets) stops silently losing
  cross-device edits — the actual, app-wide defect this ticket exists to close, for every synced entity,
  not just one feature. The watermark becomes correct by construction rather than "usually correct because
  the common failure cause was removed." A Host operator's own edits finally reach connected Clients live.
  Zero schema/migration risk.
- **Costs / risks:** one new wire message type and two new per-connection `ws` fields on the Host — small,
  but real new protocol surface that must be covered by Red Hat's mandatory review (any change to
  write-ordering/replay semantics is a constitution-level human-approval gate). The rolling-upgrade
  consequence (Migration) is a real, if accepted, degradation for a mixed fleet, not a no-op.
- **Explicitly not built here:** accurate cross-device device display (Option A); live apply-acks;
  protocol versioning; the analogous `author_user_id` risk; the pre-existing Client-side
  `DeviceManagerScreen` gap. All flagged, none silently dropped.

## Confidence

**High** on Part 1 (stub-seed) — independently reproduced by 4 of 5 isolated ideation frames, the
security argument is verified against the actual authorization code path (not assumed), and it requires
zero schema change for a defect whose ticket-level framing anticipated a possible schema change. **High**
on rejecting Option B — the SQLite-FK-cannot-be-altered-without-a-table-rebuild fact is a structural, not
incidental, disqualifier, and B buys no security benefit over C. **Medium-high** on Part 2's exact
mechanism (per-op sequential ack via a single-resolver-on-`ws`, mirroring the existing
`full_sync_applied` pattern) — the ordering/gap proof is sound and directly reuses an established idiom,
but it is the one genuinely new piece of protocol surface in this design and is the piece a Maker should
most carefully re-verify against `sendMissedOps`'s current exact control flow before implementing, since
it changes what "the loop breaks" means. **Medium** on the Migration section's characterization of the
rolling-upgrade window as "safe, not silent" — reasoned from the code as it stands, not exercised by a
live mixed-fleet repro in this session.

**Evidence behind this confidence:** direct reading of `electron/sync/syncClient.js`,
`electron/sync/syncServer.js`, `electron/db/schema.sql`, `electron/main.js`,
`test/integration/harness.js`, `docs/adr/2026-07-25-device-trust-revocation.md`, and
`docs/adr/2026-08-15-locations-concurrent-create-collision.md` — line-cited throughout this document —
plus five isolated, parallel `adhd` ideation passes whose independent convergence on the adopted
mechanism is reported above, not asserted from memory alone.
