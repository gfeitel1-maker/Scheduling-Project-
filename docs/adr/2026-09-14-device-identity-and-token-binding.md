---
title: "ADR: Persistent per-device libp2p identity, binding a session token to the peer presenting it"
document_type: adr
status: accepted
authority: normative
implementation_state: not_started
date: 2026-09-14
decided: 2026-09-14
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
supersedes: []
extends: [docs/adr/2026-09-06-libp2p-membership-mapping.md]
related_adrs:
  - docs/adr/2026-07-25-device-trust-revocation.md
  - docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md
  - docs/adr/2026-09-08-libp2p-join-flow.md
depends_on_external: ["libp2p@2.10.0", "@libp2p/crypto@5.1.23", "@libp2p/peer-id@5.1.x"]
related_discovery: []
program: shoresh-future-architecture
---

# ADR: Persistent per-device libp2p identity, binding a session token to the peer presenting it

## Status

Accepted, 2026-09-14, product-owner. Implementation not started — see
`docs/work/tickets/T162-device-identity-and-token-binding.md` for the slice plan.

## Context

T155 (`docs/work/tickets/T155-admission-gate-characterized-limits.md`) characterized, rather than
closed, one property of the libp2p admission gate: **a camp token is a bearer credential.**
`evaluateAuthenticate` (`electron/auth/connectionAuth.js`) verifies a token's signature and its
`device_id` claim, then checks that device's trust/revocation status — but nothing checks *which
libp2p peer is presenting the token*. A token copied off a paired device's disk authenticates from
any machine that dials the Host and speaks the protocol. This is measured, not assumed, by
`syncNodeAuthGate.test.js`'s `T155` block: a token issued for `device-impostor`'s claimed identity,
replayed from a peer the Host has never seen, is admitted (`auth_ok`) — bounded only by the fact
that revocation is re-checked on every authenticate, so revoking the named device closes the replay
immediately.

`devices.libp2p_peer_id` (schema v57) already exists and already looks like the obvious fix, but is
explicitly documented — in `electron/db/localDb.js`, `electron/sync/automerge/peerIdentity.js`, and
guarded by a standing test in `electron/db/libp2pPeerId.migration.test.js` — as a **routing
convenience only, never a trust signal**, because `libp2p` (`electron/sync/automerge/transport.js`)
generates a fresh keypair-derived `PeerId` on every process start. Binding to a value that changes
on every restart would reject every ordinary reconnect. Closing T155 requires making the identity
itself durable first, and only then trusting it.

The owner has decided to do this. This ADR records the design; product decisions the design surfaces
(reinstall support cost, key format) are stated explicitly rather than assumed.

## Decision

### 1. Where the key lives, and in what form

**Each device generates and persists its own Ed25519 keypair, locally, the first time it runs a
sync node** — not just the Host. This is a new concept distinct from `host_signing_key`:
`host_signing_key` is Host-only and signs *tokens*; this key is per-device (every device that ever
runs `startSyncNode`, Host or Client) and establishes the device's own *transport identity* to
libp2p.

New table, local-only, singleton per device database (mirrors `host_signing_key`'s shape exactly —
same `CHECK (id = 1)` singleton pattern — but the *set* of devices holding one is "every device,"
not "the Host"):

```sql
CREATE TABLE IF NOT EXISTS device_identity_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  peer_id TEXT NOT NULL,
  private_key TEXT NOT NULL,   -- hex-encoded libp2p protobuf-marshaled PrivateKey
  created_at TEXT NOT NULL
);
```

