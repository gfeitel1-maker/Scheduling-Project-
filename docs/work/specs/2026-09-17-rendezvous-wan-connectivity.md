---
title: "Serverless rendezvous and WAN connectivity — external spec, reconciled"
document_type: spec
status: draft
created: 2026-09-17
task_class: security-auth
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-14-internet-transport-security-gate.md, docs/adr/2026-09-15-ephemeral-join-secret-for-wan-discovery.md, docs/adr/2026-09-17-wan-rendezvous-seam.md]
related_tickets: [docs/work/tickets/T207-tier4-guard-blind-to-http-rendezvous.md, docs/work/tickets/T208-discovery-seam-has-no-local-trust-filter.md, docs/work/tickets/T209-rendezvous-worker-phase-a.md, docs/work/tickets/T210-signed-rendezvous-record-and-namespace.md, docs/work/tickets/T211-wire-rendezvous-into-discovery-path.md, docs/work/tickets/T212-wan-connectivity-measurement.md]
archive_when: "Phases A–C are either shipped and Verifier-PASS recorded, or the owner has decided the program is not wanted and that decision is recorded with its reason"
---

# Serverless rendezvous and WAN connectivity

**Source:** an external implementation handoff supplied by the product owner
(`Shoresh_Rendezvous_WAN_Claude_Opus_5_Handoff.docx`, 2026-09-17). This document is the durable
in-repo record of that spec **plus** its reconciliation against decisions this repository has
already made. It is a spec, not authority: where it disagrees with an ADR or a standard, the ADR
or standard wins (`GOVERNANCE_INDEX.md` §11).

## 1. What the external spec asks for

Two capabilities, in this order of preference: find the already-trusted peer, then reach it
directly.

- **Rendezvous.** Already-paired peers that move between networks rediscover each other's current
  libp2p reachability through a Cloudflare Worker + Workers KV "bulletin board" at
  `rendezvous.shoresh.org`. Peers `POST /v1/register` a signed, ~2h-expiring record binding
  `{namespace, peerId, addresses, issuedAt, expiresAt, signature}`, and `GET /v1/peers/<namespace>`
  to find each other. KV TTL garbage-collects; client-side signature and freshness checks handle
  spoofing and replay.
- **WAN traversal.** After rediscovery, improve the odds of a direct dial across NAT — UPnP/NAT-PMP
  port mapping, reachability-aware advertised addresses, and (only if measurement justifies it)
  DCUtR hole punching and a circuit-relay client.

Its invariants: trust and pairing stay local; mDNS stays; Noise/Yamux/mutual-auth/Automerge
downstream are unchanged; no central Shoresh database and no cloud-hosted Automerge; a rendezvous
outage must never block startup; **a Cloudflare response never establishes trust**; direct P2P is
preferred. Its namespace is a ~256-bit random value minted at trusted setup — explicitly never the
camp id or the join code.

Phases: **A** Worker + KV proof · **B** real signed libp2p records · **C** feed the existing
discovery/mutual-auth path · **D** UPnP/NAT-PMP + reachability-aware addresses · **E** measure
where failure actually occurs · **F** only if justified, DCUtR / circuit-relay client.

The full verbatim text of §§1–25, including the observability vocabulary (§21), the WAN test matrix
(§20) and the definition of done (§24), is reproduced in the source `.docx` the owner holds. The
material claims are summarised above and every one that this repository has an opinion about is
reconciled below.

## 2. Reconciliation against what this repository already decided

### 2.1 Already answered — do not re-decide

| Spec claim | Already settled by |
|---|---|
| "Internet-reachable transport needs a security re-assessment first" | `docs/adr/2026-09-14-internet-transport-security-gate.md`, and it is **mechanically enforced** by `electron/sync/automerge/transportBoundary.guard.test.js`. Not advisory. |
| Circuit relay is a last resort, direct-only preferred (§17) | Owner decision, 2026-09-15: **direct-only, no relay** (`docs/work/security/2026-09-15-wan-dht-boundary-assessment.md`). The spec agrees with a decision already taken. |
| Rendezvous must not be the data path; data stays on peers | Settled architecture since the Stage 6 cutover. Nothing in this program touches it. |
| A public discovery key must not be derived from the camp id | `docs/adr/2026-09-15-ephemeral-join-secret-for-wan-discovery.md` (accepted). The spec's 256-bit namespace is the same conclusion reached independently. |

