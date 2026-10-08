---
title: "Relay-less cross-network reconnect: a 3-rung no-middleman ladder (remembered reflexive → camp-peer gossip → camp-owned rendezvous)"
document_type: adr
authority: normative
status: proposed
implementation_state: not-started
date: 2026-10-08
decided: 2026-10-08
deciders: [product-owner]
program: security-hardening
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, SECURITY.md, docs/adr/2026-10-02-wan-discovery-transport-ladder.md]
supersedes: []
amends: []
implements: []
---

# Relay-less cross-network reconnect — 3-rung no-middleman ladder (owner-directed)

## Status

PROPOSED. Design-only; hand to the security-batch worker on the organizer's acceptance.

> **Owner rulings, 2026-10-08, verbatim:**
> "it is possible for them to meet over different wifis once they have established a connection on lan
> without a relay" · "i will not accept that cloudflare is the only way they can meet. i do not want
> to be the middleman" · "number 3 is my relay point. but it has to be a last back up option." ·
> "number 3 is cloudflare from me."

The owner's objection is to Cloudflare being the ONLY or PRIMARY way to meet — not to running it as a
last-resort fallback. So rungs 1–2 are always tried first and must succeed with no Worker at all; rung
3 is the owner's own Cloudflare rendezvous Worker (T209, on his account), shipped as the default but
camp-overridable. No relay is built; data is never in any third party's path.

## Context

Two devices that paired on a LAN, then moved to different home networks (both behind ordinary NAT),
cannot reconnect today (verified `fe681e65`): remembered addresses are private LAN IPs; mDNS doesn't
cross networks; and the rendezvous record is published with an **empty address list**
(`electron/sync/automerge/rendezvousClient.js:157`). An HTTP echo of the source IP gives the wrong
port (the HTTPS socket ≠ the transport socket). The fix learns each device's **dialable reflexive
mapping from the transport socket itself** (STUN-from-socket) and then reconnects by trying, in a
strict order, three decentralized rungs — direct first, a shared introducer only as a last resort.

## Decision — the ladder (strict order; LAN meet remains the hard prerequisite)

Every rung reconnects only **already-LAN-paired, T331-signed camp identities**; admission is always
T331 auth over Noise after a connection forms. All reflexive addresses are camp-encrypted and signed.

**Rung 1 — remembered public reflexive address (direct; no meeting point).** While connected, each
device learns its current public reflexive mapping via STUN-from-socket and shares it with peers, who
remember it (extends the Slice-1 `peer_last_addresses` mechanism to store the PUBLIC reflexive
address, not only the LAN-observed one). On reconnect, dial the peer's last-known public address
directly and attempt a coordinated simultaneous open. Free public STUN (e.g. `stun.cloudflare.com:3478`)
is a **reflector only — not a dependency and not a meeting point**; it reveals a mapping, it
introduces no one.

**Rung 2 — camp-peer address gossip (direct; no meeting point).** Any reachable camp peer shares the
current reflexive addresses of the others — signed with their T331 identities — over the existing
authenticated sync (a signed, camp-encrypted presence/address field in the camp document; this is the
mechanism T338 sketched, now load-bearing). If A can reach any camp peer C that knows B's current
address, A learns B's address from C and punches directly. No third party.

**Rung 3 — the owner's Cloudflare rendezvous Worker (LAST BACKUP ONLY).** Only if rungs 1 and 2 both
fail, consult the rendezvous at `SHORESH_RENDEZVOUS_URL` — shipped **defaulting to the owner's own
Cloudflare Worker (T209, on his account)**, and **camp-overridable**: a fork may point it elsewhere
(its own endpoint) or **unset it entirely ⇒ rungs 1–2 only**. It introduces the two peers (signed
records) and carries a punch-timing signal; **data stays direct** (device-to-device QUIC+Noise after
the punch — the Worker never carries camp data). It is never primary and never in the data path.

**Enforced ordering invariant (tested, red-first): rung 3 is NEVER contacted while rung 1 or rung 2
can succeed.** The reconnect coordinator escalates strictly 1 → 2 → 3, and only on a rung's failure;
a test asserts zero rung-3 network calls occur when rung 1 or 2 would succeed.

## Feasibility — exactly what is missing (verified against the installed tree)

Two pieces do not exist today; one has a make-or-break unknown to settle BEFORE building.

- **No QUIC transport installed.** `@chainsafe/libp2p-quic` is not a dependency (the `quic` row in
  `transportCapabilities.js` is `signoff: null`); the live transport is `tcp()` only
  (`transport.js:206`). QUIC must be added and signed off **through the T327 security + battle-test
  gate, like every capability** (TCP simultaneous-open is unreliable through NAT; UDP/QUIC is why the
  owner specified it).