**Encoding deviates from `host_signing_key`'s hex-DER deliberately.** `host_signing_key` uses DER
because it round-trips through Node's own `createPrivateKey`/`createPublicKey`. This key round-trips
through `@libp2p/crypto`'s own marshal format instead — `privateKeyToProtobuf(key)` /
`privateKeyFromProtobuf(buf)` (`@libp2p/crypto@5.1.23`, confirmed present in
`node_modules/@libp2p/crypto/dist/src/keys/index.d.ts`) — because that is the format `createLibp2p`'s
`privateKey` option and `@libp2p/peer-id`'s `peerIdFromPrivateKey` actually consume; forcing it
through DER would just add a translation step with no benefit. Hex encoding for the same reason
`host_signing_key` and `device_secret_identifier` already use it: consistency with every other
hex-encoded secret in this codebase, not a new convention.

**Never synced.** This table joins the same exclusion class as `host_signing_key`: never registered
in `PROJECTIONS`, `campScopedEntities.js`'s `DIRECT_CAMP_ENTITIES`/`PARENT_SCOPED_ENTITIES`, or
`campDocument.js`'s `MODELED_ENTITIES`. Key material has no business in shared CRDT history — same
reasoning `issueCampToken`'s doc comment already gives for `signing_secret`.

### 2. When the identity is created; existing devices

**Created lazily on first sync-node start**, analogous to `ensureHostSigningKey`'s lazy-create-at-
first-need pattern: a new `ensureDeviceIdentity(db)` (new module, `electron/auth/deviceIdentity.js`)
called once inside `startSyncNode` (`electron/sync/automerge/syncNode.js`), before `startTransport`
is invoked, so the `privateKey` is available to pass into `createLibp2p`.

Rejected: creating it at `bootstrapCamp()` (Host-only entry point — a Client never calls it, so a
Client would still need its own lazy path anyway) or at pairing (pairing happens *before* a device
has necessarily run a sync node at all in every flow, and tying key generation to a specific IPC
call rather than "first time this device needs a libp2p identity" adds a call-site dependency for no
benefit). First-sync-node-start is the one place every device — Host or Client — is guaranteed to
pass through before it ever dials or is dialed.

