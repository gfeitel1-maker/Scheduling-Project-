---
title: "Rendezvous (Cloudflare Worker + KV) WAN boundary security assessment"
document_type: reference
authority: descriptive
status: active
date: 2026-09-17
program: security-hardening
---

# Rendezvous WAN assessment — pre-implementation

Continuation of `docs/work/security/2026-09-15-wan-dht-boundary-assessment.md`, re-run against the
external "Serverless Rendezvous & WAN Connectivity" spec (Cloudflare Worker + Workers KV bulletin
board at `rendezvous.shoresh.org`, phases A–F). Assessed against commit `78a3586`.
Everything below was confirmed by reading the file cited; opinions are labelled.

## Boundary verdict

**Trusted-LAN: HOLDS TODAY, and the Tier-4 guard CANNOT detect the proposed change.**

- Shipped state still LAN-only: `package.json:41-48` declares only `@libp2p/identify`,
  `@libp2p/mdns`, `@libp2p/tcp`, `libp2p@2.10.0` — no relay/DHT/bootstrap/autonat/dcutr/upnp.
  `electron/main.js:2707` wires `peerDiscovery: [createMdnsDiscovery({ campId })]`; bind is
  `/ip4/0.0.0.0/tcp/0` (`electron/main.js:2695`).
- **The guard is evadable by this exact design.** `transportBoundary.guard.test.js:30-40` matches on
  a fixed *package list*, and :67 asserts `/peerDiscovery:\s*\[\s*createMdnsDiscovery\(/`. Phases A–C
  of the spec add **no listed package** (an HTTPS `fetch` to a Worker is not a libp2p transport) and
  a rendezvous discovery service appended *after* `createMdnsDiscovery(` in the same array still
  satisfies that regex. The marker blocklist (:72) contains `kadDHT, circuitRelay, bootstrap(,
  dcutr, autonat, webRTC` — none of which a Worker-based rendezvous mentions. So Phases A–C could
  ship fully green while publishing this node's real WAN addresses to the public internet. This is
  the single most important finding in this document: the Tier-4 checkpoint the ADR calls
  "unavoidable by construction" is avoidable by construction for the design actually proposed.

## Carry-forward: status of the five 2026-09-15 blockers (verified in tree today)

1. **Guard blind to the real bind — FIXED, but incompletely.** The guard now reads
   `electron/main.js` and asserts mDNS-only discovery (`transportBoundary.guard.test.js:56-78`).
   Deterministic. It is however still *package/marker*-shaped, hence the evasion above → re-opened as
   new finding R1.
2. **40-bit campId-derived, non-rotating join code — OPEN. Refutation attempt failed; confirmed.**
   `electron/sync/joinCode.js:78-84`: `crypto.createHash('sha256').update(campId)` → first 5 bytes →
   Crockford base32 → 8 chars = 40 bits, pure function of `campId`, no rotation, no expiry.
   `joinDiscoveryTag` (:129-136) = `sha256(code)[:16]`. The accepted ADR
   `docs/adr/2026-09-15-ephemeral-join-secret-for-wan-discovery.md` is `implementation_state:
   proposed`, and a repo-wide search for `ephemeralJoin|joinSecret|join_secret` in `electron/` and
   `src/` returns nothing. **Unimplemented. Owner's belief is correct.**
