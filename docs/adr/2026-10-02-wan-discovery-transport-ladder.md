---
title: "WAN discovery/transport ladder: DHT + hole-punch as the primary cross-network path, Cloudflare demoted to last resort"
document_type: adr
authority: normative
status: accepted
date: 2026-10-02
decided: 2026-10-02
deciders: [product-owner]
program: security-hardening
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, SECURITY.md]
supersedes: []
amends:
  - docs/adr/2026-09-17-wan-rendezvous-seam.md
  - docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md
  - docs/adr/2026-09-27-wan-connectivity-hardening-ladder.md
related_adrs:
  - docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md
  - docs/adr/2026-09-14-internet-transport-security-gate.md
  - docs/adr/2026-09-15-ephemeral-join-secret-for-wan-discovery.md
  - docs/adr/2026-09-19-per-camp-genesis-identity.md
  - docs/adr/2026-09-26-schema-version-gate-before-merge.md
related_docs:
  - docs/work/security/2026-09-15-wan-dht-boundary-assessment.md
  - docs/work/security/2026-09-26-internet-transport-signoff-reassessment.md
  - docs/work/security/2026-10-03-t334-dht-capability-assessment.md
  - docs/work/specs/2026-10-03-cross-network-discovery-options-menu.md
  - docs/work/specs/2026-10-03-t334-slice3-dht-discovery-design.md
  - docs/work/specs/2026-10-03-t336-slice-a-holepunch-design.md
  - docs/work/specs/2026-10-03-t337-coordination-layer-design.md
implementation_state: in-progress
amended: 2026-10-03
---

# WAN discovery/transport ladder — DHT-first, Cloudflare last

> **Amended 2026-10-09** by `docs/adr/2026-10-09-router-port-mapping-on-rung-1.md` (owner reversal: no STUN of any kind). Rung 1 now first dials the peer's router-mapped libp2p TCP address (the device's own router is asked via UPnP-IGD / NAT-PMP to map its pinned libp2p TCP listener; mechanism revised from a UDP punch port the same day), not a STUN-learned candidate. Text below that says STUN is superseded; the 'no permanent public listening port, no port-forward' exposure line is amended by the accepted mapping.

**Ticket:** T327. **Status: accepted (owner, 2026-10-02).**

## Acceptance (owner, 2026-10-02)

The owner accepted this ADR, delegated, in these words (verbatim, relayed): *"go. ahead and approve
it for me. i don't want to be asked. run it through security. battle test it. if it passes, then they
can continue on. but realy push them to test it."* This is explicit current human instruction
(Constitution Article I, precedence 1), which is why a security-posture ADR is accepted here despite
Article IV's default that such changes are the owner's undelegated reserve — this is not the organizer
self-accepting under the delegation carve-out, it is the owner's own ruling on this specific ADR.

**The five open questions are resolved at their recommended defaults:**
1. **Three-tier ladder accepted** (DHT-first, Cloudflare last), amending the 2026-09-17/2026-09-27
   ordering.
2. **Rotation fires AUTOMATICALLY on device removal** (director-initiated "rotate now" remains an
   additional manual control, not the only trigger).
3. **Public libp2p DHT/bootstrap network is the default** (configurable per camp; clean LAN-only
   degradation when unreachable).