**Existing devices: clean cutover, no back-compat path.** Per the owner's standing preference
(pre-production, no real camp data — `feedback_preproduction_bias_bold` in project memory) and
confirmed explicitly here rather than assumed: the migration (§5) sets every existing
`devices.libp2p_peer_id` to `NULL`. Those values were written under the old "routing convenience,
regenerated every restart" regime and are not meaningfully tied to any device's new persistent
identity — carrying one forward would either be a coincidence (harmless) or would falsely bind a
device to a stale value from a past process lifetime (harmful, per §4's bind-once semantics). Every
device re-establishes its binding via TOFU (§3) the first time it authenticates or logs in after
upgrade. No device is locked out by this migration — first contact after upgrade is trusted, exactly
like first contact today.

### 3. How the token binds to the peer

**Recommendation: look up the expected peer id from `devices` at authenticate/login time; do not
carry it as a token claim.** Confidence: high — evidence in "Failure modes" below.

`evaluateAuthenticate` (`electron/auth/connectionAuth.js`) and `evaluateLogin` both gain a `peerId`
parameter, populated from `fromPeerId` — the value `authGate.js` already threads through from
`connection.remotePeer.toString()`, i.e. **the peer identity libp2p's own Noise handshake already
cryptographically established for this connection**, not a client-asserted field. This is the load-
bearing fact that makes the design work: nothing new needs to prove peer possession of a private
key, because libp2p already proved it before `onAuthenticate` is ever called. The design only needs
to check that proven identity against what this device claims to be.

**Binding policy — trust-on-first-use (TOFU), enforced by a new `bindOrVerifyPeerIdentity(db,
deviceId, peerId)`** (replacing, at the `authenticate`/`login` call sites only, the current
unconditional-overwrite `recordLibp2pPeerId`):

- `devices.libp2p_peer_id IS NULL` for this `device_id` → this is the device's first-ever bind.
  `UPDATE devices SET libp2p_peer_id = ? WHERE id = ?` (guarded by the existing partial unique index
  from v57 — a collision here means two devices are claiming the same keypair, cryptographically
  negligible and correctly rejected, same posture `peerIdentity.js` already documents for its
  stale-claim case). Admit.
- `devices.libp2p_peer_id` is set and equals `peerId` → admit (the ordinary reconnect case; now
  stable across restarts because the identity itself is persistent).
- `devices.libp2p_peer_id` is set and differs from `peerId` → **reject**, new reason
  `peer_identity_mismatch`, new WS/libp2p-close-code-convention value `4405` (next after the
  existing 4401–4404 run), audited via `recordAuditEvent` exactly like the existing trust-denial
  branch.

Applied at both call sites that currently call `recordLibp2pPeerId(db, msg.device_id, fromPeerId)`
unconditionally — `syncNode.js`'s `onAuthenticate` (line 287) and `onLogin` (line 359) — because a
reinstalled device could otherwise bypass the mismatch check by re-logging-in instead of
reconnecting. `joinSession.js`'s `recordLibp2pPeerId(db, reply.host_device_id, hostPeerId)` (a
*Client* recording the *Host's* peer id to know where to dial back) is a different direction — a
routing hint the Client keeps about the Host, not an admission decision the Host makes about a
Client — and is out of scope here; noted as an open question below rather than silently left
inconsistent.

**Failure modes of the two options, why table-lookup wins:**

- **Token-carries-peer-id** (mint the claim into the token payload at issue time, verify by
  comparing the token's own claim to `fromPeerId`): works, but requires widening `issueCampToken`/
  `issueLocalToken`'s payload shape and re-signing on every re-bind (e.g. after a deliberate
  re-pair), and moves the "current expected peer id" fact into a value that lives inside opaque,
  already-signed bytes — a second source of truth alongside `devices.libp2p_peer_id`, which
  `recordLibp2pPeerId` already needs to keep for routing regardless. Two places to keep consistent
  for one fact.
- **Table-lookup at authenticate time (chosen):** zero token schema change — `issueCampToken`,
  `issueLocalToken`, `issueDeviceToken` are untouched. Reuses the exact pattern
  `evaluateAuthenticate`'s own doc comment already states as the codebase's convention: "revocation
  re-checked fresh here rather than cached — same revocation-enforcement rule `authorize()` applies
  on every IPC call." One source of truth (`devices.libp2p_peer_id`), read fresh, same table the
  revocation check already re-queries in the same function.

**The reinstall / lost-laptop / restored-backup case, named precisely, as the owner accepted this
cost explicitly:** a reinstalled app (or a laptop restored from a backup taken before the reinstall,
or any event that discards `device_identity_key`) generates a **new** keypair on next launch. Its
`peer_id` no longer matches the one bound in `devices.libp2p_peer_id` on any Host it was previously
paired with. Its session token(s) — even if otherwise structurally valid and unexpired — are
rejected with `peer_identity_mismatch` on every Host that knew the old identity. **This is treated as
equivalent to needing to re-pair, not as an outage to route around silently.** The recovery path is
the existing device-trust flow: the director revokes the old `devices` row (or an explicit "reset
device identity" admin action, scoped separately — see the open question below) and the device pairs
again as new, going through `pairing_request`/approval/`login` exactly like a first-time device. No
new automatic recovery is designed here; a support cost is accepted deliberately, per the owner's
2026-09-14 decision, not discovered as an accidental side effect.

### 4. `devices.libp2p_peer_id`'s invariant, replaced not deleted

**Old invariant** (v57, still true today): *this column is a routing convenience only; nothing may
authorize based on it.*

**New invariant** (this ADR): *this column is a security-relevant, bind-once-per-device identity
anchor, set by `bindOrVerifyPeerIdentity` and read by `evaluateAuthenticate`/`evaluateLogin` as part
of the admission decision — but it still confers no role or capability on its own.* The distinction
that survives from the old invariant: binding a peer id lets a device *reach* the admission check at
all (or rather, prevents a *different* peer from reaching it under a stolen token) — it still says
nothing about what that device is *authorized to do* once admitted. `authorize()` must continue to
never read this column; the separation between "who may connect" (admission, now including identity
binding) and "what may this actor do" (`authorize()`, role-based) is exactly the layering
`issueDeviceToken`'s doc comment already establishes for the `device`-vs-`camp` token split, and this
change does not blur it.

`electron/db/libp2pPeerId.migration.test.js`'s existing guard test —

```js
describe('devices.libp2pPeerId is documented as a non-trust routing convenience', () => {
  it('is not referenced anywhere in the authorization boundary', () => {
    expect(authorizeSrc).not.toMatch(/libp2p_peer_id/)
  })
})
```

— **is updated, not deleted.** The `authorize.js`-never-references-this-column assertion still holds
under the new design (unchanged) and stays as its own describe block with an updated block comment
explaining *why* it still holds (admission ≠ authorization). A **new** describe block is added
alongside it asserting the new invariant precisely: `connectionAuth.js` (specifically
`evaluateAuthenticate`/`evaluateLogin`) *does* reference `libp2p_peer_id`, and does so only for
admission binding, not for role/permission decisions — e.g. by asserting the reference exists in
`connectionAuth.js` and does not co-occur with anything resembling a role/permission grant in the
same function. The old test's *literal* assertion (column absent from `authorize.js`) is preserved
verbatim; what changes is the file's framing comment and the addition of the new sibling assertion,
so the invariant is sharpened rather than silently narrowed.

### 5. Migration/rollback (schema v60)

This repo is at v59. New migration block, `>= 59 && < 60` guard (per the v57/v58 precedent of
guarding against skip-ahead on a db that hasn't reached the prior version):

```js
if (getSchemaVersion(db) >= 59 && getSchemaVersion(db) < 60) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS device_identity_key (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        peer_id TEXT NOT NULL,
        private_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `)
    // Clean cutover (§2): every existing libp2p_peer_id value was written under the
    // old "routing convenience, regenerated every restart" regime and is not tied to
    // any device's new persistent identity. Null them so every device re-establishes
    // its binding via TOFU on next contact — no live camp data exists to protect, per
    // the owner's 2026-09-14 decision (see ADR §2).
    db.exec('UPDATE devices SET libp2p_peer_id = NULL')
  })()
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (60, ?)').run(
    new Date().toISOString()
  )
}
```

Both-places DDL: `device_identity_key`'s `CREATE TABLE` also added to `schema.sql` verbatim, per the
v56/v57 precedent, so a fresh install and a migrated db agree on `PRAGMA table_info`.

**Rollback** (`electron/db/rollback/v60_down.js`, following the `v59_down.js` shape exactly):
drops `device_identity_key`. **Cannot restore the nulled `libp2p_peer_id` values** — they were
routing hints, already documented as regenerated/disposable, and the migration's own comment already
states they carry no meaning worth restoring. Same posture as `v59_down.js`'s "DATA IS NOT RESTORED,
and cannot be" for `day_overrides`. `DELETE FROM schema_migrations WHERE version >= 60` per the
`>= N` (not `= N`) precedent so a later migration's row surviving rollback can't defeat the `>= 59 &&
< 60` guard on next `initSchema()`.

### 6. Observable success predicate and the T155 test inversion

**Success predicate:** a session token replayed from a libp2p peer other than the one bound to that
token's `device_id` is rejected with `peer_identity_mismatch`, while an ordinary reconnect from the
same device — including after that device's own process has restarted — continues to succeed,
because its libp2p identity, and therefore its `PeerId`, no longer changes across restarts.

**Test layer:** `electron/sync/automerge/syncNodeAuthGate.test.js`'s existing T155 block, wired
end-to-end through `startSyncNode` against a real SQLite db exactly as today — this is deliberately
not a new isolated unit test, because the property under test is specifically "does the *real*
admission path reject the replay," which only an end-to-end wiring proves.

**The existing T155 test is inverted by this work, not just extended — say so explicitly:**

```js
// BEFORE (T155, characterizing the open gap):
const replayed = await impostor.authenticateWith(b.peerId, { type: 'authenticate', token, device_id: deviceId })
expect(replayed).toEqual({ type: 'auth_ok' })   // bearer token, no peer binding

