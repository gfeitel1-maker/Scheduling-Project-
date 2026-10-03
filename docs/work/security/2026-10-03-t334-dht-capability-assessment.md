---
title: "T334 Slice 3 — public-DHT capability deep security assessment"
document_type: security
authority: evidence
status: active
task_class: security-auth
created: 2026-10-03
assessed_commit: 4b4aef2f7e3b2b6fa56b267d8db5d6e5d77f8a21
governing_docs: [docs/work/specs/2026-10-03-t334-slice3-dht-discovery-design.md, docs/adr/2026-10-02-wan-discovery-transport-ladder.md, SECURITY.md]
archive_when: T334 capability+battle-test gate records the final signoff decision for kadDht/bootstrap
---

# SECURITY ASSESSMENT — T334 Slice 3 (kadDht + bootstrap, public-DHT discovery)

Date: 2026-10-03   Assessed against commit: 4b4aef2f (branch claude/t334-dht-build, NOT merged)

Assessed with: security-review (surface map), systematic-debugging (traced each path entry→effect),
bdi-mental-states (adversarial toward the boundary assumption), verification-before-completion
(confirmed vs open split, with live probes). Assessor: Opus 4.8 (security-assessment profile).

## Boundary verdict

**Trusted-LAN boundary: AT RISK (holds in shipped/running code today; architecture has formally
committed to breaking it, and this slice is the first brick).**

Evidence, separated into what is true in CODE now vs what the roadmap commits to:

- **In running code the boundary still HOLDS.** The DHT capability is quadruply dormant: (1)
  `dhtEnabled = process.env.SHORESH_DHT_ENABLED === '1'` defaults false (`syncStarter.js:354`); (2)
  `kadDht`/`bootstrap` carry `signoff: null` (`transportCapabilities.js:70-81`); (3) the Tier-4 guard
  is RED — I ran `transportBoundary.guard.test.js`: 2 failing (the `@libp2p/kad-dht`/`@libp2p/bootstrap`
  packages are in the resolved tree and the `kadDHT` / `bootstrap(` markers appear in `syncStarter.js`,
  both with no signoff) — which is exactly the intended §4-step-1 state; (4) **the kadDHT service is
  not actually attached to the libp2p node even when `dhtEnabled` is flipped** (Finding 1). Installed
  transport remains TCP + Noise + Yamux; discovery is mDNS + optional Cloudflare rendezvous.
- **The roadmap has already retired the boundary in principle.** ADR 2026-10-02 (owner-accepted,
  verbatim delegation) makes the public DHT the *primary* WAN discovery path, not a fringe option.
  "Trusted private LAN" is no longer the governing deployment assumption for the product's intended
  end state; it is now one rung of a ladder whose top rung is a globally-reachable node. The honest
  posture word is therefore AT RISK: the expired assumption has not yet reached running code, but it
  is the declared destination and nothing architectural now stands against it except the capability
  gate.

## Is the public DHT a materially larger exposure than the accepted Cloudflare rendezvous? Yes — the public DHT is worse.

Confirmed by code + a live probe (see Finding 4 / §8.3 below). Three independent axes, all worse:

