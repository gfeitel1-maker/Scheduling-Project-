---
title: "Router port mapping (UPnP-IGD / NAT-PMP) for the known-spot laptop: feasibility"
document_type: spec
authority: proposed
status: draft
created: 2026-10-09
archive_when: "the router-port-mapping ticket (T359) is closed or this feasibility is superseded by the ADR docs/adr/2026-10-09-router-port-mapping-on-rung-1.md"
task_class: security-auth
governing_docs: [docs/adr/2026-10-08-relayless-cross-network-reconnect.md, docs/adr/2026-10-02-wan-discovery-transport-ladder.md, SECURITY.md]
---

# Router port mapping (UPnP-IGD / NAT-PMP / PCP) for the known-spot laptop: feasibility

> **Revision 2026-10-09.** The decision this report fed (`docs/adr/2026-10-09-router-port-mapping-on-rung-1.md`) was revised after Red Hat FAILED the original draft: the thing mapped is now the **libp2p TCP listener**, pinned to a persisted port, not the punch UDP port. Library, router-protocol and gateway-detection findings below are about asking the router for a mapping and still hold. Findings that assume the **UDP punch port** (what to map, one session per port, the libjuice exposure, peer-reflexive acceptance) do not carry over; read them against the ADR, which governs. The findings are left as written. Ticket: T359 (slices revised).

## Goal and success predicate

Owner requirement: a laptop at a known spot (the camp office) can be reached by a laptop at a new
spot with **no third party**: no STUN and no relay. Each device asks **its own router** for its public
address and an inbound port mapping. The mapped public `addr:port` goes into the signed address record
peers already exchange (rung 1 remembered candidates), and is refreshed while connected.

**Success predicate (observable):** with STUN unset and rendezvous unreachable, a new-spot laptop
dials the office laptop's remembered *mapped* address and syncs. When the office router refuses or
has no UPnP/NAT-PMP, the director sees a status saying so, and the ladder falls to rung 2/3. The
mapping is gone after quit or revoke (router table shows no entry).

**Non-goals:** CGNAT or double-NAT offices (these cannot be mapped from inside), PCP-only ISP
gateways, and any change to the trust model.

## 1. Libraries (checked with `npm view` and tarball inspection, 2026-10-09)

| Package | Latest | Licence | Protocols | Native deps | Maintenance |
|---|---|---|---|---|---|
| `@achingbrain/nat-port-mapper` | 4.0.5 (Oct 2025) | Apache-2.0 OR MIT | **UPnP-IGD (v1/v2, IPv4+IPv6) and NAT-PMP** (`upnpNat()`, `pmpNat(gatewayIp)`). **No PCP** (no PCP code in `dist/`). TCP **and UDP**. | None. Pure JS (`@achingbrain/ssdp`, `xml2js`, `netmask`) | Maintained by a js-libp2p maintainer; used by `@libp2p/upnp-nat` |
| `@libp2p/upnp-nat` | 4.0.28 (Oct 2026) | Apache-2.0 OR MIT | Wraps `upnpNat()` only: **UPnP only**, no NAT-PMP, no PCP | None | Part of js-libp2p monorepo; peers on `@libp2p/interface ^3.3.0`, `@libp2p/utils ^7.4.1` (matches repo) |
| `@silentbot1/nat-api` | 0.4.9 (Nov 2025) | MIT | UPnP + NAT-PMP | None (uses `chrome-dgram`, `default-gateway`) | Fork of the dormant `nat-api`; single maintainer |
| `nat-api` | 0.3.1 (2022) | MIT | UPnP + NAT-PMP | None, but depends on deprecated `request` | Dormant |
| `nat-upnp` | 1.1.1 (2022 metadata; code much older) | none listed | UPnP | deprecated `request`, `ip` (has CVE history) | Dormant |
| `nat-pmp` | 1.0.0 (2022 metadata) | MIT | NAT-PMP | `debug ~0.7` | Dormant |
| `@runonflux/nat-upnp` | 1.0.2 | MIT | UPnP | `axios 0.26` (old) | Small fork |

No maintained pure-JS **PCP** (RFC 6887) client was found. PCP is a superset of NAT-PMP (RFC 6886)
on the same UDP port 5351. A minimal MAP opcode client is roughly 200 lines of `dgram` if ever needed.

All of the above are plain Node `dgram`/`http` and run in the Electron main process. None needs a
native build for mac-arm64, mac-x64 or win-x64.

## 2. Fit with the repo