### 2.2 Stale or wrong in the spec's premise

1. **"Add UPnP/NAT-PMP using the package compatible with the repository's js-libp2p version"
   (§14) reads as a routine addition. It is not.** `@libp2p/upnp-nat`, `@libp2p/autonat`,
   `@libp2p/dcutr` and `@libp2p/circuit-relay-v2` are all on the Tier-4 guard's forbidden list.
   Adding any of them turns the build red until a **human** records a re-assessment and flips
   `INTERNET_TRANSPORT_SIGNOFF`. Phases D and F are therefore not implementable as specced without
   an owner decision.
2. **Relay: the spec, and our own first reading of it, collapsed two different things.** *(Owner
   ruling, 2026-09-17, superseding this document's first draft and narrowing the 2026-09-15
   "direct-only, no relay" decision to the case it was actually about.)* Circuit relay has two uses
   and only one is rejected:
   - **Relay as a data path** — traffic stays on the relay for the life of the connection.
     **REJECTED, permanently out of scope** unless the owner reopens it. The owner is not willing
     to host camps' traffic.
   - **Relay as brief coordination for DCUtR** — the relayed connection exists only long enough for
     both peers to synchronize a simultaneous-open attempt; the hole punch upgrades to a direct
     connection and the relay drops out. **This is the intended route**, and it is what §16 of the
     source handoff actually describes.

   Target path: rendezvous finds the peer → direct dial → on failure, a coordination-only relayed
   connection → DCUtR → direct. The design must **enforce**, not merely intend, that the relayed
   connection never becomes a sustained data path — `circuit-relay-v2` carries reservation, data
   and duration limits built for exactly this, and they must be set concretely and asserted by a
   test. **If the hole punch fails, the connection fails**; it does not fall back to relaying.
3. **The stack is TCP-only, which the spec never accounts for.** Transports are `@libp2p/tcp`
   only — no QUIC/UDP. js-libp2p's hole-punching story is built around QUIC's cheap
   connectionless simultaneous-open; TCP simultaneous open is timing-sensitive and unreliable
   across real NAT vendors. **Phase F as specced is unlikely to work well on this stack even if the
   gate were opened.** See `docs/adr/2026-09-17-wan-rendezvous-seam.md`.
4. **Phase ordering inverts the spec's own philosophy.** §17 rightly insists on measuring before
   deploying a relay, but §19 ships Phase D (UPnP — a gated, production-behaviour-changing,
   internet-facing capability) *before* Phase E (measurement). Followed literally, an implementer
   either flips the security gate without the evidence it exists to require, or improvises. **The
   correct order is A → B → C → E → (D/F only if E justifies them).**
5. **"Possession of the namespace is not sufficient authentication" (§7) is true of the design and
   false of the code as it stands today.** See §2.3 below — this is the single most important
   finding in this document.
6. **The spec's non-goals do not mention namespace rotation, and neither does §7.** There is no
   rotation, revocation or re-provisioning story for the namespace at all: not for a departed
   staffer's laptop, not for a device rebuild (which this repo's history says loses signing keys),
   not for a restore from a backup predating a device removal. An implementer following the letter
   of the spec will not build one and will not flag the gap.

### 2.3 Genuinely new — and one blocking defect it surfaces

The reviews turned up two **confirmed criticals** that are properties of the repository today, not
of the spec:

**C1 — The Tier-4 guard cannot see the change this spec proposes.**
The guard (`transportBoundary.guard.test.js`) asserts three things: no forbidden npm package, no
forbidden import in `transport.js`, and that `electron/main.js` still matches
`/peerDiscovery:\s*\[\s*createMdnsDiscovery\(/`. An HTTPS `fetch` to a Cloudflare Worker is not a
libp2p package, is not imported by `transport.js`, and appending a rendezvous service *after*
`createMdnsDiscovery(` in that array still satisfies the regex. **Phases B and C could publish this
node's real WAN addresses to the public internet with a fully green gate.** The one mechanical
checkpoint against silent boundary widening is blind to the exact boundary widening now proposed.
→ **T207**, blocking prerequisite.