1. **Exposure population.** Cloudflare rendezvous exposes opaque-namespace→peerId→multiaddr records to
   ONE operator (2026-09-27 §2, accepted). The public DHT with `kadDHT({ clientMode: false })`
   (`syncStarter.js:358` — **server mode**) makes the node JOIN the global Kademlia routing ring: its
   PeerId + multiaddrs, and the provider records it publishes, become observable to an unbounded,
   uncontrolled, globally-distributed population of third-party DHT nodes (whichever happen to sit
   near the CID's key-space, plus anyone who learns the tag). One bound operator → the whole internet.
2. **Pre-auth attack-surface reachability.** This is the larger change and the ADR's safety argument
   does not address it. The rotating tag keeps the camp's *identity* confidential and records
   *un-impersonable* — but it does nothing to shrink who can *reach* the node. A DHT-server node is a
   long-lived, enumerable, internet-reachable endpoint; the pre-auth surface (`authGate.js`,
   `mutualAuth.js`, `joinCode.js`, `rateLimit.js`) becomes reachable from the entire internet rather
   than the LAN + one rendezvous path. The rotating tag is necessary but NOT sufficient containment
   for this axis; the containment that actually bears the load is brute-force-safe tag (confidentiality)
   + the mutualAuth/authGate/rateLimit surface + the capability gate.
3. **Availability/integrity of lookups.** Cloudflare is one operator we can reason about; the public
   DHT is subject to eclipse/Sybil near the key (§5.3, Open Question A below), a class that simply does
   not exist for the single-operator noticeboard.

Verdict on §5.5's explicit question: **the public DHT is the worse exposure class.** It should be
signed off only with that stated plainly, not by analogy to the Cloudflare acceptance.

## Confirmed findings (ranked by leverage)

### F-1 (HIGH leverage — blocks signoff, not a runtime vuln) — The kadDHT service is never attached to the libp2p node; the capability as wired cannot function, so the HARD live-rotation acceptance criterion cannot be met by this code.
- Location: `electron/sync/automerge/syncStarter.js:355-374`, `syncNode.js:81` (startSyncNode destructure),
  `transport.js:66,103` (`startTransport` signature + hardcoded `services: { identify: identify() }`).
- Attack path / effect: `syncStarter.js` builds `dhtServices = { dht: kadDHT({clientMode:false}), bootstrapDiscovery: bootstrap(...) }`
  and passes it to `startSyncNode({ dhtServices, ... })`. **`startSyncNode`'s parameter list (`syncNode.js:81`)
  does not destructure `dhtServices`**, so it is silently dropped; `startTransport` (`transport.js:66`)
  does not accept it either, and the libp2p `services` block is hardcoded to `{ identify: identify() }`
  with no `dht` and no `ping`. Consequence: even if a follow-up PR flips `dhtEnabled` AND the signoff,
  the node never joins the DHT — `createDhtDiscovery`'s `node.contentRouting.provide/findProviders`
  calls run against a node with no content router, throw, are caught and logged, and yield nothing.
- Confirmed how: traced the call chain; `grep` shows `dhtServices` has exactly one reference in
  production code (its creation). A live probe additionally proved `kadDHT({...})` requires a `ping`
  service capability (`UnmetServiceDependenciesError: Service "@libp2p/kad-dht" required capability
  "@libp2p/ping"`) which the production `services` block also lacks — so the current wiring would in
  fact THROW at node construction if `dhtServices` were threaded in as written.
- Why it matters for the gate: the spec §2/§4 presents the wiring as complete ("Maker builds the DHT
  wiring … only the signoff + flag flip remain"). It is not. A whole layer — thread `dhtServices`
  through `startSyncNode`→`startTransport`→libp2p `services`, add `ping()`, choose client vs server
  mode — is missing. Therefore **no real-kad-dht battle test can even run against this code**, and the
  non-negotiable live-rotation-on-the-DHT criterion cannot be demonstrated. This fails safe (the DHT
  simply does nothing), so it is not an exploitable vulnerability — but it is a hard blocker on signoff.
- Fix: implement the service wiring (C1 below) before any battle-test gate; then the real tests of C2/C3.

### F-2 (MEDIUM leverage) — Discovery-tag rotation does NOT by itself cut off a still-connected revoked device; the real cutoff rests entirely on admission-layer eviction, and the shipped test does not prove the end-to-end cutoff.
- Location: `rotatingDiscoveryTag.js:20-30`, `authorityReplay.js:383-395`, `dhtDiscovery.test.js:64-160`.
- Attack path: the rotating tag is `HMAC(campDhtSecret, revocationDigest)` — a *pure function of
  document state*. A revoked device that is still connected and still receiving document state also
  receives the trusted revoke entry, so it computes the SAME new tag and remains mutually discoverable
  under the new tag. Discovery rotation only cuts off a device that has STOPPED receiving document
  state. The genuine cutoff for a still-connected revoked device is the admission/`authorize()` /
  `authenticatedPeers` eviction (T331), NOT this discovery module.
- Confirmed how: read the derivation (pure over `currentRevokedDeviceIds`) and the tests. The shipped
  "HARD live-rotation" test (`dhtDiscovery.test.js:64-100`) proves only that `dhtDiscovery.js` looks up
  `findProviders` against the current tag and never re-queries the stale tag — a narrow property of the
  discovery module. It does NOT prove a revoked-while-running device is severed, because it mocks
  `contentRouting` and never exercises the admission layer. The spec/ADR acknowledge the merge-layer
  check is required "alongside, not instead of" discovery rotation — but the acceptance criterion as
  worded ("its DHT discoverability … must be cut off without a process restart") is satisfied by the
  current test only for the already-disconnected case.
- Fix: C3 — prove the end-to-end cutoff including admission eviction of a still-connected revoked peer.

### F-3 (INFORMATIONAL — confirms a design claim) — F1/F2/F3 of the frozen T329 attempt do not recur over this path.
- Location: `authorityReplay.js:361-395`, `authorityRevocationDigest.js`, `rotatingDiscoveryTag.js`.
- Confirmed how: the DHT keys off `currentRevokedDeviceIds`, which counts an entry only when
  `createVerifiedEntryTrust`'s `isEntryTrusted` passes — the signer's peer id must be causally
  established AND the ed25519 signature must verify, failing CLOSED when no signer identity exists
  (`authorityReplay.js:363-371`). So the revoked set is signature-gated, not a peer-writable scalar —
  **T329-F1 (unsigned peer-writable `campEpoch`) has no analogue here.** Because the tag is a pure
  total function of that signed set, it changes for every computing device the instant the signed set
  converges — **T329-F2's receive-side-only out-wait does not apply to the tag derivation itself**
  (the residual race is the admission-eviction one in F-2, which is architecturally acknowledged and
  is T331's domain, not a re-introduction of F2). The forged-entry case is covered by `isEntryTrusted`
  + T335's own `rotatingDiscoveryTag.test.js` / `authorityRevocationDigest.test.js` — **T329-F3's
  "untested forged/resync" is closed at the UNIT level.** Note it is NOT closed at the real-kad-dht
  multi-node level (see F-4 / Open Questions). The T329 assessment doc itself is not present in this
  worktree (it lives on the frozen `claude/t329-*` branch); this confirmation rests on spec §0's
  F1-F3 description cross-checked against the code.

### F-4 (MEDIUM leverage) — Battle-test coverage is entirely mock-level; the public-DHT-specific adversarial classes are UNTESTED.
- Location: `dhtDiscovery.test.js` (all 9 tests mock `contentRouting` with an inline fake).
- Confirmed how: read the whole file. Every test injects a hand-rolled `fakeContentRouting`. There is
  no real kad-dht node, no multi-node ring, and (because of F-1) there could not be. The ADR's own
  §4 gate requires "real adversarial battle-testing: … DHT poisoning/eclipse, replay … and a
  red-before-green proof that rotation-on-revocation actually cuts a removed device off." None of the
  DHT-specific classes (eclipse, Sybil-near-key, replay-vs-TTL) is exercised at all; the cutoff proof
  is the mock-level F-2 one. Mock-level coverage is adequate to land inert code (§4 step 1) but is
  **not adequate to sign off a public-DHT capability** — the whole point of the gate is the real-network
  adversarial surface, which mocks cannot reach.
- Fix: C2 — real in-process multi-node kad-dht adversarial tests.

## §8.3 public-bootstrap-net dial-level liveness: HEALTHY — VERIFIED HERE (not merely unverifiable).

This environment DID permit egress. I started a real libp2p node (tcp + noise + yamux + identify +
ping + `kadDHT`) with the public bootstrap list from `dhtDiscovery.js` (`DEFAULT_DHT_BOOTSTRAP_NODES`)
and within 20s it dialled and connected to **61 peers** via `/dnsaddr/bootstrap.libp2p.io/...`. The
Governor pre-check's "TCP/4001 filtered" was a bare-port artifact — the real stack resolves DNSADDR to
the bootstrap nodes' actual advertised addresses and connects. Per the organizer ruling this is a
**HEALTHY dial-level result that closes §8.3 with no owner involvement and triggers no escalation.**
(Caveat: the probe used `clientMode:true`; production is configured `clientMode:false` — see Open
Question C. And the gate should still re-run this on the owner's hardware/an independent runner to
confirm it is not specific to this machine's egress, but the "not dependable → escalate" trigger is
NOT met; the net is live.) `npm audit --omit=dev`: 0 vulnerabilities, including kad-dht@16.4.5 /
bootstrap@12.0.32.

## Open questions (NOT findings — need investigation before confirm/drop, and are part of the signoff gate)

- **A. Eclipse / Sybil near the key.** Can an adversary who does NOT know the tag still deny a camp's
  `findProviders` by Sybil-flooding the DHT region near the hashed CID, or intercept/withhold provider
  records? Known public-DHT class, UNTESTED here. What would settle it: a multi-node in-process kad-dht
  test placing adversarial nodes near the key and measuring lookup success/withholding. (Confidentiality
  of the tag does not answer this — it is an availability/integrity question.)
- **B. Replay vs rotation cadence.** Does a captured provider record (multiaddr+peerId) expire on the
  real kad-dht provider-record TTL within a window shorter than the rotation cadence, OR is a replayed
  record harmless because the self-certifying PeerId signature still can't be impersonated? Needs
  measurement against the installed kad-dht@16.4.5 TTL, not assumed.
- **C. clientMode:false (server mode) necessity.** Server mode makes the node answer routing queries
  and join the global routing table — materially wider exposure than clientMode:true. Is server mode
  actually required for `provide`/`findProviders` at Shoresh's scale, or would client mode suffice and
  shrink the surface? Record the decision with evidence.
- **D. join-secret scrypt re-benchmark (§5.1).** The 112.7ms/guess figure is dated 2026-09-27 on a
  specific machine; the ~3.5M CPU-year margin for a public-DHT-wide offline attacker must be
  re-measured at pickup against the real `joinCode.js` scrypt params. Not done in this assessment
  (out of this slice's code; it is the joinCode path).

## Re-opened tradeoffs

- **No-TLS / Noise-only on the wire.** Conditions when accepted: LAN-only reachability. Do they still
  hold? The transport is Noise-encrypted + mutually authenticated end-to-end, which is the right
  property regardless of reachability, so opening the DHT does not by itself invalidate this — BUT it
  removes the "only LAN peers can even attempt the handshake" backstop. Recommendation: keep Noise;
  explicitly re-confirm `rateLimit.js` and `authGate.js` pre-auth hardening are sized for
  internet-scale connection attempts, not LAN-scale, before signoff (this is the real exposure shift,
  not the encryption).
- **Plaintext-PIN-on-wire.** Not reachable over the DHT discovery path (PIN is local `attemptLogin`,
  never transmitted to a discovered peer). Conditions unchanged; not implicated by this slice. No action.
- **"Public DHT/bootstrap counts as infrastructure we don't run" (ADR 2026-10-02).** Conditions when
  accepted: records are opaque + un-impersonable via the rotating tag. Those conditions DO hold for
  confidentiality/impersonation (F-3) but do NOT cover reachability/availability (boundary §2-3 above,
  Open Questions A/B). Recommendation: the acceptance stands for what it actually covers; the signoff
  record must state the uncovered axes explicitly rather than inheriting the Cloudflare acceptance.

## Verdict

**FAIL for capability signoff** (do NOT add the `kadDht`/`bootstrap` signoff entries; do NOT flip
`dhtEnabled`). This is the correct, intended outcome for a §4-step-1 landing: inert code + red guard.
It is **NOT a STOP** — the bootstrap net is dial-level HEALTHY (verified: 61 peers), the eclipse/
poisoning risk is a known, bounded, testable class rather than an un-closeable one, and every blocker
below is closeable. No organizer→owner escalation is triggered by this assessment (§8.3 healthy; no
un-closeable risk).

**Security posture score: 3 / 5.** The signed-rotation primitive genuinely closes the T329 F1-F3 class
at the unit level and the gate discipline (red guard, dormant flag, signoff withheld) is being followed
correctly — but the capability is presented as "wired, pending flip" when a required libp2p service
layer is in fact missing (F-1), the hard live-rotation criterion is unmet, and all DHT adversarial
coverage is mock-level.

### Closeable conditions before signoff
- **C1 (blocker, from F-1):** Thread `dhtServices` through `startSyncNode`→`startTransport`→libp2p
  `services`; add the `ping()` service kad-dht@16 hard-requires (confirmed via UnmetServiceDependencies);
  resolve client vs server mode (Open Question C). Until this exists the capability is non-functional
  and the live-rotation criterion cannot be demonstrated.
- **C2 (blocker, from F-4):** Real in-process multi-node kad-dht adversarial tests — eclipse/Sybil near
  the key (A), replay vs real provider TTL (B) — not mocked `contentRouting`.
- **C3 (blocker, from F-2):** Prove the end-to-end revoke-while-running cutoff INCLUDING admission-layer
  eviction of a still-connected revoked peer, red-before-green — not only that `dhtDiscovery.js` queries
  the current tag. State explicitly that discovery rotation alone does not sever a still-connected
  revoked device.
- **C4:** Re-confirm internet-scale sizing of `rateLimit.js`/`authGate.js` pre-auth hardening (re-opened
  tradeoff above) and re-benchmark the join-secret scrypt margin (D/§5.1) at pickup.
- **C5:** Re-run the §8.3 dial-level liveness on an independent runner/owner hardware to confirm it is
  not specific to this environment's egress (healthy expected; records as evidence, no escalation
  unless it comes back unreachable).
