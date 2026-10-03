---
title: "Cross-network discovery options menu (public DHT rejected by owner)"
document_type: spec
authority: proposed
status: superseded
task_class: security-auth
created: 2026-10-03
governing_docs: [docs/adr/2026-10-02-wan-discovery-transport-ladder.md, docs/work/security/2026-10-03-t334-dht-capability-assessment.md, docs/adr/2026-07-28-explicit-userdata-directory.md, SECURITY.md]
archive_when: superseded — see status
---

# Cross-network discovery — options menu (design only, builds nothing)

> **RESOLUTION/CORRECTION (2026-10-03, owner directive via organizer).** This document is
> **superseded** by the "Amendment 2026-10-03" and "Design-of-record, stated plainly" sections of
> `docs/adr/2026-10-02-wan-discovery-transport-ladder.md` — that ADR is the current authority, not
> this spec. Two framings below are **corrected, not merely superseded**, and must not be read as
> live design questions:
> 1. **The public DHT (Option 1, and the public-network shape named throughout) is rejected and
>    removed as a discovery pathway** — not deprioritized, not a future option. One-line why: it
>    exposes device online-status/network address to an unbounded public population.
> 2. **The "two peers that have never shared a LAN" framing this document uses below — including the
>    "honest unsolvable residual" / "what no option can fully satisfy" language — is a mis-framing the
>    owner rejected.** LAN-meet-first is a **hard prerequisite**, not a case this architecture tries to
>    solve. A pair of devices with no shared LAN history is **out of scope by first principle**, never
>    a residual, gap, or open problem. Read every "never met since" / "both stale" passage below as the
>    analysis that *led to* Option 4 being recommended, not as a currently-accepted characterization of
>    an unsolved case.

**RESOLVED (2026-10-03).** The owner resolved this menu's open questions to Option 4's shape —
remembered-address + hole-punch as the default path, single-operator rendezvous (the existing
Cloudflare path) as the rare fallback — in his own words, not merely by picking a numbered option:
*"devices have to first meet on the same lan... after that they should be able to go anywhere... the
cloudflare relay is a back up for a rare case where a weird firewall throws a barrier we can't work
around."* The binding record of this resolution is the "Amendment 2026-10-03" section of
`docs/adr/2026-10-02-wan-discovery-transport-ladder.md`. This document's analysis below is unchanged
and remains useful context for why Option 4 was recommended and why Options 1 and 3-as-default were
not, but it is no longer the open question — the decision is made.

**This document opens no capability, writes no code, and recommends but does not decide.** It exists
because the owner rejected the public-DHT cross-network path verbatim ("no. i do not accept this.")
after `docs/work/security/2026-10-03-t334-dht-capability-assessment.md` confirmed the public DHT is a
materially worse exposure than the already-accepted Cloudflare rendezvous on three axes: unbounded
observer population, internet-wide reachability of the pre-auth surface, and eclipse/Sybil exposure of
lookups. `docs/adr/2026-10-02-wan-discovery-transport-ladder.md`'s tier-2 ("DHT + hole-punch, PRIMARY
WAN") is therefore reopened. Nothing below re-proposes that rejected shape as the default.

## The constraint, stated honestly

Two devices met and mutually authenticated once (LAN pairing, or a trusted remembered address) and
must later find and reach each other again across **different** networks — home wifi with hidden,
changing public addresses, no port forwarding, ordinary consumer NAT.

The owner's two hard requirements:
- (a) **no exposure of device online-status or network address to the public network** — not to an
  unbounded population of strangers.
- (b) **no central Cloudflare dependency as the primary path** — he will not stand that up as the
  normal case, only accepts it as a last resort (already shipped, already accepted).

The physical constraint this cannot wish away: **a NAT'd peer with no stable address cannot be found
by another NAT'd peer with no stable address unless something, somewhere, holds a rendezvous point
both sides can reach.** That something is either (i) a shared address one side already remembers from
a prior LAN encounter, (ii) a third party both sides trust to relay a "here's where I am now" message,
or (iii) a large swarm of untrusted third parties doing the same job anonymously (a public DHT) — which
is exactly what the owner just rejected. There is no fourth shape. Any option that claims to solve the
"both addresses are stale, never met since" case without naming which of (i)/(ii)/(iii) it relies on is
not being honest about where the coordination happens.

## Reused building blocks (do not re-derive)

