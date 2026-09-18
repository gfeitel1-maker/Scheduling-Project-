---
title: "Rendezvous record encoding and camp namespace rotation"
document_type: adr
authority: normative
status: proposed
date: 2026-09-18
program: security-hardening
affects:
  - electron/sync/automerge/rendezvousRecord.js
  - electron/sync/automerge/rendezvousNamespace.js
  - electron/sync/automerge/rendezvousSequence.js
  - electron/db/localDb.js
  - electron/db/schema.sql
  - docs/adr/2026-09-17-wan-rendezvous-seam.md
  - docs/work/tickets/T210-signed-rendezvous-record-and-namespace.md
  - docs/work/tickets/T209-rendezvous-worker-phase-a.md
implementation_state: proposed
---

# Rendezvous record encoding and camp namespace rotation

This ADR completes the two things `docs/adr/2026-09-17-wan-rendezvous-seam.md` left open: the exact
canonical byte encoding of the signed rendezvous record, and a rotation path for the camp rendezvous
namespace. Everything that ADR already settled — rendezvous as an HTTP side-channel that cannot
create trust, signing with the device's own libp2p Ed25519 identity key rather than the Host signing
key, the coordination-only relay decision — stands unchanged and is not repeated here.

Nothing in this ADR is wired into the running app. Every module it describes is pure library code
with no network egress, so `INTERNET_TRANSPORT_SIGNOFF` stays `false` and the Tier-4 guard
(`electron/sync/automerge/transportBoundary.guard.test.js`) is not modified. Wiring is T211, which
is parked.

## Decision 1 — canonical signed byte layout: versioned, domain-separated, fail-closed

Sign over this fixed-order, length-prefixed concatenation. Never `JSON.stringify`: field order and
unicode escaping are not stable across implementations, so a JSON-signed record is a signature no
second implementation can reliably verify.

    DOMAIN_PREFIX   7 bytes   ASCII "SHRZV1\0"
    version         1 byte    0x01
    namespace      32 bytes   raw (not hex) in the signed material
    peerId                    varint-length-prefixed UTF-8
    epoch           8 bytes   big-endian u64
    seq             8 bytes   big-endian u64
    issuedAt        8 bytes   big-endian ms-epoch
    expiresAt       8 bytes   big-endian ms-epoch
    addressCount              varint
    addresses[]               each varint-length-prefixed multiaddr bytes, sorted ascending
                              byte-lexicographically before signing

The domain prefix keeps this signature from being confused with anything else this device's libp2p
identity key signs, in either direction. Sorting the addresses means two callers that assembled the
same address set in different orders produce identical signed bytes.

The version byte is checked first and unconditionally. A verifier that does not recognise the
version **rejects the record outright** and never attempts a best-effort parse. That is the
anti-downgrade property: a v1-only verifier has no code path that accepts anything but a well-formed
v1 record, so there is nothing for a downgrade to reach. A record missing a required field, or
carrying a field this version does not define, is rejected as malformed **before** signature
verification is attempted — which closes the "syntactically valid but semantically empty, validly
signed" defect class.

**Signing and verification.** The publishing device's own libp2p Ed25519 identity key
(`electron/auth/deviceIdentity.js`). The verifier recovers the public key from the record's own
`peerId` field: an Ed25519 PeerId is an *identity* multihash, so it embeds the raw protobuf public
key, and `peerIdFromString(peerId).publicKey` returns it with no external lookup. Verified against
the installed `@libp2p/peer-id@6.0.15` and `@libp2p/crypto@5.1.23`, not from memory. This makes the
record self-certifying: a valid signature for peer id `P` is producible only by the holder of `P`'s
private key, entirely independent of whether the namespace stayed secret. Knowing a camp's namespace
therefore lets an attacker publish noise, never impersonate a trusted peer.

**Clock skew tolerance: 5 minutes**, as a named constant in the module rather than at a call site. A
record is fresh iff `issuedAt - 5min <= now <= expiresAt + 5min`, where `now` is the verifier's own
untrusted clock. The tolerance is applied at *both* boundaries so that a verifier whose clock is
wrong in either direction does not reject valid records; against a ~2h TTL, 5 minutes does not
meaningfully extend how long a stale record can be accepted. No NTP dependency is introduced.

**The record carries nothing beyond structural necessity**: exactly
`{namespace, peerId, epoch, seq, issuedAt, expiresAt, addresses[], signature}`. No device name, no
camp name, no hostname. This does not solve the privacy finding in
`docs/work/specs/2026-09-17-rendezvous-wan-connectivity.md` §2.3 — multiaddrs still expose the
publishing device's public IP to anyone who can read the board, which is structural to a
reachability record — but it adds no surface beyond that, and the versioned encoding leaves room for
an encrypted-body v2 that v1 verifiers reject rather than misparse.

## Decision 2 — two counters, not one: `seq` is device-local and disposable, `epoch` is namespace-scoped

