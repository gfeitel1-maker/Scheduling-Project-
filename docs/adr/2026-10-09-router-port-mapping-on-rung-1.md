---
title: "Router port mapping on rung 1: map the libp2p TCP listener, a STUN-free router-learned public address (amends the relay-less reconnect ADR and the WAN ladder ADR)"
document_type: adr
authority: normative
status: accepted
implementation_state: not-started
date: 2026-10-09
decided: "2026-10-09 — owner GO, 'Build it (Recommended)', accepting the exposure recorded below"
revised: "2026-10-09 — mechanism revised UDP punch port -> libp2p TCP listener after Red Hat FAIL; Governor engineering decision within keeper delegation, owner posture unchanged"
deciders: ["product-owner (via board keeper)"]
program: security-hardening
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/DESIGN_STANDARD.md
  - SECURITY.md
  - docs/work/specs/2026-10-09-router-port-mapping-feasibility.md
  - docs/work/security/2026-10-09-wan-ladder-assessment.md
supersedes: []
amends:
  - docs/adr/2026-10-08-relayless-cross-network-reconnect.md
  - docs/adr/2026-10-02-wan-discovery-transport-ladder.md
---

# Router port mapping on rung 1

## Status

ACCEPTED by the owner. Build is ticket T359 (`docs/work/tickets/T359-router-port-mapping-rung-1.md`), five PRs, everything inert behind `SHORESH_PUNCH_ENABLED === 'true'`.

**Revision 2026-10-09.** The first draft mapped the punch UDP port. Red Hat FAILED it: nothing listens on the office side of that port unless a session is already open. `connectFromMemory` needs both ends to start a session together (`electron/sync/automerge/punchTransport.js` around line 629-630); the pinned UDP port is bound only while a session exists (around line 538-545); the office's own rung 1 filters the roamer's memory down to no-memory (`punchRung1.js` around line 52-53); and a held-open answerer would pin the single port and leave libjuice exposed pre-auth to the internet. Peer-reflexive acceptance from an unlisted address was never demonstrated. **The mechanism is now: map the libp2p TCP listener, which is always on.** The owner's posture is unchanged (one forwarded port, only paired laptops get in, unmapped on quit/revoke/disable); the owner decisions below stand, and the changed mechanism is a Governor engineering decision inside the keeper's delegation.

## Owner decisions (verbatim)

**1. The STUN reversal.** A Cloudflare-STUN ruling was withdrawn. The owner, recorded in `docs/work/security/2026-10-09-wan-ladder-assessment.md`:

> "no. i do not accept this. you know that i believe that laptops can find one another on dfferent wifis. let's assume for the moment that it's not available if you are two places you have never been. but if one f you is in a spot that is known, then it should be possible if the other is in a new spot"

Consequence: **no STUN of any kind, and no third party** on rungs 1 and 2. A device at a KNOWN spot (the camp office) must be reachable from a device at a NEW spot. Both devices at never-seen spots is out of scope for now.

**2. The GO.** On the feasibility report the owner chose "Build it (Recommended)" and **accepts the exposure**: one mapped UDP port is reachable from the internet while the app runs. _(Mechanism revised 2026-10-09: the mapped port is now the libp2p TCP listener, not a UDP punch port. The posture, one forwarded port with only paired laptops admitted and the mapping removed on quit/revoke/disable, is the same.)_ Entry still requires Noise mutual authentication and the T331 device-identity admission (`authGate`). The mapping is removed on quit, on revoke, and when punch is disabled.

## Context (verified against the code, 2026-10-09)