// AFTER (this ADR, closing it):
const replayed = await impostor.authenticateWith(b.peerId, { type: 'authenticate', token, device_id: deviceId })
expect(replayed.type).toBe('auth_failed')       // deviceId is already bound to `a`'s peer id
                                                  // (the FIRST authenticate above bound it via TOFU);
                                                  // impostor's distinct peer id mismatches
```

The block's title and comment (`'A CAMP TOKEN IS A BEARER CREDENTIAL: ...'`) must change to state
what is now true, not what used to be true — e.g. `'a token replayed from a peer other than the one
it is bound to is rejected'` — and the counterweight test in the same `describe` (revocation closing
a still-valid-looking token) is kept as-is; it remains true and remains the second line of defense.
`docs/work/tickets/T155-admission-gate-characterized-limits.md`'s own text (`status: completed`) is
not reopened — it correctly recorded a characterization at the time it was written; this ADR's ticket
(T162) is the one that closes the gap it named, and should say so via `related_adrs`/cross-reference
rather than editing T155's already-closed record.

## Interface-contract checklist (`org-interface-contracts`)

- **Idempotency.** The TOFU bind is a single `UPDATE` on first contact; every subsequent
  authenticate for the same device+peer is a read-compare-equal no-op. Two authenticate attempts
  from the same never-before-seen device racing each other is the only concurrent-write case, and it
  resolves the same way `peerIdentity.js`'s existing stale-claim handling does: the unique index
  makes the second writer either match (fine) or collide (correctly rejected as a genuine identity
  conflict, not silently overwritten).
