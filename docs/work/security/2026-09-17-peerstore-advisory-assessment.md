---
title: "GHSA-vrf4-mx87-p53w (PeerStore certified-address poisoning) — reachability assessment"
document_type: reference
authority: descriptive
status: active
date: 2026-09-17
program: security-hardening
---

# PeerStore advisory assessment — GHSA-vrf4-mx87-p53w

Assessed against commit `e574cf28d422366ecf6c052cc24b9fc492c78dff` (branch
`claude/shoresh-rendezvous-wan-handoff-5f211b`). Everything under "Confirmed" was read in the
file cited — including the installed `node_modules` copies of the vulnerable code, which is the
only way to answer a reachability question honestly. Opinions and inferences are labelled.

## Boundary verdict

**Trusted-LAN boundary: HOLDS. This advisory is NOT REACHABLE in the installed dependency graph,
and would not be an impersonation or disclosure vector even if it were.**

That is a stronger claim than "mitigated", and it rests on one fact: **nothing in this tree calls
the vulnerable function.**

## The mechanism, read in the installed code (not from the advisory text)

A libp2p *certified* address entry comes from a `RecordEnvelope` — a `PeerRecord`
(peerId + multiaddrs + seqNumber) signed by a key, sealed for the `PeerRecord.DOMAIN`. The
defect is in `PersistentPeerStore.consumePeerRecord`:

`node_modules/@libp2p/peer-store/dist/src/index.js:102-136`

```js
const envelope = await RecordEnvelope.openAndCertify(buf, PeerRecord.DOMAIN, options)
const peerId = peerIdFromCID(envelope.publicKey.toCID())   // <- derived from the SIGNING key
if (expectedPeer?.equals(peerId) === false) { ... return false }
const peerRecord = PeerRecord.createFromProtobuf(envelope.payload)
...
await this.patch(peerRecord.peerId, {                       // <- WRITES TO THE PAYLOAD'S peerId
  peerRecordEnvelope: buf,
  addresses: peerRecord.multiaddrs.map(multiaddr => ({ isCertified: true, multiaddr })),
}, options)
```

The signature is verified, and the `expectedPeer` guard is checked against the **envelope's**
peer id — but the record is then written under `peerRecord.peerId`, an **unverified payload
field**. An attacker signs an envelope with their own key (so `openAndCertify` passes and
`expectedPeer` matches them), sets the inner `peerId` to a victim's, and the victim's PeerStore
entry is overwritten with attacker multiaddrs flagged `isCertified: true`. The monotonic-`seq`
replay guard is also defeated, because the stored record it compares against is fetched with
`this.get(peerId)` — the *attacker's* entry, not the victim's. CVSS `C:N/I:H/A:L` matches:
integrity of the address book, no confidentiality.

**Confirmed: the only caller of `consumePeerRecord` anywhere under `node_modules` is the
peer-store package itself.**

```
grep -rl "consumePeerRecord" node_modules --include='*.js' | grep -v "@libp2p/peer-store"
  -> node_modules/libp2p/dist/index.min.js
```

That single hit is a prebuilt browser bundle of peer-store, and it is **not a resolvable entry
point**: `node_modules/libp2p/package.json` `exports` maps `"."` to `./dist/src/index.js` only
(no `main`, no `./dist/index.min.js` export). `libp2p/dist/src/**` contains no `PeerRecord`
reference at all. The real-world callers of `consumePeerRecord` are `@libp2p/kad-dht`,
circuit-relay and rendezvous-style routing services. **None is installed** — the full
`node_modules/@libp2p/` set is: `crypto, identify, interface, interface-internal, logger, mdns,
multistream-select, peer-collections, peer-id, peer-record, peer-store, tcp`
(`npm ls @libp2p/kad-dht @libp2p/circuit-relay-v2` → empty).

