---
title: "ADR: Deepen the sync/auth layer — extract the reliable-delivery+catchup submodule, key its ack registry, and collapse the device-trust gate into one predicate"
document_type: adr
status: accepted
authority: normative
implementation_state: not-started
date: 2026-08-17
deciders: [product-owner]
task_class: security-auth
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, SECURITY.md]
related_specs: []
related_tickets: []
related_adrs: [docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md, docs/adr/2026-08-16-client-reauth-on-restart.md, docs/adr/2026-07-25-device-trust-revocation.md, docs/adr/2026-07-24-centralized-authorization-layer.md]
supersedes: []
affects: []
---

# ADR: Deepen the sync/auth layer — extract the reliable-delivery+catchup submodule, key its ack registry, and collapse the device-trust gate into one predicate

**Status: ACCEPTED (2026-08-17), design only, no code written yet.** Architecture-deepening initiative,
sourced from the F4 sync/auth audit (`docs/work/architecture-reports/2026-08-16-sync-auth-audit-summary.md`,
read at HEAD `b693e98`; re-verified against `e792b0e`, current `main`, which includes the merged T87
fix). C2 (single-source the `full_sync` snapshot manifest) already shipped as T88. The owner has
approved pursuing the remaining three ranked candidates — C1 (extract the reliable-delivery/catch-up
submodule), C4 (keyed ack registry, coupled to C1), C3 (collapse the device-trust gate into one
predicate). **C1 and C4 are behavior-preserving refactors. No schema change, no wire-protocol change in
any slice.** This ADR designs the module boundaries, the exact moved/new symbols, the slice sequence,
and resolves the one open design question the audit flagged: whether C4 lets T85's `isReauthenticate`
guard be simplified. It does not.

**Acceptance note (2026-08-17):** the owner accepted this ADR with one directed change to C3 — the
reachable device-trust reason divergence identified below (Context, row 4 vs rows 1–2) is to be
**harmonized**, not preserved, as one intentional, tested, reviewed behavior change layered on the C3
predicate-collapse. C3 is therefore **not** purely behavior-preserving: it changes which reason string
(and, at one call site, which WS close code) two of the four call sites report for one specific,
reachable device state. C1 and C4 remain unchanged and fully behavior-preserving. See Approach §C3,
Security, Consequences, and Test strategy below — all updated to reflect the harmonized design; earlier
language in this document describing the divergence as "deliberately preserved" is superseded by this
note.

## Context

Three candidates, each verified against current source, not re-asserted from the audit summary alone:

