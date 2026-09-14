---
title: "Characterize what the libp2p admission gate does not promise"
document_type: ticket
status: completed
created: 2026-09-13
task_class: security-auth
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-09-06-libp2p-membership-mapping.md]
archive_when: the bearer-token property of a camp token is measured by a test rather than inferred, and SECURITY.md states it alongside the revocation behaviour that bounds it
---

# T155 — Characterize what the libp2p admission gate does not promise

From the external architecture review of 2026-09-13 (item 6), which asked for
adversarial pressure on eleven cases. Most were already covered, and the review
should be told so rather than have work generated for them:

Already tested — unknown peer (bytes never reach `A.merge`), failed auth, a
`local` token over libp2p, an expired token, a `device_id`/token mismatch, a
revoked device with a structurally valid token, re-admission after disconnect,
unsupported auth message types, **outbound** broadcast gating, pairing/login rate
limits including device-id rotation on one connection, and `MAX_PENDING_PAIRING`.
Wrong-genesis documents and malformed Automerge binaries are both refused in
`syncNode.handleReceived` — the genesis check exists precisely because the
admission gate cannot catch it. Revocation of a still-connected device evicts it
from the live admission set immediately (`revokeDevice` -> `revokePeer`), rather
than waiting for a disconnect.

## The one that was genuinely open

**A camp token is a bearer credential.** `evaluateAuthenticate` binds a token to
the `device_id` *inside* it; nothing binds it to the libp2p peer id presenting
it. Now measured rather than assumed: a valid token replayed from a peer the Host
has never seen is admitted, and — the counterweight, in the same test file —
revocation is re-checked on every authenticate, so the replay stops working the
moment the named device is revoked.

It is not closed here, deliberately. `devices.libp2p_peer_id` cannot do it:
libp2p generates a fresh peer id every process start, which is exactly why that
column is documented as a routing convenience and never a trust signal, so
requiring a match would reject every ordinary reconnect. Closing it means
persisting a libp2p identity per device and binding tokens to it — a design
decision with key-management consequences, not a test fix. Raised as an open
question rather than silently absorbed.

Relay and hole-punching cases (review item 7) are **not applicable**: the shipped
transport is TCP + mDNS only. No `circuitRelay`, `dcutr`, DHT or AutoNAT exists
under `electron/`; WAN traversal is Stage 7 and the ADR already states that the
direct punch is untested and that the CGNAT result went via relay.