- `punchTransport` takes `iceServers` defaulting to `[]` (`electron/sync/automerge/punchTransport.js`, option destructuring) and `syncStarter.js` passes none. With no STUN, libjuice gathers no `srflx` candidate, and `rememberOwnReflexive` (`punchIdentity.js`) keeps only `typ srflx` lines from the selected pair, so this device has **no public candidate to publish**. The existing rung-1 design assumed STUN; this ADR replaces that source.
- **There is no STUN on main.** `electron/sync/automerge/punchTransport.js` line 121 defaults `iceServers = []`; no production call site passes `iceServers` (the only other STUN reference is the `STUN_RE` validator). Production rung 1 therefore has **no public candidate outside a LAN today**: its filter keeps only public `srflx`, and `srflx` cannot exist without STUN. **The router-mapped address becomes the ONLY public candidate, and it is what makes rung 1 work at all.**
- The libp2p TCP listener is always on: `syncStarter.js` line 453 uses `listenAddrs = ['/ip4/0.0.0.0/tcp/0']`, an **ephemeral** port. It must be pinned (Decision section 2) before it can be mapped.
- The punch UDP port is pinned (`punch_identity.local_port`) but bound only while a punch session exists, and `punchTransport.sessionOnFreePort` allows one session per port. That is why it cannot be the known-spot mechanism (see the Revision note).
- `peer_last_addresses` (`electron/sync/automerge/peerAddressBook.js`) is a device-local, never-synced table of up to 5 multiaddrs per peer (`PEER_LAST_ADDRESSES_MAX_PER_PEER`), written by `rememberPeerAddress` only from `syncNode.js`'s `onPeerAdmitted` (an address observed on an authenticated connection). Every stored address carries `/p2p/<peerId>`, so a dial is verified by Noise against that identity. `redialTrustedPeers` dials every remembered address of every trusted peer in parallel at startup, re-checking trust before each dial. Today an address enters only by being **observed**; nothing writes an address learned from a peer's gossip.
- `attemptRung1` (`punchRung1.js`) redials `peer_punch_memory` through `connectFromMemory`, keeps only public `typ srflx` candidates, and treats memory older than 12 h as `no-memory`. It remains the UDP path for signaling-driven punches (rungs 2 and 3).
- Gossip entries (`punchGossip.js`) are signed with the T331 device key and camp-encrypted, live in the camp document only (no SQLite table), and a reader drops entries older than `GOSSIP_TTL_MS` (10 min).
- Revocation funnels through `forgetRevokedPeer` (called from `main.js` `revokeDevice` and the quorum teardown in `syncNode.js`); it forgets the peer's addresses and punch memory and calls `rotatePunchIdentity`.

## Decision

### 1. Library
Use `@achingbrain/nat-port-mapper` (4.0.5 at assessment time; UPnP-IGD v1/v2 and NAT-PMP, pure JS, Apache-2.0 OR MIT) **directly**, from a new Shoresh module. **Not `@libp2p/upnp-nat`**: it rewrites libp2p's announced addresses through the address manager (identify), supports UPnP only, and its announcement behaviour is not ours to control. PCP is out of scope. Maker resolves the exact version from `package-lock.json` and re-reads that version's API before coding (`org-source-verification`); the report's API claims are from `npm view` and tarball inspection and were not re-verified against a running gateway. **No STUN of any kind.**

### 2. What is mapped: the libp2p TCP listener
- Pin the listener to a **persisted per-device TCP port**, stored like `punch_identity.local_port`. The slice decides where; it may need a schema column (then the schema family applies: `npm run schema:check`, a migration and a `vNN_down.js`). On a bind conflict, fall back to an ephemeral port and report status `port-in-use`.
- Map that TCP port with the library, using the **router-reported external IP and the RETURNED external port** (request external == internal, record what the router actually granted).
- Lease **1 hour with auto-refresh** before expiry. If an IGDv1 router accepts only lease 0 (permanent), accept it, mark the status `permanent-lease`, and rely on unmap-on-quit as the only cleanup.
- The roamer dials a **plain libp2p TCP multiaddr**. Noise, the T331 `authGate`, `isPeerRevoked`, the T340 un-admitted cap and deadline, and the connection rate limiter apply unchanged. Noise is pure JS, so there is no native pre-auth parser on this path. There is no peer-reflexive step, no both-ends timing requirement and no one-peer-per-port ceiling.