- The repo is on `libp2p ^3.3.11` and `@libp2p/interface ^3.3.0` (package.json), so `@libp2p/upnp-nat`
  4.x would install cleanly.
- **But it is the wrong tool here**, for three reasons found in its source (`dist/src/upnp-port-mapper.js`):
  1. It maps the addresses in **libp2p's address manager**, meaning libp2p's own TCP listener addresses. It knows
     nothing about the node-datachannel punch socket, which libp2p does not own.
  2. On success it calls `addressManager.addPublicAddressMapping(...)` and confirms the external
     multiaddr with an effectively infinite TTL. That changes what libp2p **announces** (identify
     and so on), outside the signed punch record, and would leak the office's public address to every
     peer identify reaches. This needs its own review and is not wanted.
  3. UPnP only, so NAT-PMP routers (Apple AirPort, many Ubiquiti/pfSense/OPNsense setups) are missed.
- **Which transport the punch rung dials:** rung 1 (`electron/sync/automerge/punchRung1.js`) redials
  remembered public candidates through `punchTransport.connectFromMemory`. That is **WebRTC DataChannel over UDP
  via node-datachannel (libjuice ICE)**, with pinned DTLS cert, ICE ufrag/pwd and port. The mapping
  must therefore be **UDP**, targeting the punch port, and not the libp2p TCP listener.
- So: use `@achingbrain/nat-port-mapper` directly, from a small Shoresh module that maps the punch
  UDP port, and leave libp2p's address manager untouched.

## 3. Is the local UDP port stable? Yes. Already solved in this repo

`electron/sync/automerge/punchIdentity.js` `materializePunchIdentity()` returns
`portRange: { begin: id.localPort, end: id.localPort }` from the persisted `punch_identity.local_port`
column. `syncStarter.js` passes it to `punchTransport`, which sets libjuice's
`portRangeBegin/End`. The ICE host port is **pinned per device and survives restarts**, so a router
mapping `external:X -> lan_ip:local_port/UDP` stays meaningful.

Consequence to note: `punchTransport.sessionOnFreePort` allows **one live session per pinned port**
(libdatachannel aborts if a second PeerConnection binds a held port, and there is no ICE UDP mux in
use). The office laptop can therefore serve only one punched peer at a time through the mapping. That
is acceptable for the one-office-plus-one-roaming case, but it is a real ceiling. Options if it
matters later: libdatachannel's `enableIceUdpMux` (check node-datachannel 0.33.4 exposes it), or a
small pinned port range with one mapping per port. A libp2p TCP listener mapped instead is a
fallback, but it would bypass the punch identity pinning and is not recommended.

The mapped candidate will usually have external port == local_port (requested), but routers may
assign a different one. Record the **returned** `externalPort`, not the requested one.

## 4. Security notes

- **No third party:** UPnP discovery is SSDP M-SEARCH multicast to 239.255.255.250:1900 on the LAN.
  Control is HTTP/SOAP to the router's LAN address. NAT-PMP is UDP to the default gateway:5351. The
  external IP comes from the router (`GetExternalIPAddress` / NAT-PMP opcode 0), which **replaces
  STUN** for learning the public address.
- **Double NAT / CGNAT:** if the router's reported external IP is private or 100.64/10, the mapping is
  useless. `@libp2p/upnp-nat` has `assertNotBehindDoubleNAT`. Replicate that check and report
  "office network is behind another NAT" as a status. Cross-check against a previously learned
  reflexive address when one exists.
- **Lifetime:** nat-port-mapper defaults to a 1 h TTL with auto-refresh 60 s before expiry. Keep a
  short TTL (for example 1 h) so a crash leaves at most an hour of exposure. Some IGDv1 routers only
  accept lease 0 (permanent), so on that fallback **removal on quit is the only cleanup**. Record that in
  the status.
- **Removal:** `gateway.unmap(port)` on graceful quit, on revoke, and when punch is disabled, followed by `gateway.stop()`.
  A crash or power loss cannot unmap, which is why the TTL is short. On startup, delete any stale
  mapping for our own `lan_ip:local_port` before re-adding.
- **Exposure:** a mapping makes the punch UDP port reachable from the whole internet, not just from
  peers. Inbound traffic still has to pass ICE connectivity checks with the pinned ufrag/pwd, then DTLS
  with the pinned cert, then Noise mutual auth. That is defence in depth, but the ICE credentials are long-lived per device, so
  treat them as secrets in the signed record (already the case) and keep the connection rate limiter
  (`connectionRateLimiter.js`) in front. Expect internet scanners to hit the port.
