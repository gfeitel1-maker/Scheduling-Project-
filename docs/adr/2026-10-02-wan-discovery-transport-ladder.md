---
title: "WAN discovery/transport ladder: DHT + hole-punch as the primary cross-network path, Cloudflare demoted to last resort"
document_type: adr
authority: normative
status: proposed
date: 2026-10-02
decided: null
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
implementation_state: not-started
---

# WAN discovery/transport ladder — DHT-first, Cloudflare last

**Ticket:** T327. **Status: proposed — this ADR is NOT self-accepted.** It records a new
transport/security posture (it opens `kadDht`, `dcutr`, and `circuit-relay-v2`, all currently
`signoff: null` in `electron/sync/automerge/transportCapabilities.js`). Per Constitution Article IV
this is a security-posture change, which is explicitly outside the delegated-acceptance carve-out and
remains the owner's alone. It is brought to the owner for acceptance. No production code ships from
this ADR, and no capability is unblocked by it.

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

**Four distinct owner sign-offs, one per capability row — not a single flip.** Each requires its own
recorded re-assessment under `docs/work/security/` before the owner adds its `signoff` entry. A
security re-assessment is **owed before each capability is unblocked**; this ADR requests none of them
now. The version-specific caps for `circuit-relay-v2`/`dcutr`/`kad-dht` must be re-read from whatever
version is actually installed when each slice is picked up (org-source-verification; none is in the
lockfile today).

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

## Open questions for the owner (acceptance items — decisions, not settled here)

1. **Accept the three-tier ladder as the target** (DHT-first, Cloudflare last), amending the
   2026-09-17/2026-09-27 ordering.
2. **Rotation trigger: automatic-on-revocation** (this ADR's recommendation, confidence high) — confirm,
   or choose director-initiated-only.
3. **Bootstrap nodes: public libp2p network (default) vs Shoresh-run vs hybrid** — this ADR recommends
   public-with-configurability; the owner's "not a central noticeboard we run" intent is the deciding
   constraint and his to apply.
4. **Acknowledge the four forthcoming per-capability sign-offs** (`kadDht`, `bootstrap`, `dcutr`,
   `relay`), each with its own re-assessment owed before it is unblocked. Accepting this ADR does not
   grant any of them.
5. **Tier-3 data relay (Slice 6 / Option B): confirm it is wanted** at all, and that the owner is
   willing to provision/run a capped relay whose uptime CGNAT-both-ends pairs' ongoing sync depends on
   (the operational commitment from 2026-09-27 Section 2).