### 3. Where the mapped address goes (existing mechanisms, no wire change)
- The device publishes `/ip4/<external-ip>/tcp/<external-port>` as a candidate in its existing signed, camp-encrypted `punchGossip_<deviceId>` entry (`punchGossip.js`), placed first, so rungs 2 and 3 carry it. `publishReflexive` and `isPublicAddress` are reused; a private or 100.64/10 address is rejected already. **Slice 2 must check** that the gossip candidate format and validator (`MAX_CANDIDATE_CHARS`, the multiaddr shape check) accept a `/tcp/` multiaddr and extend them minimally if they are UDP-only.
- **A stale gossip entry is unreadable (10 min TTL), and a laptop that roamed away cannot receive a fresh one.** So the dial must not depend on reading gossip at dial time. While connected, when a peer's gossip entry verifies (signature and registry, as today), its mapped TCP address is written into `peer_last_addresses` as `/ip4/<ext>/tcp/<port>/p2p/<peerId>` through a new function in `peerAddressBook.js` (public-address filter re-applied at the write; a trust boundary). This is the remembered-address mechanism used for LAN reconnect, extended with one new source (verified gossip) beside the existing one (observed connection). **Slice 2 must also protect a mapped row from the 5-row recency prune** (for example by marking or by exempting the newest public row), otherwise a few LAN addresses push it out. If this needs a column it becomes a schema change; prefer a no-schema rule.
- The address is signed at the gossip hop and is stored device-local after verification. The table itself holds no signature, and does not need one: a dial to a stored address is authenticated end to end by the `/p2p/<peerId>` Noise check.
- Dial order in rung 1: **the peer's remembered public mapped TCP address first**, before the UDP punch attempt (`attemptRung1`), then the existing remembered srflx candidates. The mapped address needs no punch memory and no pinned peer ICE credentials, which removes the first draft's open dependency on `peer_punch_memory`.
- A mapped-sourced address has its own age limit of 7 days (the office keeps the same external port in practice; a wrong guess costs one dial timeout). Confidence: medium; a tuning value settled in slice 2 with a test.

### 3a. Pinned no-STUN invariant
Production ICE servers stay `[]`. Slice 2 keeps the pinned test asserting that the production start path passes no `iceServers`, so STUN cannot quietly return. The punch/WebRTC path remains for the signaling-driven punches of rungs 2 and 3 and is **not** the mechanism for the known-spot case. A device with no mapping publishes no public TCP candidate. Two never-seen-spot laptops still cannot find each other without a third party; that residual is the owner's own framing.

### 3b. Supersession
Rung 1's "learn reflexive via STUN-from-socket" text in `2026-10-08-relayless-cross-network-reconnect.md` is **superseded** by this section.

### 4. Lifecycle
Pin and bind the TCP listener, then map; refresh on a timer before lease expiry; re-publish gossip and re-remember when the external IP or port changes. **Unmap** on graceful quit (`will-quit` in `main.js`), on revoke, and when punch is disabled. **At startup, before mapping, delete any stale mapping for our own LAN IP and pinned port** (a crash cannot unmap; the 1 h lease bounds it, except on lease-0 routers). **On network or gateway change, unmap from the old gateway if it is still reachable, before mapping on the new one.**

### 5. Double NAT / CGNAT
If the router reports an external IP that is private or in 100.64.0.0/10, the mapping is useless: do not publish it, set status `double-nat`.

### 6. Status, shown to the director as a flag (not a banner)
Closed set: `mapped | permanent-lease | refused | no-gateway | double-nat | port-in-use | error`, each with a plain "why" sentence, surfaced in the existing sync flag area. Per DESIGN_STANDARD sections 5 (feedback) and 8 (transitions): the flag has a visible pending state while discovery runs, and its reduced-motion equivalent is a static text change, never no feedback. No coming-soon controls, and a failed map is surfaced, never silent.