**C2 — The discovery→auth seam performs no local-trust check, so a rendezvous response *would*
establish reach.** Verified directly in `electron/sync/automerge/mutualAuth.js`: `tryAuthenticate`
gates only on an in-memory `attempted` Set and on this device having a token. It then sends
`{ type: 'authenticate', token, device_id }` to **any** peer surfaced by `onPeerDiscovery`. There is
no check that the peer id is a known, trusted device. On the LAN this is bounded by mDNS
link-local multicast. Over rendezvous it is bounded by whoever can POST into the namespace. The
spec's invariant "a Cloudflare response never establishes trust" is therefore **not currently
enforced by any code** — it would have to be built.
→ **T208**. **Closed 2026-09-18.** _Prior (superseded): this paragraph described the seam as
"partially closed," with the LAN case blocked on a hard constraint — `transport.js` passing no
`privateKey` to `createLibp2p`, so a fresh peer id was minted every process start and a
peer-id-based trust check would reject every legitimate device after a restart. That premise
stopped holding the same day it was written: T162 landed (also 2026-09-17) and `syncNode.js` now
loads a persisted per-device identity via `ensureDeviceIdentity` before ever dialing, so a device's
peer id is stable across restarts._ The LAN case is now closed: `createBoundPeerTrust(db)`
(`electron/sync/automerge/peerIdentity.js`) is `startSyncNode`'s default `isPeerTrusted`, replacing
the old permissive `lanTopologyTrust` stub. It resolves a discovered peer id to the `devices` row
`bindOrVerifyPeerIdentity`'s TOFU bind bound it to, and admits only when that row is authorized and
not revoked, re-querying fresh on every discovery. See T208 §0 for the full history, including a
round-2 correction of this seam's client-to-client-regression and revocation-enforcement reasoning
(neither changes the closed verdict, both were about *why*, not *whether*).

Also new and unaddressed by the spec, from the adversarial review:

- **Revocation lag.** "Authorized by local trust state" is an eventually-consistent, CRDT-replicated
  value. A revoked device off-LAN can still find and reach peers whose revocation has not converged
  — and rendezvous actively *widens* that reach during exactly the disconnect window revocation
  matters most. A signed record also survives in KV for up to its full TTL after revocation.
- **Reconnection DoS via the `attempted` dedupe.** `attempted.add(peerId)` happens before any
  outcome, and is cleared only on dial failure or explicit rejection — **not on a hang**. A hostile
  record for a trusted peer id (peer ids are not secret) pointing at an endpoint that accepts and
  never replies suppresses the real peer's later discovery. No trust is established; the feature is
  simply defeated by an unauthenticated actor.
- **Clock skew.** Freshness is checked against an untrusted local clock with no stated tolerance
  and no NTP dependency. A fast clock rejects all valid records; a slow one accepts expired ones.
- **Dial storms.** §12 registers and discovers unconditionally at startup with no backoff, budget
  or circuit breaker against stale/private addresses — a direct regression to the instant
  local-first startup the product is built around.
- **KV eventual consistency across edge PoPs.** Last-write-wins on a rapid Wi-Fi↔hotspot flap can
  leave stale addresses winning at one PoP and fresh ones at another. `issuedAt`/sequence must
  order writes, not only gate client freshness.
- **Privacy is a first-class finding, not a footnote.** The board is a live, refreshed register of
  the public IPs of staff laptops at children's camps — geolocatable to city/ISP, correlatable
  across seasons via stable peer ids, with Cloudflare request logs outside the record TTL, keyed by
  a namespace that per §7 never rotates.
- **The endpoint must be configurable and fully disable-able.** *(Owner ruling, 2026-09-17,
  superseding the "single point of failure" framing this document carried in its first draft.)*
  Shoresh is open source: anyone who does not want the project's rendezvous infrastructure forks
  it, turns it off, or self-hosts. `rendezvous.shoresh.org` under the owner's account is therefore
  a fine default and is **not** treated as a blocking operational risk. What this *does* require of
  the design is a first-class off switch: the endpoint is configuration, and **rendezvous-off is a
  supported, tested configuration that degrades to exactly today's LAN-only behaviour** — not a
  code path that rots because nobody runs it. §13's vocabulary still needs a failure class that
  says "this capability is disabled or gone" rather than "your network is bad".

## 3. Observable success predicate

Adapted from the spec's §24, with the two prerequisites added:

1. Existing same-network pairing and mDNS behaviour still works. *(Regression bar.)*
2. The Tier-4 guard fails the build when an HTTP rendezvous client is wired into the production
   node without sign-off — proven by a planted defect, not by inspection.
3. No peer discovered by any mechanism is sent this device's session token unless its peer id is
   already a locally-trusted device — proven by a test that plants an untrusted peer id.