3. **PIN confidentiality off-LAN reduces to the join proof — OPEN (derivative of #2).**
   `joinProof` is `HMAC(code, role|nonce)` (`joinCode.js:184-194`); its strength is the 40 bits of #2.
4. **LAN-sized DoS limits — PARTIALLY FIXED.** `electron/sync/automerge/connectionRateLimiter.js`
   now exists (per-source-IP: 30 new conns/10s, 20 concurrent) and is wired into the real transport
   at `electron/sync/automerge/transport.js:74,87-91,107`. It is deliberately inert for private/
   loopback sources (`isPrivateOrLoopback`, :27-43) so it activates exactly when WAN arrives — good.
   Still open: `MAX_CONNECTIONS = 200` (`transport.js:46`) and `MAX_PENDING_PAIRING = 50`
   (`authGate.js:53`) are unchanged global ceilings, so a distributed flood from many source IPs
   (each under the per-IP cap) still exhausts them. Fail-open on unknown source (`:29`) is correct
   for LAN and becomes a gap for `/p2p-circuit` addresses in Phase F.
5. **No code signing / update integrity — OPEN, unchanged.** `package.json` `build`: `"asar": false`,
   `mac.identity: null`, `win.target: "nsis"` with no signing config, no `publish`/auto-update.

## Does the rendezvous design change the blocker set?

Yes, and precisely. The spec's §7 namespace (256-bit random, generated at trusted setup, never the
camp id or join code) is a **different key on a different surface**. Two surfaces must be kept apart:

- **RE-DISCOVERY surface (already-paired peers, the rendezvous path).** Keyed by the random
  namespace. Blocker #2 does **not** attach here: the namespace is not derived from `campId` and is
  not the join code. Blocker #3 does not attach either — no PIN crosses the rendezvous path.
- **JOIN surface (a brand-new device, first pairing).** Still keyed by the 40-bit join code
  (`joinCode.js:78`) and still mDNS-only. Blockers #2 and #3 remain **fully open here**, unchanged.

So: the rendezvous design *dissolves #2/#3 for the rendezvous path only*, provided — and this is a
hard precondition, not a detail — the implementation never publishes the join tag, the camp id, or
any `campId`-derived value to the Worker, and never lets a rendezvous-discovered peer enter the
*first-pairing* flow. The spec says this (§7, §10, §24); nothing in the current code enforces it.
Blockers #4 and #5 attach to **both** surfaces and are unaffected by the namespace change: #4
because rendezvous makes real WAN addresses reachable, #5 because an internet-talking app is the
condition under which unsigned update becomes an RCE channel.

## Confirmed findings (ranked by leverage)

**R1 — Tier-4 guard does not cover HTTPS-based rendezvous | CRITICAL | `transportBoundary.guard.test.js:30-77`.**
Attack path: a future change adds `electron/sync/rendezvous/*.js` doing `fetch('https://rendezvous.shoresh.org/v1/register')`
and appends a discovery service to `main.js:2707`'s array. No listed package is added; the
`createMdnsDiscovery(` regex still matches; the marker list has no term for it; suite green. The
boundary changes with no checkpoint. Confirmed by reading the three assertions against the spec's
Phase A–C shape. **Fix:** before any rendezvous code lands, extend the guard to fail on (a) any
outbound network call from `electron/**` to a non-loopback host outside the existing libp2p stack,
(b) the literal `rendezvous.shoresh.org` / any `https://` constant under `electron/sync/`, and
(c) `peerDiscovery` arrays with more than one element. Guard-first, then implementation.

