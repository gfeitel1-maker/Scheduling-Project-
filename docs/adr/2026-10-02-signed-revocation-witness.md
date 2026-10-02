---
title: "Signed, monotonic revocation witness — corrected WAN discovery ladder Slice 2"
document_type: adr
authority: normative
status: proposed
date: 2026-10-02
decided: null
deciders: [product-owner]
program: security-hardening
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - SECURITY.md
supersedes: []
amends:
  - docs/adr/2026-09-19-per-camp-genesis-identity.md
related_adrs:
  - docs/adr/2026-10-02-wan-discovery-transport-ladder.md
  - docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md
  - docs/adr/2026-09-19-multi-device-erasure-propagation.md
  - docs/adr/2026-09-26-schema-version-gate-before-merge.md
  - docs/adr/2026-09-14-device-identity-and-token-binding.md
related_docs:
  - docs/work/security/2026-10-02-t329-slice2-camp-epoch-assessment.md
  - docs/work/specs/2026-10-02-t329-rotation-on-revocation-design.md
related_tickets: []
implementation_state: not-started
affects:
  - electron/sync/automerge/syncNode.js
  - electron/sync/automerge/mutualAuth.js
  - electron/sync/automerge/transport.js
  - electron/automerge/projector.js
  - electron/automerge/tombstoneSignature.js
  - electron/automerge/rebuildSupportCommand.js
  - electron/automerge/purgeSupportCommand.js
  - electron/db/schema.sql
  - electron/db/rollback/
  - SECURITY.md
---

# ADR: Signed, monotonic revocation witness — corrected WAN discovery ladder Slice 2

**Ticket:** T330. **Status: proposed — not accepted.** Goes to the product owner for acceptance;
nothing here authorizes code. No capability in `electron/sync/automerge/transportCapabilities.js`
is opened by this ADR (see "Tier-4 impact" below).

## Why this ADR exists

T329 (branch `claude/t329-ephemeral-join-secret-rotation @9f120797`, **frozen, do not merge**)
attempted Slice 2 of the accepted parent ADR
(`docs/adr/2026-10-02-wan-discovery-transport-ladder.md`) and **failed its security + battle-test
gate**. The failure assessment
(`docs/work/security/2026-10-02-t329-slice2-camp-epoch-assessment.md`) and the flawed design
(`docs/work/specs/2026-10-02-t329-rotation-on-revocation-design.md`) confirmed three findings this
ADR exists to close. This ADR also corrects and amends
`docs/adr/2026-09-19-per-camp-genesis-identity.md`, which recommended the `campId`-scoped
`camp_epoch` shape T329 built — that recommendation is withdrawn below.

## Candidate approaches considered (divergent ideation, `adhd` skill)

Four parallel frames (regulator, hostile-attacker, remove-load-bearing-assumption, 3am-on-call)
converged, independently, on the same underlying angle, which is itself a signal: **the gate cannot
live inside the opaque CRDT payload at all — it has to live on the connection/peer-identity layer,
checked at handshake time and re-checked continuously, with the signed fact propagated as its own
out-of-band channel rather than as a document field compared pre-merge.**

Clustering the ~24 raw ideas by angle:

- **Transport/handshake-layer gate** (all four frames independently proposed this) — refuse the
  libp2p connection or the `authenticate` exchange itself for a revoked device, so `handleSyncMessage`
  never runs. `[N6 V9 F9]` ★. This is not new machinery — it is the exact shape
  `electron/sync/automerge/mutualAuth.js`'s `isPeerTrusted`/token check and
  `electron/sync/automerge/syncNode.js`'s `isPeerSyncCompatible` (T271 round 3) already occupy.
  **Chosen as the primary enforcement point.**