- **Hostile or buggy router:** it can lie about the external IP, map elsewhere, or drop the mapping. The worst
  case is a failed dial or misdirected packets, never a trust bypass, because identity is pinned
  end-to-end. A router on the LAN can already see all traffic, so this adds no new attacker. Parse
  XML defensively (xml2js and size limits) and use timeouts. Never follow a `LOCATION` URL that is not on
  the gateway's own LAN subnet (SSDP spoofing by another LAN host).
- **Egress scanner:** this adds new outbound sockets (SSDP multicast, HTTP to the LAN). Check whether
  `internetRendezvousScan.js` or the privacy and egress gates classify LAN-only egress, and add an explicit
  allowlist entry with a test.

## 5. Prevalence: realistic success rate

- Trend Micro (2019 scan) reported about 76% of routers it detected had UPnP enabled. This is consumer-skewed and its
  methodology is not public, so it is indicative only:
  https://www.trendmicro.com/en_us/research/19/c/upnp-enabled-connected-devices-in-home-unpatched-known-vulnerabilities.html
- "Probe and Pray" (Di Cioccio et al., PAM 2012, 120k homes): in most homes no UPnP data could be
  collected, and returned data was often wrong. Treat this as a warning that "UPnP on" does not mean
  "UPnP works": https://hal.archives-ouvertes.fr/hal-00835395
- NAT-PMP and PCP: no representative measurement found. Bitcoin Core's PCP/NAT-PMP rollout tracked an
  informal router table showing many common ISP routers without PCP:
  https://mirror.b10c.me/bitcoin-bitcoin/31663/
- Institutional and managed networks (school, JCC, enterprise firewalls, guest Wi-Fi) routinely disable
  UPnP as standard hardening guidance, and many ISPs now deploy CGNAT. Both defeat the approach.

**Honest estimate for "known spot = camp office":** if the office uses an ISP or consumer router,
maybe 50–75% success. If it uses a managed or institutional network, or is behind CGNAT, it is near 0%. This is
a judgement from the sources above, not a measurement. The status line will tell the
director which case they are in. A one-time "check this network" probe in settings would turn the
estimate into a per-camp fact.

## 6. Recommendation

**Library:** `@achingbrain/nat-port-mapper` 4.x used directly (UPnP-IGD and NAT-PMP, pure JS, UDP,
auto-refresh, same maintainer family as the libp2p stack). **Do not** add `@libp2p/upnp-nat`. Skip
PCP for now; add a tiny in-house PCP MAP client only if field data shows PCP-only gateways.

**Port strategy:** map the existing pinned punch UDP port (`punch_identity.local_port`). Put the
router-reported external IP and returned external port into the signed rung-1 record as a new
candidate kind (for example `mapped`, alongside `srflx`), and refresh the record when the mapping refreshes
or the external IP changes.

**Slice plan (each small and reversible, behind the existing `SHORESH_PUNCH_ENABLED` gate):**
1. *Mapper module* (`portMapping.js`): discover (UPnP, then NAT-PMP via the default gateway), double-NAT
   check, map, refresh, unmap. Uses an injected client so it is unit-testable with a fake gateway. Status enum:
   `mapped | refused | no-gateway | double-nat | error`.
2. *Record wiring:* add the `mapped` candidate to the signed address record and to rung-1 dial
   ordering (mapped first, then srflx). Update the `punchRung1` public-address filter tests.
3. *Lifecycle:* unmap on quit, revoke and disable. Clear stale mappings on start. Add a revoke test in the style of
   `punchRung1Revoke.test.js`.
4. *Director status:* a flag (not a banner) showing whether the office is reachable from outside, and why not.
5. *Egress/scanner gate update and a hardware check:* one real consumer router plus one phone hotspot.

**Confidence:** high that the mechanism is buildable (port already pinned, pure-JS library supports
UDP and NAT-PMP). Medium-low on field success rate at real camp offices.

**WAN ADR impact:** `docs/adr/2026-10-08-relayless-cross-network-reconnect.md` (rung 1) and
`docs/adr/2026-10-02-wan-discovery-transport-ladder.md` need an amendment: rung 1 gains a
router-mapped candidate learned **without STUN**, and the "no STUN" requirement means
`iceServers` should be empty on this path. Rung 1 currently learns srflx from ICE, which needs a STUN
server. Also record the one-session-per-pinned-port ceiling and the new LAN-egress surface.