A single monotonic counter cannot survive a device rebuild (the counter resets to 0 while a stale,
still-live KV record from before the rebuild carries a higher value and wins) or a backup restored
from before a device's removal. Splitting the anti-replay material by scope and lifetime closes both:

- **`epoch`** and the namespace it is paired with live on the `camps` Automerge record.
  _Prior: this originally described `epoch` and namespace as two separate fields,
  `rendezvousEpoch` and `rendezvousNamespace`. That was found to be a design defect during round-2
  review (see the new "Decision 3a" below) and is superseded by a single field,
  `rendezvousDiscovery`, before this ADR's implementation state left `proposed`. Both are additive
  to an entity already in `MODELED_ENTITIES` using the flat per-field record shape, so there is no
  document-shape change beyond one new field and no migration._ It starts at epoch 1 when rendezvous
  is first enabled and the epoch component is incremented **only** on an explicit rotation, never by
  ordinary publishing. Because it is in the document it reaches every currently-syncing device for
  free, exactly as `camps.signing_public_key` already does.
- **`seq`** is device-local: a new singleton SQLite table `rendezvous_sequence` (migration v69, the
  `id = 1` shape `device_identity_key` uses), incremented before each publish attempt. It is never
  registered in `PROJECTIONS`, `campScopedEntities.js` or `MODELED_ENTITIES` — the same exclusion
  class as `device_identity_key` and `host_signing_key`, guarded the same way. Sequence numbers need
  not be gapless, only increasing, so an unknown-outcome publish is safe to retry with a higher value.

Losing `seq` to a rebuild is therefore harmless: `epoch` is what a stale device can never regain.

**Verifier-side watermark.** A verifier keeps, per peer id, the highest `(epoch, seq)` it has ever
accepted and rejects anything that does not strictly exceed it in epoch-major order. This is what
actually defeats a replayed older record winning at one Cloudflare KV edge PoP: the worker is treated
as an untrusted cache that may serve stale or forked data, never as a consistency authority. Where
the watermark is persisted belongs to T211; T210's obligation is that `verify()` accepts a
caller-supplied `{lastEpoch, lastSeq}` and returns a monotonicity verdict alongside the signature
verdict, so the wiring layer has a complete, decidable function to call.

## Decision 3a — namespace and epoch are ONE document field, not two (round-2 correction)

Added during round-2 review, before this ADR left `proposed`: Red Hat confirmed against
`electron/automerge/reconcile.js` that conflict resolution is per document key, adjudicated
independently for each key. With `rendezvousNamespace` and `rendezvousEpoch` as two separate keys,
two devices rotating concurrently could merge into a pair **neither device ever generated** — device
A's namespace with device B's epoch. A director resolving what look like two unrelated single-field
conflicts could pick exactly that mix by hand, with no way to see from either conflict prompt that
they were coupled. Worse, if the surviving epoch is lower than one already published under, every
future publish fails `rendezvousRecord.js`'s monotonicity check — a self-inflicted denial of service
on the feature rotation exists to fix.

**Decision:** store the pair as one scalar document field, `camps.rendezvousDiscovery`, holding a
fixed-shape string `v1:<decimal epoch>:<64 hex namespace chars>` — deliberately not something
JSON-shaped a naive merge or reorder could still split. Automerge's conflict resolution operates on
one key at a time, so a single key can only ever resolve to one of the whole values written to it:
splitting becomes structurally impossible rather than merely unlikely. A conflict on this field is a
whole pair for a director to choose between, which is the CRDT property Decision 3 (below) actually
needs. The reader is strict: a value not matching the fixed shape is rejected outright rather than
half-parsed, so a corrupted or hand-edited value fails loud instead of returning a namespace with no
epoch or vice versa.

This also corrects Decision 5's idempotency claim below: `mintRendezvousNamespace` is idempotent
against *sequential* calls only. Two devices minting concurrently both observe "no existing
namespace" and both write; one wins the merge and the other's `minted: true` return value does not
reflect what survives. That race exists regardless of field count. What Decision 3a's single-field
shape guarantees is that the *loser's* write is a whole, self-consistent pair — never a value mixed
from both attempts.

## Decision 3 — rotation reuses the existing revocation boundary; no new primitive

`rotateRendezvousNamespace()` mints a fresh namespace and increments the epoch together as the
single `rendezvousDiscovery` field (Decision 3a), written through `campDocument.js`'s low-level
`recordKey`/`readRecord` primitives — the same flat per-field record shape every modeled entity uses.