- **Concurrent retries.** A reconnect retry from the same device always presents the same `peerId`
  (persistent identity), so retrying an authenticate is safe under the same idempotency argument
  above — no double-apply, no drop.
- **Unknown outcomes.** `evaluateAuthenticate`/`evaluateLogin` remain synchronous decisions returned
  to the caller in the same call — no new ambiguous-outcome window is introduced.
- **Error shape.** New `{ ok: false, code: 4405, reason: 'peer_identity_mismatch' }`, following the
  existing 4401–4404 convention exactly, documented in the function's own return-shape comment
  alongside the others.
- **Scope/authority boundary.** Tightens the admission boundary; does not touch `authorize()` and
  does not let this column cross into role/permission decisions (§4). Camp isolation unaffected —
  per-camp-db, per-camp `devices` table, unchanged.
- **Trust boundary.** The value being compared (`fromPeerId`) is not client-asserted data — it is
  established by libp2p's Noise handshake before `onAuthenticate` is ever called, i.e. it is exactly
  the kind of already-verified value this project's trust-boundary rule says does not need
  re-validation. The value it's compared against (`devices.libp2p_peer_id`) lives in this device's
  own local SQLite, the same trust root pairing/revocation state already lives in.

## Files/modules affected

- New: `electron/auth/deviceIdentity.js` — `ensureDeviceIdentity(db)`.
- New: `electron/sync/automerge/peerIdentity.js` — add `bindOrVerifyPeerIdentity(db, deviceId,
  peerId)`, alongside (not replacing) the existing `recordLibp2pPeerId`, which `joinSession.js`'s
  Host-routing-hint use keeps calling unchanged.
- Changed: `electron/auth/connectionAuth.js` — `evaluateAuthenticate`/`evaluateLogin` gain a `peerId`
  parameter and the bind-or-verify check; new `4405`/`peer_identity_mismatch` return shape.
- Changed: `electron/sync/automerge/syncNode.js` — `onAuthenticate`/`onLogin` pass `fromPeerId`
  through as `peerId`; call `ensureDeviceIdentity(db)` at `startSyncNode` startup; call
  `bindOrVerifyPeerIdentity` instead of `recordLibp2pPeerId` at these two call sites specifically.
  `startTransport` receives the persisted `privateKey`.