The one service that *does* handle signed peer records in this app —
`identify()` (`electron/sync/automerge/transport.js:103`) — does **not** use the vulnerable
path. `node_modules/@libp2p/identify/dist/src/utils.js:63-117` performs the two checks
peer-store omits, and writes under the connection's authenticated peer:

```js
if (!peerRecord.peerId.equals(envelopePeer)) throw new InvalidMessageError(...)
if (!connection.remotePeer.equals(peerRecord.peerId)) throw new InvalidMessageError(...)
...
await peerStore.patch(connection.remotePeer, peer)
```

So over identify, a peer can only ever poison **its own** address entry.

## Confirmed findings (ranked by leverage)

### F1 — Advisory not reachable today. Severity: INFORMATIONAL (no action beyond T214).
Attack path: none exists. Evidence: the grep above; the `exports` map; the absent `@libp2p`
packages. Confirmed by reading installed code, not by reasoning from the architecture.
Fix: T214 (libp2p 3.x) remains correct hygiene and a **precondition for adding any routing
service**, but is not an exposure today.

### F2 — The owner's stated residual is CORRECT, and stricter than stated. Severity: N/A (confirmation).
Even with a poisoned certified address, this node cannot be made to talk to an attacker *as if*
it were the real peer:
- `electron/sync/automerge/mutualAuth.js:123` dials by **peer id string**
  (`syncNodeHandle.dial(peerId)`), which `electron/sync/automerge/transport.js:38-40,259-261`
  turns into `node.dial(PeerId)` — the PeerStore-address path. So redirection is real.
- But `node_modules/libp2p/dist/src/connection-manager/dial-queue.js:334-345` encapsulates
  `/p2p/<peerId>` onto every stored address before dialing, and
  `node_modules/@chainsafe/libp2p-noise/dist/src/utils.js:18-31` throws `UnexpectedPeerError`
  when the handshake identity key does not match the expected remote peer.
  **Impersonation requires the victim's private key. Confirmed.**
- Consequence is therefore bounded at **dial redirection and denial of service**: failed dials,
  `attempted` dedupe-slot churn in `mutualAuth.js:82-94` (already bounded by the 30s stall timer
  at `:87-94`), and — worse for availability — *certified* entries outrank uncertified ones in
  address sorting, so a poisoned certified address would be preferred over the genuine mDNS one
  and could suppress sync with a real peer until it re-announced. No token is disclosed: nothing
  is sent until `authenticateWith` succeeds over a handshake that already failed.

### F3 — mDNS already offers the same consequence class on the LAN, without the advisory. Severity: LOW (accepted-LAN).
`node_modules/libp2p/dist/src/libp2p.js` `#onDiscoveryPeer` merges a discovered peer's
multiaddrs straight into the PeerStore (`peerStore.merge(peer.id, { multiaddrs })`) with **no
authentication of the announcement**. mDNS responses are unauthenticated broadcast; the camp's
service tag is `sha256(campId)`-derived (`electron/sync/automerge/discovery.js:49-51`) and peer
ids are not secret. So an attacker already on the camp LAN can announce a trusted peer id at
attacker addresses today, at libp2p 2.10.0, with or without this advisory — and gets the same
(DoS-only) outcome, blocked by the same Noise check. **The advisory adds no new LAN capability.**
This is inside the accepted trusted-LAN tradeoff; it is recorded so the upgrade is not
mistaken for closing it.

### F4 — Today's token-to-stranger bound is LAN topology, not local trust. Severity: MEDIUM (pre-existing, not advisory-caused).
`electron/sync/automerge/mutualAuth.js:49-80` requires an `isPeerTrusted` predicate, and T193's
comment (`:29-48`) is explicit that this is the seam deciding who receives this device's session
token. **Production does not pass one.** `electron/main.js:2690-2710` calls `startSyncNode`
without `isPeerTrusted`, so `electron/sync/automerge/syncNode.js:479` falls back to
`lanTopologyTrust = () => true` (`syncNode.js:51`) — permit-all. That is defensible while the
only discovery mechanism is camp-scoped mDNS on a LAN, and it is exactly what must change before
any rendezvous-fed peer reaches this seam (spec §"acceptance" items 3 and 6). Raising it here
because the same code path is the consumer of any poisoned address: if rendezvous lands before a
real predicate is wired, address-book integrity stops being a DoS-only question.