_Prior: this ADR first said "through the same document path `signing_public_key` uses." That was
wrong, found during implementation and corrected here. `camps.signing_public_key` is **not** a
replicated document field at all — `projector.js` says so explicitly; it is written straight to
SQLite from the authenticated login reply. Registering the two new fields in `PROJECTIONS.camps.fields`,
the mechanism that sentence pointed at, would also have required matching SQLite columns, because
`electron/automerge/seed.js` builds `SELECT id, <fields> FROM camps` from that list — contradicting
this ADR's own "additive, no migration" claim. Going under the allowlist to the record primitives
keeps the fields document-only with no `camps` schema change._ Its security rests on two invariants this codebase already
enforces rather than on anything new:

1. Automerge sync is gated by the existing device-trust/revocation check. A revoked device stops
   receiving document state, so it never learns the post-revocation namespace or epoch.

   **Confirmed, with a stated limitation (round-2 review).** `electron/main.js:973`'s `revokeDevice`
   calls `getAutomergeNode()?.revokePeer(peerId)`, and `electron/sync/automerge/transport.js`'s
   `revokePeer` (~line 356) deletes the peer from `authenticatedPeers`, the same set `broadcastDoc`
   and the inbound-message handler gate on. So **on the device that performs the revocation**, the
   live connection to the revoked peer stops carrying document state immediately — no reconnect
   needed. That much is verified, not assumed.

   The residual: `revokePeer` is called only from that one explicit `revokeDevice` handler. Nothing
   in `syncNode.js` or `transport.js` calls it in reaction to a revocation *arriving* through
   Automerge sync from another device — there is no code path where receiving the revocation as
   document state causes a device to tear down its own live connection to the revoked peer. A
   revoked device that stays connected to a **third** device (one that has not yet independently
   revoked it) can keep receiving document state — including a post-rotation namespace/epoch —
   through that third device until the third device's own trust check fires, on whatever trigger
   that is (a future reconnect, an explicit revocation of its own, or nothing at all if that trigger
   does not exist yet). This is not a claim this ADR resolves; closing it is T211's problem, which is
   parked. Stated here rather than left implicit in "a revoked device stops receiving document
   state," which is true only from the revoking device's own point of view.
2. KV entries expire on their own (<= 2h TTL). A departed device leaves at most one stale,
   address-only record under a namespace nobody polls any more.

**Device rebuild**: a rebuilt device gets a fresh `device_identity_key`, so its old identity can
never produce a valid signature again — it is self-revoked from publishing. **Backup restored from
before a removal**: the same invariant (1) — its replica is frozen at whatever it last saw, and no
currently-trusted verifier polls the namespace it still holds.

Co-signed revocation attestations and quorum-based rotation were considered and rejected: they invent
a consensus primitive to obtain a guarantee the existing sync boundary already gives.

**Deliberately not decided here**: whether rotation fires automatically on every device revocation or
is a director-initiated action. That is a product decision, recorded as open rather than improvised
inside an implementation.

## Decision 4 — module placement keeps the Tier-4 guard green without modification

`rendezvousRecord.js`, `rendezvousNamespace.js` and `rendezvousSequence.js` are pure: encoding,
signing, verification, document field access, SQLite access. None of them contains any pattern in
`electron/sync/automerge/internetRendezvousScan.js`'s `EGRESS_PATTERNS` table, and none is imported
by `electron/main.js` or the production node's `peerDiscovery`. The guard stays green with
`INTERNET_TRANSPORT_SIGNOFF` unchanged at `false`, and the guard file is not touched. The HTTP client
that *will* trip the guard is T211, which is parked and out of scope.

## Consequences

- **T209 is unblocked to proceed in parallel.** It was sequenced after T210 because the record
  contract was unsettled; this ADR settles encoding, sequence and rotation, and settles the address
  body as plaintext for Phase B. The worker treats every KV value as an opaque signed blob and never
  decodes or verifies it — verification is entirely client-side — so T209 can build `POST`/`GET`
  against a fixture today with no format renegotiation later. The worker's own request-logging
  posture remains open and was never gated on the record format.
- `camps` gains two permanent optional fields; absent means rendezvous was never enabled.
- A new device-local, never-synced table joins the `device_identity_key`/`host_signing_key` exclusion
  class and must be added to the standing guard that enforces it.
- Address payload encryption is out of scope for Phase B.

## Verification

- Canonical encoding is stable and address-order-independent: the same logical record with
  differently ordered input addresses produces identical signed bytes.
- A signature verifies only under the record's own claimed peer id's keypair; tampering with any
  field fails verification.
- An unrecognised version byte is rejected, not partially parsed.
- A record missing a required field, or carrying an undefined one, is rejected before signature
  verification runs.
- Freshness: `issuedAt` more than 5 minutes ahead, or `expiresAt` more than 5 minutes past, is
  rejected; inside the window, accepted.
- Monotonicity: a record whose `(epoch, seq)` does not strictly exceed the supplied watermark is
  rejected, epoch-major.
- Rotation changes namespace and epoch together and leaves `seq` alone.
- The Tier-4 guard suite passes unmodified, with all three modules present and
  `INTERNET_TRANSPORT_SIGNOFF` still `false`.