**R2 — A rendezvous-discovered peer is dialed and handed this device's session token with NO local-trust check | CRITICAL | `electron/sync/automerge/mutualAuth.js:28-101`, `transport.js:263-264`, `electron/auth/localAuth.js:441-484`.**
This is the finding that falsifies the spec's claim that "possession of the namespace is not
sufficient authentication" *against the code that would consume it*. Trace:
`transport.js:358-362` fires `onPeerDiscovery({id, multiaddrs})` for **every** peer the discovery
mechanism surfaces; `mutualAuth.js:97` subscribes and calls `tryAuthenticate(id)`;
`tryAuthenticate` (:36-77) checks only an `attempted` Set and whether a token exists — **there is no
check that `peerId` is a locally-trusted device** — then calls
`syncNodeHandle.authenticateWith(peerId, { type:'authenticate', token, device_id: deviceId })`,
which dials the peer and sends the frame (`transport.js:263-281`). Today the only thing preventing
this from reaching a hostile peer is that mDNS is camp-tag-scoped and link-local. Wire rendezvous
into that same `onPeerDiscovery` seam — which the spec §3/§10 explicitly asks for — and anyone who
can POST to the namespace induces our node to dial them and send a valid session token.
The token is a **bearer credential with no channel binding**: `verifySessionToken`
(`localAuth.js:441-484`) verifies an Ed25519 signature over the payload and nothing about the
connection, and `evaluateAuthenticate` (`electron/auth/connectionAuth.js:33-75`) admits on
`token` + matching `device_id` + `devices` trust — both of which the attacker just received in the
same frame. The attacker replays them to the real Host and is admitted to the doc-sync protocol,
i.e. full CRDT read/write until `exp`. **Fix (mandatory before Phase C):** enforce the spec's §10
rule *in code, at the discovery seam* — filter discovered peerIds against local trust state before
`tryAuthenticate`, and add a test that a rendezvous-sourced unknown peerId never reaches
`authenticateWith`. Separately, bind the session token to the libp2p peerId (or make the
authenticate frame a challenge-response over the peer's key) so an exfiltrated token is not
replayable. Note the Noise handshake does **not** save us here: it authenticates whatever key the
attacker legitimately owns, and the attacker is announcing its own real peerId.

**R3 — Address-card poisoning / dial redirection | MEDIUM | same seam.**
A namespace holder posting a *trusted* peerId with attacker-chosen multiaddrs cannot complete the
Noise handshake (no private key), so no token leaks on that variant — confirmed: `authenticateWith`
only sends after `dialProtocol` succeeds. Residual, real: (a) forced dials to arbitrary
attacker-chosen ip:port from the user's machine — a scanning/SSRF-ish primitive and a
connect-amplification vector; (b) denial of re-discovery, because `attempted` (mutualAuth.js:34) is
only cleared on failure and a flood of bogus cards for real peerIds exhausts dial attempts;
(c) with fabricated peerIds, unbounded dial fan-out. **Fix:** cap accepted records per namespace per
fetch, cap dial concurrency from rendezvous-sourced addresses, reject non-global/loopback/RFC1918
multiaddrs in records, and require the local-trust filter of R2 *before* dialing, not after.

**R4 — Replay of an old signed record | MEDIUM | design-level, no code yet.**
The spec §11 binds `issuedAt`/`expiresAt` into the signature and relies on client-side freshness.
That is sound *only if* the client clock is trusted and the signed material includes the namespace
(it does, §11). Residual: within the ~2h window, an old card is indistinguishable from a current one,
so a peer that has moved networks can be pinned to a stale address (a downgrade/DoS, not a
compromise). Monotonic sequence per peerId, rejecting any record with `seq` below the highest seen,
closes it; the codebase already has the `cred_version` precedent from T172.

**R5 — Registration flooding of a namespace | MEDIUM.**
Nothing in the spec bounds writes per namespace. Anyone holding the namespace can write unbounded
`<peerId>` keys (KV key is `shoresh:rendezvous:<namespace>:<peerId>`, §9), inflating the GET response
and driving R3's dial fan-out, plus Cloudflare cost. **Fix:** Worker-side per-namespace key cap
(e.g. 16) and per-IP write rate limit; client-side hard cap on records processed per fetch.

**R6 — Privacy: the bulletin board is a location register for children's summer camps | HIGH.**
First-class, not a footnote. The records are, by design, current **public IP addresses** of camp
director/staff laptops, refreshed on every network change (§12). Consequences confirmed against the
spec text: (a) a namespace holder — or Cloudflare, or anyone who compels Cloudflare — can geolocate
a camp's devices to city/ISP granularity and watch them move, in near-real-time, on a ~2h refresh
cadence; (b) correlation: all peerIds under one namespace are provably the same organisation, and a
peerId is stable across namespaces and networks, so devices are trackable between camps and over
seasons; (c) retention: KV TTL garbage-collects the *record*, but Cloudflare request logs, Analytics,
and any KV backup are outside the app's control and are not TTL'd by §9; (d) enumeration: a 256-bit
namespace is not guessable, so bulk enumeration is not the risk — *disclosure* of one namespace is,
and namespaces per §7 never rotate. **Fixes:** make the namespace rotatable and revocable (a
director must be able to burn a leaked one); encrypt the address card body under a key derived from
the camp secret so Cloudflare stores ciphertext and only the namespace is plaintext; set the Worker
to no request logging / minimal Analytics and record that in a published privacy note; treat the
namespace as a secret in the UI (never shown in a screenshot-able "share this" panel, never in logs
per §21); and write down the legal-compulsion posture — this is US-hosted infrastructure holding
the movement patterns of staff at children's camps.

**R7 — Malicious or compelled Cloudflare operator | MEDIUM (bounded, but larger than the spec implies).**
Confirmed against the code path: the operator **cannot read or forge camp data** (Noise + the
signature requirement + `authenticatedPeers` gating in `transport.js`), and cannot mint trust
(`evaluateAuthenticate` requires a Host-signed token). The operator **can**: withhold records
(silent WAN-sync outage, indistinguishable from a network failure — spec §13's diagnostics
distinction is therefore a security control, not just UX); read every address card (R6); correlate
and geolocate; and **inject arbitrary records**, which is only harmless once R2 is fixed — with R2
open, the Worker operator is a full compromise path. State plainly in SECURITY.md that the operator
is in the *availability and metadata* trust base, not the confidentiality/integrity one.

**R8 — Pre-auth `authGate` surface becomes internet-reachable | HIGH (aggregate).**
Publishing real WAN multiaddrs removes the "random unadvertised port + NAT" obscurity the
2026-09-15 assessment named as the actual boundary. Everything reachable pre-authentication —
`authGate.js`'s `authenticate` / `pairing_request` / `login` handlers, all parsing attacker-supplied
JSON (`decodeMessage`, `authGate.js:86-88`) — becomes hostile-internet-facing. Blocker #4's residual
(global `MAX_CONNECTIONS=200` / `MAX_PENDING_PAIRING=50`) is the concrete exposure, since the
per-IP limiter does not bound a distributed flood. Fuzzing of the pre-auth frame parsers should be
re-run before Phase C, not after.

## Open questions (NOT findings)

- Does `libp2p@2.10.0`'s connection manager auto-dial discovered peers independently of
  `mutualAuth`? If it does, R3's dial fan-out is worse and cannot be fixed in `mutualAuth` alone.
  *Settled by:* reading the installed `libp2p@2.10.0` connection-manager source for an auto-dial
  component and its default.
- Does any existing code path treat the camp id as non-sensitive in a way that would let it reach
  the Worker (e.g. through an address card field or a log)? *Settled by:* a taint trace once the
  rendezvous module exists; unanswerable today.
- What is the actual `npm audit` posture at the versions a Worker/rendezvous change would pin?
  Not run for this assessment; must be part of the Phase-C gate.

## Re-opened tradeoffs

- **"Noise proves a channel, not membership" (SECURITY.md:152-158).** Accepted when every peer was
  physically on a director's LAN. Under rendezvous, the peer on the other end of a Noise channel is
  an arbitrary internet host that a bulletin board named. **No longer acceptable as-is** — R2 is the
  concrete failure. Recommendation: peerId-bound session tokens.
- **Join code as "not a secret" (`joinCode.js:14-21`, the file predicts this).** Still acceptable
  *for the LAN join path only*, and only for as long as rendezvous never carries a join tag.
  Recommendation: implement the accepted ephemeral-secret ADR before Phase C anyway, because the
  separation between the two surfaces is a convention nothing enforces today.
- **Unsigned builds / `asar:false` / `identity:null`.** Accepted for a non-internet app. Once the
  app talks to `rendezvous.shoresh.org`, this expires. Recommendation: signing + notarization before
  Phase C; no auto-update until signed.
- **Device-side role enforcement under CRDT merge.** Unchanged by rendezvous *provided* R2 is fixed;
  if R2 is not fixed, a rendezvous-sourced attacker becomes a "paired peer" and this tradeoff is
  being made against an internet adversary rather than a camp employee. Re-confirm after R2.

## Tier-4 sign-off: which phases need the flip, and the preconditions

**Mechanically, under the guard as written today (`transportBoundary.guard.test.js`):**

| Phase | Trips the guard? | Should it require sign-off? |
|---|---|---|
| A — Worker + KV API, no client | No (no repo change) | No |
| B — real libp2p records published from the app | **No** (evadable, R1) | **YES — this is the boundary change** |
| C — feed discoveries into dial/mutual-auth | **No** (evadable, R1) | **YES** |
| D — `@libp2p/upnp-nat` | Yes (:39) | Yes |
| E — measurement only | No | No (if B/C already signed off) |
| F — `@libp2p/dcutr`, `@libp2p/circuit-relay-v2` | Yes (:30-38) | Yes |

The gap between column 2 and column 3 for Phases B and C **is** finding R1. Fix the guard first so
the mechanism matches the intent.

**Preconditions that must ALL be true before a human flips `INTERNET_TRANSPORT_SIGNOFF`** (checkable,
in order; I am not authorized to flip it and have not touched the guard):

1. Guard extended to detect HTTPS/Worker rendezvous and multi-element `peerDiscovery` (R1), with a
   non-vacuity test that plants a rendezvous-shaped change and sees it go red.
2. Local-trust filter enforced at the discovery seam: a discovered peerId not in local trust state
   never reaches `authenticateWith`; test asserts it (R2).
3. Session token bound to the libp2p peerId, or authenticate replaced by challenge-response; test
   asserts an exfiltrated token replayed from a different peerId is rejected (R2).
4. Ephemeral/rotating join secret ADR implemented and the 40-bit `joinCode(campId)` derivation gone
   (blocker #2/#3), with `joinCode.test.js` vectors updated deliberately.
5. Rendezvous namespace is rotatable and revocable by the director, is never `campId`-derived, and
   a guard test asserts no `campId`/join-tag-derived value can be placed in an address card (R6).
6. Address-card body encrypted to the camp; the Worker stores ciphertext + namespace only (R6).
7. Worker enforces per-namespace key cap and per-IP write rate limit; client caps records processed
   per fetch and dial concurrency from rendezvous sources (R3/R5).
8. Record replay bounded by a monotonic per-peer sequence, not freshness alone (R4).
9. Global `MAX_CONNECTIONS` / `MAX_PENDING_PAIRING` re-sized for hostile scale, with a documented
   rationale; pre-auth frame-parser fuzzing re-run green (R8, blocker #4 residual).
10. Builds signed + notarized (macOS) and signed (Windows); `asar` reconsidered; no auto-update
    channel added unsigned (blocker #5).
11. Cloudflare logging/retention posture written into SECURITY.md, with the operator explicitly
    placed in the availability+metadata trust base only (R6/R7).
12. `npm audit` clean at the pinned tree and this assessment (plus an R2-focused review) recorded.

Phases A and E can proceed now. **Phases B, C, D and F must not.**

## Summary Score (for Grader)

**Security posture: 2** — The auth/merge core remains well-built and blocker #1 was genuinely fixed
and #4 half-fixed, but the proposed design lands on two confirmed critical seams at once: the Tier-4
guard cannot see an HTTPS rendezvous (R1), and the discovery→`mutualAuth` path hands this device's
bearer session token to *any* peerId a discovery mechanism surfaces (R2), while the accepted
ephemeral-join-secret ADR remains unimplemented.
