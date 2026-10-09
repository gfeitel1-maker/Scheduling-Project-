---
title: "Router port mapping on rung 1: a STUN-free, router-learned public candidate (amends the relay-less reconnect ADR and the WAN ladder ADR)"
document_type: adr
authority: normative
status: accepted
implementation_state: not-started
date: 2026-10-09
decided: "2026-10-09 — owner GO, 'Build it (Recommended)', accepting the exposure recorded below"
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

## Owner decisions (verbatim)

**1. The STUN reversal.** A Cloudflare-STUN ruling was withdrawn. The owner, recorded in `docs/work/security/2026-10-09-wan-ladder-assessment.md`:

> "no. i do not accept this. you know that i believe that laptops can find one another on dfferent wifis. let's assume for the moment that it's not available if you are two places you have never been. but if one f you is in a spot that is known, then it should be possible if the other is in a new spot"

Consequence: **no STUN of any kind, and no third party** on rungs 1 and 2. A device at a KNOWN spot (the camp office) must be reachable from a device at a NEW spot. Both devices at never-seen spots is out of scope for now.

**2. The GO.** On the feasibility report the owner chose "Build it (Recommended)" and **accepts the exposure**: one mapped UDP port is reachable from the internet while the app runs. Entry still requires the pinned ICE credentials, the pinned DTLS certificate, Noise mutual authentication, and the T331 device-identity admission. The mapping is removed on quit, on revoke, and when punch is disabled.

## Context (verified against the code, 2026-10-09)

- `punchTransport` takes `iceServers` defaulting to `[]` (`electron/sync/automerge/punchTransport.js`, option destructuring) and `syncStarter.js` passes none. With no STUN, libjuice gathers no `srflx` candidate, and `rememberOwnReflexive` (`punchIdentity.js`) keeps only `typ srflx` lines from the selected pair, so this device has **no public candidate to publish**. The existing rung-1 design assumed STUN; this ADR replaces that source.
- **There is no STUN on main.** `electron/sync/automerge/punchTransport.js` line 121 defaults `iceServers = []`; no production call site passes `iceServers` (the only other STUN reference is the `STUN_RE` validator). Production rung 1 therefore has **no public candidate outside a LAN today**: its filter keeps only public `srflx`, and `srflx` cannot exist without STUN. **The router-mapped address becomes the ONLY public candidate, and it is what makes rung 1 work at all.**
- The punch UDP port is already pinned: `materializePunchIdentity` returns `portRange: { begin: localPort, end: localPort }` from `punch_identity.local_port`, and the transport validates 1024..65535. A router mapping to that port stays meaningful across restarts.
- `punchTransport.sessionOnFreePort` allows one live session per pinned port (`PunchPortBusyError`).
- `attemptRung1` (`punchRung1.js`) redials `peer_punch_memory` through `connectFromMemory`, keeps only **public `typ srflx`** candidates, and treats memory older than 12 h as `no-memory`.
- Gossip entries (`punchGossip.js`) are signed with the T331 device key and camp-encrypted, live in the camp document only (no SQLite table), and a reader drops entries older than `GOSSIP_TTL_MS` (10 min).
- Revocation funnels through `forgetRevokedPeer` (called from `main.js` `revokeDevice` and the quorum teardown in `syncNode.js`); it forgets the peer's addresses and punch memory and calls `rotatePunchIdentity`.

## Decision

### 1. Library
Use `@achingbrain/nat-port-mapper` (4.0.5 at assessment time; UPnP-IGD v1/v2 and NAT-PMP, pure JS, UDP supported, Apache-2.0 OR MIT) **directly**, from a new Shoresh module. **Not `@libp2p/upnp-nat`**: it maps libp2p's own TCP listener addresses, announces them through libp2p's address manager (identify), supports UPnP only, and knows nothing about the punch socket. PCP is out of scope; add a small in-house client only if field data shows PCP-only gateways. Maker resolves the exact version from `package-lock.json` and re-reads that version's API before coding (`org-source-verification`); the report's API claims are from `npm view` and tarball inspection and were not re-verified against a running gateway.

### 2. What is mapped
The pinned punch UDP port. Request external port == local port; **record the external port and external IP the router actually returned**. Lease 1 hour with refresh before expiry. If an IGDv1 router accepts only lease 0 (permanent), accept it, mark the status `permanent-lease`, and rely on unmap-on-quit as the only cleanup.

