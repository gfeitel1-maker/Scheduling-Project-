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
reachable only on the local network.** The shipped libp2p node uses `@libp2p/tcp` bound to a
loopback default (`/ip4/127.0.0.1/tcp/0`) with `@libp2p/mdns` LAN discovery — no relay, no DHT,
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
6. **Credential-signature replay + degrade-window permanence (T165)** — the Q1 enforcement closes
   credential *forgery* but two merge-path credential-*mutation* residuals (a paired peer replaying
   an old Host-signed tuple to demote an admin / roll back a PIN; and forgeries accepted on a
   key-less rebuilt device becoming permanent) are MEDIUM under the LAN boundary and rise to HIGH
   once a peer can be remote. Both MUST be fixed before this gate is signed off. See
   `docs/work/tickets/T165-credential-signature-replay-and-degrade-permanence.md` and
   `docs/work/security/2026-09-15-Q1-enforcement-merge-review.md`.

### Enforcement (this is not just prose)

`electron/sync/automerge/transportBoundary.guard.test.js` fails the test suite — and therefore
`npm run verify` — if any internet-transport package is added to `package.json`, if `transport.js`
imports one, or if `DEFAULT_LISTEN` moves off loopback. The guard is disabled only by flipping its
`INTERNET_TRANSPORT_SIGNOFF` constant to `true`, which a reviewer may do **only after** the
re-assessment above is recorded (as an ADR or an entry in the security-program doc). Flipping the
switch forces someone to open the guard file, which points back here — the checkpoint is
unavoidable by construction.

## Consequences

- The boundary change can no longer happen silently or incrementally; it trips a red build.
- The cost is one extra guard test and the discipline of a recorded re-assessment before shipping
  internet transport — proportionate to the fact that this is the single largest latent risk in
  the product's direction.
- The guard's package list must be kept current: a new internet-transport library not on the list
  would slip through. That risk is noted in the security-program doc's maintenance section.

## Verification

- The guard passes on the current LAN-only tree (3 assertions green).
- Adding any listed package, importing one in `transport.js`, or changing `DEFAULT_LISTEN` off
  loopback turns the suite red with a message pointing here — confirmed by construction (the
  assertions read the live `package.json` and `transport.js`).
