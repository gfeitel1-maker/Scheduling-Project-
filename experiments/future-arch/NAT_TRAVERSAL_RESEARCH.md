# NAT Traversal Research — Can Two Computers Connect Directly, and When Do They Need a Relay?

**Status:** research note, feeds the "future architecture" shared-document sync track.
**Scope:** the *connection / transport* half only. This is the companion to `PEER_DISCOVERY_RESEARCH.md`, which covered *discovery* (locating a peer). Discovery answers "where is device X?"; **this note answers "now that I know where it is, can I actually push bytes to it directly, and if not, what falls back to a relay?"** The relay question — the one the owner cares about — is decided here, not in discovery.
**Reference systems:** Syncthing (the owner already field-tested it), Tailscale, WebRTC/ICE, libp2p.
**Audience:** the product owner (non-engineer). Terms are defined as they appear.

---

## 0. TL;DR for the owner

**Your question: "if two of our computers *know* each other, can they connect directly in milliseconds without a relay?"**

Honest bottom line:

- **On the same WiFi / LAN: yes, always.** Direct, fast, no server of any kind. Your own test showed ~23 ms machine-to-machine on one LAN. This never needs a relay.
- **Across different networks: usually yes, but not always.** With the right techniques (below), best-in-class systems get a *direct* connection roughly **90% of the time** ([Tailscale](https://tailscale.com/blog/how-nat-traversal-works)). But a real, stubborn **minority of networks cannot be traversed at all** — and one of *your own machines* (the locked-down work laptop) is exactly that minority: across different WiFis a raw direct attempt got 100% packet loss, and Syncthing connected the two only through its **relay** (~47 ms). That is not a bug in your setup; it is the expected behavior for that class of network.
- **"Knowing each other" solves trust, not reachability.** Having met before (paired device keys) permanently removes the need to re-establish *identity*. It does **not** give you a usable *address* later, and it does **not** improve the odds of punching through — traversal depends on the two networks you happen to be on *right now*, not on any past meeting.
- **Every serious direct-connect system keeps a relay as a fallback** — Tailscale (DERP), WebRTC (TURN), libp2p (circuit relay). They do this because ~10–20% of real network pairs genuinely can't be connected directly. Crucially, in the modern designs the relay is used as a **matchmaker first** (help the two peers find each other and time the "punch") and only becomes a full data-forwarder for the un-punchable minority. So the server can be **tiny for the majority and only occasionally a real relay** — but it cannot honestly be reduced to *zero* if you want live connections to work for everyone.
- **Recommendation:** don't hand-build this. Embed Syncthing — its discovery + hole-punching + relay-fallback *is* exactly this stack, and it already worked in your own test. The relay it used is the safety net for the exact machine that couldn't be punched. Keeping that safety net is the difference between "live sync works for everyone" and "live sync works for everyone except the person on the corporate laptop."

---

## 1. The problem in one paragraph

Two computers on different home/office networks each sit behind a **NAT** (Network Address Translation) — the near-universal box (your router) that lets many private devices share one public internet address. NAT is great for outbound browsing but hostile to *inbound* connections: from the internet, your laptop has no stable, directly-dialable address of its own. So when peer A wants to send data to peer B, A doesn't have a real address to aim at, and even if it did, B's router would drop the unexpected incoming packet. **NAT traversal** is the set of tricks that get a direct path open anyway. When the tricks fail, a **relay** — a server both peers *can* reach outbound — forwards the bytes between them.

---

## 2. How NAT traversal / "hole punching" actually works

**Plain language.** Your router only lets replies back in for conversations *you* started. The trick is to make both peers *start* the conversation at the same instant, each aimed at the other. When A sends its first packet toward B, A's router writes down "I'm expecting a reply from B" and opens a temporary opening — a **pinhole** — for it. B does the same toward A. If the timing lines up, each side's outbound packet arrives while the other side's router is already holding its pinhole open, and the two pinholes meet in the middle. A direct path now exists. This is **hole punching**, and the both-fire-at-once version is **simultaneous open**.

**Precise, in the order a real system does it:**

1. **STUN — learn your own public address.** STUN (*Session Traversal Utilities for NAT*) is a dead-simple question a peer asks a public helper server: "what IP and port do you see this packet coming from?" Because the packet crossed your NAT on the way out, the server sees the *public* `ip:port` your router assigned — the address the outside world would have to aim at. As Tailscale puts it, *"when you talk to a server on the internet from a NATed client, the server sees the public `ip:port` that your NAT device created for you"* ([Tailscale](https://tailscale.com/blog/how-nat-traversal-works)). This is a lookup, not a relay: the STUN server sees one tiny packet and is done.

2. **Exchange candidates over a signaling channel (unavoidable).** Each peer now has a list of **candidate** addresses: its LAN address (`host`), its STUN-discovered public address (`server-reflexive`), and possibly a relay address. But A's public address is only useful to B if B *learns* it, and vice versa — and both must fire at nearly the same moment for the pinholes to line up. That requires a **signaling / coordination channel**: a shared meeting point, reachable by both, that relays these small "here's my current address, punch *now*" control messages. Tailscale is explicit that *"peers have to know in advance the `ip:port` their counterpart is using... [we need] a coordination server to keep the `ip:port` information synchronized"* ([Tailscale](https://tailscale.com/blog/how-nat-traversal-works)). **This is the key point for the owner:** even two peers that already *know and trust* each other still need a rendezvous *in the moment* to swap current addresses and time the punch, because neither can know the other's fresh NAT address in advance. Signaling is small (a few control messages); it is not data-relaying.

3. **Fire simultaneously.** Both peers send packets at each other on the exchanged addresses. Pinholes open, packets cross, a direct connection forms — typically in well under a second when it works.

4. **ICE ties it together.** **ICE** (*Interactive Connectivity Establishment*) is the standard framework — the one WebRTC uses — that gathers all candidate addresses and tries them in a preference order: **host (LAN) first → server-reflexive (STUN hole-punch) next → relayed (TURN) last** ([bloggeek](https://bloggeek.me/webrtcglossary/ice/)). It uses whichever works and keeps the best. Every system below is some flavor of this ladder.

---

## 3. NAT types — which ones can be traversed

Hole punching works by *predicting* the public port your NAT will use, so the other peer knows where to aim. How predictable that port is depends on the NAT's "mapping" behavior. The classic four types (from the STUN literature, RFC 3489):

| NAT type | Behavior | Hole-punchable? |
|---|---|---|
| **Full-cone** | Once a port is opened outbound, *anyone* can use it inbound. | Yes, easily. |
| **Address-restricted cone** | Reuses the same public port, but only accepts inbound from addresses you've sent to. | Yes — that's what the punch does. |
| **Port-restricted cone** | Same, but restricted to the exact `ip:port` you sent to. | Yes — simultaneous open handles this. |
| **Symmetric** | Assigns a **new, unpredictable public port for every destination**. | **Largely no** — see below. |

**Why symmetric NAT breaks simple hole punching.** With a symmetric NAT, the public port your router shows a STUN server is *not* the port it will use when talking to your peer — it picks a fresh, effectively random one per destination. So the address you learned from STUN is a lie by the time your peer tries to use it: *"symmetric NAT... randomizes the source port mapping for every outbound connection... even if both sides coordinate using STUN, they cannot predict or reuse a stable port"* (search synthesis of the NAT-traversal literature). If **both** peers are behind symmetric NATs, direct punching is close to hopeless without heavy tricks (§4). If only one side is symmetric, **port prediction** and the **birthday-paradox** attack (§4) can still often win.

**CGNAT — the modern complication.** **Carrier-Grade NAT** (*CGNAT*) is a *second* layer of NAT run by the ISP itself: many customers share one public address at the carrier. It is standard on **mobile / phone-hotspot networks** and increasingly on home ISPs short on IPv4 addresses. Measurements found CGNAT on **>17% of end-user networks and >90% of cellular networks** ([Richter et al., IMC 2016](https://www.icir.org/christian/publications/2016-imc-cgnat.pdf); [Wikipedia: Carrier-grade NAT](https://en.wikipedia.org/wiki/Carrier-grade_NAT)). CGNATs are frequently symmetric and never accept unsolicited inbound, so they make direct connection materially harder — and libp2p flatly notes that if *"your ISP uses CG-NAT... then it is not possible"* to hole-punch to you ([libp2p](https://libp2p.io/docs/dcutr/)).

**Firewalls that block regardless of NAT type.** Separate from NAT, a **strict / enterprise firewall** may block all UDP, or all unsolicited inbound of any kind — this is a *policy* decision, not an addressing one, so no amount of clever port math helps. **This is almost certainly what happened with the owner's managed work laptop:** it blocked inbound, so the raw direct TCP attempt saw 100% packet loss even though the address was known. The laptop's *policy* was the wall, and only a relay (which both machines reach *outbound* over HTTPS) got around it.

**Mapping this to camp-realistic networks:**

| Network the staff are on | Typical reachability |
|---|---|
| Home WiFi | Usually traversable (cone NAT); direct connection normally succeeds. |
| Phone hotspot / cellular | Often hard — CGNAT + symmetric; frequently relay-only. |
| Corporate / org / campus / guest WiFi | Often blocks UDP, isolates clients from each other ("client isolation"), or firewalls inbound — hard to impossible. |
| **Managed / locked-down work laptop** | May block inbound on *any* network regardless of the NAT — the owner's own failing case. |

---

## 4. Real-world direct-vs-relay statistics from best-in-class systems

The honest headline: **every system engineered specifically to connect peers directly still ships a relay fallback, because a measurable minority of network pairs cannot be traversed.** The numbers:

**Tailscale (WireGuard-based mesh VPN).** Their canonical write-up estimates *"you could get a direct connection over 90% of the time, and your relays guarantee some connectivity all the time"* ([Tailscale, "How NAT traversal works"](https://tailscale.com/blog/how-nat-traversal-works)). Their toolbox is the full arsenal:
- STUN for public-address discovery;
- **UPnP-IGD / NAT-PMP / PCP** — three protocols for *politely asking the router to open a port for you* proactively, which turns a hard NAT into an easy one when the router cooperates;
- **port prediction** and the **birthday-paradox** attack for endpoint-dependent (symmetric-ish) NATs: instead of guessing one port, fire probes at *many* ports at once so a collision becomes statistically likely — *"with 256 probes, success probability reaches 64%; with 1,024 probes, 98%"*, and half the time it succeeds in under 2 seconds ([Tailscale](https://tailscale.com/blog/how-nat-traversal-works); see also [Improving NAT traversal, part 1](https://tailscale.com/blog/nat-traversal-improvements-pt-1));
- **DERP** (*Designated Encrypted Relay for Packets*) as the fallback, carried over **HTTPS/TCP 443** so it works even where UDP is entirely blocked — precisely the locked-down-firewall case.

**WebRTC / ICE (the browser real-time stack).** The widely-cited industry figure is that **roughly 15–20% of consumer WebRTC sessions need TURN** (the relay) to connect, though it *"can be anything between 0 and 50 percent depending on your user base... which is why it is worth measuring rather than guessing"* ([bloggeek, "TURN"](https://bloggeek.me/webrtcglossary/turn/)). TURN (*Traversal Using Relays around NAT*) is ICE's last-resort relayed candidate.

**libp2p (IPFS's peer-to-peer stack) — DCUtR.** libp2p pairs **Circuit Relay v2** (a relay a non-dialable peer can be reached through) with **DCUtR** (*Direct Connection Upgrade through Relay*): the peers first connect *via the relay*, then use that relayed channel to swap addresses and time a hole-punch, upgrading to direct and dropping the relay ([libp2p](https://libp2p.io/docs/dcutr/); [IPFS blog](https://blog.ipfs.tech/2022-01-20-libp2p-hole-punching/)). A large-scale measurement across **4.4M attempts from 85,000+ networks in 167 countries** found a **conditional hole-punch success rate of 70% ± 7.1%** (given that relay reservation and address discovery first succeeded), with **TCP and QUIC both ~70%** ([Large-Scale Measurement of DCUtR in IPFS, arXiv:2604.12484](https://arxiv.org/abs/2604.12484)). Note this ~70% is *lower* than Tailscale's ~90% — the decentralized-web population includes far more CGNAT/mobile/symmetric peers, which is a useful reminder that the "direct success rate" is a property of *your users' networks*, not of the software.

**Synthesis.** Depending on the population, **~80–90% direct is achievable for typical desktop/home networks, dropping toward 70% (or worse) when mobile/CGNAT/corporate networks are common.** The remaining 10–30% is not a solvable engineering gap — it's the structural reality of symmetric NAT, CGNAT, and firewall policy. That is why *every* one of these systems keeps a relay.

---

## 5. "Relay as matchmaker, not middleman" — the pattern that answers the owner's minimal-server hope

The owner's instinct — "I don't want a server sitting in the middle of all our data" — is *exactly* the design principle these systems already follow. The relay's role is minimized in two stages:

- **For the majority (punchable networks): the server is a matchmaker only.** It carries a handful of tiny **signaling** control messages (STUN results, "punch now" timing) and then **steps out of the data path entirely** once the direct connection forms. Tailscale's DERP does double duty — *"we use this communication path both as a data relay when NAT traversal fails... and as the side channel to help with NAT traversal"* — and for successful punches it's only ever the side channel ([Tailscale](https://tailscale.com/blog/how-nat-traversal-works)). libp2p's DCUtR is the sharpest example: the relay carries the *initial* connection just long enough to coordinate the punch, then the peers upgrade to direct and the relay drops out. **Your actual data never touches the server in the common case.**
- **For the un-punchable minority: the server becomes a real relay.** Only the ~10–30% that can't be traversed keep forwarding all their bytes through it — the safety net that "guarantees *some* connectivity all the time."

**Proactive helpers that raise the direct-success odds (shrinking the minority):**
- **UPnP-IGD / NAT-PMP / PCP** — the app asks the router directly to open and forward a port. When the router says yes (many home routers do), a would-be-hard NAT becomes trivially reachable, no punching needed.
- **Port prediction / birthday-paradox** — statistical port-guessing that recovers many symmetric-NAT cases (§4).
- **IPv6 — the quiet game-changer.** With IPv6, addresses are so plentiful that devices often get a *real, globally-routable address with no NAT at all*. When **both** peers have working IPv6, they can frequently connect directly with no traversal trickery — the NAT problem simply doesn't exist for that path. IPv6 availability is rising, so this increasingly sidesteps the whole issue for a growing share of connections (Syncthing, Tailscale, and libp2p all try IPv6 candidates first for this reason).

Net: the "minimal server" the owner wants is real and standard — but it is a **signaling + occasional-relay** server, not *no* server.

---

## 6. The owner's specific probe: does meeting on the SAME network first help later, after everyone scatters?

This deserves a precise, point-by-point answer because it's the crux of the owner's hypothesis.

**(a) Prior LAN pairing permanently solves IDENTITY / trust — and that's genuinely valuable.** When the machines were together on one WiFi, they exchanged device keys (Shoresh's existing pairing). That trust is durable: they never have to re-pair, and any future cross-network rendezvous therefore **never handles trust — only address lookup**. This is a real reason LAN-first is worth doing. It shrinks what the server must be trusted with to almost nothing.

**(b) It does NOT hand you a usable future ADDRESS.** The address a peer had on the shared LAN is a *private* address (like `192.168.x.x`) — meaningless and unreachable from anywhere else on the internet. Once a peer moves to a different network, it gets a **new, NAT'd public address** that neither it nor its peers could have known in advance. So the prior meeting gives you the peer's *identity* but not its *current whereabouts*; the whereabouts must be looked up fresh every time, which is why a rendezvous/signaling point is still needed in the moment.

**(c) It does NOT by itself improve hole-punch success.** Whether a punch works depends entirely on the **two NATs/firewalls the peers are behind at connection time** — their type, whether they're symmetric, whether they're CGNAT, whether a firewall blocks inbound. None of that is affected by a past meeting on a different network. Having-met-before changes *trust*, not *traversability*.

**(d) The one real exception: a peer with a stable, reachable address.** If a particular peer has a **static public IP, a dynamic-DNS name, a manually port-forwarded router, or a UPnP-opened port**, then others *can* reconnect straight to it with little or no rendezvous — it behaves like a mini-server. This is worth exploiting where it exists (e.g. a camp office desktop on a fixed line could be a natural always-reachable anchor). But **managed laptops and phones generally cannot accept inbound**, so you can't rely on every peer being such an anchor.

**Two related ideas the owner may be reaching for:**
- **"Last-known-address" caching.** Remembering where a peer *was* helps only if it's *still* there (same network, still reachable). It's a cheap optimization worth having, but it doesn't replace a fresh lookup after anyone moves.
- **Keeping a connection alive / keep-alives.** A live direct connection is great *while it lasts* — but a network change (staff member leaves camp WiFi for home) **breaks it**, and re-establishing it lands you right back at the same NAT-traversal problem, needing the same rendezvous. Persistence doesn't dodge the connection problem; it just defers it to the next network change.

**Net for the owner:** meeting on the same network first is worth doing — it permanently removes *trust* from the cross-network path and lets you exploit any stable-address peers. But it **cannot eliminate the ongoing need for a small address-lookup + punch-coordination server**, and it does nothing to rescue the un-punchable minority. LAN-first *shrinks* the server's job; it does not delete the server.

---

## 7. What "no relay AT ALL" would concretely cost

Suppose the decision is to ship signaling (matchmaking) but **no data-relay fallback whatsoever**. Then for the un-traversable minority — symmetric-NAT-on-both-sides, CGNAT (many phone hotspots), and locked-down corporate/managed devices like the owner's work laptop — the outcome is concrete and unavoidable:

> **Those peers get NO live cross-network connection.** They cannot receive live edits from, or push live edits to, the rest of the group while apart.

What they'd fall back to is **asynchronous / eventual sync**: changes propagate later, whenever a path *does* exist — e.g. via the shared `.shoresh` folder synced through Syncthing's *own* relay (if embedded), through a shared cloud folder, or simply "the next time everyone is back on the same WiFi." No data is lost; it just isn't *live*.

**Framed as the actual product decision:** *Is it acceptable to tell the stubborn minority "real-time collaboration across networks won't work for you — your changes sync up later instead"?* For a handful of camp staff who are mostly co-located on camp WiFi and only occasionally remote, this may well be acceptable — the live path covers the common case and eventual sync covers the rest. But note **the minority includes the owner's own work laptop**, so "no relay at all" is not a hypothetical exclusion — it would exclude a real, named device that already failed to connect directly in testing.

**How common is the minority, for camp-realistic setups?** Rough, honest estimate: if staff are mostly on home/camp WiFi, expect **~80–90% of cross-network peer *pairs* to connect directly** (Tailscale-like conditions). The failing ~10–20% concentrates in three buckets — anyone on a **phone hotspot / cellular** (CGNAT, often relay-only), anyone on a **restrictive corporate/guest network**, and any **managed device** that blocks inbound. Those buckets are small in count but they're *predictable* and they recur (the same laptop fails every time), so the felt impact is "one specific person's live sync never works," which is more annoying than a random 15%.

---

## 8. Recommendation + the smallest sensible design

**The minimal connection stack is the ICE ladder, and you should not build it by hand:**

1. **Host / LAN candidate first** — if peers are on the same network, connect directly (already what Shoresh does; ~23 ms in testing). Free, no server.
2. **STUN hole-punch** — discover public addresses, exchange them over a small signaling channel, punch. Add proactive helpers (UPnP/NAT-PMP/PCP, IPv6-first, port prediction) to push the direct-success rate toward ~90%.
3. **Relay fallback** — for the un-punchable minority, forward bytes through a relay reachable over HTTPS/443. Used as **matchmaker for everyone, middleman only for the stubborn few.**

**Strong recommendation: embed Syncthing rather than assembling STUN/ICE/TURN or WebRTC/libp2p yourself.** Syncthing already ships *this exact stack* — local discovery, global discovery, hole punching, **and relay fallback** — and it is the system that **already worked in the owner's own test** (~47 ms via its relay to the very laptop that couldn't be punched). Its relay pool is community-run and self-hostable, and by design a relayed transfer is end-to-end encrypted so the relay sees only ciphertext. Building custom means standing up and operating STUN + a signaling service + TURN (or adopting the full weight of WebRTC or libp2p) — a large amount of protocol surface, all of which Syncthing gives you for free and has already proven against your hardest case.

**If a custom transport is ever required** (e.g. to avoid the Syncthing dependency), reuse a batteries-included library — **libp2p** (DCUtR + circuit relay) or a **WebRTC** data-channel stack — rather than reimplementing NAT traversal. Do not write STUN/ICE/TURN from scratch; it is a multi-year, heavily-cornered problem and the field's own measurements (§4) show even the experts land at 70–90%, not 100%.

---

## 9. Confidence + what's still open

**High confidence:**
- LAN direct connection is free and reliable (owner-verified, ~23 ms).
- Cross-network direct connection succeeds for the *majority* but a real minority (symmetric NAT, CGNAT, locked-down firewalls) cannot be traversed — sourced to Tailscale (~90%), WebRTC/TURN (~15–20% relay), and libp2p/IPFS (70% ± 7.1%).
- A signaling/rendezvous point is structurally required even between known-identity peers (they can't know each other's fresh NAT addresses in advance).
- The relay can be minimized to matchmaker-for-the-majority + middleman-for-the-minority, but not to zero if live sync must work for everyone.
- The owner's work laptop is a genuine member of the un-punchable minority (relay-only in testing), not a fixable fluke.
- Embedding Syncthing supplies the whole stack and already handled the hardest case.

**Still open (needs the owner's numbers / a decision, not more research):**
- **The actual direct-vs-relay split for *these specific staff and networks*** — this can only be *measured*, not predicted (the field's own advice: "measure rather than guess"). A short instrumented pilot across the real devices would replace the ~80–90% estimate with a real number.
- **Product call:** is "eventual sync, not live" acceptable for the stubborn minority (which includes a known internal laptop)? If yes, a relay-less design is viable; if no, a relay fallback is mandatory.
- **If self-hosting a relay/signaling point:** sizing, encryption posture, and who operates it (small ongoing ops cost) — sketched separately in `RELAY_OPERATIONS_SKETCH.md`.
- **IPv6 upside** for this population is unquantified — if camp and staff-home ISPs offer working IPv6, the direct-success rate could be higher than the IPv4-centric estimates suggest.

---

### Sources

- Tailscale — [How NAT traversal works](https://tailscale.com/blog/how-nat-traversal-works) (~90% direct; STUN; birthday-paradox; UPnP/PMP/PCP; DERP as signaling + relay)
- Tailscale — [How Tailscale is improving NAT traversal, part 1](https://tailscale.com/blog/nat-traversal-improvements-pt-1) and [part 2](https://tailscale.com/blog/nat-traversal-improvements-pt-2-cloud-environments)
- bloggeek.me — [TURN](https://bloggeek.me/webrtcglossary/turn/) (~15–20% of WebRTC sessions need TURN) and [ICE](https://bloggeek.me/webrtcglossary/ice/) (host → srflx → relay candidate order)
- libp2p — [DCUtR](https://libp2p.io/docs/dcutr/) and [Hole Punching](https://libp2p.io/docs/hole-punching/)
- IPFS blog — [Hole punching in libp2p — overcoming firewalls](https://blog.ipfs.tech/2022-01-20-libp2p-hole-punching/) (circuit relay v2 → DCUtR upgrade; symmetric NAT failure)
- arXiv:2604.12484 — [Large-Scale Measurement of NAT Traversal (DCUtR in IPFS)](https://arxiv.org/abs/2604.12484) (70% ± 7.1% conditional hole-punch success; TCP ≈ QUIC ≈ 70%; 4.4M attempts / 85k networks / 167 countries)
- Richter et al., IMC 2016 — [A Multi-perspective Analysis of Carrier-Grade NAT Deployment](https://www.icir.org/christian/publications/2016-imc-cgnat.pdf) (CGNAT on >17% of eyeball ASes, >90% of cellular ASes)
- [Wikipedia: Carrier-grade NAT](https://en.wikipedia.org/wiki/Carrier-grade_NAT) (CGNAT breaks unsolicited inbound / P2P)
- Companion: `experiments/future-arch/PEER_DISCOVERY_RESEARCH.md` (discovery layer; Syncthing local/global discovery)
