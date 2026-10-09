# SECURITY ASSESSMENT — WAN punch/reconnect ladder, default-on go-live (T327 S5)

Date: 2026-10-09   Assessed against commit: `c80a0032` (origin/main), plus open PRs #836 and #837 read via `gh pr diff`

Scope: the reconnect ladder behind `SHORESH_PUNCH_ENABLED` (LAN, then rung 1 remembered reflexive
redial, rung 2 camp-peer gossip with signaling, rung 3 rendezvous), the punch transport
(`node-datachannel`), the live rendezvous Worker (`workers/rendezvous/`), and what changes if the
flag defaults on.

Method: I read the code paths end to end. I ran `npm audit --omit=dev` (0 advisories) and checked
the lockfile entries. Nothing was exercised on hardware or against the live Worker. Every finding
names the file it comes from. Anything I could not trace is listed under Open questions.

## Boundary verdict

**Trusted-LAN boundary: BROKEN by design once the flag is on. The replacement boundary mostly HOLDS, with one real gap.**

- With the flag on, `syncStarter.js` adds `/ip4/0.0.0.0/udp/0` to the listen addresses, and the
  device opens a native ICE/DTLS endpoint whose peers can be anywhere on the internet. LAN-only
  stops being true.
- The *data* boundary that replaces it does hold. Every punch connection goes through the libp2p
  upgrader, so Noise, authGate/T331 mutual auth, `isPeerRevoked`, Yamux and Automerge sync all run
  over it (`punchTransport.js` header; `upgradeInbound`/`upgradeOutbound` at both the listener and
  `connectFromMemory`). Rung 2 signaling is served only to admitted, registry-trusted peers
  (`punchSignaling.js` `eligible()`), and each envelope is origin-signed. There is no pre-auth
  *application* message surface.
- The *metadata* boundary is the weak point. A camp's public IPs reach the Worker operator, and
  they stay readable to anyone who once held the camp namespace and address key, including a
  revoked device. See F1 and F2.

## Confirmed findings (ranked by leverage)

### F1 — Revocation does not rotate the rendezvous namespace or address key | HIGH (when rung 3 is configured) | `electron/sync/automerge/rendezvousNamespace.js`, `rendezvousAddressKey.js`, `syncStarter.js`

