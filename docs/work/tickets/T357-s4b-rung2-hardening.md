---
ticket: T357
document_type: ticket
title: S4b — rung 2 hardening (highWater and replay stores fail closed and surface write failures, address filter gaps, signaling budget ordering, once-per-revocation identity rotation), inert behind SHORESH_PUNCH_ENABLED
status: open
created: 2026-10-09
archive_when: "the highWater and replay file stores report an unreadable or corrupt file and refuse entries instead of starting empty, warn and expose every write failure, and fsync before rename; isPublicAddress rejects the listed special-use ranges; a replayed signal neither burns the origin budget nor raises CLOCK_SKEW; forgetRevokedPeer rotates the punch identity once per revocation; nothing activates without SHORESH_PUNCH_ENABLED"
task_class: security-auth
parent: T347
governing_docs: [docs/adr/2026-10-08-relayless-cross-network-reconnect.md, docs/adr/2026-10-09-rendezvous-worker-durable-object-storage.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md]
related_prs: []
related_tickets: [docs/work/tickets/T354-s4a-rung1-remembered-reflexive-redial.md]
---

# T357 — S4b: rung 2 hardening

Keeper must-fix list for the relay-less cross-network reconnect. Everything stays inert behind
`SHORESH_PUNCH_ENABLED === 'true'`; no dependency is added and no flag is flipped.

## What changed

1. **Stores fail closed, never swallow a write failure** (`electron/sync/automerge/punchFileStore.js`,
   shared by `createHighWaterStore` in `punchGossip.js` and `createReplayStore` in `punchSignaling.js`).
   A missing file is a normal first run. An unreadable or corrupt file is warned and kept on `.failed`;
   `readReflexive` then refuses every entry (`.refused`), `attemptRung2` returns
   `high-water-unavailable`, and the replay store refuses every signal. A failed write is warned,
   returned from `set()` / kept on `.lastWriteError`, and listed in `readReflexive(...).storeErrors`.
   The temp file is fsynced before the rename. `createHighWaterStore` requires a real `filePath`, and a
   plain `Map` no longer satisfies the `highWater` requirement.
2. **`isPublicAddress`** also rejects Teredo `2001::/32`, documentation `2001:db8::/32`, site-local
   `fec0::/10`, discard `100::/64`, ORCHID `2001:10::/28`, ORCHIDv2 `2001:20::/28`, `192.0.0.0/24`
   and `192.88.99.0/24`. One red case each.
3. **Planted defects** for the two previously unplanted tests: breaking the store write turns "a restart
   does not re-accept a rolled-back entry" red; removing the store check turns the `no-high-water-store`
   test red.
4. **Signaling budget ordering**: the replay check now runs before the per-origin rate limit and the
   stale-signal `CLOCK_SKEW` emit, so a replayed envelope burns no budget and raises no skew event.
5. **Identity rotation once per revocation**: `forgetPeerAddress` returns the rows it removed and
   `forgetRevokedPeer` rotates only when there was something to forget.
6. **Vacuous negative wait**: `punchTransport.sync` "a peer revoked mid-connection is cut off" used a
   fixed 500ms sleep before asserting the revoked write had not landed, so it could pass whenever the
   write simply had not arrived yet. It now waits for A's production sync path to log that it refused
   B's message, then asserts. Finding recorded here per the keeper list.
7. Stale wording: v91 in the localDb v93 comment and this ticket family's T354 body, and KV mentions in
   `rendezvousClient.js` (storage is a Durable Object per the 2026-10-09 ADR).

## Verification

Local (light) runs: punchGossip, punchSignaling (affected tests), punchIdentity, peerPunchMemory,
punchRung1Revoke. `punchRung2.test.js` buildCamp tests and `punchTransport.sync.test.js` need
`node-datachannel`, absent from this machine's node_modules; CI is the gate for those.