- **Slice 1 remembered-address reconnect** — `electron/sync/automerge/peerAddressBook.js`
  (`rememberPeerAddress`, `redialTrustedPeers`), backed by the device-local `peer_last_addresses`
  table (schema v88/v89). Stores up to 5 multiaddrs per peer, written only from an already-
  authenticated connection (`syncNode.js`'s `onPeerAdmitted`). Every remembered multiaddr carries an
  explicit `/p2p/<peerId>` component, so Noise's mutual-auth handshake still gates trust — remembering
  an address grants no trust by itself.
- **T335 rotating discovery tag** — `electron/sync/automerge/rotatingDiscoveryTag.js`
  (`rotatingDiscoveryDigest` = `HMAC(campDhtSecret, revocationDigest)`), `authorityRevocationDigest.js`,
  `discovery.js`'s `rotatingServiceTag`, `syncStarter.js`'s `computeRotatingServiceTag`. A pure,
  signed, un-impersonable per-camp tag that changes automatically when the signed revoked-device set
  changes. Built for DHT keying but is transport-agnostic — any rendezvous mechanism that needs an
  opaque, rotating lookup key can reuse it unchanged.
- **T331 distributed-authority admission** — `authorityReplay.js`, the handshake/`handleSyncMessage`/
  projector gates. The actual cutoff mechanism for a revoked-but-still-connected device; no discovery
  option below changes or substitutes for this.
- **Existing Cloudflare rendezvous** — `rendezvousClient.js`, already signed off (2026-09-17/18) as
  last-resort discovery. Single operator, opaque namespace, already accepted at that scope.

## Option menu

### Option 1 — Private/closed libp2p DHT over a camp-specific swarm key

**(a) Exposure.** Nodes join a Kademlia ring restricted to peers holding the camp's private swarm key
(libp2p's `PreSharedKeyConnectionProtector` or an equivalent closed-swarm gate). Only devices that
already hold that camp's secret can join the ring at all, so routing-table membership, online-status,
and multiaddrs are visible only to the camp's own devices post-key-check — not the public internet.
This satisfies (a) for the *steady-state* ring.

**(b) Capability coverage — confronting the bootstrap problem head-on.** A closed DHT still needs a
first node to dial into. A camp device that has never seen another camp device since its address
changed has no ring member to contact — the swarm key proves it's allowed to join, it does not tell it
*where* to dial. This is the same unsolved rendezvous problem, one layer down: something has to hand
the joining device at least one current address of an existing ring member. Candidates for that
something are exactly (i)/(ii)/(iii) above — i.e., this option does not remove the bootstrap problem,
it relocates it to "how do you learn one current camp-ring member's address," which still needs either
a remembered address (back to Slice 1) or a third-party meeting point (back to Cloudflare or a
Shoresh-run node). **It solves nothing Slice 1 doesn't already solve, and for the fully-cold case it
quietly reintroduces the third party it was proposed to avoid.** It adds real new exposure risk too:
operating any DHT code path (even closed) reopens several of the T334 assessment's findings — F-1's
wiring gaps (`dhtServices` never threaded through `startSyncNode`→`startTransport`, missing `ping`
service dependency) would need to be fixed regardless of public vs. private, and Open Questions A/B
(eclipse/Sybil near a key, provider-record replay vs TTL) still apply *within* a closed ring if any
single compromised or revoked-but-undetected device's key leaks — a camp ring is smaller, so Sybil
cost is lower, not higher, relative to the public DHT.

**(c) Spend/infra.** Zero infra for the ring itself. But solving the cold-bootstrap case for a closed
swarm requires either a Shoresh-run seed node (spend, see Option 3) or reuse of Cloudflare as the
address-of-one-ring-member channel (exactly what the owner wants minimized, not eliminated by this
option).

**(d) Reuse/new.** Reuses the rotating tag as the swarm's lookup key. New: `@libp2p/kad-dht` +
`@libp2p/bootstrap` wiring (unblocking the same F-1 gaps the public-DHT assessment found), a
pre-shared-key connection gate libp2p does not ship as a drop-in for the installed version (needs
`org-source-verification` against the actual `kad-dht`/`libp2p` package versions in
`package-lock.json` before any implementation estimate), and a new "how do I bootstrap into my own
closed ring" problem that resolves to one of the other options anyway.

**Verdict: a trap.** It reads like a privacy-preserving middle ground but either degenerates to Slice 1
(when a ring member's address is remembered) or secretly re-adds a third-party meeting point (when it
isn't) — while adding DHT-specific implementation and audit surface for no capability gain over
Option 2 + Option 3 combined.

### Option 2 — Remembered-address reconnect + NAT hole-punch (dcutr/AutoNAT), no DHT at all

**(a) Exposure.** Zero public exposure. No ring, no third-party lookup, no broadcast. The only parties
who ever see an address are (i) the peer itself, observed directly over an already-authenticated
connection, and (ii) the local SQLite row on the observing device, which is device-local and never
synced (confirmed at `peerAddressBook.js`'s header comment and the `purgeCollateral.js` exclusion
class). This is the strongest exposure profile of every option — it fully satisfies (a) with no
caveats.

**(b) Capability coverage.** Covers exactly the case the comment at `peerAddressBook.js:1-10` already
scopes Slice 1 to: a peer reconnecting at a **remembered** address, or reachable via hole-punch when
at least one side is dialable or both sides support `dcutr`-coordinated punching through their current
(possibly new) NAT mapping. It does **not** cover, and cannot be made to cover without adding a
coordination point: two peers whose remembered addresses are **both stale** (neither has reconnected
on any network since both addresses changed) and who have no live rendezvous channel to exchange a
fresh address. State this plainly rather than softening it — this is the residual the constraint
section names. In practice this gap is narrower than it sounds: addresses go stale on home ISPs on the
order of days-to-weeks (DHCP lease renewal, modem reset), not every session, and the memory book keeps
5 addresses per peer, so the "both stale simultaneously" case requires both devices' ISPs to have
re-assigned addresses with no successful reconnect by either side in between.

**(c) Spend/infra.** Zero. No new infrastructure, no service to operate, no owner spend decision
required. `dcutr`/`@libp2p/autonat` are already named in the ADR's Slice 4 and already carry
`signoff: null` in `transportCapabilities.js:40-45` (blocked, not built) — picking this option still
requires the same security+battle-test gate the ADR already describes for hole-punch, just without the
DHT discovery half.

**(d) Reuse.** Reuses Slice 1 entirely as-is. New work: wire `@libp2p/dcutr` + `@libp2p/autonat` (ADR
Slice 4), with the explicit-close-on-punch-failure behavior and its test already specified there. No
new discovery primitive, no new stored shape — `peer_last_addresses` already exists.

**Verdict: the safe floor.** Fully satisfies the owner's exposure requirement, costs nothing, reuses
everything already built, and visibly narrows (does not claim to eliminate) the discovery gap. The
honest limitation is the residual case in (b).

### Option 3 — Minimal Shoresh-run rendezvous/bootstrap node (meeting-only, not a traffic relay)

**(a) Exposure.** A single operator (Shoresh, not Cloudflare) sees: which opaque rotating tags are
currently "online" and a reachable address for each — the same shape of record the already-accepted
Cloudflare rendezvous holds today, just hosted by Shoresh instead of Cloudflare. This is **not**
materially different from the Cloudflare exposure profile on the owner's stated axis (public network
exposure) — it is one trusted operator either way, not the public. The only difference from Cloudflare
is *who* operates it, which matters for control and cost, not for the metadata-exposure tradeoff the
owner rejected the public DHT over.

**(b) Capability coverage.** Fully solves the cold case Option 2 cannot: two peers with no live
coordination channel can still both reach a fixed, known rendezvous address and exchange current
addresses through it, then connect directly (optionally hole-punched via the same node acting as
`circuit-relay-v2` coordination-only, as the ADR's tier-3 already describes for Cloudflare). This is
the only option (besides a public DHT, which is rejected) that closes the "both stale, never met since"
gap completely.

**(c) Spend/infra — flag clearly.** This requires Shoresh to stand up, pay for, and operate a node
with a stable public address. That is an owner spend/infra decision this document does not make and
should not design toward speculatively — it is named here only because it is the genuinely-available
option that actually closes the residual gap, and the choice of operator (Shoresh vs. Cloudflare)
is a legitimate point of difference even though the metadata-exposure math is similar.

**(d) Reuse.** Reuses the rotating discovery tag exactly as T335 built it (transport-agnostic key),
and the existing `rendezvousClient.js` KV-style get/put/list protocol shape almost unchanged — the
"Cloudflare Worker + KV" pattern already documented at `internetRendezvousScan.js:13` could run
against Shoresh-operated infrastructure with the same client code, swapping only the endpoint. New
work: standing up and operating that endpoint (ops, not code) and the resulting support burden over
time (uptime, abuse handling) — the actual cost of this option is operational, not implementation.

**Verdict: closes the gap Option 2 leaves, at the cost of an owner-approved spend decision and ongoing
operational burden — essentially "do what Cloudflare already does, but we run it." Worth having as the
explicit fallback rung, not the default.**

### Option 4 — Hybrid ladder: Option 2 as the fast/default path, Option 3 engaged only on failure

**(a) Exposure.** Matches whichever rung actually fires. The common case (either side has a recent
remembered address, or both are hole-punchable) never touches any third party — zero public exposure,
same as Option 2 alone. Only the residual cold case escalates to a single trusted operator (Option 3),
and only for that pair's lookup, not a standing broadcast.

**(b) Capability coverage.** Full coverage: Option 2's fast path for the common case, Option 3's
fallback for the cold case Option 2 cannot solve. This is the only menu item that both satisfies the
owner's exposure requirement for the normal path *and* has no unsolved residual — the residual is
pushed to a rung that is explicitly gated as last-resort, not silently always-on.

**(c) Spend/infra.** Same as Option 3: the fallback rung requires the same owner-approved spend
decision, but it is exercised rarely (only on the cold-reconnect case), which is a materially smaller
operational and cost footprint than a rendezvous node used as the default path.

**(d) Reuse.** This is structurally identical to the ladder the ADR already describes
(`docs/adr/2026-10-02-wan-discovery-transport-ladder.md`'s tier structure) with tier 2 ("DHT +
hole-punch") replaced by "remembered-address + hole-punch, no DHT" and the existing tier-3 Cloudflare
rung kept as-is (or optionally pointed at a Shoresh-run node instead of Cloudflare, per Option 3's (c)
tradeoff — a separate, smaller decision). No new primitive beyond what Options 2 and 3 already name.

**Verdict: the recommended shape.** It is the ladder the ADR already committed to, minus the one rung
the owner rejected.

## Comparison table

| Option | Public exposure | Closes cold-reconnect gap | Spend/infra | New build surface |
|---|---|---|---|---|
| 1. Private DHT | None in steady state; bootstrap problem re-adds a third party | No (relocates the problem) | Zero for ring; spend if cold-bootstrap uses Option 3 | DHT wiring (reopens F-1 gaps) + swarm-key gate (unverified for installed version) |
| 2. Remembered address + hole-punch | None | No (honest residual) | Zero | `dcutr`/`autonat` wiring only (already scoped in ADR Slice 4) |
| 3. Shoresh-run rendezvous | Single trusted operator (Shoresh, not public) | Yes | **Owner spend/infra decision required** | Reuses Cloudflare-shaped client; new: operate the endpoint |
| 4. Hybrid (2 fast path, 3 fallback) | None on the common path; single-operator only on cold fallback | Yes | Same as 3, exercised rarely | Options 2 + 3 combined, no new primitive |

## What no option can fully satisfy

No zero-infrastructure, zero-public-exposure option exists for two peers that have never shared a LAN
or a successful reconnect since both of their addresses went stale. That case requires a coordination
point outside both peers — stated as a physical fact, not a gap in this design. The only way to avoid
naming a trusted third party for that exact case is to accept it as permanently unsolved (a real,
honest choice: tell the director "reconnect once more while still reachable the old way, e.g. back on
the original LAN, or via support") rather than quietly reaching for the public DHT to paper over it.
Option 4 is the menu's answer to "solve it anyway": push the residual onto a rung that is rare,
owner-controlled, and no worse than the Cloudflare exposure already accepted — not onto an unbounded
public swarm.

## Recommendation

**Option 4 (hybrid: Option 2 as default, Option 3 — reusing the existing Cloudflare-shaped rendezvous
client, Shoresh-operated or left on Cloudflare — as last-resort fallback), confidence: high.**

Evidence behind this:
- It is a strict improvement on the ADR's own existing shape: same tier structure, same reuse of
  Slice 1 and T335, only the rejected tier-2 DHT rung removed and not replaced with anything new to
  audit.
- It fully satisfies the owner's two stated requirements for the path that fires in the common case
  (zero public exposure, no standing Cloudflare dependency), and is honest rather than silent about
  the one case it cannot solve without a trusted meeting point.
- It defers the one genuinely open decision — who operates the fallback rendezvous node, Shoresh or
  Cloudflare — to its own smaller, separable owner call, rather than bundling it with the public-DHT
  question that has already been answered.
- Option 1 is excluded from the recommendation: it was assessed as a trap (relocates rather than
  solves the bootstrap problem, adds real DHT-adjacent audit surface for no net capability gain).

## Open questions for the owner (via organizer)

1. Accept Option 4's shape (remembered-address + hole-punch as default, single-operator rendezvous as
   rare fallback) in place of the rejected DHT-primary tier 2?
2. If yes: for the fallback rung, keep the existing signed-off Cloudflare rendezvous, or authorize
   standing up a Shoresh-run equivalent (a spend/infra decision this document does not make)?
3. Is the honest residual — two peers both stale with no coordination point, if the fallback rung is
   ever disabled or unreachable — acceptable as a permanently-unsolved edge case, documented rather
   than engineered around?

This document builds nothing and opens no capability gate. Nothing proceeds until the owner picks.