- **No STUN client anywhere in the stack** (confirmed; AutoNAT, the old dial-back reflexivity, was
  dropped). A **minimal STUN binding-request client (RFC 5389) must be built or added as a small
  vetted dependency.**
- **MAKE-OR-BREAK — socket affinity.** STUN must leave from the **same local UDP port QUIC binds**, so
  the learned mapping is the mapping peers reach. Whether `@chainsafe/libp2p-quic` allows binding a
  **fixed** UDP port and **sharing/owning** that socket is **UNVERIFIED** (uninstalled). The slice
  **verifies this first**; if the transport can't accept an externally-owned socket, that is the
  blocking gap to report before building. Do not assume it.

## Honest residual (documented, NOT built — owner: no relay)

**Symmetric NAT / CGNAT-both-ends cannot punch** on any rung (their mapping differs per destination, so
the reflexive mapping learned toward STUN/a-peer doesn't match the one used toward the other peer).
This is the owner's "rare weird firewall" case: documented as a known limitation, **no relay planned**;
those users sync on the same network.

## Posture — no middleman as the primary path

This REMOVES the "Cloudflare = introducer on EVERY reconnect" concern. Rungs 1–2 are fully
peer-to-peer with no meeting point (STUN is a bare reflector that introduces no one), and they are
ALWAYS tried first — enforced by the ordering invariant below. Rung 3 is the owner's Cloudflare Worker
but only as the **last-resort** introducer: never primary, never in the data path, and overridable or
disable-able per fork. So the owner is the fallback introducer of last resort, not the middleman of
every reconnect. No standing relay; data is always direct device-to-device.

## Exposure (plainly, per rung)

- **STUN reflector:** sees a device's public IP as a request source only (no identity, no camp data).
- **Rungs 1–2:** reflexive addresses travel only among signed, camp-encrypted identities (remembered
  locally / gossiped over authenticated sync). No third party sees them.
- **Rung 3 (only after 1–2 fail):** the configured rendezvous — the owner's Cloudflare Worker by
  default, or a fork's own endpoint, or none — sees peer IP:port for the record TTL (~2h) when
  consulted, the same exposure class the owner accepted for discovery on 2026-09-28. Data never
  touches it.
- Camp devices open **no permanent public listening port and configure no port-forward** — the punch
  uses an **ephemeral NAT mapping**; admission (T331/Noise) still gates every resulting connection.

## Build size

MODERATE — one focused slice plus the QUIC capability signoff:
- Enable **QUIC** + its signoff via the **T327 gate** (first: settle the socket-affinity unknown).
- A **minimal STUN client** bound to the QUIC socket/port.
- **Rung 1:** store/share the public reflexive address (extend `peer_last_addresses`), redial it.
- **Rung 2:** a signed, camp-encrypted reflexive-address field in the camp doc + gossip over sync.
- **Rung 3:** fill + sign the reflexive address into the existing rendezvous record
  (`rendezvousClient.js:157`), demoted to last-resort behind the ordering gate; ship
  `SHORESH_RENDEZVOUS_URL` defaulting to the owner's Worker, camp-overridable/unsettable. The owner's
  **T209 Cloudflare Worker DEPLOY is the FINAL step** (owner spend/infra — prepared here, deployed by
  the owner once rung 3 is built; agents do not deploy or flip it).
- A **reconnect coordinator** enforcing the strict 1→2→3 order + the coordinated simultaneous open
  (custom; libp2p has no cold-punch primitive — dcutr needs a relay).
- Residual documented, not built.

## Verification (implementing slice — test-first, full `npm run verify`, T327 gate for QUIC)

1. **Socket affinity FIRST** (make-or-break): STUN query and QUIC listener share one external mapping;
   if not achievable with the installed QUIC transport, STOP and report before building further.
2. **Ordering invariant, RED-FIRST:** rung 3 is never contacted while rung 1 or 2 can succeed — assert
   zero rung-3 network calls on a reconnect that rung 1 (remembered address live) or rung 2 (a camp
   peer knows the address) satisfies; and that with `SHORESH_RENDEZVOUS_URL` unset, only rungs 1–2 run.
3. Rung 1: a remembered public reflexive address reconnects two cone-NAT peers with no meeting point.
4. Rung 2: with rung 1 stale, a reachable camp peer's signed gossip supplies the address and reconnect
   succeeds, no rung 3.
5. Rung 3: with 1 and 2 failed and a URL set, the camp-owned rendezvous introduces + times the punch;
   data flows device-to-device (nothing camp-level touches the rendezvous).
6. A symmetric-NAT pair fails to punch on all rungs and surfaces a clear "same-network required" state,
   not an opaque hang.
7. Admission still gates every punched connection (a non-camp peer never passes T331/Noise).
