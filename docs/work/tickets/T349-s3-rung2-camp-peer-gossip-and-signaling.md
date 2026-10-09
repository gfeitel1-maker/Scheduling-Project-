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
  **Final round (owner-approved):** `attemptRung2` now takes `bindChannel` and hands the punch
  transport `signaling.channelTo(target)` before it dials, so the SDP/candidate exchange travels on
  the authenticated punch-signal stream (direct, or forwarded by an admitted camp peer); with no
  `bindChannel` it refuses (`no-signal-channel`) rather than dial bare. `hasRoute` is async and
  true only when the target is itself connected and admitted here, or when a relay CONFIRMS over a
  route probe on the same protocol that it is connected to and admitted with the target; otherwise
  `no-signal-route`. The loopback test proves the stream/forwarding and signature properties, not
  NAT traversal.
- Scope note: the `authorityLogSignature.js` refactor touches a security-sensitive module; the
  existing authority-log tests pass unchanged.
- Test helper lives at `test/punchRung2Support.js` (plaintext test DBs are a test-harness-only
  pattern the `openLocalDbCallers` guard keeps out of `electron/`).
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

## Final-round hardening (done)

Replay memory is keyed on `(from, id)`, lives until `ts + MAX_SKEW_MS`, is bounded, and persists
across restart through a JSON file store (`createReplayStore({filePath})`, no SQLite schema change;
the caller picks the path at wiring). Relay forwards time out (`forwardTimeoutMs`, the onward dial is
aborted) and are rate-limited per ORIGIN (`originRateMax`) as well as per peer. Gossip readers take a
`highWater` store (required, see Scoped fix round) and refuse an entry older than the newest verified ts per device. Gossip candidates
must be public unicast `ip4`/`ip6` udp with a non-zero port (private, loopback, link-local, CGNAT,
multicast, unspecified and IPv4-mapped refused at publish AND read; `allowPrivateCandidates` is a
loopback-fixture switch only). Clock skew is surfaced: a verified future-dated gossip entry gives
`attemptRung2` reason `clock-skew` and a `CLOCK_SKEW` connectivity event, and a verified stale or
future-dated signal emits the same event instead of vanishing. Each behavior has a test that was
shown red with the defect planted.

Still not built: `emit` and the `highWater` / replay store file paths are wired by the follow-up.

## Scoped fix round (keeper-ruled)

- `isPublicAddress` parses IPv6 numerically (eight 16-bit groups; no URL parsing). Added refusals:
  NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`; 6to4 `2002::/16` rejected outright (not by embedded
  IPv4: the prefix has no legitimate use for a camp peer); test-nets `192.0.2.0/24`,
  `198.51.100.0/24`, `203.0.113.0/24`; benchmarking `198.18.0.0/15`. Test fixtures that used
  test-net addresses as "public" now use real public ranges.
- `highWater` persists via `createHighWaterStore({filePath})` (bounded JSON file, same mechanism as
  the replay store, no schema change) and is REQUIRED: `readReflexive` throws without one,
  `attemptRung2` returns `no-high-water-store` without reading or dialling.
- Filed, NOT fixed: rate-limit-before-replay-check budget ordering (low).

## Flake write-up

`punchTransport.sync.test.js` "a peer revoked mid-connection is cut off" failed once in a parallel
run elsewhere. It does not import `punchSignaling`, `punchGossip` or `punchRung2`; this ticket's only
change to it is the temp-file prefix. It passed 3 of 3 in isolation here. Likely cause (unproven, not
reproduced): the test runs a real DTLS punch, mutual auth and two syncs inside a 30 s vitest budget
with a fixed 500 ms sleep and 15 s `waitFor`s, which a loaded 8 GB machine running several suites can
exceed. It is not caused by T349; it remains an open timing-sensitivity risk.