- **Attack path.** A device is revoked (a departed staffer's laptop) but keeps its copy of the camp
  document, which holds the namespace (`v1:<epoch>:<ns>`) and `camps.rendezvousAddressKey`. It can
  poll `GET /v1/peers/<ns>` with no credentials and decrypt every record's
  `encryptedAddressBody` (AES-GCM under an HKDF of the static address key, `rendezvousRecord.js`).
  It then learns the current public IP and port of each camp device that publishes while it needs
  rung 3. It can also fill the namespace up to `MAX_PEERS_PER_NAMESPACE` (200) with fabricated peer
  ids, which locks new devices out (the Worker's own header names this).
- **Evidence.**
  - `rotateRendezvousNamespace` has **no production caller**. A grep of `electron/` and `src/`
    outside tests finds only a comment in `rotatingDiscoveryTag.js` and `syncStarter.js` saying
    each is mint-only.
  - `rendezvousAddressKey.js` exports `read` and `mint` only. No rotate function exists.
  - The mDNS service tag *is* revocation-derived (T335), so the LAN side already handles this. The
    WAN side does not.
- **Confirmed how.** By tracing the code (grep for callers plus reading the exports). Not
  reproduced against the live Worker.
- **Mitigating factor.** PR #837 re-checks membership before rung 3, so a revoked *target* is
  never requested. Rung 3 is also demand-driven while punch is on, so publishing is intermittent.
  Neither fact stops the revoked *reader*.
- **Fix.** On a revocation that lands in the document, rotate the namespace and epoch AND re-mint
  the address key (add `rotateRendezvousAddressKey`). Trigger it from the same revocation-state
  derivation the mDNS tag uses. Add a test proving a revoked device's key cannot decrypt a record
  published after the rotation.

### F2 — The Worker operator sees each publishing device's public IP regardless of address encryption | MEDIUM | `workers/rendezvous/worker.js` (`throttle` reads `cf-connecting-ip`)

- **Attack path / exposure.** A `POST /v1/register` comes from the device's own NAT. Cloudflare,
  and anyone with access to the account, therefore sees the source IP, the namespace (plaintext
  path and body), the peer id (plaintext), and the timing. Encrypting the address body hides the
  port and any extra candidates, but not the IP, because the request itself carries it. Across
  requests the operator can link namespace to the set of IPs to time, which amounts to a camp's
  locations over time.
- **Evidence.**
  - The Worker header lists "Traffic analysis" as not defended.
  - `rendezvousRecord.js` v2 keeps namespace, peerId, epoch, seq and timestamps in plaintext.
  - Nothing is stored in the DO beyond about 2h, and the source code never logs. The residual is
    Cloudflare's own edge logs, which are an account setting outside the repository.
- **Confirmed how.** By reading the code. I have **not** verified whether account log retention and
  Logpush are set short or off on the live deployment; that is an owner dashboard action.
- **Fix / condition.** Keep rung 3 a rare fallback (see Q1). Record in a dated owner note that
  Workers Logs and Logpush are disabled for `shoresh-rendezvous`. Accept the residual explicitly,
  since the operator is the owner's own account.

### F3 — Global write budget can be exhausted by one stranger | MEDIUM (availability only) | `worker.js` `GLOBAL_WRITES_PER_DAY = 7000`

- **Correction to memory.** The note says the Worker rate limit is "open". That is stale. Per-IP
  limiter bindings exist (`wrangler.toml`: register 60/min, peers 120/min, keyed on IPv4 or the
  IPv6 /64), they **fail closed** with 503 when missing, and the DO enforces exact per-namespace
  (30 per 60s, 200 peers) and per-service (7000 per day) caps.
- **Remaining gap.** Cloudflare documents the per-IP limiter as best-effort and per-location. A
  namespace is not needed to write: any well-formed 64-hex value is accepted. A distributed or
  multi-location caller can therefore burn the 7000 per day global budget, and rung 3 is then down
  for every camp until 00:00 UTC. The owner accepted this on 2026-10-09 (Free plan), and it is
  recorded in the Worker header.
- **Confirmed how.** By reading the code. Per-namespace writes are capped at 30/min, so about 4 new
  namespaces cover the whole day's budget in under a minute of real requests.
- **Recommendation.** Keep it accepted, as long as rung 3 is a rare fallback. If rung 3 turns out
  to be the common path (Q1), this becomes an outage vector for the feature and should be revisited
  (for example, require a proof derived from the address key on register).

### F4 — Rendezvous-discovered addresses are dialled without a registry check before the dial | LOW | `rendezvousClient.js` `createRendezvousDiscovery` → `onDiscoveredPeer`

- **Path.** Any holder of the namespace, revoked devices included, can post a record self-signed by
  its own key that lists arbitrary public addresses. Camp devices that are polling will dial them.
- **Why it stays low.** authGate refuses an unknown or revoked peer after Noise, so no data flows.
  The effect is limited to bounded outbound dial attempts to attacker-chosen public IPs.
  `publicRecordAddresses` already drops private ranges, so this cannot be pointed at the LAN.
- **Fix (cheap).** Before dispatching `peer`, drop records whose peer id is not a trusted,
  unrevoked registry device.

### F5 — `node-datachannel` native endpoint parses pre-auth UDP from internet peers | LOW–MEDIUM (residual) | `punchTransport.js`, `node-datachannel@0.33.4`

- **What is exposed.** Before Noise ever runs, libdatachannel/libjuice parse STUN binding requests
  and DTLS ClientHellos in C/C++ on the punch UDP port. Several things limit who can send them:
  ICE short-term credentials (ufrag/pwd from signed signaling, or remembered for rung 1), the pinned
  DTLS certificate, `maxPendingInbound = 4`, and the fact that offers arrive only over the
  authenticated signaling stream (`listener.admits(sid)`). Even so, a STUN packet with a wrong
  MESSAGE-INTEGRITY is still *parsed* before it is rejected. A memory-safety bug in that parser
  would be reachable by anyone who can reach a mapped port.
- **Supply chain (checked).**
  - `package.json` pins `node-datachannel` to exactly `0.33.4`.
  - The lockfile carries `sha512` integrity for the main package and for the
    `@node-datachannel/darwin-x64` and `darwin-arm64` prebuilds, all resolved from
    `registry.npmjs.org`. There is no GitHub-release download at install time, so lockfile
    integrity covers the binary.
  - `npm audit --omit=dev`: 0 advisories.
  - PR #836 adds `checkLockfilePlatforms` and a packaged load probe. These prove that the module
    ships and loads, not that it is trustworthy.
- **Residual.** We trust the npm publisher of the prebuilt binary, and there is no reproducible
  build. That is the same posture as `better-sqlite3-multiple-ciphers`.
- **Fix / condition.** Re-run audit and the postinstall check at activation. Pin a policy to bump
  `node-datachannel` within N days of a libdatachannel or libjuice CVE. Note that
  `win32-x64-msvc` is required by #836's check; it was not individually inspected here.

### F6 — Coordinator DoS posture is adequate | INFO

- `reconnectCoordinator.js` runs one in-flight ladder per peer, applies per-peer jittered backoff,
  and takes its peer list from the local registry only. No remote party can add a peer to sweep.
- Signaling has a 32 KiB frame cap, per-peer and per-origin rate limits, hop limit 1, a fanout of
  3, a freshness window, and a persisted replay store that fails closed when corrupt.
- The pre-#837 risk was that a rung which kept erroring pinned a peer below rung 3 forever. #837
  fixes that with `RUNG_ERROR_LIMIT = 3`, and it also re-checks membership so a peer revoked during
  rungs 1–2 is never handed to rung 3.
- I found no remote amplification path into the coordinator. Only admitted peers can reach it.

### F7 — Replay and forgery of signed records: holds | INFO

- Rendezvous records are Ed25519 over a fixed-order, length-prefixed encoding with a domain tag.
  The client applies an (epoch, seq) watermark and a ±5 min skew window.
- Signal envelopes are origin-signed over `[id, from, to, ts, payload]`. Replay protection is keyed
  on (from, id) and persisted across restarts, with a 2 min freshness window, and the relay cannot
  re-sign.
- Gossip entries go through signature, registry, revocation, TTL, public-address and rollback
  (high-water) checks (`punchRung2.js` doc block).
- I found no forgery path. The only weakness is F1: a still-valid key holder of the namespace.

### F8 — Logging of peer ids and IPs: holds | INFO

- `connectivityEvents.js` emits address *classes* by default. Raw multiaddrs appear only with
  `verboseAddrs`.
- The punch and rendezvous `console.warn` lines log error messages and file paths, not IPs or peer
  ids. The Worker has no console calls.
- Two things still carry peer ids: `PUNCH_RUNG_ERROR` and `CLOCK_SKEW`, which include `peerId` and
  go to stdout. That is pseudonymous and local, so acceptable.
- Not inspected: libp2p `debug` loggers (`transport.log`). They are off unless `DEBUG` is set.

## Open questions (NOT findings)

- **Q1 — Does the ladder ever produce a public reflexive candidate in production?**
  - **Why it matters.** `syncStarter.js` passes no `iceServers`, and `punchTransport` defaults them
    to `[]`. Without STUN, libjuice gathers no `srflx` candidate. `rememberOwnReflexive` keeps only
    `typ srflx` lines from the selected pair (`punchTransport.js` ~l.358), so rungs 1–2 and the
    rung-3 record may have nothing to publish. If so, the owner's model (punch is primary,
    Cloudflare is rare) quietly inverts to "rung 3 or same-network-required", which raises the
    weight of F2 and F3. Fixing it by adding a public STUN server would disclose IPs to that STUN
    operator, which is a new third party and needs its own owner decision.
  - **What would settle it.** The two-network hardware run from
    `2026-10-03-t336-cross-network-punch-validation.md`, repeated on this build with the flag on,
    logging which rung succeeds and whether `punch_identity.reflexive_candidates` is ever non-empty.
- **Q2 — Mid-connection revocation on a punch connection.**
  - **Why it matters.** Rung 1 re-checks trust after the upgrade. Whether an *established* punch
    connection is closed when a revocation merges depends on the generic connection-close-on-revoke
    path (T331), which I did not re-trace for the punch transport specifically.
  - **What would settle it.** A test that revokes a peer connected over the punch transport and
    asserts its connection closes.
- **Q3 — Live Worker matches the repo.**
  - **Why it matters.** The deployed Worker must actually have the limiter bindings, and log
    retention must be minimal.
  - **What would settle it.** `wrangler deployments list` / dashboard evidence, recorded by the
    owner.

## Re-opened tradeoffs

| Tradeoff | Conditions when accepted | Still hold? | Recommendation |
|---|---|---|---|
| Rung 3 global-budget exhaustion (F3) | Rung 3 is a RARE fallback; Free plan | Unknown: Q1 suggests rung 3 may become the common path | Keep accepted only if Q1 shows rungs 1–2 succeed; otherwise revisit |
| Worker traffic analysis by operator (F2) | Owner's own account; short log retention | Retention not evidenced | Owner records Logs/Logpush off |
| Namespace rotation "deliberately out of scope" (T210 D3) | Rendezvous was opt-in and inert | **No**: default-on punch with a URL makes rung 3 live for every camp | Implement F1 before rung 3 ships configured |
| Prebuilt native binary trust (F5) | Same as the SQLite driver | Yes | Keep, with an audit at activation |

## Verdict: GO-WITH-CONDITIONS for `SHORESH_PUNCH_ENABLED` default-on

Conditions, all required before the default flips:

1. **F1 fixed** (rotate namespace and address key on revocation, with a test), **or** ship the
   default with `SHORESH_RENDEZVOUS_URL` unset, so the ladder is LAN plus rungs 1–2 only and the
   Worker is never contacted.
2. **Q1 settled on hardware.** Show that rungs 1–2 actually connect two independently NATed
   devices on this build. If they need STUN, adding a STUN server is a separate owner exposure
   decision and is not bundled into this flip.
3. **PRs #836 and #837 merged**, with CI green.
4. **The punch row's `signoff` in `transportCapabilities.js` written** at the T327 gate (it is
   `null` today), with the npm audit and postinstall re-check recorded.
