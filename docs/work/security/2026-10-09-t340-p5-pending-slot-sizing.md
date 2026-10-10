---
title: "T340 precondition 5 — internet-scale libp2p rate-limit review and pre-Noise pending-slot sizing"
document_type: security
authority: evidence
status: active
task_class: security-auth
created: 2026-10-09
governing_docs: [docs/work/tickets/T340-wan-activation-go-live-checklist.md, docs/adr/2026-10-08-max-connections-dos-mitigation.md, docs/work/tickets/T359-router-port-mapping-rung-1.md, docs/work/security/2026-10-09-wan-ladder-assessment.md, SECURITY.md]
archive_when: T340 is archived
---

# T340 precondition 5: pending-slot sizing and the internet-scale rate-limit review (2026-10-09)

Assessed against commit `6b8dc4cd` (origin/main) and the **installed** `libp2p@3.3.11`
(`node_modules/libp2p/package.json`). Every libp2p claim below comes from reading that version's
`dist/src` and not from memory or docs. Nothing was measured on hardware. The numbers are
arithmetic over the code's constants.

**Threat model (owner):** honest failures, plus internet scanners and DoS against the TCP listener.
T359's router port mapping makes that listener reachable from the internet. Malicious admins are
out of scope.

**Trigger:** #840 Red Hat N1. A distributed scan can hold the 16 global pending slots and refuse a
legitimate roaming dial.

## 1. What libp2p 3.3.11 enforces before Noise

The source of truth here is `connection-manager/index.js` `acceptIncomingConnection`, called first
from `upgrader.js` `upgradeInbound`. It checks these in order:

1. **`deny` list (IP/CIDR):** refuse.
2. **`allow` list (IP/CIDR):** accept immediately and increment `incomingPendingConnections`. **This
   skips the pending cap, the per-host rate limit and `maxConnections` entirely.**
3. **Pending cap:** if `incomingPendingConnections === maxIncomingPendingConnections`, the dial is
   refused (`ConnectionDeniedError`, socket closed). Nothing is queued and nothing is evicted. When
   the cap is full, every new inbound dial is refused, legitimate or not.
4. **Per-host rate limit:** `inboundConnectionThreshold` points per 1-second window, keyed on the
   remote IP. The default is **5/s** (`constants.defaults.js`). Shoresh does not override it in
   production. A dial refused at step 3 does not consume a token.
5. **`maxConnections`:** accept and increment pending.

After `acceptIncomingConnection`, `upgradeInbound` runs our `connectionGater.denyInboundConnection`
(the `connectionRateLimiter`), then `_performUpgrade`: multistream, Noise, then muxer selection. The
pending slot is released in the `finally` block (`afterUpgradeInbound`). That means a slot is held
for the **whole** upgrade, from TCP accept through the end of muxer negotiation. The upgrade is bounded by
`inboundUpgradeTimeout`, which defaults to **10 000 ms** (`INBOUND_UPGRADE_TIMEOUT`). It can be set
through `connectionManager.inboundUpgradeTimeout` (`libp2p.js` passes it into `new Upgrader`).
Shoresh does not set it.

Consequences:
- A dial that **our gater** denies gives its slot back almost at once, through the same `finally`. A
  gater-level per-source cap therefore really does protect the global slots, even though it runs
  after the global counter is incremented.
- **Peer id is unknown before Noise.** In Noise XX the responder learns the initiator's static key
  only in message 3. No hook before Noise can prioritise a known peer by id, so the only
  pre-Noise key available is the source IP.

## 2. Our layers on top, and a defect found while tracing them

`connectionRateLimiter.js` applies to public IPs only. Private and loopback addresses are exempt. It allows
30 new connections per 10 s per IP (3/s) and **20 concurrent per IP**. A concurrent count is released
only on `connection:close`.

**Finding F1 (correctness, honest-failure DoS).** In libp2p 3.3.11, `connection:close` is dispatched
only from `upgrader.js` `_createConnection`, which means **only for connections that finished upgrading**.
An inbound connection that passes the gater and then fails or times out during Noise is never
released. Every failed handshake from a public IP permanently uses up one of that IP's 20 concurrent
units until the app restarts. Two effects follow:
- *Honest failure:* a camp device behind CGNAT or a flaky mobile link that fails 20 handshakes is
  locked out of this node for good. The only way back is a restart.
- *Memory:* `recentByIp` and `concurrentByIp` keep an entry for every public IP that ever connected.
  Internet scanners grow those maps without limit.

As it happens, F1 currently makes the slot-holding attack harder, because each IP gets only 20 attempts in its
lifetime. That is an accident, not a control, and fixing F1 removes it. The sizing below assumes F1
is fixed.

## 3. Attack cost to hold N slots

Holding a slot only requires completing TCP and then staying silent until `inboundUpgradeTimeout`
fires. To hold N slots continuously, an attacker needs `N / T` new connections per second, where T is the timeout.

| Config | Sustained dials needed | Distinct IPs needed (per-IP limits after F1 is fixed) |
|---|---|---|
| Today: N=16, T=10 s | 1.6/s | **1.** One IP is allowed 3/s by our limiter and 5/s by libp2p, and its 20 concurrent units exceed 16. |
| N=16, T=5 s | 3.2/s | 2 |
| N=64, T=5 s, per-source pending cap 2 | 12.8/s | **32 concurrent sources** |

