---
ticket: T337
document_type: ticket
title: Coordination layer — camp-peer circuit-relay-v2 (foundation for NAT hole-punch), opens the relay capability
status: open
created: 2026-10-03
archive_when: "circuit-relay-v2 coordination via a reachable camp peer is built test-first, the relay role is proven camp-admitted-only (R declines to broker for a non-admitted/revoked requester), AutoNAT is proven camp-peers-only, both carry-forward proofs + revoke-while-running-at-every-hop pass on real multi-node libp2p, and the capability is signed off through the full capability+battle-test gate"
task_class: security-auth
parent: ""
governing_docs: [docs/work/specs/2026-10-03-t337-coordination-layer-design.md, docs/adr/2026-10-02-wan-discovery-transport-ladder.md, SECURITY.md]
related_prs: []
---

# T337 — Coordination layer (camp-peer circuit-relay-v2), foundation-first

## Context

The owner-decided WAN ladder (ADR 2026-10-02, Amendment + RESEQUENCE 2026-10-03) is: LAN meet
[hard prerequisite] → remembered-address reconnect + NAT hole-punch (dcutr/AutoNAT) [PRIMARY
cross-network] → Cloudflare rendezvous [RARE firewall-only fallback]. The public DHT is rejected and
removed. The Slice-A design (T336) surfaced that dcutr cannot run cold — it upgrades an existing
connection — so a coordination channel is FOUNDATIONAL and must be built first. This ticket is that
foundation. Design: `docs/work/specs/2026-10-03-t337-coordination-layer-design.md`.

## What it does

A device B whose cached address for target C no longer resolves consults its own `peer_last_addresses`
for any OTHER camp peer R it can currently reach, dials R (reusing Slice-1's stale-address-safe dial),
and asks R to broker a brief `circuit-relay-v2` coordination exchange to C; once B and C have each
other's current reflexive addresses, T336 `dcutr` punches direct and that direct path becomes
primary. **Correction (gate-fix round 3, Red Hat MEDIUM): "the relayed hop is torn down" was
wrong** — the underlying reservation is a STANDING, auto-renewed slot for as long as B stays
connected to R (circuit-relay-v2's own refresh behavior, not overridden by this design); only the
per-stream exchange is capped (~128 KiB / 2 min per relayed exchange), and only the TRAFFIC moves
to the direct path once punched — R's reservation for B persists as an idle fallback, not a torn-
down one-shot. No device is designated "the" relay (eligibility = currently reachable, per attempt
— no single point of failure). The camp-admitted-only restriction is structural: R only brokers
for a peer it has itself already passed through Noise + T331 `authorize()`/`isPeerRevoked`.
Opens the Tier-4 `relay` (circuit-relay-v2) capability; lands guard-blocked (`signoff: null`) until
the full gate passes. Runtime ladder unchanged (direct preferred once punched; relay is the
reachability path until then, and an idle fallback after; Cloudflare only when no camp peer is
reachable).

## Acceptance (hard, red-before-green, real multi-node libp2p — NO mocks)

- Candidate-R selection capped per reconnect attempt, ranked by `last_seen_at` (mirrors
  `redialTrustedPeers`' cap) — no reconnect storm.
- MUST-PROVE A: revoke-while-running severance at EVERY hop (B↔R, R↔C, final B↔C direct) AND the
  relay-role camp-only property — plant a revoked/non-admitted device asking R to broker, prove R
  DECLINES (not only that admission later refuses the punched connection).
- Both carry-forward proofs: a revoked device refused at admission via cached-address, hole-punch, AND
  the coordination-relay path; plus the Slice-1 cached-address carry-forward.

**AutoNAT camp-peers-only is carried to the T336 gate, not T337's.** (Gate-fix round 2, FIX 4,
Code Reviewer.) T337's mechanism never wires AutoNAT at all — §A's candidate-R selection and R's
eligibility rest entirely on `peer_last_addresses`/`devices`-rooted dial reachability, never a
reflexive-address probe. `transportCapabilities.js`'s `dcutr` row (not `relay`) owns
`@libp2p/autonat`, and design §C itself scopes the AutoNAT-camp-peers-only red-before-green test to
"before THAT capability's signoff is written." T337's acceptance above is scoped to what this
ticket actually opens (`relay`/circuit-relay-v2); the 3-node (A / camp B / reachable-non-camp X)
AutoNAT test belongs in T336's own acceptance, where AutoNAT is actually wired.
- Full capability + battle-test gate (security-assessment + Security + Red Hat + Grader); signoff on a
  clean pass per the owner's T327 delegation.