5. **Q2 test added** (a revoked peer on a punch connection is disconnected).
6. **Owner evidence** that Cloudflare Workers Logs and Logpush are off and the limiter bindings are
   live (Q3).

What flipping the default changes:

- Every device opens a UDP listener and native ICE/DTLS parsing (F5).
- Every device persists remembered reflexive and DTLS session material (rung 1).
- Every device gossips its public reflexive address into the camp document, encrypted under the
  camp key.
- If a rendezvous URL is shipped, every camp publishes, on demand, IP-revealing requests to
  Cloudflare (F2) into a namespace that revocation does not rotate (F1).

The data path itself stays inside Noise plus mutual auth plus authorize().

## Owner-side evidence and rulings (recorded 2026-10-09, relayed by the board keeper)

- **Q3 / condition 6 — Worker logging and limits (deployed version `765e9d16`):** `[observability] enabled = false`;
  no Logpush job has ever been created. Live acceptance: a 300-request burst gave exactly 30 accepted and 270
  "namespace write budget exhausted"; the 200-device cap holds (peer 201 refused "namespace is at capacity",
  a refresh from an existing peer accepted). **The per-IP limiter binding is best-effort and did NOT enforce on the
  burst**, so the per-namespace and global budgets are the effective limits; F3's residual stands.