### 7. Accepted limits (documented, not built)
- Both ends at never-seen spots remains out of scope (owner).
- Success depends on the office router (the owner's hardware check settles it per camp): the report estimates 50 to 75 percent for consumer or ISP routers, near zero for managed networks or CGNAT. That is a judgement from sources, not a measurement; the status flag tells the director which case they are in.

## Exposure (plain)

The TCP port is open to **the whole internet** for as long as the app runs and the mapping exists. Expect scanners. An unauthenticated caller reaches exactly this, in order: libp2p's TCP accept, the Noise handshake (pure JS), then `authGate`. A caller that is not an admitted, non-revoked device is dropped there. The T340 bounds apply to that window: the un-admitted connection cap, the handshake deadline, and the connection rate limiter. No native (C/C++) parser is reachable before authentication on this path, unlike the first draft's UDP port.

**Residual: stale mappings.** IGDv1 lease 0 is permanent, so removal on quit is the only cleanup there. A laptop that moves networks leaves a stale mapping on the old router until that router reboots or expires it. Mitigation: on network or gateway change, unmap from the old gateway if still reachable before mapping on the new one (Decision section 4). If the old gateway is not reachable, the stale entry stays, and its target is a LAN address this device no longer holds.

Revocation: `forgetRevokedPeer` forgets the peer's remembered addresses; the revoked device is also refused at `isPeerRevoked`/`authGate`. We additionally unmap on revoke (slice 3). A hostile or buggy router can lie about the external IP or drop the mapping; the worst case is a failed dial, never a trust bypass, because identity is verified by the `/p2p/<peerId>` Noise check. Never follow a UPnP `LOCATION` URL that is not on the gateway's own LAN subnet (SSDP spoofing); cap XML sizes and use timeouts.

## New egress surface (gate entry required)

SSDP multicast to 239.255.255.250:1900, HTTP/SOAP to the router's LAN address, and NAT-PMP UDP to the default gateway port 5351. All are LAN-only. `internetRendezvousScan.js` has **no pattern for `dgram`**, so this egress is invisible to the text scanner today; slice 5 adds a `dgram` pattern, a `portMapping` row in `transportCapabilities.js` (`packages: ['@achingbrain/nat-port-mapper']`, an explicit `egressAllowlist` for the one module, `inertPresence: true`, `signoff: null` until the owner's hardware session), and a test that plants an unlisted `dgram` file and requires the gate to fail.

## Interaction with in-flight revocation work

Namespace and address-key rotation on revoke is a separate change (assessment F2/F3). This ADR's contribution to it: **no STUN servers anywhere**, so a revoked peer cannot learn our address from a third party, and the mapped address is only published inside the camp-encrypted gossip entry under the camp's address key. On revoke we additionally unmap (slice 3) and re-map after the next transport start. If address-key rotation lands later, the gossip entry is re-published under the new key by the existing publisher with no change here.

## Interface-contract check (`org-interface-contracts`)

- Idempotency: map, refresh and unmap are idempotent per (LAN IP, port); a repeated map returns the same record. Publishing re-uses `publishReflexive`'s highWater and signature scheme.
- Unknown outcome: a map that times out is `error`/`refused` and is retried on the next cycle; unmap on a gateway that is gone is best-effort and never blocks quit.
- Error shape: the mapper returns a status object, never throws to callers.
- Boundary: no IPC handler and no op-log primitive is added; the status reaches the renderer through the existing sync-status push path. If slice 4 needs a new IPC read, it goes through `authorize()` and `electron/ipcSurfaceParity.test.js`.
- Trust boundary: candidates from a peer's gossip are already signature- and registry-verified before use; the new `peer_last_addresses` write re-applies the public-address filter. Dialing a stored address is authenticated by the `/p2p/<peerId>` Noise check. Idempotency of the remember step: the (peer_id, multiaddr) key makes a repeated write update `last_seen_at` in place.

## Candidates considered

Closed case for divergence: the owner chose the mechanism (ask your own router) and Governor chose the mapped socket after Red Hat's FAIL. Rejected, recorded: public STUN (owner reversal); `@libp2p/upnp-nat` (rewrites announced addresses, UPnP only); **mapping the punch UDP port** (first draft: no listener on the office side outside a session, a held-open answerer would expose libjuice pre-auth, one peer per port, prflx acceptance never demonstrated); a pinned port range or ICE UDP mux (no longer needed).

## Consequences

- Rung 1 gains a dial that needs no third party, no punch memory and no ICE credentials; STUN is removed as an assumption from both amended ADRs.
- A new dependency and a new LAN egress surface, both behind the existing flag and a new capability row.
- The TCP listener becomes a persisted, pinned port (possible schema column, slice 1) and is a standing internet-facing exposure while the app runs, accepted by the owner and bounded by Noise, `authGate` and T340.
- Stale mappings after a network move are a documented residual with a mitigation, not a guarantee.

## Amendments to the earlier ADRs

Pointer lines are added to `docs/adr/2026-10-08-relayless-cross-network-reconnect.md` (rung 1 text: "learns its public mapping via STUN-from-socket" is superseded by the router-mapped libp2p TCP address; the "no permanent public listening port and no port-forward" exposure line is amended by this ADR's mapping) and to `docs/adr/2026-10-02-wan-discovery-transport-ladder.md` (no STUN of any kind on the ladder; rung 1 gains a dial to the peer's router-mapped TCP address). Neither earlier ADR's decision text is deleted.