- **Envelope/handshake self-report, cross-verified against a locally-held signed truth** — a peer
  announces a witness value in its own handshake frame (mirroring `schemaVersion`/
  `appliedTombstones` in `mutualAuth.js`'s `authenticateWith` payload), but the receiver never
  trusts the self-report alone — it is cross-checked against the receiver's own independently
  synced, signed revocation set. `[N7 V8 F9]` ★. **Chosen**, because it reuses the T271
  handshake-sourced-predicate pattern exactly, closing Finding 1 without inventing a second
  protocol.
- **Cryptographic structural impossibility** (deriving the session key itself from the epoch, or
  gating inside the Noise upgrader) — elegant in the abstract, but it requires touching libp2p's
  own crypto pipeline, which this codebase does not own and has never modified; a defect here is
  catastrophic and unreviewable against the installed `@libp2p/*` versions without new expertise
  this team doesn't need to acquire for a problem the handshake-layer gate already solves. `[N8 V3
  F6]` — **trap**: maximal novelty, minimal near-term viability, solves nothing the cheaper
  approach doesn't already solve.
- **Out-of-band gossip of the witness, independent of CRDT replication** (a separate pubsub
  broadcast, or a parallel non-Automerge channel) — real insight (revocation shouldn't ride on
  ordinary document merge semantics), but **this project already has exactly this primitive**: the
  signed purge-tombstone family (`electron/automerge/tombstoneSignature.js`, the `tombstones`
  table, T233) is a host-signed, append-only, monotonically-versioned record that propagates via
  ordinary CRDT sync *without* being subject to LWW-scalar risk, because it is a **set addition**,
  not a field overwrite. `[N5 V9 F9]` ★. **Chosen** — reuse this family rather than inventing a
  second signed-gossip mechanism.
- **Self-healing anti-entropy ("every peer refuses to sync until it presents the highest witness
  it has ever seen from anyone")** — this is the right global property, but the literal
  "require the other peer to assert a value first" shape reopens a replay/liveness-DoS surface
  (a peer that never updates refuses everyone forever). `[N6 V5 F6]` — trap, refined: keep the
  *comparison-against-locally-verified-truth* half, drop the *demand-from-peer* half.
- **Always-on freshness/liveness protocol for a point-in-time event** (periodic re-proof) — same
  trap `docs/adr/2026-09-19-per-camp-genesis-identity.md` already flagged and rejected for the same
  class of problem: permanent infrastructure for a rare event. `[N4 V4 F5]` — **trap**, excluded.

**Non-obvious pick marked ★:** combining the handshake-layer gate (closes Finding 1's "wrong path"
literally — it isn't even a question of which merge path checks a field, because no merge happens
before the gate) with the tombstone-family signed-set primitive (closes Finding 2's forgeability
and Finding 3's non-monotonicity *structurally*, by construction of the primitive, not by a new
comparison rule) is the smallest responsible design: it introduces **zero new cryptographic
machinery and zero new protocol round-trip** — every piece reuses a pattern already reviewed and
shipped in this codebase (T271's handshake-sourced peer predicate; T233's signed append-only
witness family).

## The witness: what it is, who signs it, how it's verified

**Reuse `tombstoneSignature.js`'s shape directly** — this is a sibling signed primitive, not a
second crypto design. Concretely:

- **New document collection, `camp_revocations`** (genesis-registered the same way the T233
  `tombstones` collection was added — an additive, subset-guard-enforced genesis regeneration;
  `campDocument.js`'s `GENESIS_B64`/`genesisRootHash`/`sharesGenesis` are otherwise **unchanged**,
  exactly as T233 left them unchanged for `tombstones`). Each entry is a **host-signed, append-only
  record**, never an overwritten scalar:

  ```
  { device_id, seq, signature }
  ```

  `device_id` is the revoked device's persistent identity row id (the same id
  `electron/main.js`'s `revokeDevice` already looks up to find a `peerId`). `seq` is a **single
  camp-wide monotonic counter** the Host increments on every revocation (not a per-device counter —
  one global ordering, so "highest verified seq" is a single comparable scalar derived locally,
  never itself replicated as a scalar). Signed fields, in the same canonical-message, domain-
  separated style as `canonicalTombstoneMessage` (new domain-separation context, e.g.
  `shoresh-revocation-sig-v1`, so a revocation signature is never interchangeable with a tombstone
  or auth-field signature): `['device_id', 'seq']`. Binding both stops a replay of one device's
  genuine revocation being relabeled against a different device, and stops an older, lower-`seq`
  revocation being replayed to roll back which devices are currently known-revoked.

- **Signing: Host-only**, via the existing `host_signing_key` row — `signRevocation(db, fields)`
  mirrors `signTombstone` exactly (throws if this device holds no host key). **No new key
  material, no new custody question**: this is the same Q1/T172 Ed25519 signing anchor, the same
  "only the Host can mint" invariant SECURITY.md already documents for tombstones.

- **Verification: independent of any unsigned scalar, independent of the sender's say-so.**
  `verifyRevocation(publicKeyHex, fields, sig)` mirrors `verifyTombstone` exactly — pure,
  side-effect-free, never throws, verifies against `camps.signing_public_key` **read from this
  device's own local SQLite row, never from the document** (the same Security-F1 correction T233's
  own ADR already made and that this design inherits rather than re-derives). A device that is
  itself revoked cannot forge a new revocation record (it does not hold `host_signing_key`'s
  private half — that is Host-only, per-device, and a revoked device was never the Host), and
  cannot forge an *un-revocation* either, because there is no un-revocation record type: a
  `device_id` once validly entered into `camp_revocations` stays revoked under that identity
  forever. (A director who wants to re-admit a physically-returned device re-pairs it, which mints
  a **new** device identity under `electron/auth/deviceIdentity.js` — this reuses the existing
  re-pair flow rather than inventing a reversible-revocation state machine, consistent with
  `karpathy-guidelines`: do not build the state machine for a case the product doesn't need.)

- **Storage/projection mirrors the `tombstones`/`peer_tombstone_reports` pattern exactly**: a local,
  never-synced SQLite table `applied_revocations (device_id, seq, PRIMARY KEY(device_id))` records
  what *this device* has verified-and-applied, written at projection time
  (`electron/automerge/projector.js`, alongside the existing `verifyTombstone` call site) by calling
  `verifyRevocation` against every `camp_revocations` entry not yet in `applied_revocations`. A
  record that fails verification is **dropped silently at projection, never applied, and never
  retried** — same refuse-and-drop discipline as `sharesGenesis`/the schema-version gate. This
  table is this device's own "highest verified seq" ledger: `MAX(seq)` over it is a value
  **recomputed locally from the verified set**, never itself a synced or merged scalar — this is
  the structural answer to Finding 3 (see "Why this is monotonic under merge" below).

## Where enforcement sits on the production path

Three enforcement points, in order of when they fire, all keyed on **device identity**, not on a
document field compared pre-merge:

**(A) Handshake gate — primary, closes Finding 1 literally.** `mutualAuth.js`'s
`authenticateWith`/`wireMutualAuth` and the inbound counterpart in `authGate.js` already gate
admission on `isPeerTrusted(peerId)` before a token is ever exchanged (T208) and already carry
`schemaVersion`/`appliedTombstones` as self-reported fields in the `authenticate` frame. Add one
more check, in the same place, with the same shape: before replying `auth_ok`, look up whether the
connecting device's persistent identity appears in **this device's own, locally-verified**
`applied_revocations` table (never the connecting peer's self-report — a revoked device gets no
vote in whether it is admitted). If present, refuse — same refusal shape `evaluateAuthenticate`
already uses for a bad token, with its own named reason so the audit log distinguishes "revoked"
from "bad credential." **This is the gate that closes the cached-address threat**: Slice 1's
persisted-peer redial (`peerAddressBook.js`'s `redialTrustedPeers`) still calls `dial` +
`authenticateWith` — it does not and cannot skip the handshake, so a revoked device with a
remembered address is refused here on every redial attempt, exactly as it would be on a fresh mDNS
discovery.

**(B) Per-sync-message gate on the actual production path — closes Finding 1's "wrong path"
finding directly.** Mirror `isPeerSyncCompatible`/`peerSchemaVersions` in `syncNode.js` precisely:
a small `isPeerRevoked(peerId)` predicate, backed by the same `applied_revocations` table (not a
new in-memory map — this one must survive process restart, since a revocation can be learned,
process-killed, and the attacker could restart the app expecting a clean slate; reading from
SQLite rather than a volatile Map closes that gap by construction). Call it at the top of
`handleSyncMessage` — **the literal site the T329 assessment named as ungated** — immediately after
the existing schema-compatibility check, before `A.receiveSyncMessage` is ever invoked. Mirrored
into `handleReceived` too, for parity (both paths must agree, same discipline the file's own header
comment already states for schema compatibility), but **the production path (`handleSyncMessage`/
`stepSync`) is the one this ADR's acceptance test targets**, not the legacy whole-doc path — see
battle test 2 below.

**(C) Live teardown on verification, not just at next handshake — closes the "within one round
trip" and third-device gaps.** `projectAll`'s existing tombstone-verification loop
(`electron/automerge/projector.js`) gains the mirrored revocation-verification loop described
above. The moment any device — the revoking Host, or a **third device that received the
revocation purely through ordinary document sync, never having revoked anyone itself** — verifies
and applies a new `camp_revocations` entry, it does two things synchronously, in the same
transaction-adjacent step `purgeSupportCommand.js` already uses for its own post-commit actions:
(1) insert into `applied_revocations`; (2) if that device_id's bound peer is currently in
`authenticatedPeers` (`transport.js`), call the **existing, unchanged** `revokePeer(peerId)` —
exactly the function `electron/main.js`'s explicit `revokeDevice` handler already calls, now
triggered by projection instead of only by the director's own action. **This is what closes the
2026-09-18 ADR's named residual** ("a revoked device that stays connected to a third device that
has not itself independently revoked it") — the third device no longer needs to perform its own
explicit revocation; receiving the witness via ordinary CRDT propagation is sufficient, because
projecting it *is* now a revocation action on every device that sees it, not only on the device
that authored it.

## Why this is monotonic under merge (closes Finding 3)

The T329 defect was an **LWW scalar document field** compared and reset via ordinary merge
semantics. This design has no such field:

- `camp_revocations` is an **append-only set of signed, independently-verifiable records**, not a
  single mutable value. Automerge's conflict resolution operates per-key; adding a new map entry
  under a fresh `device_id` key is never a conflict, and two devices concurrently revoking two
  *different* devices simply produces two new entries — no merge contest exists for this shape at
  all (unlike the T229-round-2 `rendezvousDiscovery` lesson, there is no shared scalar two
  concurrent writers could split).
- A device's local "highest verified seq" is **never itself transmitted or merged** — it is
  `MAX(seq)` recomputed from `applied_revocations`, a locally-derived cache over a verified,
  monotonically-growing set. Receiving the same record twice, or in a different order relative to
  other records, is idempotent (verification is a pure per-record predicate; insertion is
  `INSERT OR IGNORE`-shaped on the primary key) and commutative (the resulting verified set is the
  same regardless of arrival order) — the concurrent-retry-safety and idempotency properties
  `org-interface-contracts` requires for a sync primitive.
- **Concurrent revocations, single host.** The camp has exactly one Host signer (confirmed
  architectural invariant); two revocations from that Host are two sequentially-signed records
  (`seq = n`, `seq = n+1`) — never two signers racing. A merge of two partial views of
  `camp_revocations` (one device having seen only `seq=n`, another having seen only `seq=n+1`)
  converges to the full set the instant both records have propagated to a given device, with no
  intermediate state that is *wrong*, only *incomplete* — exactly the property a signed append-only
  set is supposed to give, and the opposite of the T329 defect where an intermediate merge state
  (`merge(6,2) → 2`) was actively wrong.

## Purge/rebuild carrying the witness forward (closes Finding 3's reset path)

`rebuildSupportCommand.js` and `purgeSupportCommand.js` already carry the sibling `tombstones`
family forward across a document/projection rebuild (same transactional discipline documented in
`purgeSupportCommand.js`'s FIX1 comment). This design requires the identical treatment for
`camp_revocations`/`applied_revocations`: a rebuild **re-seeds and re-verifies the full
`camp_revocations` collection from the document and reconstructs `applied_revocations` from
scratch by re-running verification over every entry** — it never starts `applied_revocations` from
an empty table and never resets any derived "last known seq" to a lower value, because that value
is *recomputed*, not restored from a snapshot that could be stale. This is the same fix class as
the already-landed board item carrying later-added columns forward through a `vNN_down` rollback
(`v51_down`/`rebuildTableCarryingColumns`) — the general discipline this codebase already applies
to "a destructive rebuild must not silently drop state a later feature depends on," applied here to
a security-critical set instead of an ordinary column.

## Composing with discovery-namespace rotation and Slice 1's cached-address reconnect

- **Namespace/epoch rotation (`docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-
  rotation.md`) stays, unchanged, as the liveness/discoverability layer.** It still has real value:
  it shrinks how long a revoked device's old discovery tag remains useful for *finding* a peer at
  all. This ADR does not require rotation to fire for authorization to hold — exactly the "both,
  layered, never instead-of" relationship the 2026-09-19 ADR already established for the
  `campId`-epoch idea, carried forward unchanged.
- **Slice 1's persisted-peer cached-address reconnect (`peerAddressBook.js`) cannot bypass this
  witness**, because reconnect-from-cache still terminates at `authenticateWith`/the handshake — it
  only skips *rediscovery*, never authentication. Gate (A) above fires on every redial attempt,
  cached or freshly discovered, with no special case for either path. This is the concrete answer
  to why authorization cannot rest on discovery rotation alone (the exact caveat the 2026-09-19 ADR
  already named): a cached address is a liveness shortcut, not a trust credential, and this design
  never treats it as one.

## Blast radius / files affected

- **New:** revocation signing/verification module (sibling of `tombstoneSignature.js`, same file
  shape, new domain-separation constant) — e.g.
  `electron/automerge/revocationSignature.js`.
- **Changed:** `electron/automerge/projector.js` (verify-and-apply loop, mirroring the tombstone
  loop); `electron/sync/automerge/syncNode.js` (`isPeerRevoked` gate in `handleSyncMessage` and
  `handleReceived`, immediately after the existing schema-compatibility check); `electron/sync/
  automerge/mutualAuth.js`/`authGate.js` (handshake-time refusal for a revoked connecting device);
  `electron/sync/automerge/transport.js` (no code change to `revokePeer` itself — it is called from
  a new site, not modified); `electron/automerge/rebuildSupportCommand.js` and `purgeSupportCommand.js`
  (carry `camp_revocations`/`applied_revocations` forward, same transactional step tombstones
  already use); `electron/main.js`'s `revokeDevice` (now also mints the signed `camp_revocations`
  entry via the Host key, in addition to its existing immediate local `revokePeer` call — the local
  call stays as the zero-latency path on the revoking device itself; the signed record is what
  reaches every other device).
- **Schema:** new table `applied_revocations` (device-local, never-synced, same exclusion class as
  `tombstones`/`device_identity_key`/`host_signing_key` — must be added to the standing guard that
  enforces that exclusion). This is a migration: `CURRENT_SCHEMA_VERSION` moves **89 → 90**, with
  its own `vNN_down` rollback module and full `npm run schema:check` coverage (ADR
  `2026-09-26-schema-version-gate-before-merge.md`'s discipline applies unchanged). Document shape:
  one new genesis-registered collection, `camp_revocations`, additive to the entity already in
  `MODELED_ENTITIES`/`GENESIS_ENTITIES` the same way `tombstones` was added for T233 — **no change**
  to `GENESIS_B64`/`genesisRootHash`/`sharesGenesis` themselves.
- **`SECURITY.md`**: gains a "Device revocation witness" subsection documenting the signed,
  monotonic, append-only mechanism and its enforcement points, alongside the existing purge-
  tombstone disclosure it is modeled on.

## Reused vs. new

**Reused:** the entire `tombstoneSignature.js` crypto shape (canonical message, Ed25519 sign/verify,
Host-only signing, local-trust-root verification) — copied to a sibling module, not re-derived;
`host_signing_key`/`camps.signing_public_key` custody (Q1/T172) — no new key material; the
`isPeerSyncCompatible`/`peerSchemaVersions` handshake-sourced-predicate pattern from T271 round 3 —
the exact template for `isPeerRevoked`; the existing `revokePeer`/`authenticatedPeers` mechanism in
`transport.js` — called from a new trigger, not modified; `rebuildSupportCommand.js`/
`purgeSupportCommand.js`'s carry-forward transactional discipline.

**Genuinely new:** the `camp_revocations` document collection and its genesis registration; the
`applied_revocations` SQLite table and its migration; the handshake-time revocation refusal in
`mutualAuth.js`/`authGate.js`; the live-teardown-on-projection trigger in `projector.js`. None of
this is a new *kind* of mechanism — each is a direct application of a pattern this codebase has
already built, reviewed, and shipped once.

## Battle tests the eventual Maker must pass (red-before-green, each targeting one finding)

1. **Forged-witness rejected (closes F2).** A device without a `host_signing_key` row (i.e. any
   non-Host device, including the revoked device itself) cannot produce a signature
   `verifyRevocation` accepts for any `{device_id, seq}` pair — attempting to sign with a non-Host
   key, or submitting a `camp_revocations` entry with a garbage/absent/wrong-key signature, is
   verified-and-dropped at projection and never reaches `applied_revocations`.
2. **Production-path enforcement proven on `handleSyncMessage`, not `handleReceived` (closes F1
   literally).** An integration test wires two real `startSyncNode` instances through the actual
   `generateSyncMessage`/`receiveSyncMessage`/`handleSyncMessage` round trip (never
   `handleReceived`, which the test must assert is NOT the code path exercised — mirroring T271
   round 3's own test shape), revokes one device mid-session, and proves its next sync-message
   round trip is refused by gate (B).
3. **Monotonic-under-merge + purge-carries-forward (closes F3).** `A.merge` two documents holding
   different subsets/orderings of `camp_revocations` entries and assert the merged set is complete
   and independent of merge order (no scalar to roll back); separately, run a purge/rebuild and
   assert `applied_revocations`'s derived max-seq is never lower after the rebuild than before it.
4. **Third-device residual closed.** Three-node topology: Host revokes device D while directly
   connected only to device B; device C is connected to both B and D and has not itself revoked
   anyone. Assert that once the witness reaches C via ordinary sync through B, C independently
   tears down (via `revokePeer`) its own live connection to D — without C's own `revokeDevice`
   handler ever being called.
5. **Revoked-device-with-cached-address cannot write (closes the Slice-1 interaction).** Using
   Slice 1's persisted-peer address store, a revoked device attempts a direct redial via its
   remembered multiaddr. Assert the `authenticate` handshake is refused by gate (A) before any
   sync message is generated or exchanged, so no write from the revoked device reaches any peer's
   document.

## `org-interface-contracts` checklist

- **Idempotency:** verifying and applying the same `camp_revocations` record twice is a no-op
  (`INSERT OR IGNORE`-shaped on `device_id` primary key; verification is a pure predicate with no
  side effect beyond that insert).
- **Concurrent-retry safety:** two devices independently projecting the same incoming record
  concurrently converge to the same `applied_revocations` state; no lock or coordination primitive
  is required because the write is idempotent and the predicate is pure.
- **Unknown-outcome handling:** a record that fails verification is dropped silently, same as a bad
  tombstone or a `sharesGenesis` failure — never half-applied, never retried, never surfaced as an
  ambiguous state.
- **Error shape:** handshake refusal for a revoked device reuses the existing `evaluateAuthenticate`
  deny shape, with a distinct reason string so it is distinguishable in the audit log from a bad
  token or a schema mismatch.
- **camp/authorize()/PROJECTIONS boundary:** `applied_revocations` joins the `device_identity_key`/
  `host_signing_key`/`tombstones` exclusion class — never registered in `PROJECTIONS`,
  `campScopedEntities.js`, or `MODELED_ENTITIES`'s syncable-field list, and must be added to
  whatever standing guard test enforces that exclusion today (the same guard `rendezvous_sequence`
  and `peer_tombstone_reports` were added to).

## Tier-4 / capability impact

**None.** Every mechanism above lives on the already-wired LAN/document-sync layer — the same
channel `schemaVersion`/`appliedTombstones` already travel in the `authenticate` frame, and the
same channel ordinary document collections already replicate over. No new libp2p package, no new
`transportCapabilities.js` row is touched. `kadDht`, `dcutr`, `circuit-relay-v2`, and `bootstrap`
remain `signoff: null`, exactly as the parent ADR left them — this slice does not depend on, and
does not unblock, any of them. (It is a prerequisite *in sequence* for Slice 3's DHT discovery to
be safe to open, per the parent ADR's own ordering — but opening Slice 3 is a separate, later
acceptance.)

## What this supersedes/amends

**Amends `docs/adr/2026-09-19-per-camp-genesis-identity.md`.** That ADR's "if/when built" section
recommended a `campId`-scoped epoch as the target shape for a future revocation-cutoff mechanism,
explicitly rejecting a *per-camp Automerge genesis root* as the wrong primitive. T329 built that
recommended epoch shape and it failed the security + battle-test gate for the reasons restated
above (unsigned, LWW scalar, wired to the wrong merge path). **This ADR withdraws that
recommendation's specific shape** (a document-field epoch compared pre-merge) while keeping its
correct load-bearing clarification (genesis carries no camp identity; `campId` does; a new
wire-transmitted trust anchor is the wrong tool) — the corrected shape is a **signed, append-only
witness set**, not a scalar epoch, checked at the **connection/handshake layer**, not inside a
document-field comparison. Nothing in the 2026-09-19 ADR's reasoning about genesis itself is
disturbed; only its epoch-shape recommendation for revocation specifically is superseded by this
design.

**References, does not reopen,** `docs/adr/2026-10-02-wan-discovery-transport-ladder.md` (the
accepted parent ADR) — this document is that ADR's Slice 2, corrected after T329's gate failure.
No part of the parent ADR's ladder ordering, rotation-automatic-on-revocation decision, or Tier-4
sign-off structure is changed here.

## Open questions for Governor / the owner

1. **Is a camp-wide monotonic `seq` (rather than a per-device counter) acceptable**, given it means
   every device's revocation record implicitly reveals the *count* of revocations this camp has
   ever issued (not which devices, just how many) to any peer that can read the document? This is a
   narrow metadata exposure, already accepted for other camp-wide counters (e.g. `rendezvousDiscovery`'s
   epoch), and this design treats it the same way — flagging it explicitly rather than assuming the
   answer.
2. **Should `revokeDevice`'s existing immediate local `revokePeer` call be removed once the signed
   witness exists**, or kept as a zero-latency belt-and-suspenders path on the revoking device
   itself (this design's recommendation: keep both — the signed witness is for *every other* device;
   the local call is strictly faster for the one device that just acted, and removing it buys
   nothing)?
3. **Scope confirmation**: this ADR assumes, per the ticket brief, that re-admitting a
   previously-revoked physical device is handled by ordinary re-pairing (a new device identity), not
   by an explicit un-revocation record. If the product wants a director-facing "undo this
   revocation" action without re-pairing, that is a new state machine this design deliberately does
   not build — confirm it is out of scope before Maker begins, since adding it later is additive
   (a new signed record type) rather than a redesign.