4. **The four per-capability owner sign-offs (`kadDht`, `bootstrap`, `dcutr`, `relay`) are REPLACED
   by a hard security + battle-test gate per capability** (owner: "run it through security. battle
   test it. if it passes, then they can continue on."). Each capability unblocks — its `signoff`
   entry is added to `transportCapabilities.js` — only after it PASSES: (a) a deep review by the
   **security-assessment** agent AND **Security** AND **Red Hat**, and (b) real adversarial
   battle-testing (forged-peer writes, join-secret brute-force against the public DHT, DHT
   poisoning/eclipse, replay, hole-punch failure modes, and a red-before-green proof that
   rotation-on-revocation actually cuts a removed device off). A Security or Grader FAIL that cannot
   be closed STOPS the loop and returns to the owner via the organizer — it is never pushed past. The
   `signoff` entry's `doc` field points at that capability's recorded security + battle-test evidence,
   not at a bare owner date.
5. **The tier-3 data relay stays an optional last resort: the code is built, but STANDING IT UP
   (deploying/paying for a relay or Cloudflare) remains an owner action** — a spend/infra decision the
   security+battle-test gate does NOT authorize. Same for any Cloudflare deploy.

This ADR opens `kadDht`, `dcutr`, `circuit-relay-v2`, and `bootstrap` (all currently `signoff: null`
in `electron/sync/automerge/transportCapabilities.js`) to be built against the gate above. No capability
is unblocked by the ADR itself; each is unblocked only by passing its gate.

## Owner intent (the goal this ADR commits to)

Recorded verbatim, owner 2026-10-02 (he notes he has said it "several times" and it keeps getting
lost on our side): **cross-network sync must NOT depend on Cloudflare.** The intended behaviour,
after the initial LAN handshake establishes mutual trust:

1. **LAN (mDNS)** — devices meet on the same network first and establish mutual trust / know each
   other. *Already shipped.*
2. **DHT + NAT hole-punch + "key turning"** — once trusted, devices on different networks find and
   reach each other **directly**, using that established identity, with **no central Cloudflare
   noticeboard**. The ephemeral join secret and the key/namespace rotation that are **already built**
   exist precisely to make this discovery brute-force-safe and to cut a removed device off when the
   keys turn. **This is the PRIMARY WAN path.**
3. **Cloudflare noticeboard + relay** — "for truly odd circumstances only" (owner 2026-10-02). The
   **last resort / bottom rung**, not the primary path.

Owner: *"this can be done. i know it can."* He is right, and we have already proven it — see below.

## The problem this ADR exists to correct

**The shipped cross-network path is upside down relative to the owner's intent.** Verified this
session against the code:

- **Cloudflare rendezvous is the ONLY wired WAN discovery path.** `rendezvousClient.js`
  (`createRendezvousDiscovery`, `electron/sync/automerge/rendezvousClient.js:209`) is wired into the
  node in `electron/sync/automerge/syncStarter.js:296–308`, gated on `SHORESH_RENDEZVOUS_URL` /
  `rendezvousConfig.enabled` (`syncStarter.js:294`). It is the one and only non-mDNS discovery
  mechanism, and `discovery` is the one and only capability signed off
  (`transportCapabilities.js:24–33`, owner sign-off 2026-09-28).
- **The primary direct-reconnect path does not exist in any form.** The `devices` table stores peer
  *identity* (`libp2p_peer_id TEXT`, `electron/db/schema.sql:111`) but **no network address** — no
  multiaddr, ip, or host:port column exists (`schema.sql:67–112`). There is no persisted-peer redial
  in the steady-state node: the only direct-dial-to-cached-address anywhere is the join flow's
  one-shot `knownHostAddr` (`joinSession.js:148,220`), scoped to a single Add-a-device attempt, never
  to steady-state reconnect (confirmed, ADR 2026-09-19 lines 229–237). `syncStarter.js` dials only
  from live mDNS/rendezvous discovery events.
- **DHT, hole-punch, and relay are all blocked and uninstalled.** In
  `transportCapabilities.js`: `kadDht` (`:70–75`), `relay` / `@libp2p/circuit-relay-v2` (`:34–39`),
  `dcutr` / `@libp2p/autonat` (`:40–45`), and `bootstrap` (`:76–81`) all have `signoff: null`. None of
  `@libp2p/kad-dht`, `@libp2p/dcutr`, `@libp2p/circuit-relay-v2`, `@libp2p/autonat`, or
  `@libp2p/bootstrap` is in `package-lock.json`. Installed transport is TCP + Noise + Yamux; installed
  discovery is mDNS only.

**The decentralized DHT path was already PROVEN cross-network, then dropped with no written
rationale.** The 2026-09-06 prototype (`cr4-dht-node.mjs`) connected two machines on different
Wi-Fis — one on a cellular hotspot/CGNAT — where **the public DHT found the peer across networks**,
direct dial failed (CGNAT is un-punchable, as predicted), and the two nodes synced **via a public
circuit relay, Noise-encrypted end-to-end over that relay** (ADR
`docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md:88–91`;
`experiments/future-arch/ENGINE_SELECTION.md:103–115`). The one case not proven there is a *direct*
home↔home hole-punch (dcutr) between two punchable peers — honestly flagged as the single un-closed
item (ADR 2026-09-06 lines 92–95). *(The prototype file `cr4-dht-node.mjs` is not in this working
tree; it lived on the prototype branch and is cited from the productionization ADR and
`ENGINE_SELECTION.md`, which are the authority for that result.)*

**Why it was dropped — the documentation gap, stated honestly.** This was **not** engineers ignoring
a ruling. The reconciliation (Build Board item `h-wan-relay-phase-plan`, cited read 2026-10-02) shows
the owner *supplied* the Cloudflare rendezvous spec on 2026-09-17 (after a 2026-09-15 "no server of
any kind"), retired the single-point-of-failure objection, and signed off Cloudflare discovery on
2026-09-28. Against the *recorded* decisions, the build is consistent. The failure was ours in a
narrower way: when the Cloudflare spec arrived, the proven DHT path was set aside **without an ADR
recording why**, so it silently became "not the plan" instead of "the primary path we build after the
rendezvous seam." Nothing wrote down that the owner's enduring intent was DHT-primary with Cloudflare
as a fallback. This ADR is that missing record, so the decision stops getting lost.

## What this ADR amends (it contradicts nothing silently)

All four prior ADRs stand except where explicitly amended here. The amendment is to **ordering and
primacy**, not to the security analysis in any of them — their mechanisms are reused, re-ranked.

- **2026-09-17 (WAN rendezvous seam)** and **2026-09-27 (connectivity hardening ladder).** Their
  four-rung ladder places **Cloudflare rendezvous + direct dial as rung 2 (the primary WAN
  discovery), with no DHT rung at all** (2026-09-27 Section 1 table). **This ADR amends that
  ordering:** DHT discovery becomes the primary WAN rung and Cloudflare rendezvous is demoted to the
  last-resort discovery fallback. The relay analysis, the ciphertext-only relay security finding
  (2026-09-27 Section 2, CONFIRMED), the v2-encrypted-record work (Section 3), and the join-secret
  attack plan (Section 4) are **unchanged and carried forward** — only their sequence changes.
- **2026-09-18 (record encoding + namespace rotation).** Its "deliberately not decided: whether
  rotation fires automatically on every device revocation or is director-initiated" (lines 195–197)
  is **the open question this ADR settles** (recommendation below; owner confirms on acceptance).
- The per-capability Tier-4 registry introduced by T288 (`transportCapabilities.js`, replacing the
  old single `INTERNET_TRANSPORT_SIGNOFF` boolean — the boolean no longer exists; the guard now reads
  the registry, `transportBoundary.guard.test.js:11–24`) is **the enforcement mechanism this ADR
  builds within**, unchanged. This ADR adds no new gate; it enumerates which existing registry rows
  the build will ask the owner to sign off.

## Decision — the three-tier ladder

After the LAN handshake has established mutual trust, cross-network discovery is attempted in this
order. A tier is attempted only if the previous one did not already yield a working connection; the
ladder never races tiers against each other (the discipline carried from 2026-09-17 — a slower tier
must not preempt a faster one that already succeeded).

| Tier | Purpose | Mechanism | Capability rows | Status |
|---|---|---|---|---|
| **1. LAN** | find on same network | mDNS multicast (`@libp2p/mdns`) | none (pre-Tier-4 baseline) | **shipped** |
| **2. DHT + hole-punch** (PRIMARY WAN) | find + reach directly across networks | Kademlia DHT discovery (`@libp2p/kad-dht`) keyed on the rotating, scrypt-derived discovery tag; NAT hole-punch via `@libp2p/dcutr` coordinated by `@libp2p/circuit-relay-v2`; secured by the already-built ephemeral join secret + namespace/key rotation | `kadDht`, `dcutr`, `bootstrap`, plus `relay` (coordination-only) | **blocked** — to build |
| **3. Cloudflare noticeboard + data relay** (LAST RESORT) | find + carry traffic when tier 2 can't | existing Cloudflare rendezvous (`rendezvousClient.js`, already signed off) as a discovery fallback; `@libp2p/circuit-relay-v2` as a capped, time-boxed **data** path for CGNAT-both-ends pairs | `discovery` (signed off), `relay` (data-path use) | discovery **wired**; relay-as-data-path **blocked** — to build, owner-gated |

Tier 2 is the owner's primary WAN path. Tier 3 engages only when tier 2 cannot: Cloudflare discovery
when the DHT cannot locate the peer (e.g. a device that cannot reach the bootstrap network at all), and
the data relay when the peer is found but **both** ends are behind symmetric/CGNAT NAT — the one
topology class that is un-punchable by any transport and therefore has no fix without a forwarding
relay (a networking invariant, 2026-09-15 assessment lines 60–67; 2026-09-27 Section 1 rung 4).

## Tier 2 settled concretely — the primary WAN path

### Discovery: revive the proven kad-dht path

Devices `provide`/`findProviders` on a Kademlia DHT (`@libp2p/kad-dht`) under the camp's **rotating
discovery tag** — not under a static campId. The tag is the scrypt-derived, window-scoped value the
ephemeral join-secret design already specifies (ADR 2026-09-15) combined with the namespace/epoch
rotation already specified (ADR 2026-09-18). A peer that finds a provider record obtains the
provider's current multiaddrs and dials them; from `mutualAuth.js` downward a DHT-discovered peer is
byte-for-byte identical to an mDNS- or rendezvous-discovered one (same `{id, multiaddrs}` shape),
so **admission, authentication, and authorization do not move** — discovery widens, the trust gate
does not. This is the same boundary property the 2026-09-26 reassessment established for rendezvous.

### Reaching directly: NAT hole-punch

Finding the address is not the same as reaching it — home-Wi-Fi devices have no fixed public address
and it changes. For the common punchable-NAT case, `@libp2p/dcutr` performs the hole-punch, using
`@libp2p/circuit-relay-v2` **only** for the brief CONNECT/SYNC coordination exchange (the
coordination-only use accepted in 2026-09-17 Decision 3b, capped at ~128 KiB / ~2 min). On hole-punch
failure, Shoresh closes the relayed coordination connection itself and does **not** silently fall
through to using it as a data path — that fall-through is tier 3, separately gated. The honest
residual, carried unchanged from 2026-09-06: a direct home↔home punch has not yet been proven on real
hardware (only the relay-assisted CGNAT path has). Proving it is part of tier 2's acceptance, not an
assumption this ADR launders into "done."

### How the already-built keys make a public DHT safe

The 2026-09-15 security assessment named the exact hazard (assessment lines 40–49): the shipped join
code is `base32(sha256(campId)[:5])` — 40-bit, deterministic, permanent (`joinCode.js`). On a public
DHT that code becomes an **internet-wide discovery key**: anyone who learns it gets the Host's
peerId + IPs and permanent reach to the pre-auth surface. **This is precisely what the ephemeral join
secret (ADR 2026-09-15) and namespace/key rotation (ADR 2026-09-18) were built to close:**

- The discovery tag is derived from a **random, Host-minted, higher-entropy (≥50-bit) ephemeral
  secret** via a cost-parameterised scrypt KDF, not from `campId`. Brute-forcing it offline is
  infeasible inside its live window (2026-09-27 Section 4, corrected margin: ~3.5 million CPU-years at
  a 100 ms KDF, to be re-benchmarked against the real scrypt parameters as part of the slice's
  done-definition, not assumed).
- The DHT `provide` is **scoped to the director's open Add-a-device window** for *joining*; a trusted
  steady-state peer re-derives the *current* rotated tag from document state it already holds, so it
  can keep finding its camp-mates without ever republishing a long-lived public key.
- **"Key turning" cuts off a removed device.** When keys turn (see rotation trigger below), the
  namespace/epoch advances; a revoked device never learns the new tag (it stops receiving document
  state), so it can no longer find or be found by the camp on the DHT. The merge-layer epoch check is
  required as defense-in-depth alongside the discovery rotation, not instead of it (ADR 2026-09-19
  lines 243–246) — a peer holding a cached multiaddr could still dial, so authorization must not rest
  on discovery rotation alone.

This is the honest answer to the 2026-09-15 open question *"'no server of any kind' needs a
definition: does the public DHT/bootstrap network count?"* (assessment line 67). It does count as
*coordination infrastructure we do not run*, and that is acceptable **because** the rotating secret
means the public DHT only ever holds opaque, short-lived, un-impersonable provider records — knowing
a tag lets an attacker publish noise under it, never impersonate a trusted peer (the self-certifying
signature property, ADR 2026-09-18). It is categorically different from Cloudflare being a
*central noticeboard we operate and depend on*.

### Where the bootstrap nodes come from — the honest coordination reality

A Kademlia DHT needs bootstrap nodes to join the ring, and NAT hole-punch needs a relay to coordinate.
This is the "some coordination" the owner acknowledges is unavoidable for devices behind changing home
addresses. Three honest options, to be settled in the tier-2 build slice (flagged as an open design
item, not silently chosen):

1. **The public IPFS/libp2p bootstrap + relay network** (what the 2026-09-06 prototype used). Zero
   infrastructure for us to run; the tradeoff is dependence on third-party public nodes' availability
   and a metadata exposure (our provider records live in a public DHT). This is coordination we don't
   operate — consistent with the owner's "not Cloudflare" intent, since it is decentralized and
   not a single point we control or that controls us.
2. **A small set of Shoresh-run bootstrap/relay nodes**, pinned and authenticated. More reliable,
   but reintroduces infrastructure we operate — to be weighed against option 1, not assumed.
3. **Hybrid** — ship public bootstrap defaults, allow a camp to configure its own, degrade cleanly to
   LAN-only when neither is reachable (the configurability pattern from 2026-09-17 Decision 4).

Recommendation: **option 1 (public network) as the default, option-3 configurability for camps that
want independence**, confidence medium — it matches the proven prototype and the owner's
"not a central noticeboard we run" intent, and the metadata exposure is the same class already accepted
for coordination in 2026-09-27 Section 2. This is a design recommendation inside the tier-2 slice, to
be confirmed with Security before the DHT is wired, not an acceptance item for this ADR.

## Rotation / "key turning" trigger — the open question, settled

ADR 2026-09-18 left open whether namespace/key rotation fires **automatically on every device
revocation** or is **director-initiated**. 

**Recommendation: automatic-on-revocation. Confidence: high.** Rationale:

- **It is the behaviour the owner's model already assumes.** The owner describes "key turning" as the
  thing that "cuts off a removed device." A director who must remember to *also* press a separate
  "rotate keys" button after revoking a device will, eventually, forget — and the window between
  revoke and manual-rotate is exactly when the removed device is still discoverable. Coupling rotation
  to revocation closes that window by construction.
- **It respects Article V — the engine never leaves a safety action half-done silently.** A revocation
  that does not turn the keys is a revocation that looks complete but isn't; that is the hidden-problem
  anti-pattern the constitution forbids.
- **The cost is bounded and already understood.** Rotation changes namespace + epoch together and
  leaves `seq` alone (ADR 2026-09-18 line 234); trusted devices re-derive the new tag from synced
  document state with no user action. The residual (a device connected only through an
  not-yet-revoking third device, ADR 2026-09-18 lines 173–183) is a pre-existing propagation
  limitation this trigger does not worsen.

Director-initiated rotation remains available as an *additional* manual control (e.g. "rotate now" for
a suspected leak), but it is not the *only* trigger. **The owner confirms this on acceptance** — it is
a product/security decision, recorded here as a recommendation, not self-decided.

## Tier 3 — the two last-resort pieces, placed precisely

- **Cloudflare noticeboard = discovery fallback.** The existing, already-signed-off
  `rendezvousClient.js` path (`transportCapabilities.js` `discovery`) is **retained, re-ranked to last
  resort**. It engages only when tier-2 DHT discovery does not locate the peer. No code is removed; its
  default posture changes from "the WAN discovery path" to "the fallback when the DHT can't find the
  peer." It stays self-hostable / disable-able / configurable (2026-09-17 Decision 4).
- **libp2p circuit relay = data-path fallback (bottom rung).** `@libp2p/circuit-relay-v2` used as a
  **sustained, capped, time-boxed** forwarding path — the reopened 2026-09-27 Section 2 Option B — for
  the one case nothing else reaches: **both** peers behind symmetric/CGNAT NAT. It engages only after
  tier-2 hole-punch has failed AND the pair cannot otherwise connect. The relay forwards only
  Noise-ciphertext (CONFIRMED, 2026-09-27 Section 2 — it holds no session key; exposure is metadata
  only), under an explicit larger-than-coordination duration/byte cap that must be set and
  Tier-4-recorded before it is enabled (2026-09-27 Section 2 cost #4). If no relay is configured, the
  pair degrades cleanly to LAN-only — the accepted permanent floor for that operator, not a bug.

## Security posture — exactly which sign-offs the build will need

Enforcement is the per-capability registry (`transportCapabilities.js`); a capability is BLOCKED by
default and becomes ALLOWED only by adding a dated `signoff` entry **in the same PR that lands the
capability's code, under mandatory Security + Red Hat review** (2026-09-27 addendum §5). This build
will ask the owner to sign off, in dependency order, these currently-`null` rows:

| Registry row | Package(s) | What it enables | Re-assessment owed before sign-off |
|---|---|---|---|
| `kadDht` (`:70–75`) | `@libp2p/kad-dht` | tier-2 DHT discovery | the public-DHT metadata exposure + the rotating-tag brute-force analysis (benchmarked scrypt cost, not assumed), confirming the 2026-09-15 hazard is closed |
| `bootstrap` (`:76–81`) | `@libp2p/bootstrap` | DHT ring entry | which bootstrap nodes (public vs Shoresh-run), pinning/auth of them |
| `dcutr` (`:40–45`) | `@libp2p/dcutr`, `@libp2p/autonat` | tier-2 hole-punch | explicit-close-on-punch-failure behaviour + its test; coordination caps |
| `relay` (`:34–39`) | `@libp2p/circuit-relay-v2` | tier-2 coordination + tier-3 data path | coordination caps AND the separate, larger data-path caps; who operates the relay; the ciphertext-only re-derivation re-confirmed against the installed version |

**Per the owner's acceptance, these four per-capability owner sign-offs are REPLACED by a hard
security + battle-test gate** (see Acceptance §4). Each capability row's `signoff` entry is added only
after that capability passes: (a) security-assessment + Security + Red Hat review, and (b) adversarial
battle-testing, with the evidence recorded under `docs/work/security/` and referenced from the
`signoff.doc` field. A Security or Grader FAIL that cannot be closed stops the loop and returns to the
owner via the organizer — never pushed past. The version-specific caps for
`circuit-relay-v2`/`dcutr`/`kad-dht` must be re-read from whatever version is actually installed when
each slice is picked up (org-source-verification; none is in the lockfile today).

## Reordered build plan — primary path first, Cloudflare demoted

Ticket-sized slices, dependency order. Governor allocates ticket numbers from a fresh scan at pickup
(this ADR is T327). **Test-first at the sync/discovery/migration seams; Red Hat mandatory on every
transport/security seam below** (sync/replay/stored-shape changes, per Constitution rule 5 and the
agent roster).

**Slice 1 — Address plumbing + persisted-peer reconnect (the missing primary-path foundation).**
The direct-reconnect path the owner's model assumes does not exist. Add a device-local, **never-synced**
store of a trusted peer's last-known multiaddrs (the join flow's `knownHostAddr` generalised to
steady-state), and a redial-from-remembered-address attempt that runs before falling through to any
discovery tier. Decide whether this is a new `devices` column or a device-local side table (the
device-identity-key exclusion class, ADR 2026-09-18 line 217 — never synced). **Test-first** (migration
+ reconnect-from-cold seam). **Red Hat** on the stored-shape change. Trips no capability row (no new
package; LAN/already-reachable addresses only). Schema migration: **yes** — rollback + the schema:check
family required (ADR 2026-09-26).

**Slice 2 — Ephemeral join secret + rotation mechanism (implements ADR 2026-09-15 + 2026-09-18's
rotation, with this ADR's automatic-on-revocation trigger).** Replace `joinCode.js`'s permanent
derivation with the random Host-minted window-scoped scrypt secret; wire namespace/epoch rotation to
fire automatically on device revocation. **Test-first** (rotation-on-revocation seam; the revoked
device can no longer derive the current tag). **Red Hat** on the revocation→rotation→discovery
path. Trips no capability row yet (LAN-only mechanism until the DHT is wired). Prerequisite for the
DHT being safe to open.

**Slice 3 — DHT discovery (`kadDht` + `bootstrap`), wired to the rotating tag.** Install
`@libp2p/kad-dht` + `@libp2p/bootstrap`; add `provide`/`findProviders` under the rotating discovery
tag in `syncStarter.js` alongside the existing mDNS and (demoted) rendezvous entries. **First slice
that opens a blocked capability — requires the `kadDht` + `bootstrap` re-assessments and the owner's
two sign-off entries.** **Test-first** (discovery-event shape parity with mDNS; tag-rotation
invalidation). **Red Hat** on the public-DHT exposure. Depends on Slice 2.

**Slice 4 — NAT hole-punch (`dcutr` + coordination `relay`).** Install `@libp2p/dcutr` +
`@libp2p/circuit-relay-v2` (coordination use only); explicit-close-on-failure behaviour + its test.
Requires the `dcutr` + `relay`(coordination) re-assessments and sign-offs. **Test-first**
(close-on-punch-failure; no silent data-path fall-through). **Red Hat** on the relay-coordination
seam. Depends on Slice 3 (needs a discovered candidate to punch toward). Includes proving the
un-proven home↔home direct punch on real hardware (the 2026-09-06 residual).

**Slice 5 — Demote Cloudflare rendezvous to discovery fallback.** Re-rank the existing rendezvous
discovery so it engages only after tier-2 DHT discovery yields nothing; no code removed, ordering +
default posture changed. **Test-first** (ladder ordering: a faster tier that succeeds is never
preempted). Trips no new capability (`discovery` already signed off). Depends on Slice 3.

**Slice 6 — Relay as capped data path (tier-3 bottom rung, 2026-09-27 Option B) — fully owner-gated,
last.** Extend `circuit-relay-v2` to a sustained, capped, configurable data path for CGNAT-both-ends
pairs; clean LAN-only degradation when unconfigured. Requires the `relay`(data-path) re-assessment
with its own larger caps. **Test-first** (cap enforcement; cannot become "open indefinitely").
**Red Hat** on the sustained-forwarding seam. Depends on Slice 4.

Signed auto-update (2026-09-27 Section 5) remains its own parallel workstream and a hard prerequisite
before any of Slices 3–6 is enabled for a real camp — unchanged by this ADR, restated so it is not
lost: no internet-reachable transport ships to a real camp before a signed update channel exists.

## Consequences

- No code ships from this ADR. Every slice is conditional on owner acceptance of this ADR and, for
  Slices 3/4/6, on the per-capability re-assessments and sign-offs enumerated above.
- The `devices` store (or a device-local side table) gains address data in Slice 1 — the first
  persisted-shape change; it must be never-synced (device-identity-key exclusion class) and carries a
  schema migration + rollback + the schema:check family.
- Cloudflare rendezvous is **retained**, not removed — re-ranked from primary to last-resort discovery
  fallback. The 2026-09-28 discovery sign-off stands; this ADR changes how that capability is *ranked*,
  not whether it is allowed.
- The public DHT becomes coordination infrastructure Shoresh depends on but does not operate — a
  deliberate, owner-intended alternative to the central Cloudflare noticeboard, safe only because the
  rotating secret keeps its records opaque and un-impersonable.
- Automatic-on-revocation rotation (if accepted) makes every device revocation also a key turn — a
  behaviour change to the revocation path, covered by Slice 2's tests.

## Open questions — RESOLVED on acceptance (2026-10-02)

All five were resolved at their recommended defaults on the owner's acceptance; see the **Acceptance**
section at the top for the binding record. In brief: (1) three-tier ladder accepted; (2) rotation
automatic-on-revocation; (3) public libp2p DHT/bootstrap default, configurable; (4) the four
per-capability sign-offs replaced by the security + battle-test gate; (5) relay code built, but
standing it up (spend/infra) stays an owner action. The only items that still return to the owner are
a security/Grader FAIL that cannot be closed, and any spend/infra action (deploying a relay or
Cloudflare).

_Prior: item (3) above and the Decision/Tier-2 sections below recorded the **public libp2p
DHT/bootstrap network** (kad-dht + public bootstrap nodes) as this ADR's PRIMARY WAN discovery
mechanism. That rung is superseded by the amendment immediately below — the owner rejected the
public DHT itself, not merely its defaults. Tier 2 in the table and the whole "Tier 2 settled
concretely" section (kad-dht keying, bootstrap-node sourcing, the public-DHT safety argument) are
therefore historical: they describe a rung that was proposed, built as dormant/gated code
(`dhtDiscovery.js`, `signoff: null`), and then rejected before activation — read them as a record of
what was tried and why it didn't ship, not as the current plan. They are intentionally left in place
below rather than deleted, per this repo's historical-marking convention._

## Amendment 2026-10-03 (owner decision — corrected ladder, public DHT removed)

**Status: ACCEPTED.** This amendment is itself a decision the owner made directly (not an
organizer-delegated acceptance under Article IV's carve-out) — his own words are the authority for
it, recorded below with the date, same standard the original 2026-10-02 acceptance used.

### What changed, and why

Session 2026-10-03 produced `docs/work/security/2026-10-03-t334-dht-capability-assessment.md`, which
found the public libp2p DHT materially worse than the already-accepted Cloudflare rendezvous on three
axes: an unbounded public observer population (any of millions of DHT participants, not one operator),
internet-wide reachability of the pre-auth discovery surface, and eclipse/Sybil exposure of lookups
that the rotating-tag confidentiality argument does not cover (it protects the *key*, not the
*availability/integrity* of a lookup against it — see that assessment and
`docs/work/specs/2026-10-03-t334-slice3-dht-discovery-design.md` §5.3 for the un-closed finding).

The owner's response, verbatim, relayed via the organizer, 2026-10-03: **"no. i do not accept this."**
He then corrected the framing of the whole ladder, verbatim: **"devices have to first meet on the same
lan. that is a hard stop first principle. after that they should be able to go anywhere. it is the
different wifis then usual finding each other that we are trying to solve for, or even one new
wifi/connection to original. between all users of a camp. the cloudflare relay is a back up for a rare
case where a weird firewall throws a barrier we can't work around."**

Two distinct corrections are in that statement, both binding:

1. **The public DHT is dropped from the ladder entirely** — not deprioritized, not reordered, removed.
   The rejection is of the public-DHT *mechanism itself* (unbounded-observer metadata exposure), not of
   its position in the ladder. No future slice re-adds `kadDht`/`bootstrap` discovery without a fresh
   owner decision; `docs/work/specs/2026-10-03-cross-network-discovery-options-menu.md`'s Option 1
   (private/closed DHT) was independently assessed as a trap in that same document and is not an
   exception to this.
2. **Cloudflare was never actually rejected as a concept** — his original "cloudflare relay is a back up
   for a rare case" restates, not reverses, the original ADR's tier-3 "last resort / bottom rung, not
   the primary path" framing (see "Owner intent" above, 2026-10-02: *"for truly odd circumstances
   only"*). What changed is tier 2's mechanism, not tier 3's role. Do not read this amendment as the
   owner softening on Cloudflare — he is restating the same constraint that was already correctly
   recorded, now contrasted against the DHT rung that was removed.

### The corrected three-tier ladder (supersedes the Decision table's Tier 2 above)

| Tier | Purpose | Mechanism | Status |
|---|---|---|---|
| **1. LAN meet** | hard-stop first principle — devices MUST establish mutual trust on the same LAN before anything else is attempted; this is not "a case to solve," it is the gate everything downstream passes through | mDNS multicast (`@libp2p/mdns`) + the existing LAN trust-establishment handshake | **shipped**, unchanged |
| **2. Remembered-address reconnect + NAT hole-punch** (PRIMARY cross-network path) | the actual problem being solved: devices that have already met on LAN, now on different wifis (including a device moved to one new connection), finding each other again across all of a camp's devices | `peerAddressBook.js`'s `rememberPeerAddress`/`redialTrustedPeers` (merged, Slice 1) + `@libp2p/dcutr`/`@libp2p/autonat` hole-punch (not yet merged) | redial: **shipped**. Hole-punch: **blocked** (`dcutr` row, `signoff: null`) — next to build |
| **3. Cloudflare rendezvous** (RARE fallback) | engaged only when tier 2 cannot connect — "a weird firewall throws a barrier we can't work around" (owner, 2026-10-03), not a normal-operation dependency | existing, already-signed-off `rendezvousClient.js` discovery; `@libp2p/circuit-relay-v2` as a capped, time-boxed data path for the CGNAT-both-ends case tier 2 cannot punch through | discovery: **wired, signed off** (2026-09-28). Relay-as-data-path: **blocked** (`relay` row, `signoff: null`) |

**No tier-2 DHT rung exists in the corrected ladder.** The kad-dht/bootstrap mechanism, the public-DHT
safety argument, and the bootstrap-node sourcing recommendation in the "Tier 2 settled concretely"
section above are **historical** — struck from the current plan by this amendment, kept in the
document per this repo's convention for marking superseded content rather than deleting it. The
`kadDht` and `bootstrap` rows in `transportCapabilities.js` (lines 70-81) remain in the registry at
`signoff: null` — their blocked, inert state is unchanged by this amendment, and no further work opens
them absent a new owner decision.

### Why: the two rejections this amendment records

- **Public-DHT metadata exposure** (the stated reason, `docs/work/security/2026-10-03-t334-dht-capability-assessment.md`): an unbounded, uncontrolled population of DHT participants can observe that *some* peer exists under an opaque key and reach it directly — a categorically different and worse exposure than a single operator (Cloudflare) holding the same shape of record, which the owner had already accepted. This is what "no. i do not accept this." was said about.
- **The fork-per-camp centralization concern, which also rules out a Shoresh-run rendezvous node as a standing dependency** (not raised by the owner in this exchange, but load-bearing for not substituting one centralization problem for another): this project is architected as open-source, forked per camp (`project_open_source_fork_per_camp_model`) — any discovery mechanism that makes a *Shoresh-operated* server the normal-case dependency undermines that model for every forked camp that doesn't want to depend on Shoresh's infrastructure. This is why `docs/work/specs/2026-10-03-cross-network-discovery-options-menu.md`'s Option 3 (a Shoresh-run rendezvous node as the default) was never recommended as the default rung, and why the existing `SHORESH_RENDEZVOUS_URL` override — letting a forked camp point its tier-3 fallback at its own infrastructure instead of Shoresh's — is a hard requirement of the corrected tier 3, not an optional nicety.

### Build sequence (owner/organizer-set, 2026-10-03; RESEQUENCED 2026-10-03, foundation-first)

_Prior: the sequence originally recorded here opened Slice A (`dcutr`) first, with Slice B
(Cloudflare/relay-as-data-path) second. That ordering silently assumed `dcutr` could run without a
prior live connection between the two peers. It cannot: `dcutr` **upgrades an existing connection to
direct**, it does not create one — the T336 Slice-A design doc
(`docs/work/specs/2026-10-03-t336-slice-a-holepunch-design.md`, §1 and Open Questions §1) surfaced this
as a plain contradiction inside this ADR's own text: the mechanism section names
`@libp2p/circuit-relay-v2` coordination mode as the channel that gets two peers' reflexive addresses
in front of each other, but the build sequence below never scheduled opening that `relay` capability
before `dcutr`. The organizer (owner-delegated) ruled on this finding: the coordination layer is
FOUNDATIONAL and is built first, with hole-punch layered on top. This section is kept, struck through
in spirit but not deleted, per this repo's historical-marking convention; the corrected sequence
follows immediately below._

**The owner's runtime ladder is UNCHANGED by this resequence.** Resequencing which capability's code
and gate land first is a build-order decision; it does not alter the ladder a connection attempt
follows at runtime, which remains exactly: a direct hole-punched connection is strongly preferred; any
relay is used only briefly to coordinate the punch and then drops out; a traffic-carrying relay is
reserved for the rare un-punchable (both-ends-CGNAT/symmetric-NAT) case. Resequencing the *build* does
not reorder the *ladder*.

**Coordination-point default (new, settled by this resequence): a publicly-reachable CAMP PEER, not
Cloudflare and not a Shoresh-run node.** Per
`docs/work/specs/2026-10-03-t337-coordination-layer-design.md` §A: a device seeking to reconnect to a
camp peer whose cached address no longer resolves asks another camp-admitted peer it *can* currently
reach to act as a `circuit-relay-v2` coordination point, restricted by construction to peers that pass
the existing T331 admission gate. This expresses the owner's no-central-dependency, distributed-
hosting model (devices coordinate among themselves) and is why the coordination layer, not Cloudflare,
is the foundation. The Cloudflare rendezvous (now Slice 3 below) remains the fallback used only when
no camp peer is reachable to coordinate — demoted in sequence but not in role; its tier-3 "rare
firewall-only fallback" position from the Decision table above is unchanged. The T209 Cloudflare
Worker deploy is still NOT pulled forward by any part of this resequence — it stays owner-spend,
client-only work until that gate.

**Corrected build sequence, in this order** — each slice's design comes to the organizer before any
capability opens, same strict capability-gate discipline as before (security re-assessment + Security
+ Red Hat + battle-test, `signoff` added only after the gate passes):

**Foundation slice — Coordination layer (T337), built first.** Opens the `relay` row
(`@libp2p/circuit-relay-v2`, `transportCapabilities.js:34-39`) in **coordination-only scope** (the
existing ~128 KiB/2 min cap from the Decision table above, unchanged) — a camp-admitted peer relaying
a brief reflexive-address exchange between two other camp peers, never a data path. See
`docs/work/specs/2026-10-03-t337-coordination-layer-design.md` for the full design, including the
AutoNAT-camp-peers-only hard requirement (shared with the hole-punch slice below) and the
carry-forward admission proofs extended to the relayed-then-punched path. **Reuses:** T328 Slice 1's
remembered-address reconnect (`peerAddressBook.js`) and the T331 admission gates, unchanged.

**Hole-punch slice — Slice A (T336), layered on the coordination foundation.** Opens the `dcutr` row (`@libp2p/dcutr`,
`@libp2p/autonat`; `transportCapabilities.js:40-45`, currently `signoff: null`) through the full
capability + battle-test gate, including:
- the Slice-1 cached-WAN-address carry-forward check — `docs/work/specs/2026-10-03-t334-slice3-dht-discovery-design.md` §5.6 named this for the (now-dropped) DHT path; the same check applies unchanged to hole-punch: a revoked device must not become redialable via `peerAddressBook.js`'s cached address merely because hole-punch widens reachability — the admission gate (`authorize()`), not discovery, must be what blocks it;
- the revoke-while-running cut-off criterion carried from T335/T334's HARD acceptance criterion (the slice-3 design's closing section) — a device revoked while connected must actually lose reach, live, not merely on next restart. This criterion was written against the DHT path specifically because DHT discoverability needed live re-keying; for the hole-punch path the equivalent requirement is that `redialTrustedPeers` and the hole-punch dial path both re-check trust immediately before each dial attempt (already the documented contract at `peerAddressBook.js:30`, "re-checks trust IMMEDIATELY BEFORE each individual dial") and that a revoked device's cached address cannot be used to establish a new hole-punched connection that survives `authorize()`.

**Reuses:** the merged Slice 1 remembered-address reconnect (`electron/sync/automerge/peerAddressBook.js`
— `rememberPeerAddress`, `redialTrustedPeers`, backed by the `peer_last_addresses` table), and the T331
distributed-authority admission/revocation gates (`authorityReplay.js`, `authorize()`) — unchanged by
this or any discovery option; admission stays the control, exactly as the slice-3 design's §2 parity
requirement already stated for the (now-dropped) DHT path and restated here for hole-punch.

**Fallback slice — Cloudflare rare-firewall fallback (tier 3's data-path half), last.** Only after the
coordination foundation and the hole-punch slice's designs and gates are through. Extends
`@libp2p/circuit-relay-v2` to a capped, time-boxed **data** path (`relay` row,
`transportCapabilities.js:34-39`, currently `signoff: null` for this data-path scope — its
coordination-only scope is opened earlier by the foundation slice above) for the CGNAT-both-ends case
hole-punch cannot solve, alongside the **existing, already-signed-off** `rendezvousClient.js` discovery
path (`transportCapabilities.js`'s `discovery` row — unaffected, no re-gate needed for discovery
itself, only for the new relay-as-data-path use). Engaged only when the foundation slice's camp-peer
coordination cannot find a reachable camp peer at all (`docs/work/specs/2026-10-03-t337-coordination-
layer-design.md` §A, last paragraph) — not a normal-operation dependency.

**Reuses:** the T335 signed rotating discovery tag
(`electron/sync/automerge/rotatingDiscoveryTag.js`'s `rotatingDiscoveryDigest`,
`authorityRevocationDigest.js`) remains the correct lookup key for this rung too — it is
transport-agnostic by design (per the options-menu doc's "Reused building blocks" section) and is not
tied to the dropped DHT mechanism; the existing Cloudflare rendezvous client and KV-worker protocol
shape; the T331 admission gates, same as the foundation and hole-punch slices.

### OWNER SPEND/INFRA — reserved, do not build toward

**Standing up the Cloudflare rendezvous Worker on the owner's own Cloudflare account/domain (ticket
T209, `docs/work/tickets/T209-rendezvous-worker-phase-a.md`, currently `in-progress` — the Worker code
exists, undeployed) is an owner action, not something any slice builds toward.** The fallback slice
builds and tests the **client** against the existing Worker code/fixtures; the **deploy** step — provisioning the
actual Cloudflare account/domain resource — is brought to the owner when the rung is otherwise ready,
exactly as the original ADR's Acceptance §5 already reserved "standing it up (deploying/paying for a
relay or Cloudflare)" as a spend/infra decision outside the security+battle-test gate's authority.

**Keep the rendezvous URL camp-configurable.** The existing `SHORESH_RENDEZVOUS_URL` override (already
established for the Cloudflare discovery path, mirrored by the slice-3 design's proposed
`SHORESH_DHT_BOOTSTRAP` pattern for the now-dropped DHT rung) must remain the mechanism by which a
forked camp points tier 3 at its own rendezvous endpoint instead of the owner's. This is a hard
requirement of the fork-per-camp model (see "Why" above), not an enhancement — the fallback slice must
not hard-code a single owner-operated URL.

### Design-of-record, stated plainly (owner directive, 2026-10-03, relayed via organizer: "make sure
that the docs reflect the public. - public never met piece is not a pathway.")

The two corrections above are easy to read as tier reshuffling. They are not. Stated as the two
standing facts every WAN-discovery doc must reflect:

1. **The public DHT is not a discovery pathway.** Not an option, not a future rung, not deferred —
   **rejected and removed** from the ladder. The one-line why: it exposes device online-status and
   network address to an unbounded population of strangers on the public network, a categorically
   worse exposure than the single-operator Cloudflare fallback the owner had already accepted. No
   future slice re-adds `kadDht`/`bootstrap` discovery without a fresh owner decision.
2. **"Two devices that never shared a LAN" is not a pathway and not an open problem.** LAN-meet-first
   (Tier 1 in the table above) is a **hard prerequisite** — trust establishment, not a discovery case
   to be solved. The architecture only ever reconnects devices that have **already met and established
   mutual trust on a LAN**. A pair of devices with no shared LAN history is **out of scope by first
   principle**, not a residual, not a gap, not an "honest unsolvable case" to be engineered around or
   left open for a future rung. Any doc, past or future, that frames it as a hard case still needing a
   solution is mis-framing this architecture and must be corrected on sight.

The corrected ladder, restated once more for unambiguous reference: **LAN meet [hard prerequisite] →
remembered-address + NAT hole-punch (dcutr/AutoNAT) [PRIMARY cross-network path] → Cloudflare
rendezvous [RARE firewall-only fallback].** No public-DHT rung. No never-met pathway.

### Doc hygiene this amendment performs

- `docs/work/specs/2026-10-03-t334-slice3-dht-discovery-design.md` is marked **SUPERSEDED/REJECTED**
  (frontmatter `status`) by this amendment — see that file's own header update. It remains in the repo
  as the historical record of the design that was built dormant and then rejected before activation; it
  is not current and must not be picked up by Maker.
- `docs/work/specs/2026-10-03-cross-network-discovery-options-menu.md` is updated to note the owner
  resolved the open questions it posed to Option 4's shape (remembered-address + hole-punch default,
  single-operator rendezvous fallback) — the same shape this amendment records as the corrected ladder,
  confirming the options-menu's recommendation was the one the owner picked.
