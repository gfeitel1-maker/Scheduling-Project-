---
ticket: T358
document_type: ticket
title: S4c — reconnect coordinator (LAN, rung 1, rung 2, then rung 3 only on failure), demand-driven rung-3 polling, public reflexive addresses in the rendezvous record, production wiring, inert behind SHORESH_PUNCH_ENABLED
status: open
created: 2026-10-09
archive_when: "the coordinator escalates strictly LAN, rung 1, rung 2, rung 3 and never contacts rung 3 while an earlier rung can succeed or when SHORESH_RENDEZVOUS_URL is unset; the rendezvous client publishes and polls only on demand with backoff; the rendezvous record carries only public reflexive addresses; attemptRung1, attemptRung2, the punch-signal protocol and gossip publishing have production callers inside the SHORESH_PUNCH_ENABLED gate; a total failure raises SAME_NETWORK_REQUIRED; nothing activates without SHORESH_PUNCH_ENABLED"
task_class: security-auth
parent: T347
governing_docs: [docs/adr/2026-10-08-relayless-cross-network-reconnect.md, docs/adr/2026-10-09-rendezvous-worker-durable-object-storage.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md]
related_prs: []
related_tickets: [docs/work/tickets/T354-s4a-rung1-remembered-reflexive-redial.md, docs/work/tickets/T357-s4b-rung2-hardening.md]
---

# T358 — S4c: reconnect coordinator

Everything stays inert behind `SHORESH_PUNCH_ENABLED === 'true'`. No dependency is added and no flag is flipped.

## What changed

1. **`electron/sync/automerge/reconnectCoordinator.js`** (new, pure, collaborators injected). Per
   unreachable peer: LAN, then `attemptRung1`, then `attemptRung2`, then rung 3 only if all of those
   failed. Rung 3 is a demand handle (`request` / `release`); it is `null` when `SHORESH_RENDEZVOUS_URL`
   is unset, so the ladder is then LAN and rungs 1-2. A rung-3 attempt waits 90s for the peer to connect.
   When everything fails it emits `SAME_NETWORK_REQUIRED` (a connectivity event for a later UI; no UI
   work here) and retries the ladder with a jittered 60s-doubling backoff capped near 30 min.
2. **Demand-driven rung-3 polling** (`startDemandRendezvousClient` in `rendezvousClient.js`,
   `punchBackoff.js`). No publish or poll while every peer is reachable. The first request ticks at
   once, then re-ticks with jittered exponential backoff; the last release stops it. With the punch gate
   on, syncStarter uses this instead of the 60s fixed-interval client. With the gate off the T288 client
   is unchanged.
3. **Rendezvous record addresses**: `addresses: []` is replaced by this device's remembered reflexive
   candidates (`ownReflexiveMultiaddrs`), filtered through `isPublicAddress`; private, LAN, loopback and
   CGNAT addresses are never published.
4. **Production wiring** (`punchReconnectWiring.js`, called only inside the gate): persisted
   `createHighWaterStore` and `createReplayStore` under userData, the `/shoresh/punch-signal/1` protocol
   on the libp2p node (exposed as `libp2pNode` from `transport.js` and `syncNode.js`), a routed signal
   channel for the single-channel punch transport, the coordinator, and republishing of this device's
   own public reflexive candidates into the camp document every 4 minutes and on peer changes.
   With no injected `punchSignaling` the starter now builds its own routed channel (previously the
   gate stayed closed in production); two inertness tests were updated for that.
5. **Carried from S4b review**: new events `PUNCH_STORE_FAILED` (store kind only, never a path), emitted
   when a high-water or replay store is corrupt or fails to write (`createReplayStore` gained
   `onError`); `isPublicAddress` rejects `3fff::/20` (RFC 9637); the `punchTransport.sync` revoked
   mid-connection test now ties its wait to the revoked write plus a second marker write.
6. **Docs**: the rendezvous ADR residual for request-quota exhaustion by cheap GETs (also in
   `workers/rendezvous/README.md`), and its frontmatter/Status now `implemented` (T355/T356).

## Known limits (not resolved here)

- The punch transport owns one signaling channel; the routed channel retargets to the latest inbound
  sender, so two simultaneous inbound punch attempts from different peers can cross. Real fix is a
  per-dial channel in the transport (S1 design).
- A rung-3 discovered record carries bare `/ip4|ip6/<ip>/udp/<port>` addresses; whether the punch
  transport can dial those without rung-2 signaling is for the two-device test and S5 to settle.

## Validation

The owner's two-device cross-NAT test is the real validation. S5 (packaging plus the T327 capability
gate) follows.

Local runs here were light: reconnectCoordinator, rendezvousDemand, rendezvousClient, punchGossip,
punchSignaling, punchIdentity, punchReconnectWiring, punchProbeShortCircuit. Tests that import
`node-datachannel` (punchTransport.sync, punchInertness, punchWiring, punchRung2 camp tests) cannot run
on this machine's stale node_modules; CI is the gate.
