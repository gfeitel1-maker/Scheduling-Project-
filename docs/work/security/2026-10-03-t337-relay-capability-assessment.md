---
title: "T337 — camp-peer circuit-relay-v2 coordination capability deep security assessment"
document_type: security
authority: evidence
status: active
task_class: security-auth
created: 2026-10-03
assessed_commit: 227187bb74d565bb5ec1ec99a31f5a62503380fb
governing_docs: [docs/work/specs/2026-10-03-t337-coordination-layer-design.md, docs/adr/2026-10-02-wan-discovery-transport-ladder.md, docs/work/security/2026-10-03-t334-dht-capability-assessment.md, SECURITY.md]
archive_when: the T337 relay(coordination) capability+battle-test gate records its final signoff decision
---

# SECURITY ASSESSMENT — T337 (relay, @libp2p/circuit-relay-v2 coordination-only)

Date: 2026-10-03   Assessed against commit: 227187bb (branch claude/t337-coordination-build, NOT merged)

Assessed with: security-review (surface map), systematic-debugging (traced each path entry→effect),
bdi-mental-states (adversarial toward the trusted-LAN boundary), verification-before-completion
(confirmed-vs-open split; ran the guard + all three battle-tests + library-default probes).
Assessor: Opus 4.8 (security-assessment profile). Installed package verified: @libp2p/circuit-relay-v2@4.2.13.

## Boundary verdict

**Trusted-LAN boundary: HOLDS in running code; AT RISK only at the runtime-enablement step, which is
not reached by this commit.** Narrower and better-contained than the T334 DHT slice.

Evidence, separated into CODE-now vs ROADMAP:

- **In running code the boundary HOLDS, triple-gated.** (1) `transportBoundary.guard.test.js` is RED —
  I ran it: 2 failing (`@libp2p/circuit-relay-v2` present in the resolved tree; `circuitRelay` marker
  present in `syncStarter.js`), both correct for the §E-step-1 "code landed, signoff withheld" state.
  (2) `relay.signoff: null` in `transportCapabilities.js:34-39`. (3) `SHORESH_RELAY_ENABLED` is read
  only as `=== 'true'` (`syncStarter.js:352`) and defaults unset/false — with it unset, `startSyncNode`
  receives `relayServerFactory`/`relayTransportFactory` = `undefined`, and `transport.js` adds neither
  the relay transport, the relay service, nor the two connectionGater hooks. The node is byte-identical
  to pre-T337: TCP + Noise + Yamux, mDNS (+ optional rendezvous) discovery.