## Open questions (NOT findings)

1. **Does `@libp2p/kad-dht` / `circuit-relay-v2` / DCUtR call `consumePeerRecord`?** Inferred
   yes for kad-dht (that is the canonical caller of signed peer records); **not verified**,
   because those packages are not installed and installing them is out of scope here. It matters
   because it decides whether T214 is a hard precondition for Phase F. Settle by checking the
   3.x packages' source at the versions Phase F would pin.
2. **Will the rendezvous client feed `RecordEnvelope` bytes, or plain multiaddrs?** The spec's
   "signed address cards" are the project's own signing scheme, not necessarily libp2p envelopes.
   If an implementer chooses to carry a libp2p `RecordEnvelope` in the card and hand it to
   `peerStore.consumePeerRecord`, **this advisory becomes directly reachable from an internet
   HTTPS response** — the single highest-leverage way to turn a non-issue into an issue. Settle
   by pinning the card format in T211's design and forbidding `consumePeerRecord` outright.
3. **Whether libp2p 3.x's address-sorting/expiry changes alter F3's DoS shape.** Not assessable
   without doing the upgrade. Stated plainly rather than guessed.

## Re-opened tradeoffs

| Tradeoff | Conditions when accepted | Still hold? | Recommendation |
|---|---|---|---|
| Trusted-LAN: unauthenticated mDNS address announcements are fine | Discovery is link-local only; a LAN attacker is already in the threat-accepted set | **Yes, today** — `electron/main.js:2708` is still mDNS-only, bind `0.0.0.0` (`:2696`) | Keep. Re-decide at the first line of rendezvous code, not after. |
| `lanTopologyTrust = () => true` in production | Only mDNS peers can reach the seam | **Yes today; expires the moment any non-mDNS discovery is wired** | Make T208's predicate a *precondition* of T211, not a parallel ticket. |
| Deferring libp2p 3.x (T214) | Advisory unreachable; upgrade is semver-major across the transport | **Yes for Phases A–C; NO for anything adding a routing/relay/DHT package** | See sequencing. |

## Sequencing recommendation

**Do not block Phases A/C on T214. Do block Phase F on it, and block T211 on a written "no
`consumePeerRecord`" constraint.** Confidence: **high** for the advisory-specific part,
**moderate** for Phase F (rests on open question 1).

Evidence: the advisory's sink has no caller in this tree, and the rendezvous design as specified
feeds *discovered peers* into the existing seam — which reaches `#onDiscoveryPeer` →
`peerStore.merge`, the uncertified path, not `consumePeerRecord`. Phases A/C therefore do not
widen this advisory's reach. They **do** widen something else, and this is the part worth the
owner's attention: rendezvous lets an **arbitrary internet host put addresses for a claimed peer
id in front of our node**, where today only a device on the camp's LAN can. That is a genuine
widening of F3's surface from "someone in the building" to "anyone on the internet who learns the
namespace" — and its blast radius is governed by F4 (the missing trust predicate) and by the
already-recorded blockers #2/#4/#5 of the 2026-09-15 and 2026-09-17 assessments, **not** by this
advisory. Sequencing WAN work behind the libp2p upgrade would buy very little; sequencing it
behind F4 and the join-secret/update-signing blockers buys nearly everything.

## Summary Score (for Grader)

Security posture: **4** — the advisory is genuinely unreachable here and the Noise/peer-id
binding makes its worst case a DoS rather than impersonation; the deduction is for F4, a
permit-all trust predicate in production that the WAN roadmap is about to make load-bearing.