4. A previously trusted peer can publish an authenticated, expiring WAN reachability record.
5. Another previously trusted peer on a different network can retrieve and validate it.
6. An unknown/untrusted peer id returned by rendezvous cannot become trusted, **and cannot receive
   a token**, through rendezvous alone.
7. A valid rendezvous discovery enters the existing dial/mutual-auth path — no new sync path.
8. Two peers on separate networks directly authenticate and synchronise where the network permits.
9. Rendezvous outage does not prevent startup or local/direct operation.
10. Logs distinguish rendezvous success from subsequent direct-dial success/failure.
11. Rendezvous is configurable and can be turned off entirely, and the off configuration is
    covered by a test that asserts it behaves exactly as today's LAN-only node does.

### What does NOT count as done

- Any of 4–8 demonstrated with `INTERNET_TRANSPORT_SIGNOFF` flipped by an agent rather than by the
  owner after a recorded re-assessment.
- Predicate 2 or 3 satisfied by reading the code rather than by a test that fails when the
  protection is removed. (Standing lesson: a non-vacuity test that plants only the defect it was
  designed for proves nothing.)
- Anything verified only against the `:5200` browser mock. Persistence, auth and sync claims
  require `electron:dev` (`TESTING_STANDARD.md`).
- A deployed Worker. Deployment to an owner-owned Cloudflare account and a public domain is an
  **owner action** and is outside every ticket below.

## 4. Phase plan and gate status

| Phase | Ticket | Tier-4 status |
|---|---|---|
| Prerequisite: guard covers HTTP rendezvous | T207 | Not gated — *closes* a gate hole |
| Prerequisite: local-trust filter at the discovery seam | T208 | **Closed 2026-09-18** — LAN case now enforced via `createBoundPeerTrust`, unblocked by T162 |
| Prerequisite: stable device identity + token binding | T162 | **Implemented 2026-09-17** — unblocks a real trust check |
| A — Worker + KV source and tests (no deploy) | T209 | Not gated (no Shoresh runtime change) |
| B — signed record contract + namespace | T210 | Not gated once T207 lands; **T207 must land first**. Implementation complete (encoding, signing, verification, rotation, round-2 hardening) as pure library code not wired into any path; ticket left `open` pending T207 per its own dependency, not for any remaining code gap |
| C — wire into the existing discovery path | T211 | **Gated by T207's widened guard — needs the owner's sign-off** |
| E — measurement and observability | T212 | Not gated |
| D — UPnP/NAT-PMP | *not ticketed* | **Blocked**: `@libp2p/upnp-nat`/`@libp2p/autonat` forbidden; and see the TCP-only finding |
| F — DCUtR + coordination-only relay client | *not ticketed* | **Blocked**: forbidden packages; scope narrowed to coordination-only per the 2026-09-17 ruling |

D and F are deliberately not ticketed. Ticketing them would imply they are scheduled work; they are
owner decisions that have not been made, resting on evidence that does not exist yet (Phase E).

## 4.1 Accepted limitation — symmetric CGNAT on both ends has no WAN path

**Owner ruling, 2026-09-17: ACCEPTED. This is a settled limitation, not an open question.**

NAT mapping is either endpoint-independent (the same external port is reused regardless of
destination — punchable) or endpoint-dependent/symmetric (a new external port per destination — not
punchable). Where at least one side of a pair is genuinely symmetric, **no mechanism in scope
establishes a WAN connection**: not direct dial, not UPnP/NAT-PMP, and not coordination-only
relay + DCUtR. Coordination-only framing does not change this, because what must succeed is the
same simultaneous-dial hole punch, and no relay makes a symmetric NAT behave like a cone NAT.
Adding QUIC does not change it either; QUIC improves reliability only for NAT classes that were
already punchable.

**What those camps get:** their devices sync when they next share a network — the ordinary
mDNS/LAN path, untouched by any of this work. There is no way to tell in advance, or from inside
the app, which category a given camp's ISP falls into.

This is recorded here so a later reader finds it as a decision already taken. Re-opening it needs
new evidence about NAT behaviour, not a re-run of the same analysis.

## 5. Non-goals

Carried from the spec's §22 unchanged, plus: no deployment of anything to an external account or
domain from inside this repository's workflow; no flip of `INTERNET_TRANSPORT_SIGNOFF` by any
agent; no change to `authorize()`, the pairing state machine, or the Automerge document shape.