- Changed: `electron/sync/automerge/transport.js` — thread a `privateKey` option through to
  `createLibp2p({ privateKey, ... })` (the option already exists in `libp2p@2.10.0`'s `Libp2pOptions`
  type — confirmed in `node_modules/libp2p/dist/src/index.d.ts`; nothing to add to `package.json`).
- Changed: `electron/db/localDb.js` — v60 migration block; `schema.sql` gains `device_identity_key`.
- New: `electron/db/rollback/v60_down.js`.
- Changed: `electron/db/libp2pPeerId.migration.test.js` — update the guard-test framing comment;
  add the new sibling invariant assertion (§4).
- Changed: `electron/sync/automerge/syncNodeAuthGate.test.js` — invert the T155 block's second
  assertion and its title/comment (§6); new tests for the mismatch-reject and TOFU-bind-on-first-
  contact cases.
- New tests: `electron/auth/deviceIdentity.test.js`, `electron/sync/automerge/peerIdentity.test.js`
  additions for `bindOrVerifyPeerIdentity`, `electron/db/deviceIdentityKey.migration.test.js`
  (v60 shape, following the v57 migration-test precedent).
- Not touched: `PLATFORM_STATE.md` (owner will update it), `authorize.js` (must stay untouched per
  §4), any renderer/`src/` code (this is an `electron/`-only change; no IPC surface changes shape).

## Reused vs. new

**Reused:** the `host_signing_key` singleton-table shape (structure, not encoding); the
`recordLibp2pPeerId`/stale-claim-clearing pattern in `peerIdentity.js` as the model for
`bindOrVerifyPeerIdentity`'s collision handling; the existing partial unique index on
`devices.libp2p_peer_id` (no index change needed — TOFU-bind-once is exactly what a partial unique
index over a nullable column already enforces); the 4401–4404 WS/libp2p-close-code convention,
extended by one value; `evaluateAuthenticate`'s existing "re-check trust fresh, every call" pattern,
extended to peer identity; `ensureHostSigningKey`'s lazy-create-on-first-need pattern.

**New:** persisting a libp2p identity at all (today it is always ephemeral) — nothing existing
covers this, it is the entire point of the change; the TOFU bind-once semantics themselves (today's
`recordLibp2pPeerId` always overwrites, which is precisely the behavior this ADR must stop doing at
the `authenticate`/`login` call sites).

## ADR required

Yes — filed at `docs/adr/2026-09-14-device-identity-and-token-binding.md`. This introduces a new
persistent data shape (`device_identity_key`) other code (the transport layer) depends on, changes
an existing contract two other modules already call (`evaluateAuthenticate`/`evaluateLogin`'s
signature and return shape), and makes a non-obviously-reversible tradeoff (accepting a named
re-pairing cost on reinstall in exchange for closing the bearer-token property) — all three of the
constitution's ADR triggers apply.

## Open questions for Governor

1. **Explicit "reset device identity" admin action.** Today, recovering from a reinstall mismatch
   works via the existing revoke-then-re-pair flow (§3), which already exists and needs no new UI.
   Whether the product wants a friendlier one-click "this is the same device, it just got a new
   identity" path (distinct from full revoke+re-pair, and requiring its own trust reasoning about who
   may invoke it) is a product decision, not a technical one — out of scope for T162 unless Governor
   pulls it in.
2. **`joinSession.js`'s Client-side recording of the Host's peer id** (routing hint, opposite
   direction from the admission binding this ADR closes) is left as `recordLibp2pPeerId`, unchanged.
   If the product later wants a Client to detect "the Host I'm dialing now presents a different
   identity than the Host I paired with" (a Host-impersonation concern, not the bearer-token concern
   T155 named), that is a separate, symmetric design question this ADR deliberately does not answer.
