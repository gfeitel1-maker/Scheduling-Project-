# Peer Discovery Research — How Two Computers Locate Each Other

**Status:** research note, feeds the "future architecture" shared-document sync track.
**Scope:** the *locating / discovery* half only. Connecting and transporting data across networks is a **separate later phase** — this note draws the boundary but does not solve that phase.
**Reference model:** Syncthing. **Existing Shoresh code:** `electron/sync/discovery.js` (mDNS via `bonjour-service`, service type `_shoresh`).
**Audience:** the product owner (non-engineer). Terms are defined as they appear.

---

## 0. TL;DR for the owner

- **Discovery and connection are two different problems.** Discovery = *learning who a peer is and what address it claims to be reachable at*. Connection = *actually getting data to flow to that address*. Finding a peer does **not** by itself let you reach it, and it does **not** by itself remove the need for a relay. The relay question lives entirely in the connection layer, which is the *next* phase.
- **On the same WiFi / LAN, discovery is essentially free and needs no server at all.** Devices shout their presence to the local network and hear each other. Shoresh already does exactly this (mDNS/Bonjour). This is the smallest possible primitive and it is already built.
- **Across different WiFis, discovery unavoidably needs one tiny internet-reachable "meeting point"** — a lookup table that answers "where is device X right now?". This is small, cheap, and self-hostable. **It is not a relay.** A relay forwards every byte of your actual data; a discovery server only hands back an address and then gets out of the way.
- **A truly serverless cross-network discovery is, for practical purposes, impossible.** Two devices behind home routers, with no address in common and no prior contact, have no way to find each other without *some* shared rendezvous point. This is a structural fact, not a Shoresh limitation.
- **The owner's "connect directly, no relay" hope holds for the large majority of cases** — but every best-in-class system built specifically to connect peers directly (Tailscale, WebRTC, libp2p) still keeps a relay as a fallback, because a real minority of network/firewall combinations genuinely cannot be traversed. That is the *connection* phase's problem, previewed in §4.

---

## 1. The core distinction: discovery is not connection

These two words get collapsed together, and collapsing them is what makes "if they can find each other, we don't need a relay" sound true when it isn't.

| | **Discovery** | **Connection** |
|---|---|---|
| Question answered | "Who are you, and what address do you claim?" | "Can I actually push bytes to you?" |
| Output | An identity (a stable device key) + one or more candidate addresses | A working, ongoing data path |
| Fails because of | The peer isn't announcing, or announcements are blocked | NAT and firewalls block the path even though the address is known |
| Where a relay lives | **Not here** | **Here** — a relay is a connection-layer fallback |
| Cost/role of any server involved | A lookup table; touched briefly, then done | Carries *all* your traffic for the life of the session |

**Why this matters to the owner's hypothesis.** "If two computers can *know* one another, we can connect and transport in milliseconds without a relay." Knowing one another is discovery. It is the easy half. Whether you can then connect *without a relay* depends entirely on the two devices' NAT and firewall situation — which discovery cannot change. So: solving discovery perfectly still leaves the relay question fully open. Discovery tells you the door's address; it does not tell you the door will open.

An address learned during discovery is a **claim from a system boundary**, not a trusted fact. Shoresh already treats it that way — `toValidatedHost()` in `electron/sync/discovery.js` validates the shape of every announcement and skips malformed ones rather than trusting or throwing. That instinct (validate, never trust announcements) must carry into any cross-network discovery too.

---

## 2. LAN discovery (same subnet) — the smallest primitive

**The setting:** every device is on the same local network (same WiFi, same "subnet" — a group of devices that can send raw messages directly to each other). Here there is a shared *broadcast domain*: one device can send a single packet addressed to "everybody on this network" and all the others receive it. That single capability is all you need.

### 2.1 The two mechanisms

- **UDP broadcast / multicast.** The rawest form. A device sends a small UDP packet (a fire-and-forget network message) to a "to everyone" address on the local wire. Everyone listening on the agreed port hears it. No server, no registry, no configuration.
- **mDNS / DNS-SD (a.k.a. Bonjour / Zeroconf).** A thin, standardized convention layered on top of that same multicast idea. Instead of "here is a raw packet," devices ask "who here offers a service of type `_shoresh`?" and matching devices answer with their name, host, and port. This is the "just works" mechanism behind AirPlay, printer discovery, and Chromecast. **This is exactly what Shoresh already uses** (`bonjour-service`, service type `_shoresh`, in `electron/sync/discovery.js`).

