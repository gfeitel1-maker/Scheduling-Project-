---
title: "Connection-manager DoS mitigation: reserve capacity for admitted camp peers against a distributed un-admitted flood"
document_type: adr
authority: normative
status: accepted
implementation_state: in-progress
date: 2026-10-08
decided: 2026-10-08
deciders: [product-owner-delegate-organizer]
program: security-hardening
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, SECURITY.md, docs/adr/2026-09-14-internet-transport-security-gate.md]
supersedes: []
amends: []
implements: [docs/work/tickets/T340-wan-activation-go-live-checklist.md]
---

# Connection-manager DoS mitigation (T340 precondition 1)

## Status

ACCEPTED. The two-layer approach below is decided, and the library verification (recorded under
"Library facts") resolved Layer 2 to a **hybrid** — native tag-prune AND an app-level floor — because
tags alone are provably insufficient at the capacity boundary. This design is **prepared, not
activated**: it is behavior-safe connection-manager hardening that lands with no change to sync
behaviour and does **not** flip `SHORESH_RELAY_ENABLED` or activate any internet transport. It
satisfies precondition (1) of T340; it does not itself authorise go-live.

## Context

`electron/sync/automerge/transport.js:46` sets a flat `MAX_CONNECTIONS = 200` and listens on
`/ip4/0.0.0.0/tcp/0`. Under the trusted-LAN threat model this is unremarkable. But T336 (dcutr
hole-punch, merged inert) makes the node **internet-reachable once activated** — the T336/T337
gate recorded this as a **T336-created latent exposure**: once `SHORESH_RELAY_ENABLED` is true, a
distributed many-source-IP flood can exhaust the flat 200-slot cap and starve a camp's own devices
of sync capacity. It is an **availability/DoS** concern (not confidentiality/integrity) and it is
**latent until activation** — it cannot bite while the node is inert (mDNS-only, NAT-blocked
inbound). T340 records it as a hard pre-activation precondition. This ADR is its design.

### The governing constraint: admission is a POST-handshake fact

The single fact that shapes the whole design: at **inbound accept** time
(`connectionGater.denyInboundConnection`, transport.js:204) libp2p hands us only the source
multiaddr/IP. The peerId — and therefore whether the peer is a camp-admitted member
(`authenticatedPeers`) — is **unknown** until **after** the Noise handshake and `authGate` complete.
So "admit camp peers, drop strangers" is **impossible at accept time**. Any mitigation that assumes
accept-time knowledge of admission is wrong. The fix must therefore split across the two moments
where different information is available.

## Decision

A two-layer mitigation. Both layers are defense-in-depth that are correct regardless of activation
state, so they land always-on (no flag coupling); they simply become load-bearing once the node is
internet-reachable.

### Layer 1 — accept-time, source-IP only (bound un-authenticated pressure)

At accept time we know only the source. Bound how much un-authenticated pressure can accumulate:

- **Keep** the existing per-source-IP inbound rate limiter (`connectionRateLimiter.js` →
  `denyInboundConnection`, transport.js:201-210) — bounds per-IP connection churn.
- **Set `connectionManager.maxIncomingPendingConnections` explicitly** (transport.js:201) to bound
  the backlog of inbound connections that have been accepted but have **not yet completed the Noise
  upgrade**. This is the direct lever against a handshake flood — many TCP connections opened that
  never finish auth. The implementing slice reads the installed default
  (`connection-manager/constants.defaults`) and sets a deliberate small value with justification
  (suggested 16–32 for a camp-scale node), rather than inheriting an internet-scale default.
- `inboundConnectionThreshold` (per-remote-host; installed default 5) is retained.

Layer 1 cannot distinguish camp from stranger (it does not know yet) — it only ensures a flood
cannot pile up un-upgraded connections faster than they resolve.

### Library facts (verified against the installed tree before deciding Layer 2)

Two independent readers (one adversarial) read installed libp2p 3.3.11 / `@libp2p/interface` 3.3.0 /
peer-store 12.0.28 (from `dist`):

- There is **no `tagPeer`**. The API is `peerStore.merge(id, { tags: { 'shoresh-admitted': { value:
  100 } } })`, removed with `merge(id, { tags: { 'shoresh-admitted': undefined } })` — **`merge`, not
  `patch`** (patch wipes other tags). Tag value range is 1–100.
- `ConnectionPruner` (connection-pruner.js:53-58) **sums all tag values per peer** and sorts ascending
  (then fewer-streams, then newest) — so a tagged admitted peer does prune **last**. Tag-prune works
  for the **overshoot** case. ✔
- **But pruning only runs on OVERSHOOT.** At exactly `maxConnections`, `acceptIncomingConnection`
  (index.js:403) **refuses a new inbound by count, before the Noise upgrade — tags are never
  consulted.** So 200 un-admitted connections that finished Noise and are idling in `authGate` block
  an admitted device's (re)connect outright. **Gap 1.**
- `maxIncomingPendingConnections` (default **10**, index.js:389) is enforced pre-Noise and
  decremented after the upgrade, so it does **not** bound the post-upgrade/in-`authGate` window.
  Post-Noise/pre-`authGate` connections **do** count toward `maxConnections`.
- `safelyCloseConnectionIfUnused` skips a connection holding a non-closable open stream — an attacker
  holding an `authGate` stream open may be **un-prunable**. **Gap 2.**

Conclusion: tag-prune alone is insufficient (gaps 1 and 2). Layer 2 is a hybrid.

### Layer 2 — post-auth, peerId known (reserve capacity for admitted camp peers) — HYBRID