Once F1 is fixed, a **single host** with one socket loop can deny all WAN inbound today. The cost is
about 16 idle TCP sockets. "Distributed" is not required. For IPv6, keying on the full /128 address
lets one /64 behave as unlimited sources, so a per-source cap has to key on the IPv6 /64.

## 4. What a legitimate WAN dial needs

One slot, held from TCP accept through the end of muxer negotiation. Inbound that is about 1 RTT of
multistream, 1.5 RTT of Noise XX and about 1 RTT of muxer selection, so around 3 to 4 RTT. At a bad
mobile RTT of 300 ms that comes to roughly 1.2 s. A 5 s timeout leaves about a 4x margin. A camp has a few dozen devices,
and a WAN reconnect burst after a router flap is at most that many dials spread over seconds.
Slots are cheap: before Noise a slot costs a socket and small buffers, and the handshake costs a few
X25519 operations. 64 slots costs nothing that matters.

## 5. Options

| Option | Effect | Verdict |
|---|---|---|
| A. Raise the pending cap | Scales attack cost linearly. On its own, one IP still fills it. | **Do it, together with B.** 16→64. |
| B. Per-source pending cap in our gater | Turns "one host" into "N/k concurrent sources". The cleanest lever, and the gater frees a denied slot at once (§1). | **Do it.** k=2, keyed per IPv4 /32 and IPv6 /64. |
| C. Shorter `inboundUpgradeTimeout` | Doubles attack cost and halves how long an honest stall holds a slot. | **Do it.** 10 s→5 s, about a 4x margin over a bad mobile path. |
| D. Prioritise known peers via libp2p `allow` | Allow-listed IPs bypass the pending cap, the rate limit **and** maxConnections. Roaming means the address changed, which is the whole case. A CGNAT neighbour would inherit the bypass. Peer id is impossible before Noise. | **Reject.** |
| E. Fix F1 | Required for honest-failure correctness and bounded memory. | **Do it** (prerequisite). |

**Residual risk, stated plainly:** a botnet with 32 or more concurrent sources sustaining about 13
dials/s can still deny WAN inbound. libp2p has no pre-Noise mechanism that tells a camp device apart
from a scanner. The fallbacks stay intact: LAN, our own outbound dials (which use no inbound slot),
and rungs 2 and 3. A held-full pending cap delays a roaming reconnect. It does not partition the camp
permanently, because the roaming device's own outbound dial to a peer that is not under attack still works.

## 6. Recommendation

`MAX_INCOMING_PENDING_CONNECTIONS` 16 → **64**; `inboundUpgradeTimeout` 10 s → **5 s**; a per-source
pending cap of **2** (IPv4 /32, IPv6 /64), public sources only; fix F1. Confidence: **high** on the
mechanism (read from installed source); **medium** on the exact numbers (arithmetic, not measured;
5 s rests on an RTT estimate). Precondition 5 can be closed once these land with red-before-green tests.

## 7. Code-change spec

1. `electron/sync/automerge/transport.js`
   - `MAX_INCOMING_PENDING_CONNECTIONS = 64`, with the comment updated to cite this doc.
   - Add `INBOUND_UPGRADE_TIMEOUT_MS = 5_000` and a `startTransport` parameter
     `inboundUpgradeTimeoutMs = INBOUND_UPGRADE_TIMEOUT_MS`. Pass it as
     `connectionManager.inboundUpgradeTimeout`.
   - Fix the stale line-59 comment. libp2p's inbound timeout covers the whole upgrade (Noise and
     muxer), not "pre-Noise only".
2. `electron/sync/automerge/connectionRateLimiter.js`
   - Add pending tracking: `allow(ip, connKey)` records `pendingBySource[sourceKey(ip)]` as a map of
     `connKey` (the remote `ip:port` multiaddr string) to an expiry time, `now + inboundUpgradeTimeoutMs`.
     When a source already has `>= maxPendingPerSource` (default 2) unexpired entries, deny.
   - Add `upgraded(ip, connKey)` and call it from a `connection:open` (inbound) listener. It deletes
     the pending entry and only then counts the connection as concurrent. That fixes F1: concurrent
     counts only upgraded connections, which are exactly the ones `connection:close` releases. A
     handshake that fails simply expires out of the pending map.
   - `sourceKey`: an IPv4 address maps to itself. An IPv6 address maps to its first four hextets (/64).
   - Prune empty or expired entries in `recentByIp`, `concurrentByIp` and `pendingBySource` on each
     `allow`, using an amortised sweep every K calls. That bounds memory.
3. Tests (`transportConnectionDos.test.js` plus `connectionRateLimiter.test.js`), each red on
   current code:
   - F1: a public-IP connection that is accepted but never upgraded no longer blocks that IP's 21st
     attempt once its pending entry expires. Today it stays denied.
   - The per-source pending cap refuses a 3rd concurrent pre-upgrade connection from one source while
     a second source is still admitted. Use injected `now`.
   - IPv6 addresses in the same /64 share one budget.
   - The libp2p node receives `inboundUpgradeTimeout === 5000`. Assert this on the constructed
     config rather than with a 5 s wall-clock wait.
4. `docs/adr/2026-10-08-max-connections-dos-mitigation.md`: add an amendment note covering 64, 5 s,
   the per-source cap, and F1. The T340 precondition 5 line points here.
