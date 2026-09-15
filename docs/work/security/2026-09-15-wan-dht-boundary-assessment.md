---
title: "WAN boundary security assessment (public DHT / relay / direct-punch)"
document_type: reference
authority: descriptive
status: active
date: 2026-09-15
program: security-hardening
---

# WAN boundary security assessment — pre-integration

Independent `security-assessment` run under the CORRECT boundary: the app is headed for
cross-internet sync (owner: "it should absolutely be live"). Prior assessments wrongly assumed a
trusted-LAN boundary. **Owner decision (2026-09-15): the target is DIRECT-ONLY, NO RELAY** ("no
server of any kind"). The relay analysis below is retained because whether a camp *needs* a relay is
decided by its ISP (CGNAT), not by policy — see the CGNAT constraint.

## Boundary verdict
Trusted-LAN "holds today" but is **enforced by network topology, not by code**, and one runtime fact
already surprised the guard:

- No internet **discovery** ships: no `@libp2p/kad-dht`/`circuit-relay-v2`/`webrtc`/`websockets`/
  `bootstrap`/`autonat`/`dcutr`/`upnp-nat` in `package.json`; `transport.js` imports none; discovery
  is `createMdnsDiscovery` only (`main.js:2541`). The DHT+relay path is proven in
  `experiments/future-arch/` but NOT integrated.
- **But production binds all interfaces**, not loopback: `main.js:2529` passes
  `listen: ['/ip4/0.0.0.0/tcp/0']` (necessary — loopback would break LAN sync). So the pre-auth
  `authGate` surface is reachable from any path that can route to the host's ip:ephemeral-port —
  shielded today only by NAT/firewall topology + the random unadvertised port + the absence of DHT
  advertising. That is obscurity, not a boundary.

## Must-fix-before-WAN blockers (ranked)

1. **Tier-4 guard is blind to the real bind — CRITICAL (guard integrity).** The guard asserts
   `transport.js`'s `DEFAULT_LISTEN` still contains `127.0.0.1`, but that constant is dead in
   production; the real bind is `0.0.0.0` at `main.js:2529`, which the guard never reads. The one
   mechanical checkpoint against a silent boundary slip cannot see the line that already widened the
   bind. **Fix now, independent of WAN.** The real boundary today is "no internet DISCOVERY"
   (mDNS-only, no DHT/relay/bootstrap dep), not "loopback bind" — the guard and docs must say that.
2. **Join code is 40-bit, deterministic from campId, never rotates — HIGH once discovery is public.**
   `joinCode.js:78-84`: `base32(sha256(campId)[:5])` = 40 bits, permanent. On any public rendezvous
   (DHT), the code becomes the internet-wide discovery key: knowing it yields the Host's peerId+IPs,
   and any leaked code grants permanent discoverability + permanent reach to the pre-auth surface.
   **Fix before WAN:** ephemeral, Host-minted, rotating, higher-entropy join secret; scope any DHT
   `provide` to the director's open Add-a-device window only.
3. **Off-LAN, PIN confidentiality reduces to the join proof — HIGH.** The PIN is NOT plaintext (Noise
   encrypts, always) and `joinSession.js:275` withholds it until the Host proves join-code knowledge
   — but that proof is HMAC over the 40-bit code, so an attacker who knows/guesses the code can run
   an impostor Host and harvest the PIN on first join. Resolved by fixing #2.
4. **DoS sized for a few LAN peers — HIGH once WAN.** `MAX_CONNECTIONS=200`, `MAX_PENDING_PAIRING=50`;
   per-frame throttles are evadable by opening a fresh connection per frame (the code admits this and
   leans on the connection ceiling + Noise handshake cost). At internet scale that is a handshake-
   flood availability DoS. **Fix before WAN:** per-source connection-rate limiting + handshake cost
   controls + re-sized ceilings.
5. **No code signing / update integrity — MEDIUM now, blocker before WAN.** `mac.identity:null`,
   unsigned Windows nsis, `asar:false` (loose files). No auto-update exists today (so no update-RCE
   channel yet), but signing+notarization and signed/integrity-checked update are required before an
   internet-connected app, and any update mechanism will ship unsigned by default if added blind.

## The CGNAT constraint (first-class finding for the direct-only decision)
Whether two devices need a relay is decided by their ISPs' NAT type, not by our policy. Direct
hole-punch (dcutr) works for many NAT types, but **two peers both behind symmetric NAT / CGNAT
cannot be connected directly — this is a networking invariant, not an effort problem.** A no-relay
policy therefore cannot *guarantee* cross-network sync for every camp; CGNAT-both-ends pairs fall
back to LAN-only. Separately, hole-punch coordination itself needs a rendezvous (a DHT/bootstrap
network = public servers we don't run, or the LAN-pair-then-remember approach). "No server of any
kind" needs a definition: does the public DHT/bootstrap network count?

## Assessed, NOT blockers
- **Login lockout holds up under WAN better than feared:** the 5/30s counter is central per username
  (server-side), so many WAN connections share one budget; and `evaluateLogin` gates the PIN path
  behind a valid 64-hex `device_secret_identifier` — a fresh WAN attacker cannot reach `attemptLogin`
  without already being a director-approved paired device. With T163 (6-digit admin PIN) + Q1/T172
  signing, distributed brute force is materially bounded.
- **Public relay (if ever used) confidentiality/integrity is fine:** circuit-relay-v2 relays a
  Noise-encrypted connection; the relay cannot read or forge camp traffic. Residual is availability +
  metadata only; the trusted relay must be pinned/authenticated.
- **Q1/T172 credential signing holds** under this boundary (Ed25519 on the Host key, transport-
  independent); the pubkey-swap bypass stays closed (`signing_public_key` not a replicable field).
- Defense-in-depth (not blockers): no CSP in `index.html`; no `setWindowOpenHandler`/`will-navigate`
  guard — cheap hardening given the renderer displays attacker-authorable imported spreadsheet text.

## Already exposed today?
Partially, and it is NOT the DHT: with `SHORESH_SYNC_ENGINE=automerge` the node binds `0.0.0.0`, so
the pre-auth surface is reachable from any routable network path — shielded only by topology + the
random unadvertised port, and the Tier-4 guard does not see it (#1). A Host on a public-IP machine,
or any future relay/DHT/bootstrap, makes the surface live immediately with #2/#3/#4 intact. Correct
#1 first.

## Score (for Grader): 3
Auth/merge core is well-built and Noise + Q1/T172 make it stronger than the ADR's stale
"no TLS / plaintext PIN" framing implies — but the boundary is topology-enforced (production binds
`0.0.0.0`), the guard is blind to that, and the 40-bit non-rotating join code + LAN-sized rate
limits are hard blockers before any internet-reachable transport.
