---
ticket: T349
document_type: ticket
title: S3 — Rung 2 camp-peer address gossip and signaling over the authenticated libp2p stream, inert
status: open
created: 2026-10-08
archive_when: "electron/sync/automerge/punchGossip.js, punchSignaling.js and punchRung2.js exist with their red-first tests green; the signed camp-encrypted reflexive-address field is read only through readReflexive; /shoresh/punch-signal/1 is served only to authGate-admitted, registry-trusted peers; and the modules are wired into syncStarter.js behind SHORESH_PUNCH_ENABLED by a follow-up"
task_class: security-auth
parent: T347
governing_docs: [docs/adr/2026-10-08-relayless-cross-network-reconnect.md, docs/current/WHERE_DATA_LIVES.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md]
related_prs: []
related_tickets: [docs/work/tickets/T347-s1-punch-transport-inert-build.md, docs/work/tickets/T338-crdt-presence-complement.md]
---

# T349 — S3: Rung 2 gossip + signaling, inert

## Context

Rung 2 of the relay-less cross-network reconnect
(`docs/adr/2026-10-08-relayless-cross-network-reconnect.md`): a camp peer shares the current
reflexive address of the others, signed, over the authenticated sync, and the punch is signalled
over the authenticated libp2p stream, directly or through one admitted camp peer. This is the
mechanism T338 sketched. No third party, and rung 3 (`rendezvousClient`) is never contacted.

## What S3 builds (no SQLite schema change)

- `electron/sync/automerge/punchGossip.js` — each device writes ONE field on the camp's own `camps`
  record, `punchGossip_<deviceId>`: `{deviceId, peerId, candidates, ts, sig}` signed with its T331
  device identity key and AES-256-GCM encrypted under a key derived (HKDF) from the camp
  `rendezvousAddressKey`. Document only, like `rendezvousAddressKey` itself
  (`PROJECTIONS.camps.fields` is `['name']`, so the projector ignores it); one writer per field, so a
  merge cannot clash. `readReflexive` verifies the signature against the peer id the local `devices`
  registry has bound to that device, and drops: unknown, unauthorized or revoked devices
  (`devices.revoked_at` and `authority_cache`), entries older than 10 minutes or more than 5 minutes
  in the future, more than 8 candidates, non-udp or over-128-char candidates, and any value over
  4096 chars (before decrypting it).
- `electron/sync/automerge/punchSignaling.js` — the real `{sendSignal, onSignal}` for S1's
  `punchTransport`, over `/shoresh/punch-signal/1`. The handler serves only peers in the authGate's
  admitted set whom the registry still trusts, re-checked per frame. Envelope
  `[id, from, to, ts, payload]` is signed by the origin and verified at the destination, so a
  forwarder cannot forge or alter it. A forwarder only passes between trusted, admitted, connected
  devices, only when the frame came from its own origin, and never re-forwards (hop limit 1). Bounds:
  32 KiB frame cap (aborts before buffering), 20 K-char payload cap, 60 frames / 10 s per peer, 2 min
  freshness window, 512-entry replay cache.
- `electron/sync/automerge/punchRung2.js` — `attemptRung2` resolves the peer's verified entry,
  requires a signalling route, dials each candidate; returns `{ok:true, candidate}` or
  `{ok:false, reason}` (`no-gossip-entry`, `no-signal-route`, `dial-failed`).
- `authorityLogSignature.js` gains `signMessageWithDeviceKey` / `verifyMessageWithPeerId`; the
  existing authority-entry functions delegate to them unchanged.

## Not built (follow-ups)

- Wiring: nothing imports these modules from `syncStarter.js` / `transport.js` yet, so nothing is
  active. The wiring registers `createPunchSignaling` on the libp2p node (the transport does not
  expose it today), publishes the device's own entry once reflexive candidates exist (S1/S4), and
  gives the punch transport a per-peer channel (`channelTo(deviceId)`).
- The reconnect coordinator (rung 1 -> 2 -> 3 ordering).
- The one-signaling-channel-per-transport limit of S1 means a real deployment needs a per-peer
  transport or a multiplexing channel; the loopback test uses one transport per ordered pair.