### 3. Where the mapped address goes (no wire or schema change)
- The router-reported public IP plus assigned external port is published as an ordinary candidate (`/ip4/<ip>/udp/<port>`, the existing gossip format) in this device's existing signed `punchGossip_<deviceId>` entry, **placed first**. `publishReflexive` and its public-address filter are reused unchanged; a private or 100.64/10 address is rejected by that filter already.
- **A stale gossip entry is unreadable (10 min TTL), and a laptop that has roamed away cannot receive a fresh one.** So rung 1 must not depend on reading gossip at dial time. Instead, **while connected**, whenever a peer's verified gossip entry carries candidates, they are written into that peer's `peer_punch_memory.candidates` (public-filtered, bounded to `MAX_RECORDED_CANDIDATES`, mapped-first), through a new function in `peerAddressBook.js`. The column is already JSON, so there is **no schema change and no migration**. This is the "refreshed while connected" behaviour: the memory follows the peer's mapping whenever the two are together.
- Candidates are presented to `connectFromMemory` as `typ srflx` lines (a type `punchTransport` and `publicSrflx` already accept). The word "mapped" is a **status and ordering concept, not a new candidate type**: no new wire kind, no signature-context change, no unknown-field risk for older peers.
- Dial order in rung 1: mapped-sourced candidates first, then any other remembered public srflx.

### 3a. How the roamer is found with no STUN (peer-reflexive)
The roaming laptop dials the office's remembered mapped `addr:port` with the office's pinned ufrag/pwd/cert, using **zero signaling**. The office learns the roamer's address as a **peer-reflexive (`prflx`) candidate** from the incoming ICE checks (`punchTransport` already accepts `host|srflx|prflx`), so neither side needs STUN. Two unmapped laptops at two new spots cannot connect (same network required); that residual is the owner's own framing.

### 3b. Pinned no-STUN invariant
Production ICE servers stay `[]`. Slice 2 adds a pinned test asserting that the production start path passes no `iceServers`, so STUN cannot quietly return. Rung 2 gossip and the rung-3 rendezvous record carry the mapped candidate (via the same published entry); a device with no mapping publishes no public candidate.

### 3c. Supersession
Rung 1's "learn reflexive via STUN-from-socket" text in `2026-10-08-relayless-cross-network-reconnect.md` is **superseded** by this section.

### 4. Memory age
`RUNG1_MEMORY_MAX_AGE_MS` is 12 h. A laptop away over a weekend would report `no-memory` and never try the office. Recommendation: a mapped-sourced candidate carries its own age limit of 7 days (the office keeps the same external port in practice and a wrong guess costs one 8 s timeout). Confidence: medium; it is a tuning value, settled in slice 2 with a test, and the hardware session shows whether it is enough.

### 5. Lifecycle
Map after the punch transport starts; refresh on a timer before lease expiry; re-publish the gossip entry when the external IP or port changes. **Unmap and `stop()`** on graceful quit (`will-quit` in `main.js`), on revoke, and when punch is disabled. **At startup, before mapping, delete any stale mapping for our own LAN IP and pinned port** (a crash cannot unmap; the 1 h lease bounds the exposure).

### 6. Double NAT / CGNAT
If the router reports an external IP that is private or in 100.64.0.0/10, the mapping is useless: do not publish it, set status `double-nat`.

### 7. Status, shown to the director as a flag (not a banner)
Closed set: `mapped | refused | no-gateway | double-nat | permanent-lease | error`, each with a plain "why" sentence, surfaced in the existing sync flag area. Per DESIGN_STANDARD sections 5 (feedback) and 8 (transitions): the flag has a visible pending state while discovery runs, and its reduced-motion equivalent is a static text change, never no feedback. No coming-soon controls, and a failed map is surfaced, never silent.