Once a peer passes `authGate` (the `admitPeer`/`onPeerAdmitted` seam, transport.js:255/608 — the same
seam T336/T337 use), its admission is known.

- **L2a — native tag-prune (handles overshoot).** On admission, `peerStore.merge` the peer with tag
  `shoresh-admitted` value 100; remove it on `revokePeer` (transport.js:565) and on `peer:disconnect`.
  The pruner then closes un-admitted / still-handshaking / failed-auth connections before admitted
  camp peers when over `maxConnections`.
- **L2b — app-level floor + authGate deadline (handles the at-cap boundary, gaps 1 & 2).** Tag-prune
  never fires at exactly the cap, so L2b is the real floor:
  - On `connection:open`, if the connection's peer is **not in `authenticatedPeers`** (read live, at
    decision time — not a snapshot) and the count of un-admitted established connections already
    exceeds `maxConnections − reservedFloor`, **abort the new connection** (reject-newest; the
    deadline below guarantees turnover). This keeps ≥ `reservedFloor` slots never held by un-admitted
    peers.
  - An **authGate deadline**: any connection not admitted within ~10s (confirm against real handshake
    timing; tune or add — `maxIncomingPendingConnections` does NOT cover this window) is **aborted**
    (ungraceful, to free the slot immediately). This forces turnover of the un-admitted bucket and
    directly closes Gap 2 (a held-open `authGate` stream past the deadline is aborted regardless of
    the prune-skip).

**Honest guarantee (what the tests pin — do not overclaim).** At `connection:open` the peerId is known
but admission is **not yet decided**, so a legitimately-reconnecting camp device is indistinguishable
from the flood at that instant. Therefore L2 guarantees: **(a)** an ESTABLISHED admitted connection
(in `authenticatedPeers`) is **never evicted** by an un-admitted flood — a **hard guarantee** (the
floor); and **(b)** a RECONNECTING camp device regains a slot **likely within an authGate-deadline
turnover cycle, but this is NOT guaranteed under a sustained distributed flood** — it competes for the
recycling un-admitted slots. L1's per-IP limiter bounds any single attacker; the distributed case is
bounded, not eliminated.

## Numbers (sized, not magic)

- `maxConnections` stays **200**. The fix is **priority**, not raising the cap — raising it only
  moves the flood ceiling.
- `reservedFloor` for admitted/camp peers must **exceed a realistic maximum camp device count** so a
  stranger flood can never consume the slots a camp needs; a camp is at most a few dozen devices, so
  a floor of ~**32** is generous. The hostile internet population is unbounded, so the un-admitted
  remainder (`maxConnections − reservedFloor`) is the only part a flood can occupy.
- `maxIncomingPendingConnections` ~ **16–32**, justified against the installed default.

The implementing slice records the final arithmetic with the installed defaults it read.

## Consequences

- **Positive:** once activated, a camp's own devices keep sync capacity under a distributed DoS; the
  hardening is also a modest LAN-side robustness gain; it is behavior-neutral when inert.
- **Cost / limits:** this bounds **availability** degradation, not a determined attacker's ability to
  consume the un-admitted remainder — that is acceptable because the camp floor is protected and the
  surface is availability-only. It does not address confidentiality/integrity (unchanged — Noise +
  `authGate` still gate all data). It is **not** a substitute for the owner-configured edge
  rate-limiting/WAF noted in the 2026-09-14 gate ADR for any hosted rendezvous.
- **Still inert:** nothing here activates internet transport. T340's other preconditions
  (real-hardware cross-network validation, C2/C4 re-confirm, dcutr-subtree re-audit, the
  literal-`true` flag doc, the ADR-2026-09-14 owner items) remain, and activation stays the owner's
  separate go-live.

## Verification (what the implementing slice must prove, test-first, real multi-node)

1. RED→GREEN (overshoot, L2a): over `maxConnections`, an admitted (tagged) camp peer survives while
   un-admitted connections prune first; WITHOUT the tag it is evicted. Non-vacuity: an admitted
   connection with free capacity is untouched.
2. RED→GREEN (Gap 1, at-cap, L2b floor): at EXACTLY `maxConnections` filled with post-Noise
   un-admitted connections, an admitted device's reconnect is refused by the count check WITHOUT
   L2b; WITH the floor (un-admitted capped at `maxConnections − reservedFloor`) the reserved slots
   are available. State the guarantee honestly (per the Honest-guarantee paragraph above):
   established-admitted is never evicted (a hard guarantee); a reconnect is likely within turnover
   but NOT guaranteed under a sustained distributed flood.
3. RED→GREEN (Gap 2, authGate deadline): a connection that completes Noise then holds an `authGate`
   stream open without authenticating is ABORTED at the deadline, freeing the slot; WITHOUT the
   deadline it is un-prunable and holds the slot.
4. RED→GREEN (pre-Noise backlog, L1): an un-upgraded inbound flood exhausts capacity without an
   explicit `maxIncomingPendingConnections`; the bound caps the backlog.
5. The tag/floor is applied at admission (`peerStore.merge`) and removed on revoke AND
   `peer:disconnect`; the un-admitted count is read live (`getConnections()` minus
   `authenticatedPeers`), not snapshotted.
6. Behavior-neutrality: LAN-only mode (flag off) sync is identical.
7. Full `npm run verify` is the gate (not a targeted suite). The slice also re-confirms T337's
   C2/C4 and re-runs the dcutr-subtree `npm audit`/postinstall check as evidence.