- **STUN (open question → ruled, then REVERSED by the owner):** a Cloudflare-STUN ruling was withdrawn. Owner,
  verbatim: "no. i do not accept this. you know that i believe that laptops can find one another on dfferent wifis.
  let's assume for the moment that it's not available if you are two places you have never been. but if one f you
  is in a spot that is known, then it should be possible if the other is in a new spot". **No STUN of any kind.**
  Requirement: a device at a KNOWN spot (e.g. the camp office) must be reachable by a device at a NEW spot with no
  third party; both at never-seen spots is out of scope for now. Direction under feasibility study: each device asks
  its own router for its public address and an inbound mapping (UPnP-IGD / NAT-PMP / PCP), publishes the mapped
  address in the signed record peers already exchange (rung 1), refreshes it while connected, and removes it on quit
  and on revoke; if the router refuses, the director sees a plain status and the ladder falls to rungs 2/3.
- **Condition 2 (two-NAT hardware proof)** is scheduled as the owner's two-laptop test, after conditions 1 and 5
  land and a packaged build exists; **condition 4** (punch sign-off) follows it.

## Summary Score (for Grader)

Security posture: 3/5. The auth and data boundary on the punch path is sound and well bounded.
The metadata boundary is not: revocation does not rotate the rendezvous namespace or address key,
and whether the ladder works without STUN is unproven.