### 8. Accepted limits (documented, not built)
- **One peer at a time per pinned port** (the `sessionOnFreePort` ceiling). One office plus one roaming laptop works; a second simultaneous punched peer is refused until the first closes. No port range, no ICE UDP mux for now.
- Later options for more than one punched peer, not built: ICE UDP mux (`enableIceUdpMux`) or a small pinned port range.
- Both ends at never-seen spots remains out of scope (owner).
- Success depends on the office router (the owner's hardware check settles it per camp): the report estimates 50 to 75 percent for consumer or ISP routers, near zero for managed networks or CGNAT. That is a judgement from sources, not a measurement; the status flag tells the director which case they are in.

## Exposure (plain)

One UDP port on the office router forwards to the app while it runs, reachable by anyone on the internet, and scanners will find it. Before any packet reaches Noise it is parsed in C/C++ by libjuice and libdatachannel (STUN binding requests, DTLS ClientHello); a memory-safety bug there would be reachable (security assessment F5, `node-datachannel` pinned at exactly 0.33.4 with lockfile integrity). Inbound sessions are limited by the pinned ICE ufrag/pwd, the pinned certificate, `maxPendingInbound`, `connectionRateLimiter.js`, and T331 admission. The ICE credentials are long-lived and stay secrets. Revocation rotates identity (cert, key, ufrag/pwd); the port is kept, so a revoked peer's stored credentials stop working, but the port itself stays mapped.

A hostile or buggy router can lie about the external IP or drop the mapping; the worst case is a failed dial, never a trust bypass, because identity is pinned end to end. Never follow a UPnP `LOCATION` URL that is not on the gateway's own LAN subnet (SSDP spoofing); cap XML sizes and use timeouts.

## New egress surface (gate entry required)

SSDP multicast to 239.255.255.250:1900, HTTP/SOAP to the router's LAN address, and NAT-PMP UDP to the default gateway port 5351. All are LAN-only. `internetRendezvousScan.js` has **no pattern for `dgram`**, so this egress is invisible to the text scanner today; slice 5 adds a `dgram` pattern, a `portMapping` row in `transportCapabilities.js` (`packages: ['@achingbrain/nat-port-mapper']`, an explicit `egressAllowlist` for the one module, `inertPresence: true`, `signoff: null` until the owner's hardware session), and a test that plants an unlisted `dgram` file and requires the gate to fail.

## Interaction with in-flight revocation work

Namespace and address-key rotation on revoke is a separate change (assessment F2/F3). This ADR's contribution to it: **no STUN servers anywhere**, so a revoked peer cannot learn our address from a third party, and the mapped address is only published inside the camp-encrypted gossip entry under the camp's address key. On revoke we additionally unmap (slice 3) and re-map after the next transport start. If address-key rotation lands later, the gossip entry is re-published under the new key by the existing publisher with no change here.

## Interface-contract check (`org-interface-contracts`)

- Idempotency: map, refresh and unmap are idempotent per (LAN IP, port); a repeated map returns the same record. Publishing re-uses `publishReflexive`'s highWater and signature scheme.
- Unknown outcome: a map that times out is `error`/`refused` and is retried on the next cycle; unmap on a gateway that is gone is best-effort and never blocks quit.
- Error shape: the mapper returns a status object, never throws to callers.
- Boundary: no IPC handler and no op-log primitive is added; the status reaches the renderer through the existing sync-status push path. If slice 4 needs a new IPC read, it goes through `authorize()` and `electron/ipcSurfaceParity.test.js`.
- Trust boundary: candidates from a peer's gossip are already signature- and registry-verified before use; the new memory write re-applies the public-address filter.

## Candidates considered

Closed case for divergence: the owner chose the mechanism (ask your own router) and recommended library after a feasibility report. Rejected alternatives, recorded: public STUN (owner reversal); `@libp2p/upnp-nat` (wrong socket, leaks via identify, UPnP only); mapping the libp2p TCP listener (bypasses punch identity pinning); a pinned port range or ICE UDP mux (deferred, see limits).

## Consequences

- Rung 1 gains a candidate that needs no third party; STUN is removed as an assumption from both amended ADRs.
- A new dependency and a new LAN egress surface, both behind the existing flag and a new capability row.
- The mapped port is a standing exposure while the app runs, accepted by the owner.
- Open dependency to verify in slice 2: `peer_punch_memory` is written only after a punch session that passed admission (`onPunchPeerAdmitted`). A pair that has only ever met over the LAN TCP path may have **no punch memory** and therefore no pinned peer ICE credentials to redial with. Slice 2 starts by checking this against the real code and a test; if true, the fix is to have the two devices establish and remember one punch session while on the same network, and that becomes part of slice 2, not a surprise in the hardware session.

## Amendments to the earlier ADRs

Pointer lines are added to `docs/adr/2026-10-08-relayless-cross-network-reconnect.md` (rung 1 text: "learns its public mapping via STUN-from-socket" is superseded by the router-learned mapped candidate; the "no permanent public listening port and no port-forward" exposure line is amended by this ADR's mapping) and to `docs/adr/2026-10-02-wan-discovery-transport-ladder.md` (no STUN of any kind on the ladder; rung 1 candidate source is the router). Neither earlier ADR's decision text is deleted.