- **The relay role, when enabled, does NOT become an open/public relay — confirmed end-to-end.** The
  server's `denyInboundRelayReservation`/`denyOutboundRelayedConnection` hooks (`transport.js:118-134`)
  both read `isPeerAdmittedForRelay`, which after `registerAuthGate` is reassigned to
  `(peerId) => authenticatedPeers.has(peerId)` (`transport.js:165`) — the SAME set `broadcastDoc` gates
  every send on, and the SAME set `revokePeer` deletes from (`transport.js:474`). A RESERVE from a
  non-admitted peer is refused before a reservation exists; a CONNECT is refused unless BOTH requester
  and destination are currently admitted. Key format is consistent (`String(peerId)` on admit/revoke,
  `peerId.toString()` at the gater). This is enforced by circuit-relay-v2's own extension points, not an
  app-side afterthought, and is proven by real multi-node tests (below). It stays inside the owner's
  "camp-internal, no public broadcast" line: there is no publish-to-an-unbounded-population step
  anywhere (contrast the rejected DHT's `provide`/`findProviders`), and no public-relay/bootstrap/DHT
  discovery is wired, so the peer population this node can relay for OR reserve on is the camp-admitted
  set reached via mDNS/direct dial.
- **Roadmap.** The ADR (owner-decided 2026-10-03) makes remembered-address + hole-punch the PRIMARY WAN
  path, with this coordination relay as its foundation and a camp peer — not Cloudflare, not a
  Shoresh-run node — as the coordination point. That is materially gentler on the boundary than the
  rejected DHT: coordination is camp-peer-to-camp-peer, never a public population.

## Confirmed findings (ranked by leverage)

**F-1 (HIGH leverage — procedural gap, not a runtime vuln) — Nothing mechanical ties runtime
enablement (`SHORESH_RELAY_ENABLED=true`) to T336/dcutr having landed. T337 enabled ALONE would make a
camp peer a standing TRAFFIC relay, which is the owner's RARE tier-3 role, not the coordinate-then-drop
primary.**
- Location: `syncStarter.js:352-359`, `transport.js:96-137`; the dcutr upgrade is T336, not built.
- Attack path / effect: `dcutr` upgrades an existing connection to direct; it does not create one
  (ADR amendment 2026-10-03; T337 spec §A). Without it, any connection that rides a `circuit-relay-v2`
  hop stays on the relay — R carries the bytes for its whole life (capped per reservation; see F-2),
  never "briefly coordinates then drops out." So a build with the relay flag on but dcutr absent uses
  the relay as a de-facto data path — exactly the tier-3 role the owner reserves for the rare
  un-punchable case, silently promoted to normal operation.
- Confirmed how: traced the wiring. `selectCoordinationCandidates` (the §A candidate-R selection) is
  present in `peerAddressBook.js:127` but has ZERO production callers (grep) — the coordinate-then-punch
  flow that consumes it is T336. So T337-alone does not itself construct a relayed sync dial; the latent
  hazard is that enabling the flag turns on circuit-relay-v2's own client auto-reservation (F-3) and
  server, after which a relayed connection, once formed, has nothing to upgrade it. The mechanical
  protections that exist (guard + signoff gate MERGE; flag gates RUNTIME) do NOT include any check that
  dcutr is present before the flag may be set true. A future one-line env/default change could enable
  the relay as the primary data path with no re-review.
- Fix / recommendation (this is the central T337-before-T336 call): **T337 MAY be signed off and merged
  alone** — the code is correctly inert (guard-RED-until-signoff, flag-default-false), well-contained,
  and genuinely wired (unlike T334-F1). **But the signoff record MUST explicitly withhold runtime
  enablement until T336 (dcutr/autonat) co-lands and is itself signed off.** Concretely: the `relay`
  coordination signoff authorizes the CODE to merge inert; it does NOT authorize `SHORESH_RELAY_ENABLED=true`
  in any real-camp build. Strengthen the mechanism rather than relying on prose: add a guard/test
  asserting the relay flag cannot be effectively enabled while the `dcutr` row is `signoff: null`
  (i.e. couple relay-runtime-enable to dcutr-signed-off), so "enabled alone" is impossible by
  construction, not by discipline. Do NOT merge with the signoff written AND the flag defaulted true.

**F-2 (LOW leverage — bounded by library + gater) — Volunteer-relay (malicious-but-admitted R) abuse
surface is real but well-bounded; it is not a meaningfully new insider threat.**
- Location: `syncStarter.js:356-358` (`circuitRelayServer({ reservations: { defaultDataLimit: 131072n,
  defaultDurationLimit: 120000 } })`); library `constants.js` (`DEFAULT_MAX_RESERVATION_STORE_SIZE = 15`,
  `DEFAULT_MAX_RESERVATION_TTL = 2*60*minute`, `DEFAULT_MAX_RESERVATION_QUEUE_LENGTH = 100`).
- Assessment: DoS-by-reservation-exhaustion against R is bounded three ways: only camp-admitted peers
  can reserve at all (gater), concurrent reservations default-capped at 15, and each relayed stream is
  capped at 128 KiB / 2 min (the ADR coordination ceiling, set explicitly). A malicious admitted R
  cannot read relayed traffic (it is Noise-ciphertext end-to-end; R holds no session key — the
  2026-09-27 §2 CONFIRMED property, re-confirmed here against v4.2.13's forward-only relay role). R
  learns only that B and C are online + their reflexive addresses — facts R is already camp-entitled to
  as a fellow admitted member (spec §B, confirmed). A malicious R's real powers are (a) refuse to
  broker (availability only — B tries the next candidate), (b) the metadata it already has standing to
  see. No new confidentiality category. Insider threat is not materially widened by the relay role.
- Recommendation: minor — `maxReservations` is left at the library default 15 (only data/duration limits
  are overridden). 15 is ample for a camp and bounds exhaustion; no change required, but set it
  explicitly to a camp-appropriate value when the data-path slice (Slice B) lands, so the coordination
  and data-path caps are not conflated.

## Open questions (NOT findings — settle before signoff)

- **Q-A. Client-side auto-reservation population.** `circuitRelayTransport()` (added to `transports`
  when enabled, `transport.js:99`) instantiates a `RelayDiscovery` + `ReservationStore` that, on
  `relay:not-enough-relays`, auto-starts discovery and reserves on any connected peer advertising the
  HOP codec (library `transport/index.js:49-65`). In THIS deployment the connected-peer set is
  camp-admitted only (no public bootstrap/DHT), so the reachable relay population should be camp-only —
  but the two connectionGater hooks govern R's SERVER role, NOT which relays this node reserves ON as a
  client. What would settle it: a test proving an enabled client auto-reserves only on admitted camp
  peers and advertises `/p2p-circuit` addresses reachable only through them — i.e. that the client role,
  like the server role, cannot reach a non-camp population. This is the §C "second place the hazard
  could leak back in" applied to the client side; the spec's §C red-before-green discipline should cover
  it explicitly, not by inference.
- **Q-B. Final B↔C hop under relay.** `relayRevokeWhileRunning.test.js` honestly scopes itself to the
  RESERVE/CONNECT broker gate and does not drive a full relayed data connection to the destination's STOP
  handshake (that is T336-adjacent). It asserts the pre-existing per-stream `authenticatedPeers` check in
  `node.handle(PROTO/SYNC_PROTO)` covers the final hop. That check is unchanged and transport-agnostic, so
  the claim is sound — but it is asserted, not exercised over a relay transport here. Confirm it with an
  end-to-end relayed-connection admission test when T336 wires the consuming path.

## Re-opened tradeoffs

- **No-TLS / Noise-only on the wire.** Accepted under LAN-only reachability. Still holds: transport is
  Noise-encrypted + mutually authenticated end-to-end, and the relay forwards ciphertext only (R holds no
  key). Opening the coordination relay does not invalidate it. The real shift to re-confirm before any
  RUNTIME enable (with F-1): `rateLimit.js`/`authGate.js` pre-auth hardening sized for the connection
  attempts an internet-reachable relay client/server invites, not LAN scale — same C4 condition T334 raised.
- **Plaintext-PIN-on-wire.** Not reachable over this path (PIN is local `attemptLogin`, never transmitted
  to a relayed/discovered peer). Unimplicated. No action.
- **"Trusted private LAN" deployment boundary.** Accepted when the only transport was loopback+mDNS. This
  slice does NOT yet break it (flag default false), but it is the foundation of the path that will. The
  containment that carries the load once enabled is admission (`authenticatedPeers`) + the gater reading
  it live + the 128 KiB/2 min cap — NOT reachability. Recommendation: the signoff record must state that
  the boundary moves only at `SHORESH_RELAY_ENABLED=true`, and that step is gated-until-T336 (F-1).

## Verdict

**PASS for capability signoff (code merge) — CONDITIONAL on F-1's enablement gate being written/mechanized.**
Security posture: **4 / 5.**

The code is genuinely and correctly wired (the T334-F1 "service never attached" failure does NOT recur
here — the relay server IS attached and the gater IS reassigned after `authenticatedPeers` exists,
proven by passing real multi-node tests incl. a red-before-green non-vacuity case). The camp-only
restriction holds end-to-end at the server role. The exposure is categorically gentler than the rejected
DHT and stays within the owner's camp-internal line. `npm audit --omit=dev`: 0 vulnerabilities.

It is **not 5/5** and **not an unconditional PASS** because of F-1: nothing mechanical prevents a build
from enabling the relay as a standing traffic path before dcutr exists, which would silently install the
owner's RARE tier-3 role as normal operation. This is **not a STOP** (no un-closeable risk, no spend/infra
required) — it is closeable in-loop.

### Closeable conditions before the signoff entry is written
- **C1 (blocker, from F-1):** The `relay` coordination signoff authorizes CODE MERGE only, inert. Write
  into the signoff record that `SHORESH_RELAY_ENABLED=true` is withheld until T336 (dcutr) is signed off,
  AND add a guard/test coupling relay-runtime-enablement to the `dcutr` row being signed off, so
  "enabled alone" is impossible by construction. (Recommendation: T337 signed off / merged alone — yes;
  runtime-enabled alone — no.)
- **C2 (from Q-A):** Red-before-green test that the enabled relay CLIENT auto-reserves/advertises only via
  camp-admitted peers (the client-role analogue of §C's server-role scoping proof).
- **C3 (from Q-B):** End-to-end admission test over a real relayed connection when T336 wires the consumer,
  confirming the final B↔C hop is admission-checked over the relay transport.
- **C4 (from re-opened tradeoff):** Re-confirm `rateLimit.js`/`authGate.js` pre-auth sizing for
  internet-scale attempts before the flag is ever set true.