**C1 — `electron/sync/syncServer.js` lines 28–362 (`send`, `sendWithAck`, `waitForFullSyncAck`,
`sendFullSyncIfFirstPairing`, `currentMaxOpSeq`, `waitForApplyAck`, `sendMissedOps`) are a self-contained
reliable-delivery + catch-up-watermark subsystem living inside a 1216-line file whose other ~850 lines are
the WS message dispatcher, per-message handlers (login, acquire_lock, submit_op, submit_bulk_replace_op,
restore/delete/merge requests), and pairing.** `sendWithAck` and `sendMissedOps` are already exported
solely so `syncServer.test.js` can call them directly (each carries its own "Exported for direct unit
testing" comment). The watermark invariant they jointly own — `devices.last_synced_seq` must never
advance past an op that has not been receiver-apply-acked, never just transport-sent (T85 Part 2) — is
documented in four separate comment blocks spread across this range and is easy to violate by editing
one function without re-reading the others. `handleAuthenticate` (line 364), which orchestrates these
functions, is not part of the cluster — it borders it exactly at line 364, decides *whether* to call
`sendFullSyncIfFirstPairing`/`sendMissedOps` (the `isReauthenticate` guard, C4's context below), and
stays in `syncServer.js`.

**C4 — the Host stashes a single ack resolver per kind directly on the connection object**, not in a
registry: `ws.pendingFullSyncAckResolve` (set in `waitForFullSyncAck`, line 138; read in the
`full_sync_applied` dispatcher case, line 1104) and `ws.pendingCatchupAckOpId`/`ws.pendingCatchupAckResolve`
(set in `waitForApplyAck`, lines 272–273; read in the `op_applied_ack` dispatcher case, line 1113). A
second concurrent invocation of either function on the *same* `ws` overwrites the first invocation's
resolver — the first invocation's real ack then resolves the wrong (or no) waiter and stalls to its full
timeout, and the two invocations' `UPDATE devices SET last_synced_seq = ?` calls race. This clobber hazard
is the **sole, explicit reason** `handleAuthenticate` computes `isReauthenticate = !!ws.deviceId` (line
452) and skips both calls entirely on a re-authenticate over an already-open socket (line 468's `if
(isReauthenticate) return`) — the comment block at lines 434–451 states this directly, and
`syncServer.test.js`'s `describe('T85 Risk 1: re-authenticate on the SAME already-authenticated socket
(shift change)'` (line 823) is the characterization test that exists specifically to prove the guard
prevents it. `syncClient.js` already has the pattern this candidate is asked to mirror:
`keyedResolverMaps` (line 347) is an array of `Map`s (`restoreResolvers`, `deleteResolvers`,
`mergeResolvers`, each keyed by `request_id`) drained uniformly in `settlePendingOnDisconnect` (lines
833–852) via `withKeyedResolverTimeout` (lines 1055–1074).

**C3 — the device-trust gate (`authorized_at` set, `revoked_at` unset) is independently re-queried in
four places**, and one of the four computes its *reason string* with different precedence than the other
three — a genuine, reachable divergence, not just duplicated code:

| # | Site | Query | Gate condition | Reason precedence |
|---|---|---|---|---|
| 1 | `electron/auth/authorize.js:37,43–45` | `SELECT id, authorized_at, revoked_at FROM devices WHERE id = ?` | sequential: `!deviceRow` → `device_not_found`; else `!authorized_at` → `device_not_authorized`; else `revoked_at` → `device_revoked` | **not-authorized wins over revoked** (revoked branch only reached if `authorized_at` is truthy) |
| 2 | `syncServer.js` `handleAuthenticate`, lines 406–420, 421–432 | `SELECT authorized_at, revoked_at FROM devices WHERE id = ?` (run *after* the self-registering `INSERT OR IGNORE`, line 402) | `!deviceRow \|\| !authorized_at` → close 4403 (`device_not_authorized`); else `revoked_at` → close 4404 (`device_revoked`) | **not-authorized wins over revoked** — same precedence as #1, collapses "not found" into "not authorized" (defensive only; self-registration above makes `!deviceRow` unreachable in practice) |
| 3 | `syncServer.js` `handleLogin`, line 509–513 | `SELECT authorized_at, revoked_at, device_secret_identifier FROM devices WHERE id = ?` | `!deviceRow \|\| !authorized_at \|\| revoked_at` → single opaque `login_failed` | **no reason exposed at all** — deliberate, per the adjacent Security comment: two rejection paths must return the identical response so a LAN attacker cannot use response shape as a device-existence/authorization oracle |
| 4 | `syncServer.js` `renew_token` handler, lines 1118–1134 | `SELECT authorized_at, revoked_at FROM devices WHERE id = ?` | `!renewDeviceRow \|\| !authorized_at \|\| revoked_at` → deny | **revoked wins over not-authorized**: `const reason = renewDeviceRow?.revoked_at ? 'device_revoked' : 'device_not_authorized'` checks `revoked_at` *first*, regardless of `authorized_at` |

**The divergence between #4 and #1/#2 is reachable, not hypothetical.** `revokeDevice`
(`electron/main.js:713–722`) only checks `SELECT id FROM devices WHERE id = ?` (existence) before writing
`revoked_at`/`pairing_status='revoked'` — it never requires `authorized_at` to already be set. A device
that is still `pending` (never approved) or a T85 FK stub-seed row (`pairing_status='unknown'`,
`authorized_at` NULL — `syncClient.js`'s `applyRemoteOp`) can be revoked directly, landing it in the state
`authorized_at: NULL, revoked_at: <set>`. In that state today: `authorize()` and `handleAuthenticate`
report/close as "not authorized" (revoked branch never reached); `renew_token` reports "device_revoked"
and closes 4404. **A predicate collapsed to a single resolved status would silently change one of these
two behaviors** — this is exactly the class of gap this ADR's ticket brief asked to be found and named,
not silently fixed.

**Resolution (owner acceptance, 2026-08-17): harmonize, revoked-wins.** This table describes the
divergence as it exists in the code being refactored; it is not left standing as the shipped behavior.
Per the acceptance note above, `renew_token`'s existing precedence (row 4 — revoked checked ahead of
not-authorized) becomes the canonical ordering applied at **all four** sites. Row 4 therefore does not
change. Rows 1 and 2 (`authorize.js`, `handleAuthenticate`) change: a device with `revoked_at` set now
reports `device_revoked` regardless of `authorized_at`. Row 3 (`handleLogin`) is unaffected — it never
exposes a reason. See Approach §C3 for the exact mechanism and Security for the allow/deny invariant.

## Divergent exploration

Per this project's `adhd` protocol — required for architecturally-significant work per the Architect role
brief. Three genuinely different candidate module shapes were generated for C1/C4 (the harder of the two
structural decisions) before converging:

**Candidate 1 — one new file (`opDelivery.js`) holding everything from `send` through `sendMissedOps`,
including the ack-resolver storage.** Simple, but conflates two different concerns at two different
layers of abstraction: "how do I safely put a JSON frame on a socket and know if it landed" (a transport
primitive `syncServer.js`'s other ~10 handlers also need — `handleLogin`, `handleAcquireLock`,
`handleSubmitOp`, `handleRestoreRequest`, etc. all call the bare `send`) versus "how does a *specific*
first-pairing/reconnect-catch-up *protocol exchange* stay watermark-correct." A single file forces every
consumer of the low-level primitive to import from a module named after the high-level protocol concern,
and — worse for the *next* deepening — leaves no natural seam to test the transport primitive in
isolation from the watermark logic. **Rejected**: conflates a leaf utility with a stateful protocol
owner.

**Candidate 2 — leave `send`/`sendWithAck` in `syncServer.js` (still exported), move only the
watermark-owning functions (`waitForFullSyncAck`, `sendFullSyncIfFirstPairing`, `currentMaxOpSeq`,
`waitForApplyAck`, `sendMissedOps`) to a new `catchup.js` that imports `send`/`sendWithAck` back from
`syncServer.js`.** This is the audit summary's literal phrasing ("belong in an `opDelivery.js`/
`catchup.js` module") read as *one* file, not two, with the low-level pair staying put. **Rejected**: it
creates a two-way import — `syncServer.js` would need `sendFullSyncIfFirstPairing`/`sendMissedOps` from
`catchup.js` for `handleAuthenticate`, and `catchup.js` would need `send`/`sendWithAck` from
`syncServer.js` — a circular module dependency. Node/ESM tolerates some circular imports mechanically,
but it is exactly the kind of "looks fine until someone reorders an import and gets `undefined` at
runtime" hazard `codebase-design` flags as a seam smell, and it is avoidable for free by picking the
other direction.

**Candidate 3 (adopted) — two new files, layered, no cycle: `opDelivery.js` (the leaf: `send`,
`sendWithAck` — pure transport, zero domain knowledge, zero dependency on `catchup.js` or `syncServer.js`)
and `catchup.js` (the protocol owner: `currentMaxOpSeq`, `sendFullSyncIfFirstPairing`, `sendMissedOps`,
plus the ack-registry functions C4 adds — depends only on `opDelivery.js`).** `syncServer.js` becomes a
pure consumer of both, for its simple one-shot sends (`opDelivery.send`, used by every existing handler)
and its complex watermark-gated exchange (`catchup`'s exports, used only by `handleAuthenticate` and the
two dispatcher ack-cases). Dependency graph: `opDelivery.js` → (nothing); `catchup.js` → `opDelivery.js`;
`syncServer.js` → both. No cycle, and it is a genuine deepening: `opDelivery.js`'s interface (`send`,
`sendWithAck`) is smaller than its current implicit interface (every handler reaching into the same file
that also owns watermark state), and `catchup.js` becomes independently testable without dragging in the
whole dispatcher.

**Why C1+C4 as a combined design, not independently ideated:** the audit itself flagged C4 as
"companion to C1" — the ack-resolver storage C4 replaces is *inside* the functions C1 moves
(`waitForFullSyncAck`, `waitForApplyAck`). Designing C1's new module boundary without deciding where the
resolver registry lives would mean redesigning the same seam twice. They are one design (Candidate 3
above), executed as two sequenced *slices* — see Slice decomposition below; combined design does not mean
combined PR.

## Approach

### C1 — module boundary (Candidate 3, adopted)

**`electron/sync/opDelivery.js` (new).** Pure transport leaf. No `db`, no `wss`, no knowledge of
op-log/watermark semantics.

- `send(ws, message)` — moved verbatim from `syncServer.js:28–37`. Currently module-private; **now
  exported**, since it becomes the shared low-level primitive every `syncServer.js` handler imports.
- `sendWithAck(ws, message, timeoutMs = SEND_ACK_TIMEOUT_MS)` — moved verbatim from `syncServer.js:59–91`,
  already exported.
- `SEND_ACK_TIMEOUT_MS` constant — moves with it (`syncServer.js:48`).

**`electron/sync/catchup.js` (new).** The reliable-delivery + catch-up-watermark protocol owner. Imports
`send`, `sendWithAck` from `./opDelivery.js`.

- `FULL_SYNC_ACK_TIMEOUT_MS` (`syncServer.js:114`), `waitForFullSyncAck` (`syncServer.js:122–141`) —
  moved. Stays module-private (only `sendFullSyncIfFirstPairing` calls it) — **except** its resolver-stash
  mechanism changes shape under C4, see below.
- `currentMaxOpSeq(db)` (`syncServer.js:244–247`) — moved, **now exported** (`handleAuthenticate` in
  `syncServer.js` calls it directly to compute `asOfSeq` once, synchronously, per the T85 §2.5 invariant
  that both `sendFullSyncIfFirstPairing` and `sendMissedOps` must observe the identical instant).
- `sendFullSyncIfFirstPairing(db, ws, asOfSeq)` (`syncServer.js:150–213`) — moved. Currently
  module-private (has an `eslint-disable-next-line no-unused-vars` on the unused-within-its-own-body
  `asOfSeq` param); **now exported**, since `handleAuthenticate` calling it lives in a different file
  after the move.
- `waitForApplyAck(ws, opId, timeoutMs)` (`syncServer.js:260–276`) — moved. Stays module-private. Its
  resolver-stash mechanism changes shape under C4.
- `sendMissedOps(db, ws, asOfSeq, ackTimeoutMs)` (`syncServer.js:290–362`) — moved, already exported.

**`electron/sync/syncServer.js` (unchanged responsibility, smaller body).** Imports `send`, `sendWithAck`
from `./opDelivery.js` (used by `sendError`, `handleLogin`, `handleAcquireLock`, `handleSubmitOp`,
`handleSubmitBulkReplaceOp`, `handleRestoreRequest`, `handleMergeLocationRequest`,
`handleDeleteRecordRequest`, `broadcastOps`, and the pairing `send*` calls in `startSyncServer`'s returned
object — every existing call site keeps calling `send`/`sendWithAck` exactly as before, only the import
source changes). Imports `currentMaxOpSeq`, `sendFullSyncIfFirstPairing`, `sendMissedOps` from
`./catchup.js` for `handleAuthenticate`'s unchanged three-line sequence (compute `asOfSeq`, fire both,
fire-and-forget). **`handleAuthenticate` itself does not move** — the `isReauthenticate` guard, the
self-registration `INSERT OR IGNORE`, the `authorized_at`/`revoked_at` check (C3's concern), and the
token/type verification stay in `syncServer.js`, unchanged in this slice.

**Not moved, explicitly out of scope:** `broadcastOps` (line ~820) — it is defined well outside the
line-40–374 cluster, is already exported and consumed by `syncClient.js` (T85 Part 3, Host-local
broadcast), and is not part of the watermark-owning cluster; moving it is a different, unrequested seam
change. `sendError` stays in `syncServer.js` — it is generic protocol-violation handling
(`syncServer.js:93–103`), not delivery/watermark logic, and only needs `send` as an import like every
other handler.

### C4 — keyed ack registry

**The mirror to `syncClient.js`'s `keyedResolverMaps` pattern is only exact for the apply-ack case.**
`op_applied_ack`'s wire message already carries a real correlator (`{ type: 'op_applied_ack', op_id }`),
so it can be genuinely keyed the way `restoreResolvers`/`deleteResolvers`/`mergeResolvers` are keyed by
`request_id`. `full_sync_applied`'s wire message carries **no correlator at all**
(`{ type: 'full_sync_applied' }`) — there is nothing to key by without adding a field to that message,
which is a wire-protocol change and out of scope for a behavior-preserving initiative. The design below
is therefore asymmetric on purpose, not an oversight:

**Apply-ack — genuinely keyed, inside `catchup.js`:**

```js
// catchup.js — per-connection registry, keyed by the op_id the wire message already carries
function pendingApplyAcks(ws) {
  if (!ws.pendingApplyAcks) ws.pendingApplyAcks = new Map()
  return ws.pendingApplyAcks
}

function waitForApplyAck(ws, opId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      pendingApplyAcks(ws).delete(opId)
      resolve(result)
    }
    pendingApplyAcks(ws).set(opId, (matchedOpId) => { if (matchedOpId === opId) finish(true) })
    setTimeout(() => finish(false), timeoutMs)
  })
}

export function resolveApplyAck(ws, opId) {
  const resolve = ws.pendingApplyAcks?.get(opId)
  if (resolve) resolve(opId)
}
```

`syncServer.js`'s dispatcher `op_applied_ack` case (line 1112–1115) changes from touching
`ws.pendingCatchupAckResolve` directly to calling the exported function:

```js
if (msg.type === 'op_applied_ack') {
  resolveApplyAck(ws, msg.op_id)
  return
}
```

Two *different* op ids waited on concurrently on the same `ws` no longer clobber each other's resolver —
each is keyed by its own `op_id`. This is a real, verifiable improvement over the single-slot field.

**Scope of that improvement — read this before relaxing `isReauthenticate` (Red Hat, Slice 2 review).**
The keyed Map fixes the clobber *only for different op_ids*. It does **not** make two overlapping
`sendMissedOps` runs on one `ws` safe, because those two runs do **not** wait on different op_ids: each
run reads the same `last_synced_seq` (the watermark is written once at the *end* of a run, never per-op),
so both start at the *identical* first op, both call `waitForApplyAck(ws, sameOpId, …)`, and the second
`set(opId, …)` overwrites the first's resolver *at that key* — the same clobber the single-slot field
had, just scoped to one key instead of the whole connection. That case is inert today only because
`sendMissedOps` has exactly one call site, gated by the unmodified `isReauthenticate`, which is what
prevents a second overlapping run from ever starting. So the keyed Map is a genuine improvement for the
different-op_id case, **not** a reason `isReauthenticate` can be retired — the same-op_id clobber and the
full-sync-ack single-slot below are both still live and both still need the guard. A known-limitation
regression test (`syncServer.test.js`, `C4 known limitation: …`) pins the same-op_id clobber so a future
change that makes overlap reachable trips a red instead of silently corrupting a watermark.

**Full-sync-ack — wrapped behind the same clean function interface, but internally still single-slot,
by necessity, not by half-finished effort:**

```js
// catchup.js
export function resolveFullSyncAck(ws, result) {
  if (ws.pendingFullSyncAckResolve) ws.pendingFullSyncAckResolve(result)
}
```

`waitForFullSyncAck` keeps stashing exactly one resolver on `ws.pendingFullSyncAckResolve` (unchanged
mechanism, `syncServer.js:122–141` moved verbatim into `catchup.js`) — there is no `full_sync`-instance
identifier on the wire to key a `Map` by, so a `Map` here would not fix anything; it would only add a
layer of indirection over the same single-slot clobber hazard, with the added risk of an ambiguous
"which entry does this unkeyed ack resolve" policy question with no correct answer. `syncServer.js`'s
`full_sync_applied` dispatcher case changes from touching the field directly to calling
`resolveFullSyncAck(ws, true)` — this is real value even without a `Map` (it is what actually deepens the
module: the field's existence becomes an internal implementation detail of `catchup.js`, invisible to
`syncServer.js` and to any future caller), but it does not, and cannot without a protocol change, make
concurrent full-sync-acks on one socket safe. **This is the concrete reason isReauthenticate cannot be
fully retired by C4 — see the Critical design question below.**

**Test-file consequence, not just an internal refactor.** `electron/sync/syncServer.test.js` directly
pokes `ws.pendingCatchupAckOpId`/`ws.pendingCatchupAckResolve` in five places (lines 829 comment, 951,
1056, 1059, 1140, 1189) to simulate a client's ack behavior against a mock `ws`. These call sites must be
updated to call `resolveApplyAck(ws, opId)` (imported from `catchup.js`) instead of reading/invoking the
internal fields directly, once those fields move behind the function interface. This is expected,
in-scope mechanical test-file work for this slice, not a surprise Maker discovers mid-implementation —
flagged here so it is budgeted for.

### C3 — one predicate, one canonical reason ordering applied at all four call sites

**New: `electron/auth/deviceTrust.js`** (co-located with `authorize.js`, same directory, same layer —
not under `electron/sync/`, since two of the four call sites are Host-only WS handlers and one is the
IPC-facing `authorize()` used by every renderer-originated write).

```js
// electron/auth/deviceTrust.js
// Single query, single column set, covering every current call site's needs — including
// device_secret_identifier, which only handleLogin reads, so handleLogin needs no second query.
export function deviceTrustStatus(db, deviceId) {
  const row = db
    .prepare('SELECT id, authorized_at, revoked_at, device_secret_identifier FROM devices WHERE id = ?')
    .get(deviceId)
  return {
    found: !!row,
    authorized: !!row?.authorized_at,
    revoked: !!row?.revoked_at,
    row: row ?? null,
  }
}

// Canonical reason precedence — owner-directed harmonization, accepted 2026-08-17 (see acceptance
// note at the top of this ADR). Revoked wins over not-authorized: a device with revoked_at set is
// reported as 'device_revoked' regardless of whether authorized_at was ever set. This matches
// renew_token's pre-existing precedence (Context table, row 4) — it is the one call site that
// already implemented this ordering before this ADR, which is why it is the one that does not
// change below. Returns null when the device is fully trusted (found, authorized, not revoked).
export function deviceTrustReason(trust) {
  if (!trust.found) return 'device_not_found'
  if (trust.revoked) return 'device_revoked'
  if (!trust.authorized) return 'device_not_authorized'
  return null
}
```

`deviceTrustStatus` keeps returning raw booleans (still needed: `handleLogin` reads
`device_secret_identifier` off `trust.row`, and the *allow* check at every site is `found && authorized
&& !revoked`, not just "what's the reason"). `deviceTrustReason` is the single new place the reason
*label* is resolved — no call site computes its own precedence anymore. Four call sites, each keeping
its existing allow/deny condition (see the invariant below), now reading from one query and one reason
function:

1. **`authorize.js:37,43–62`** — replace the `deviceRow` query with `const trust =
   deviceTrustStatus(db, session.deviceId)`. Deny condition unchanged: `if (!trust.found ||
   !trust.authorized || trust.revoked) return deny(..., deviceTrustReason(trust), ...)`. **Behavior
   change:** for the reachable state `authorized_at: NULL, revoked_at: <set>`, this site previously
   reported `'device_not_authorized'` (not-authorized checked first); it now reports
   `'device_revoked'`. This reason is only ever audit-logged (`recordAuditEvent` inside `deny()`) and
   returned as `{allowed: false, reason}` to the internal write-authorization caller — no `src/`
   renderer code branches on this string, so no user-visible text changes (confirmed by repo-wide
   grep: `device_not_authorized`/`device_revoked` do not appear under `src/`).
2. **`syncServer.js` `handleAuthenticate`, lines 406–420, 421–432** — replace the direct query with
   `deviceTrustStatus(db, verified.deviceId)`, then `const reason = deviceTrustReason(trust)`. Deny
   condition unchanged (`!trust.found || !trust.authorized || trust.revoked` still closes the socket);
   close-code mapping changes to follow `reason`: `reason === 'device_revoked'` → close 4404;
   otherwise (`device_not_found` or `device_not_authorized`) → close 4403. **Behavior change:** for
   the same reachable state as #1, this site previously closed 4403; it now closes 4404. **Confirmed
   UX-neutral:** `src/hooks/useDeviceMode.js`'s `reasonForAuthRejectedCode(code)` (lines 25–32) puts
   both 4403 and 4404 in the same `DEVICE_REVOKED_CODES` set and maps either to the identical director
   message ("This device's access was removed. Ask your director or admin to re-approve it, then sign
   in again."). Moving this one reachable state from 4403 to 4404 changes zero rendered text and zero
   other observable client behavior — verified by reading `useDeviceMode.js` directly, not assumed.
   *One label change on a dead branch (Red Hat, Slice 3 review):* the old code used a hardcoded
   `'device_not_authorized'` for the combined `!deviceRow || !authorized_at` branch, so a *not-found*
   row reported `'device_not_authorized'`; `deviceTrustReason` now reports `'device_not_found'` for it.
   The close code is unchanged (4403 either way), and the branch is unreachable — the synchronous
   `INSERT OR IGNORE` self-registration immediately above guarantees `trust.found` is true (the handler
   is not `async`, so no interleaving). Documented in-code at the branch; no functional effect.
3. **`syncServer.js` `handleLogin`, line 509** — replace the query with `deviceTrustStatus(db,
   msg.device_id)`, reading `trust.row.device_secret_identifier` for the subsequent
   `timingSafeEqual` check (unchanged). Deny condition unchanged: `if (!trust.found ||
   !trust.authorized || trust.revoked)` → opaque `login_failed`. **No behavior change** — this site
   never calls `deviceTrustReason` and never exposes a reason, by design (the adjacent Security
   comment: two rejection paths must return an identical response so a LAN attacker cannot use
   response shape as a device-existence/authorization oracle). Harmonizing the reason label has
   nothing to change here because no reason ever leaves this handler.
4. **`syncServer.js` `renew_token` handler, line 1124** — replace the query with `deviceTrustStatus(db,
   ws.deviceId)`, then `const reason = deviceTrustReason(trust)`, replacing the inline
   `renewDeviceRow?.revoked_at ? 'device_revoked' : 'device_not_authorized'` ternary. Deny condition
   unchanged; close-code mapping unchanged (`reason === 'device_revoked'` → close 4404, matching the
   existing `if (renewDeviceRow?.revoked_at) ws.close(4404, ...)` guard). **No behavior change for the
   revoked-wins precedence** — this site already implemented that ordering before this ADR; it now
   sources it from the shared function instead of a local literal. **One label change on a dead branch
   (Red Hat, Slice 3 review):** the old two-way ternary returned `'device_not_authorized'` for a
   *not-found* row (`undefined?.revoked_at` is falsy); the three-way `deviceTrustReason` returns
   `'device_not_found'` for that case. This is inert — `renew_token` only fires on an already-
   authenticated connection (`ws.deviceId` set), the `operations.device_id` FK prevents deleting a
   `devices` row for any device that has synced, the client discards `token_renewal_failed.reason`
   unread, and this branch never audits. No close-code change. Pinned by a `renew_token` not-found test.
   The earlier "identical for every input combination" wording was an overclaim corrected here.

**Invariant, true before and after this refactor, at all four sites:** the *allow/deny outcome* for
every combination of `found`/`authorized`/`revoked` is unchanged. All four sites already deny in the
`authorized_at: NULL, revoked_at: <set>` state today, and all four still deny it after this change —
harmonization moves only which *reason label* (and, at site 2 only, which *close code*) accompanies an
already-denied request. No previously-allowed device becomes denied; no previously-denied device
becomes allowed.

*Exposure note (Red Hat, Slice 3 review — informational, does not change the decision):* the reachable
`authorized_at: NULL, revoked_at: <set>` state that motivates this harmonization is reachable at the
IPC/API layer (`revokeDevice` requires only that the device row exist, not that it was ever authorized),
but is **not** triggerable through the shipped UI today — `DeviceManagerScreen.jsx` renders a Revoke
button only for already-authorized devices; a never-authorized (pending) device offers "Deny"
(`pairing_status='denied'`, which never sets `revoked_at`). So this slice hardens an API-layer
consistency gap, not a currently UI-triggerable one. The defensive posture is still correct — the state
is reachable by direct IPC — and nothing here depends on the UI gate staying as it is.

No new column, no new table, no schema change. The single query selects a fixed superset
(`device_secret_identifier`) that three of the four call sites already ignore today by not selecting
it — selecting an unused column changes nothing observable.

## Critical design question — does C4 let `isReauthenticate` be simplified or removed?

**No. Keep it exactly as-is.** Two independent reasons survive C4, either one sufficient on its own:

**1. The full-sync-ack clobber is not fixed by C4, by construction (see C4's design above).**
`full_sync_applied` carries no correlator, so no keyed registry — however designed — can distinguish
which of two concurrent `sendFullSyncIfFirstPairing` invocations on the same `ws` a single incoming ack
belongs to. `isReauthenticate` is still the only mechanism preventing two such invocations from ever
overlapping on one connection. Fixing this fully would require adding a correlator field to the
`full_sync`/`full_sync_applied` wire messages — a protocol change explicitly out of scope for this
behavior-preserving initiative (and, if ever done, its own future ADR, not a side effect of this one).

**2. Even where C4 *does* genuinely fix the resolver-clobber (apply-ack, keyed by `op_id`), a second,
independent hazard remains: the final watermark `UPDATE devices SET last_synced_seq = ?` race.** Two
concurrent `sendMissedOps` runs on the same device each read their own `since` from
`devices.last_synced_seq` at call time, replay their own candidate op range, and — at the end — each run
`UPDATE devices SET last_synced_seq = <its own lastSuccessSeq>`. Whichever `UPDATE` *completes last* wins,
regardless of which run's `lastSuccessSeq` is numerically larger. C4's keyed apply-ack registry makes each
run's *individual op-by-op waiting* correct in isolation; it does nothing to serialize the two runs'
*final writes* against each other. A slower run that started with a smaller `since` finishing after a
faster run that advanced further could silently regress the watermark backward — a correctness
regression T85 exists specifically to prevent, and `isReauthenticate` is what removes the possibility of
two concurrent runs in the first place, not just what protects their resolvers.

**T87 interaction, re-confirmed at `e792b0e`, not just carried forward from the T87 ADR's own claim:**
T87's `onAuthRejected`/close-handler work (`syncClient.js`'s `ws.on('close', (code) => {...})`, clearing
`token` and firing `authRejectedListeners` on 4401–4404) operates entirely on the **Client** side and
never touches `ws.deviceId`, `isReauthenticate`, or any Host-side resolver state. T87's own ADR states
this interaction explicitly ("a startup `authenticate` on a fresh WS connection has `ws.deviceId` unset...
does not introduce any new re-authenticate-on-the-same-socket case beyond what T85 already handles") —
confirmed still true by re-reading `syncServer.js`'s current `handleAuthenticate` (lines 364–485, `e792b0e`):
nothing in this ADR's design touches `ws.deviceId` assignment, the token/type verification, or the
`isReauthenticate` computation itself. **Recommendation: leave `isReauthenticate` and its guard clause
(`syncServer.js:452`, `468`) byte-for-byte unchanged in every slice of this initiative.** A future ADR
could revisit it *if* a correlator is ever added to `full_sync`/`full_sync_applied` (closing reason 1) —
flagged as a non-goal below, not designed here.

## Slice decomposition

**Three slices, not two.** The task brief's own prior ("C1+C4 coupled → one slice") is a reasonable
starting instinct — C4's registry lives inside the functions C1 moves — but splitting further is smaller
and more reversible without adding real coordination cost, per the owner's own standing principle
(small reversible changes) and `karpathy`'s bar for the smallest responsible unit of change:

1. **Slice 1 — C1, pure move.** Create `opDelivery.js` + `catchup.js`; move the eight symbols listed
   above verbatim (same bodies, same comments, same behavior — a mechanical extraction); update
   `syncServer.js`'s imports; update `syncServer.test.js`'s import paths only (no behavior-assertion
   changes). Zero behavior change, by construction — the characterization tests listed below should pass
   byte-identical before and after with no test-body edits beyond import paths. Lowest risk, fastest
   review, trivially revertible (a straight `git revert` restores one file to its pre-slice shape).
2. **Slice 2 — C4, registry shape change, scoped to the now-isolated `catchup.js`.** Replace
   `ws.pendingCatchupAckOpId`/`ws.pendingCatchupAckResolve` with the keyed `Map` + `resolveApplyAck`;
   wrap `ws.pendingFullSyncAckResolve` behind `resolveFullSyncAck`; update `syncServer.js`'s two
   dispatcher cases to call the exported functions instead of touching `ws` fields; update
   `syncServer.test.js`'s five direct-field-poke call sites to call `resolveApplyAck` instead. This slice
   is a real (if externally invisible) mechanism change and deserves its own focused review — bundling it
   with Slice 1's pure move would force a reviewer to hold "is this move faithful" and "is this new
   registry correct" in mind at once, for no benefit, since Slice 1 already establishes the file boundary
   Slice 2 needs.
3. **Slice 3 — C3, independent.** `deviceTrust.js` + the four call-site swaps. Touches
   `electron/auth/authorize.js` and three handlers in `syncServer.js` (`handleAuthenticate`,
   `handleLogin`, `renew_token`) — none of which C1/C4 touch. No ordering dependency on Slices 1–2;
   can land before, after, or interleaved. Security-sensitive (auth boundary) — deserves a solo Security
   review pass rather than sharing attention with the delivery-layer slices.

**Recommended order: 1 → 2 → 3**, sequential, each its own PR, each independently mergeable and
independently revertible. Slice 3 could run in parallel with 1–2 if the team wants; sequencing it last
here only reflects that it is the one with a live security-review gate, so isolating it end-to-end (own
branch, own panel, nothing else changing underneath it mid-review) is cleaner.

## Files/modules affected

| File | Slice | Change |
|---|---|---|
| `electron/sync/opDelivery.js` | 1 | **New.** `send`, `sendWithAck`, `SEND_ACK_TIMEOUT_MS` — moved verbatim from `syncServer.js`. |
| `electron/sync/catchup.js` | 1, 2 | **New.** `currentMaxOpSeq`, `sendFullSyncIfFirstPairing`, `sendMissedOps`, `waitForFullSyncAck`, `waitForApplyAck`, `FULL_SYNC_ACK_TIMEOUT_MS` — moved verbatim (Slice 1). `resolveApplyAck`, `resolveFullSyncAck`, keyed `pendingApplyAcks` Map — added (Slice 2). |
| `electron/sync/syncServer.js` | 1, 2 | Slice 1: imports `send`/`sendWithAck` from `opDelivery.js`, `currentMaxOpSeq`/`sendFullSyncIfFirstPairing`/`sendMissedOps` from `catchup.js`; ~330 lines removed. Slice 2: `full_sync_applied` and `op_applied_ack` dispatcher cases call `resolveFullSyncAck`/`resolveApplyAck` instead of touching `ws.pending*` fields directly. `handleAuthenticate`'s `isReauthenticate` logic **unchanged** in both slices. |
| `electron/sync/syncServer.test.js` | 1, 2 | Slice 1: import-path updates only. Slice 2: five call sites (lines 829 comment, 951, 1056, 1059, 1140, 1189) updated from direct `ws.pendingCatchupAck*` manipulation to `resolveApplyAck(ws, opId)`. |
| `electron/auth/deviceTrust.js` | 3 | **New.** `deviceTrustStatus(db, deviceId)` (raw booleans, unchanged query). `deviceTrustReason(trust)` (**new**, harmonized precedence — revoked wins). |
| `electron/auth/authorize.js` | 3 | `deviceRow` query replaced by `deviceTrustStatus` + `deviceTrustReason` calls; deny condition unchanged, reason label changes for the `authorized_at: NULL, revoked_at: <set>` state. |
| `electron/sync/syncServer.js` | 3 | `handleAuthenticate`: device-trust query replaced by `deviceTrustStatus`/`deviceTrustReason`; deny condition unchanged, close-code choice (4403 vs 4404) now follows the harmonized reason — changes for the same reachable state. `handleLogin`: query replaced, deny condition unchanged, no reason ever exposed (unaffected). `renew_token`: query and inline ternary replaced by `deviceTrustStatus`/`deviceTrustReason`; deny condition and close-code mapping unchanged (this site already implemented the now-canonical precedence). |
| `electron/db/schema.sql` | — | **No change**, any slice. |

## Reused vs. new

**Reused, unchanged:** every existing function body (Slice 1 is a verbatim move, not a rewrite); the
single-pending-resolver-on-`ws` idiom for full-sync-ack (kept, just encapsulated — C4 does not touch its
internals, only its access path); the `withResolverTimeout`/`withKeyedResolverTimeout` idiom in
`syncClient.js` (referenced as the design precedent for C4's `Map`, not modified — `syncClient.js` is
untouched by this entire ADR); each of the four call sites' existing *allow/deny condition* (unchanged at
all four — see the invariant in Approach §C3); `authorize.js`'s existing `deny()` helper and
audit-logging convention (untouched); `renew_token`'s existing revoked-wins precedence, now sourced from
the shared `deviceTrustReason` instead of a local literal, with identical output for every input.

**New:** two files (`opDelivery.js`, `catchup.js`) and one file (`deviceTrust.js`) — no new tables, no
new columns, no new wire-message types, no new IPC surface. One new per-connection field shape
(`ws.pendingApplyAcks`, a `Map`, replacing two flat fields) — internal to `catchup.js`, never read
elsewhere after Slice 2. Two new shared function signatures (`deviceTrustStatus`, `deviceTrustReason`)
that four existing call sites adopt; the deny condition each site applies is unchanged, but two of the
four (`authorize.js`, `handleAuthenticate`) now report a different reason label — and, at
`handleAuthenticate`, a different WS close code — for the one reachable state where the old per-site
precedences disagreed.

## Security

**C1/C4 introduce no new trust decision and no new wire surface.** `opDelivery.js`/`catchup.js` are pure
code-motion (Slice 1) plus an internal resolver-storage change invisible outside `catchup.js` (Slice 2) —
neither slice changes what is sent, to whom, or under what authorization; `handleAuthenticate`'s
authentication/authorization sequence (token verification, self-registration, the trust check) is
untouched in both slices, staying in `syncServer.js`. The apply-ack `Map` is keyed by `op_id`, a value
already public on the wire (every `op_applied` message already carries it) — keying by it exposes
nothing new.

**C3 must not weaken the device-trust gate — verified per call site, not assumed.** All four call sites'
*allow/deny outcome* is provably unchanged: `deviceTrustStatus` computes the identical three facts
(`found`, `authorized`, `revoked`) each site already derives from its own query today, from the identical
columns; each site's own deny *condition* (`!found || !authorized || revoked`, in every case) is
untouched — only the query call, and, at two sites, the *reason label* it reports on an already-denied
request, are replaced.

**C3 is a deliberate, deny-preserving reason-label change, not a preserved divergence.** Per the
acceptance note at the top of this ADR, the owner directed harmonization: `deviceTrustReason` applies
one canonical precedence (revoked wins over not-authorized) at all four sites, matching `renew_token`'s
pre-existing precedence. This is a real, intentional change to observable output at two of the four
sites for the reachable `authorized_at: NULL, revoked_at: <set>` state (Context table, row 4 vs rows
1–2):

- `authorize.js` now reports `device_revoked` instead of `device_not_authorized` for that state. This
  reason is only audit-logged and returned to an internal caller — confirmed by grep that no `src/`
  code branches on either string, so no renderer-facing behavior changes.
- `handleAuthenticate` now closes the WS with code 4404 instead of 4403 for that state. **Confirmed
  UX-neutral**, not assumed: `src/hooks/useDeviceMode.js`'s `reasonForAuthRejectedCode` maps both 4403
  and 4404 to the identical director-facing message. A WS peer that inspects the raw close code
  (rather than going through the app's own UI) *would* observe a different code for this one state —
  that is the intended effect of harmonizing, not a defect.
- `handleLogin` and `renew_token` are unaffected — the former never exposes a reason (unchanged, by the
  adjacent oracle-resistance design), the latter already implemented the now-canonical precedence.

Security review (mandatory for this `task_class`) should specifically re-verify: (a) the four deny
*conditions* are byte-equivalent in allow/deny outcome pre/post-refactor for every combination of
`found`/`authorized`/`revoked`, including the reachable `revoked-but-never-authorized` state; (b) the
reason-label change at `authorize.js` and `handleAuthenticate` is confined to that one state and matches
`deviceTrustReason`'s documented precedence exactly, with no other state's reason or close code
affected; (c) `deviceTrustStatus`'s single query selecting a superset of columns
(`device_secret_identifier`) never leaks that column anywhere it wasn't already read — it flows only into
`handleLogin`'s existing `timingSafeEqual` comparison, never serialized, exactly as today.

## Migration

**No schema change, no wire-protocol change, in any slice.** This confirms the task brief's premise
directly rather than asserting it: every symbol C1 moves is moved verbatim (no signature change beyond
export visibility, which is a module-boundary fact invisible to any caller outside the moved files
themselves); C4 changes an internal storage shape (`ws.pendingCatchupAckOpId`/`Resolve` → a `Map`) that
is never read or written by any code outside `catchup.js` and `syncServer.js`'s two dispatcher cases,
both updated in the same slice; C3 replaces four identical-shape SQL queries with one, selecting a
superset of the same table's same columns. **Rollback for every slice is a plain code revert** — no data
migration, no forward/backward wire compatibility concern, since no peer (Host or Client, old or new
binary) ever observes a difference in what is sent or received.

## Non-goals

- **A `full_sync`/`full_sync_applied` correlator field**, which would let C4's keyed-registry pattern
  extend fully to the full-sync-ack case and remove reason 1 for keeping `isReauthenticate`. A genuine
  wire-protocol change; its own future ADR if ever pursued, not a side effect of this behavior-preserving
  initiative.
- **Retiring or relaxing `isReauthenticate`.** Explicitly evaluated and rejected in this ADR (see Critical
  design question) — two independent reasons survive C4, either sufficient alone.
- **A different canonical precedence than revoked-wins** (e.g. not-authorized-wins, or a
  product-visible distinction between the two reasons). The owner accepted revoked-wins on
  2026-08-17; revisiting the choice itself is a product/security decision, not something this ADR
  reopens.
- **Moving `broadcastOps` or `sendError`** into either new file. Neither is part of the C1-identified
  cluster; moving them would be scope creep on an initiative whose entire premise is "no functional
  change, smallest responsible extraction."
- **C5 (name the two identities of `createSyncClient`)** — a separate, lower-ranked audit candidate, not
  in this initiative's approved scope (only C1/C3/C4 were approved; C2 already shipped as T88).

## Test strategy

Per `docs/governance/GOVERNANCE_INDEX.md`, this spans `database-sync`/`concurrency` (C1/C4) and
`security-auth` (C3) — per `WORK_RECORD_STANDARD.md` §4, a cross-class task takes the stricter gate list
from both: integration suite mandatory, Security review mandatory, Red Hat recommended for the
write-ordering-adjacent C1/C4 slices.

**Behavior-preserving proof for Slices 1–2; fail-first proof of an intentional change for Slice 3:**

1. **Slice 1 (C1 move).** The existing characterization tests are the proof, unmodified in assertion body:
   `electron/sync/syncServer.test.js`'s full suite (all `describe` blocks under "Task 10 round-5 Fix 4",
   "Task 10 round-6", "T85 Part 2", "Red Hat follow-up: sendWithAck..." — lines 915–1290) must pass with
   only import-path edits. Any assertion-body change in this slice is itself a signal the move was not
   actually verbatim. Integration scenarios 06 (`06-catchup.js`), 13 (`13-host-crash-mid-sync.js`), 15
   (`15-clock-skew.js`), 17 (`17-second-device-domain-sync.js`), 24
   (`24-device-fk-seeding-and-watermark.js`) all call into this cluster indirectly (through real
   `syncServer`/`syncClient` pairs) and must pass unmodified.
2. **Slice 2 (C4 registry).** `describe('T85 Risk 1: re-authenticate on the SAME already-authenticated
   socket (shift change)'` (`syncServer.test.js` line 823) is the load-bearing regression test — it must
   continue to pass with `isReauthenticate` untouched, proving the guard still prevents the scenario C4
   does not (and cannot, for full-sync-ack) fully close on its own. Add one new unit test: two overlapping
   `sendMissedOps` calls on the same mock `ws`, each waiting on a *different* `op_id`, both resolve
   correctly via their own `resolveApplyAck` call — this is the direct, new proof of the clobber fix C4
   actually delivers. Update the five direct-field-poke call sites per Files/modules affected, and confirm
   the test file's meaning is unchanged (same simulated protocol behavior, different internal API).
3. **Slice 3 (C3 predicate + harmonize) — not purely behavior-preserving; the fail-first
   characterization test is mandatory, not optional.** This slice makes one intentional, reviewable
   behavior change (the reason label at `authorize.js` and `handleAuthenticate`, and the close code at
   `handleAuthenticate`, for the `authorized_at: NULL, revoked_at: <set>` state), so the test proof must
   show both what changed and that only that one state changed:
   - New unit tests for `deviceTrustStatus` (raw `{found, authorized, revoked}` shape, unchanged) and
     `deviceTrustReason` (the new precedence function): not-found, authorized, not-authorized, revoked,
     and the reachable `revoked-but-never-authorized` combination.
   - **Fail-first characterization test, written before the call-site changes land:** for
     `authorize.js` and `handleAuthenticate`, first write a test that pins the *old* divergent reason
     (`device_not_authorized` / close 4403) for the `authorized_at: NULL, revoked_at: <set>` state
     against the current code, confirm it passes (proving the old behavior is correctly captured), then
     flip the assertion to the *new* harmonized reason (`device_revoked` / close 4404) and confirm it
     fails against the current code and passes only once the call site is updated to use
     `deviceTrustReason`. This makes the intentional change explicit in the diff and reviewable by
     Security/Red Hat as a change, not something that could slip through as an accidental refactor
     side-effect.
   - For all four call sites, a table-driven test asserting the outcome (allow/deny, reason string or
     its absence, close code where applicable) for every one of the 2×2×2 `found`/`authorized`/`revoked`
     combinations against the post-refactor code — seven of the eight combinations must match
     pre-refactor output exactly; the eighth (`revoked-but-never-authorized`) must match the new
     harmonized output at `authorize.js`/`handleAuthenticate` and the unchanged output at
     `handleLogin`/`renew_token`. The test itself should say, in a comment, which combination is the
     intentional-change case so a reviewer isn't left inferring it.
   - `electron/auth/authorize.test.js` and the relevant `syncServer.test.js` login/renew_token/authenticate
     suites must pass with exactly one assertion-body change per site touched (the reason/close-code
     expectation for the one changed state) — any other assertion-body change is itself a signal of an
     unintended regression.
   - Security and Red Hat should scrutinize this slice specifically — it is the one place in this
     initiative where "the diff matches the ADR" is not the same question as "nothing changed."
4. **Full regression, every slice:** `npm run test`, `npm run lint`, `npm run build`, and the integration
   suite (mandatory per `database-sync`) must all pass with zero new failures. `npm run check:governance`
   for frontmatter/status-drift hygiene on this ADR and its run record.

## Consequences

- **Positive:** `syncServer.js` shrinks from 1216 lines to roughly 850, with its remaining content
  entirely dispatcher/handler/pairing logic — a single-responsibility file instead of a file that also
  quietly owns a watermark invariant. The watermark invariant itself gains one clear owner (`catchup.js`)
  instead of being explained across four separate comment blocks in a much larger file. The apply-ack
  clobber hazard (real, even if currently masked by `isReauthenticate`) is genuinely closed for future
  code that might legitimately need concurrent catch-up runs on one connection. The device-trust gate
  gains one query implementation and one canonical reason precedence instead of four near-identical
  queries with a silent divergence among them — the divergence identified in Context is resolved, not
  just documented, per the owner's 2026-08-17 acceptance.
- **Costs/risks:** three PRs instead of one, more review overhead in aggregate than a single combined
  change — accepted deliberately per the small-reversible-changes principle. Slice 2's test-file updates
  (five call sites in `syncServer.test.js`) are real, budgeted work, not free. The C4 asymmetry (apply-ack
  genuinely fixed, full-sync-ack only encapsulated) could read as "half-done" to a future reader who does
  not read the Critical design question section — mitigated by the inline comment on `resolveFullSyncAck`
  explaining why, and by this ADR itself being the durable record. Slice 3's harmonization is a real,
  intentional behavior change riding on a refactor PR — mitigated by the mandatory fail-first
  characterization test (Test strategy §3) and the explicit Security/Red Hat scrutiny called out there, so
  it cannot land as an unreviewed side-effect.
- **Explicitly not built here:** a full-sync correlator; any change to `isReauthenticate`; C5. **Built
  here, deliberately:** the harmonized device-trust reason precedence (revoked wins) at all four call
  sites — a real behavior change, confirmed deny-preserving at all four sites and confirmed
  user-interface-neutral (both affected close codes already fold to the same director-facing message in
  `useDeviceMode.js`). Nothing in this list is silently dropped or silently changed.

## Open questions for Governor

- **Resolved by owner acceptance (2026-08-17):** the prior version of this ADR left `renew_token`'s
  reversed reason precedence as an open product/security question and deliberately preserved the
  divergence. The owner has since directed harmonization (revoked wins, matching `renew_token`'s
  existing precedence) — see the acceptance note and Approach §C3. No longer open.
- **No ticket exists for this initiative** (unlike C2/T88, which had its own ticket because it was a live
  data-loss bug). Governor should decide whether each slice gets its own ticket for tracking (mirroring
  T88's precedent) or whether this ADR plus its run record is sufficient tracking for a purely
  architectural, no-functional-change initiative.
- **Slice ordering/parallelism:** this ADR recommends 1 → 2 → 3 sequential for review-isolation reasons,
  but notes Slice 3 has no technical dependency on 1–2 and could run in parallel if Governor prefers to
  compress calendar time over minimizing reviewer context-switching.

## Confidence

**High** on C1's module boundary (Candidate 3) and the no-cycle reasoning — directly verified by reading
`electron/sync/syncServer.js` in full at `e792b0e` and confirming the exact line ranges, existing exports,
and every call site of `send`/`sendWithAck` outside the C1 cluster. **High** on the C4 asymmetry finding
(full-sync-ack unkeyable without a protocol change) — this is a structural fact about the wire message
shape (`{ type: 'full_sync_applied' }`, no id field), directly confirmed by reading both the send side
(`syncServer.js`) and the message construction (`syncClient.js`'s `full_sync` handler,
`ws.send(JSON.stringify({ type: 'full_sync_applied' }))`), not inferred. **High** on the
`isReauthenticate`-must-stay verdict — two independent, structurally distinct reasons (unkeyable
full-sync-ack; the final-`UPDATE`-race that survives even a correctly-keyed apply-ack registry), each
independently sufficient, both directly reasoned from the actual `sendMissedOps`/`waitForApplyAck` control
flow at `e792b0e`, not from the T85 ADR's prose alone (re-derived from source, then cross-checked against
T85's own stated rationale for agreement). **High** on the C3 divergence finding (row 4 of the Context
table) — traced to `electron/main.js`'s `revokeDevice` (lines 713–730) directly, confirming the
`authorized_at` precondition genuinely does not exist, so the `revoked-but-never-authorized` state is
reachable in production, not a hypothetical edge case invented for the ADR. **Medium-high** on the exact
Slice 2 test-file migration scope (five call sites in `syncServer.test.js`) — found by direct grep and one
targeted read of the surrounding block (line ~823–890), not a full line-by-line audit of every one of the
five sites' exact surrounding assertions; Maker should re-confirm each site's full context before editing,
per this ADR's own "verbatim behavior" bar. **High** on the harmonization's UX-neutrality claim (2026-08-17
acceptance addendum) — directly confirmed by reading `src/hooks/useDeviceMode.js` lines 19–32:
`reasonForAuthRejectedCode` puts both close codes 4403 and 4404 in the same `DEVICE_REVOKED_CODES` set
and returns the identical `DEVICE_REVOKED_REASON` string for either, so moving the
`revoked-but-never-authorized` state from 4403 to 4404 changes no rendered director-facing text; and by a
repository-wide grep confirming `device_not_authorized`/`device_revoked` (the `authorize.js` reason
strings) are never read under `src/`, so the same state's reason-label change at `authorize.js` has no
renderer-visible effect either.

**Evidence behind this confidence:** direct reading of `electron/sync/syncServer.js` (full file, 1216
lines), `electron/sync/syncClient.js` (lines 1–1207, covering `keyedResolverMaps`,
`settlePendingOnDisconnect`, `withKeyedResolverTimeout`, `applyFullSync`'s `full_sync_applied` send, and
every reference relevant to this design — confirmed by a repository-wide grep for
`pendingFullSyncAckResolve`/`pendingCatchupAck` that no other file references these fields), `electron/auth/authorize.js`
(full file), `electron/main.js` lines 695–735 (`denyDevice`/`revokeDevice`), `docs/adr/2026-08-16-device-fk-seeding-and-delivery-watermark.md`
(full), `docs/adr/2026-08-16-client-reauth-on-restart.md` (full, including its 2026-08-17
post-implementation review note), `docs/governance/standards/WORK_RECORD_STANDARD.md` (full),
`docs/work/architecture-reports/2026-08-16-sync-auth-audit-summary.md`, and a targeted grep + read of
`electron/sync/syncServer.test.js` around lines 790–1290 and every `pendingCatchupAck*` reference — all at
worktree HEAD `e792b0e` (current `main`, includes the merged T87 fix), not the audit's original `b693e98`.
**Added for the 2026-08-17 acceptance addendum:** full read of `src/hooks/useDeviceMode.js` lines 1–60
(`reasonForAuthRejectedCode`, `DEVICE_REVOKED_CODES`, `DEVICE_REVOKED_REASON`) and a repository-wide grep
for `device_not_authorized`/`device_revoked` across `src/` and `electron/auth/authorize.js`.