Both need **no server**. Discovery on a LAN is genuinely peer-to-peer and free.

### 2.2 How Syncthing does local discovery (the reference)

Syncthing's local discovery is deliberately simple and worth copying conceptually:

- Each device periodically **broadcasts an announcement** on the local network.
- **IPv4:** a UDP packet broadcast to the local broadcast address (or `255.255.255.255`), **destination port `21027`**.
- **IPv6:** the same announcement **multicast** to the link-local multicast address `ff12::8384`.
- **Packet contents (conceptually):** the sender's **device ID** (its stable cryptographic identity) plus the **addresses/ports** it is listening on for actual data connections. So the announcement itself already carries the discovery payload: *identity + where to reach me*.
- Any device that hears the announcement now knows a peer exists on the LAN and what address to try.

Sources: [Syncthing Local Discovery Protocol v4](https://docs.syncthing.net/specs/localdisco-v4.html), [Syncthing Firewall Setup](https://docs.syncthing.net/users/firewall.html).

Shoresh's mDNS approach and Syncthing's raw-broadcast approach are two encodings of the *same* primitive: shout identity + address to the local network, listen for others doing the same. Shoresh's choice (mDNS) is the more standard, OS-integrated one and is a good fit — no change needed.

### 2.3 Reliability and edge cases (be honest about these)

LAN discovery is simple but not universal. It fails in specific, identifiable situations:

- **Networks that block multicast/broadcast.** Many corporate, university, and public "guest" WiFi networks disable multicast to reduce noise. mDNS silently stops working there.
- **"Client isolation" / "AP isolation."** A common guest-WiFi setting that forbids devices on the same WiFi from talking to each other *at all*. This blocks not just discovery but any LAN connection — the devices are on the "same WiFi" but walled off from one another. Worth calling out to the owner: *same WiFi network name does not guarantee the devices can reach each other.*
- **Multiple subnets / VLANs / a bridged WiFi + wired LAN.** Broadcasts and multicasts usually do **not** cross from one subnet to another. Two devices on the "same office network" but different subnets won't discover each other via mDNS. (Syncthing's own docs flag exactly this: routers may not forward broad/multicasts between subnets or between bridged WiFi and LAN — [firewall docs](https://docs.syncthing.net/users/firewall.html).)
- **Local firewall.** A host firewall blocking the discovery port (21027 for Syncthing; whatever mDNS uses, UDP 5353, for Bonjour) blocks discovery.

### 2.4 Security posture

Announcements arrive from anyone on the network. They are **input from a boundary**, not authenticated facts:

- Treat every announcement as an untrusted claim: validate its shape, then verify the peer's *identity* cryptographically before trusting it with data (Shoresh already gates real access behind its Ed25519 camp-token / PIN auth, which is the right layer for that).
- A malformed or malicious announcement must be **skipped, not trusted and not fatal** — which `toValidatedHost()` already does.
- Discovery reveals presence to everyone on the LAN. On a shared camp WiFi that's fine; it's worth knowing it is not private.

### 2.5 Smallest viable LAN primitive — stated explicitly

> **Periodically multicast `{device identity, listening address}` to the local network; listen for the same from others; validate each announcement's shape and skip bad ones.** No server. Shoresh already has this via mDNS. **Nothing more is needed for the same-WiFi case.**

---

## 3. Cross-network discovery (different WiFis) — the smallest primitive

### 3.1 The fundamental problem

Now the two devices are on different networks — e.g. one on the camp WiFi, one on a home network or a phone hotspot. Two structural facts break everything from §2:

1. **No shared broadcast domain.** There is no "everybody" address that reaches both devices. Shouting to the local network reaches only the local network. The primitive that made LAN discovery free simply does not exist across the internet.
2. **NAT hides private addresses.** Each device sits behind a home/office router doing **NAT** (Network Address Translation — the router lets many private devices share one public internet address). The device only knows its *private* address (like `192.168.1.42`), which is meaningless to anyone outside its own network. Its real, internet-visible address is the router's, and even that changes and has no fixed "door" open. So a device cannot even *state its own reachable address* reliably, let alone learn a peer's.

The consequence: two NAT'd devices that have never been in contact have **no way to locate each other on their own**. There is nothing to shout to and nothing to shout. They need a **meeting point** — a rendezvous — that both can reach independently.

### 3.2 How Syncthing does global discovery (the reference)

Syncthing solves this with a small **global discovery server** (`stdiscosrv`). It is a lookup table, nothing more:

- **Announce:** every ~30 minutes, a device makes an **HTTPS POST** to the discovery server with its **device ID** and the addresses it thinks it's reachable at, e.g. `{"addresses": ["tcp://192.0.2.45:22000", "relay://192.0.2.99:22028"]}`. The server also observes the device's *public* IP from the connection itself. It stores: **device ID → observed public address(es)**.
- **Lookup:** to reach a peer not seen on the LAN, a device makes an **HTTPS GET** with the target's device ID: `https://discovery.syncthing.net/?device=ABC12345-...`. The server returns the stored addresses.
- **Trust:** the connection is TLS-encrypted and the server's certificate is verified; to *announce* a device ID, the client must present a certificate proving it owns that ID. So a stranger cannot poison the table with fake addresses for your device.
- **Pool + self-hosting:** Syncthing runs a public pool of these servers, and — critically — **`stdiscosrv` is open and self-hostable.** You can run your own and point your devices at it.

Sources: [Syncthing Global Discovery v3](https://docs.syncthing.net/specs/globaldisco-v3.html), [syncthing-globaldisco(7)](https://www.mankier.com/7/syncthing-globaldisco), [Syncthing Security Principles](https://docs.syncthing.net/users/security.html), [stdiscosrv docs](https://docs.syncthing.net/users/stdiscosrv.html).

### 3.3 The key honest point: a lookup server is not a relay

This is the single most important reframing for the owner.

- A **discovery/rendezvous server** stores a tiny row per device (`device ID → address`), is contacted briefly to write or read that row, and then **steps out of the path**. Its bandwidth cost is a rounding error — a handful of small HTTPS requests per device per hour. It never sees your camp data.
- A **relay** sits *in the middle of the actual data path* and forwards **every byte** the two devices exchange, for the whole session. Its cost scales with your traffic and it must be trusted (or the data encrypted end-to-end so it can't read it).

So: **cross-network discovery needs a server, but it is the cheap kind.** Conflating "we still need a little discovery server" with "we still need a relay" is the error to avoid. You can have zero relay and still, unavoidably, need the tiny discovery server.

### 3.4 Is fully serverless cross-network discovery possible?

**Essentially no.** Absent a shared rendezvous point, two NAT'd devices with no address in common have no channel through which to exchange addresses — it's a chicken-and-egg: to talk you need an address, to get an address you need to talk. Every real system solves it with *some* meeting point:

- A discovery server (Syncthing).
- A signaling server (WebRTC — the app must supply one; the protocol has no built-in discovery).
- A DHT (distributed hash table — a peer-to-peer lookup table like BitTorrent's). This removes the *single* server but not the *bootstrap* problem: you still need well-known bootstrap nodes to enter the DHT, so it is "less centralized," not "serverless," and it is far more complexity than a 2–10 person tool warrants.

The honest bottom line for the owner: **the relay-free path still needs one small internet rendezvous for cross-network discovery.** That is the irreducible minimum. It is small and self-hostable, but it is not zero.

### 3.5 Smallest viable cross-network primitive — stated explicitly

> **A tiny self-hostable server holding one row per device (`device key → last observed public address`), written by an authenticated announce and read by a device-key lookup over HTTPS/TLS.** That is the whole thing. It is not a relay, and its cost at camp scale is negligible.

---

## 4. The boundary to connection (preview of the next phase — not solved here)

Discovery hands you a peer's identity and a candidate public address. **Reaching it is a separate problem**, because NAT that hid the address also blocks unsolicited inbound connections. Getting through is called **NAT traversal**, and its main trick is **hole punching**:

- **STUN** (a small public helper server) tells a device its own public address as seen from the outside, and the act of asking "punches a pinhole" in its NAT for return traffic. ([WebRTC NAT traversal explainer](https://meetrix.io/blogs/stun-vs-turn-vs-ice-webrtc-nat-traversal/))
- Both peers then fire packets at each other's public addresses *simultaneously*, so each one's outbound packet props the other's pinhole open. When it works, a direct path forms.
- **It succeeds for many NAT types and fails for others.** The classic failure is **symmetric NAT** (a router that assigns a *different* external port for every destination, so the address STUN learned is already wrong by the time the peer uses it), and strict enterprise firewalls that block inbound UDP outright. ([Nabto](https://www.nabto.com/what-is-nat-traversal-in-webrtc/), [meetrix](https://meetrix.io/blogs/stun-vs-turn-vs-ice-webrtc-nat-traversal/))

**This is exactly why a relay fallback exists**, and every serious system built to connect peers directly keeps one:

- **Tailscale** (WireGuard + very aggressive NAT traversal): reports **direct-connection success rates "well north of 90%"** in typical conditions. Every connection *starts* via a **DERP relay** to exchange addresses, upgrades to direct when hole punching works, and **stays on DERP as a last resort** when it never does. ([How Tailscale is improving NAT traversal](https://tailscale.com/blog/nat-traversal-improvements-pt-1), [Connection types](https://tailscale.com/docs/reference/connection-types))
- **WebRTC** (**ICE** = try every path): **STUN** for the direct attempt, **TURN** (a relay) when direct fails — most often because a peer is behind symmetric NAT. Industry reports put **~15–20% of production connections on TURN relay**. ([bloggeek TURN](https://bloggeek.me/webrtcglossary/turn/), [meetrix](https://meetrix.io/blogs/stun-vs-turn-vs-ice-webrtc-nat-traversal/))
- **libp2p** (**DCUtR** — Direct Connection Upgrade through Relay): peers meet over a **Circuit Relay**, attempt a hole-punched direct upgrade, and **fall back to keeping the relay connection** if the upgrade fails. ([libp2p hole punching](https://blog.ipfs.tech/2022-01-20-libp2p-hole-punching/), [DCUtR spec](https://github.com/libp2p/specs/blob/master/relay/DCUtR.md))

**The honest takeaway (stated plainly, not over-argued):** the owner's hypothesis — connect directly, no relay — holds for the **majority** of real cases (Tailscale's >90% is the best real-world evidence). But a genuine minority of network/firewall combinations cannot be traversed by anyone, which is why the best systems keep a relay as a safety net. A locked-down corporate work laptop is a prime candidate for that minority — consistent with Shoresh's earlier observation that one such laptop needed relaying *even on a phone hotspot*. Deciding whether Shoresh wants that safety net is the **next phase's** call; this note only marks the boundary.

---

## 5. Scaling to N peers (2, 3, 10)

Camp scale is 2–10 peers. Discovery scales trivially here:

- **LAN:** each device announces; each hears all others. Broadcast/multicast is one-to-all, so cost does not grow with N in any way that matters at this scale. 10 devices on one WiFi discover each other for free.
- **Cross-network:** each device announces once per interval; finding the group is N lookups (or one lookup per peer you want to reach). For N=10 that is a trivial number of small HTTPS requests. Discovery-server load is negligible.
- **Topology:** at 2–10 peers a **full mesh** (every device holds a direct connection to every other) is entirely feasible — that's at most ~45 connections for 10 peers, well within reach. No hub, no election, no coordinator needed for discovery.

**The owner's instinct that small N is easy is correct — on the discovery side.** The only thing that does *not* get easier with small N is the per-*device* NAT-traversal question in §4: a single un-traversable peer is un-traversable whether the group is 2 or 10. But that's connection, not discovery.

---

## 6. Recommendation: the smallest discovery design for Shoresh

Two paths, depending on the transport decision in the sync track.

### If Shoresh embeds Syncthing as the transport (the leading option in the sync ADR)
- **Local + global discovery come for free.** You inherit §2 (LAN broadcast) and §3 (global discovery via `stdiscosrv`) with no discovery code to write.
- **Self-host the discovery server** (`stdiscosrv`) if you don't want dependence on Syncthing's public pool — it's designed for exactly this, and it's the cheap kind of server, not a relay.
- Net: discovery is a solved, no-new-code line item under this path.

### If Shoresh builds discovery custom
- **LAN:** keep what exists — **mDNS via `bonjour-service`, service type `_shoresh`** (`electron/sync/discovery.js`). It is the smallest viable LAN primitive and it already works. Keep the validate-never-trust posture (`toValidatedHost`).
- **Cross-network:** stand up **one tiny self-hostable discovery/signaling server**: authenticated **announce** (`device key → observed public address`) + **lookup by device key**, over HTTPS/TLS, mirroring `stdiscosrv`'s shape. Nothing larger.

### The one thing to flag, unavoidably
> Cross-network discovery is the single piece that **cannot** be fully serverless. It needs one small internet rendezvous. That server is **separate from, and much lighter than, a relay** — and whether Shoresh *also* wants a relay is a distinct, later, connection-layer decision.

---

## 7. Confidence + what's still open

**Confidence: high** on everything in this note.
- The discovery-vs-connection distinction, the LAN and global discovery mechanisms, and the "rendezvous is not a relay" point are well-established and directly sourced (Syncthing protocol specs, Tailscale/WebRTC/libp2p documentation).
- The claim that fully serverless cross-network discovery is impractical is a structural argument (no shared address, no channel to exchange one) corroborated by the fact that *every* production system uses a rendezvous.
- The Shoresh-specific reads (`electron/sync/discovery.js` already implements the smallest LAN primitive with the right security posture) are verified against the code.

**Deliberately out of scope (the next phase — connection / NAT traversal):**
- Whether Shoresh needs a relay fallback at all, and if so, self-hosted vs. Syncthing's relay pool.
- Actual measured direct-connection success rates for Shoresh's real user population (staff home networks, camp WiFi, locked-down work laptops) — the >90% figure is Tailscale's, a useful prior but not Shoresh's own number.
- STUN/ICE/hole-punching mechanics in depth, and the specific behavior of the one work-laptop case that relayed even on a hotspot.

**Bottom line for the owner:** finding peers is the easy half — free on the same WiFi, and needing only a tiny cheap lookup server across different WiFis. That lookup server is *not* the relay. Whether you can then connect without a relay is a genuinely different question, true for most peers and false for a stubborn minority, and it is the next thing to study.

---

### Sources
- Syncthing — Local Discovery Protocol v4: https://docs.syncthing.net/specs/localdisco-v4.html
- Syncthing — Global Discovery v3: https://docs.syncthing.net/specs/globaldisco-v3.html
- syncthing-globaldisco(7) man page: https://www.mankier.com/7/syncthing-globaldisco
- Syncthing — Discovery Server (stdiscosrv): https://docs.syncthing.net/users/stdiscosrv.html
- Syncthing — Firewall Setup: https://docs.syncthing.net/users/firewall.html
- Syncthing — Security Principles: https://docs.syncthing.net/users/security.html
- Tailscale — How Tailscale is improving NAT traversal (part 1): https://tailscale.com/blog/nat-traversal-improvements-pt-1
- Tailscale — Connection types: https://tailscale.com/docs/reference/connection-types
- WebRTC — STUN vs TURN vs ICE: https://meetrix.io/blogs/stun-vs-turn-vs-ice-webrtc-nat-traversal/
- WebRTC — TURN, when you need it and what it costs: https://bloggeek.me/webrtcglossary/turn/
- WebRTC — What is NAT Traversal (Nabto): https://www.nabto.com/what-is-nat-traversal-in-webrtc/
- libp2p — Hole punching (IPFS blog): https://blog.ipfs.tech/2022-01-20-libp2p-hole-punching/
- libp2p — DCUtR spec: https://github.com/libp2p/specs/blob/master/relay/DCUtR.md
- Shoresh code — `electron/sync/discovery.js` (mDNS/Bonjour, `_shoresh`, `toValidatedHost`)
