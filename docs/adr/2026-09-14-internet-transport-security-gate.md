---
title: "Internet-reachable transport requires a full security re-assessment (enforced gate)"
document_type: adr
authority: normative
status: accepted
date: 2026-09-14
supersedes: []
implementation_state: implemented
program: security-hardening
affects:
  - electron/sync/automerge/transport.js
  - electron/sync/automerge/transportBoundary.guard.test.js
  - SECURITY.md
  - docs/work/security/2026-09-14-security-program.md
---

# Internet-reachable transport requires a full security re-assessment (enforced gate)

**Status: ACCEPTED and implemented** (the enforcing test ships in this change).

## Context

Every security decision in Shoresh rests on one load-bearing assumption: **the sync transport is
reachable only on the local network.** CORRECTION (2026-09-15 WAN assessment, finding 1): the
production node does NOT bind loopback — `electron/main.js` passes `listen: ['/ip4/0.0.0.0/tcp/0']`
(all interfaces, necessary for LAN sync; loopback would let nothing connect). `transport.js`'s
loopback `DEFAULT_LISTEN` is dead in production. So the boundary is **not** the bind; it is
**discovery**: the shipped node uses `@libp2p/mdns` (link-local multicast) only — no relay, no DHT,
no WebRTC/WebSocket/WebTransport, no bootstrap list, no NAT traversal. Under that assumption a
set of real, documented tradeoffs are *acceptable*: no TLS on the wire (`ws://`-era reasoning
carried forward), the plaintext PIN in the first-login message, device-side role enforcement
under CRDT sync, and rate limits sized for a handful of LAN peers rather than internet-scale abuse.

The roadmap points the other way. The parked "shared-document sync + Syncthing relay" work and
the "productionize automerge/libp2p sync" track both move toward devices that reach each other
**across the internet**. libp2p is *designed* for exactly this — adding a circuit relay or a
public listen address is a few lines. The danger is that it lands as an incremental "just enable
the relay" change, and every one of the tradeoffs above silently becomes an internet-facing
exposure without anyone re-deciding it. That is the failure mode this ADR exists to prevent —
and it is precisely the mistake an earlier assessment made by treating the LAN boundary as
permanent instead of as an assumption with an expiry.

## Decision

**Before any internet-reachable transport or discovery mechanism ships, a full security
re-assessment is mandatory and must be recorded.** "Internet-reachable" means any of: a circuit
relay (`@libp2p/circuit-relay-v2`), WebRTC/WebSockets/WebTransport transports, a DHT
(`@libp2p/kad-dht`), a bootstrap peer list, AutoNAT/DCUtR/UPnP hole-punching, or a non-loopback
default listen address.

The re-assessment must cover, at minimum:
1. **Transport confidentiality** — TLS/`wss` or equivalent; the plaintext-PIN-on-wire tradeoff
   revisited (it is unacceptable off-LAN).
2. **Relay/rendezvous trust** — any relay must be authenticated; a relay must not be able to read
   or forge camp traffic (Noise proves a channel, not membership — that gap widens off-LAN).
3. **Rate limiting and abuse** — the current caps assume a few LAN peers; internet exposure needs
   connection/pairing/login limits sized for hostile scale, and the `MAX_CONNECTIONS` ceiling
   revisited.
4. **Electron update integrity** — an internet-connected app needs signed, integrity-checked
   auto-update; unsigned update is an RCE vector once the app talks to the internet at all.
5. **Device-side role enforcement under CRDT sync** — re-evaluate whether a compromised paired
   peer's writes are acceptable when peers are no longer all on a trusted LAN.
6. **Credential-signature replay + degrade-window permanence (T172) — RESOLVED 2026-09-15.** The two
   merge-path credential-*mutation* residuals the Q1 enforcement review found (replaying an old
   Host-signed tuple to demote an admin / roll back a PIN; forgeries accepted on a key-less rebuilt
   device becoming permanent) are fixed: a monotonic `cred_version` bound into the signature defeats
   replay, and the no-key branch now *skips* rather than accepts an unverifiable change. Done ahead
   of this gate (the owner reclassified them as present risks — devices connect over paths beyond the
   LAN). Re-verify remains part of any internet-transport re-assessment, but the known findings are
   closed. See `docs/work/tickets/T172-...` and `docs/work/security/2026-09-15-Q1-enforcement-merge-review.md`.

### Enforcement (this is not just prose)

`electron/sync/automerge/transportBoundary.guard.test.js` fails the test suite — and therefore
`npm run verify` — if any internet-transport package is added to `package.json`, if `transport.js`
imports one, or if `electron/main.js` stops wiring mDNS-only discovery (i.e. an internet rendezvous — DHT/bootstrap/relay — is added to the production node). The guard is disabled only by flipping its
`INTERNET_TRANSPORT_SIGNOFF` constant to `true`, which a reviewer may do **only after** the
re-assessment above is recorded (as an ADR or an entry in the security-program doc). Flipping the
switch forces someone to open the guard file, which points back here — the checkpoint is
unavoidable by construction.

**Amended 2026-09-18 (T207) — the boundary is also asserted behaviourally, because the three
assertions above are package-shaped and marker-shaped and the boundary is not.** An HTTPS `fetch`
to a bulletin-board service is not an npm libp2p package, is not imported by `transport.js`, and a
rendezvous service appended *after* `createMdnsDiscovery(` in the `peerDiscovery` array still
satisfies that regex. A node could have published its real WAN addresses to a public board with a
fully green gate. The guard therefore adds a fourth assertion: **no file under `electron/sync/**`
may perform internet egress of its own, by any name, in any file** — detection lives in the
separately-tested pure function `electron/sync/automerge/internetRendezvousScan.js`, whose own
header states what it can and cannot see. The sync path reaches the network only through libp2p, to
peers found on the link-local network; anything else is the boundary change this gate exists to
catch.

## Consequences

- The boundary change can no longer happen silently or incrementally; it trips a red build.
- The cost is one extra guard test and the discipline of a recorded re-assessment before shipping
  internet transport — proportionate to the fact that this is the single largest latent risk in
  the product's direction.
- The guard's package list must be kept current: a new internet-transport library not on the list
  would slip through. That risk is noted in the security-program doc's maintenance section.

## Verification

- The guard passes on the current LAN-only tree (assertions green; three at the time of writing,
  four since T207 added the egress assertion described above).
- Adding any listed package, importing one in `transport.js`, or wiring an internet rendezvous
  (DHT/bootstrap/relay) into `electron/main.js`'s discovery turns the suite red with a message pointing here — confirmed by construction (the
  assertions read the live `package.json` and `transport.js`).
- The egress assertion is confirmed by a **planted defect** rather than by construction: a
  rendezvous client added under `electron/sync/**` turns the suite red, and its removal turns it
  green again. That is the check the earlier three could not make — see T207.
