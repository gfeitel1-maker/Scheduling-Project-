# NAT Hole-Punching Without a Relay You Run — What's Actually True

**Question under test:** Can two NAT'd peers on different networks establish a *direct*
connection via hole-punching **without a dedicated relay server that you run** — and can
libp2p do it? A prior claim asserted "hole-punching always requires a relay."

**Verdict up front:** The prior claim is **too strong and, as stated, wrong** — *if* "relay"
means "a server that carries your data." Hole-punching does **not** require a data relay for
the majority of punchable peers. What it *does* require is a **mutually-reachable coordination
point** (address reflector + signaling rendezvous). That coordination point can be public
infrastructure you don't run (public STUN, a public DHT), so "no infrastructure *I* run" and
"no data relay carrying my traffic" are both achievable. But "**no coordination server
whatsoever**, for two peers who have never met" is **not** generally achievable — that's the
kernel of truth the prior claim was groping at. The claim conflated "needs coordination" with
"needs a relay." Those are different things.

The one important libp2p-specific caveat is at the bottom: libp2p's DCUtR is architecturally
built to coordinate *over a circuit-relay connection*, so with stock libp2p you still lean on a
relay as the **signaling channel** (though not as a data path, and it can be a public one).

---

## 1. Signaling vs. relay — the core distinction

Hole-punching needs two things before the "punch": (a) each peer learns its own public
`address:port` as seen from the outside, and (b) the peers exchange those addresses and
coordinate a roughly simultaneous dial. Neither of these is inherently a *data relay*. Four
different mechanisms can supply them:

| Mechanism | What it does | Carries your data? | Who runs it |
|---|---|---|---|
| **STUN server** | Reflects your public IP:port back to you ("what do I look like from outside?"). Address discovery only. | **No.** One request/response, then it's out of the path. | Public STUN exists (Google, others); you can run one but rarely need to. |
| **Signaling server** | Relays a *few small control messages* (each peer's candidate addresses) so the two peers can find each other. No media/data path. | **No** — control plane only. | Usually you run it (WebRTC's classic gap), OR it can be a chat/DHT/pre-shared channel. |
| **DHT (e.g. Kademlia)** | Distributed rendezvous: peers publish/look up each other's current addresses via a shared hash table. Replaces the signaling server with public P2P infrastructure. | **No** — it's a lookup service. | Public (IPFS/BitTorrent DHTs) or your own bootstrap. |
| **TURN / circuit relay** | Actually forwards your data end-to-end when a direct path can't be made. | **Yes** — this is a true relay. | You (TURN) or public volunteers (libp2p relays). This is the *fallback*, not the punch. |

The key move: **STUN, signaling, and DHT are coordination; TURN/circuit-relay is data
relay.** They are frequently confused because in some stacks (libp2p, Tailscale) the *same
server* plays both roles. That coupling is an implementation choice, not a law.

---

## 2. The minimal requirement — the chicken-and-egg

**For two peers who have NEVER connected before, both behind NAT: some mutually-reachable
coordination point is strictly necessary.** There is no way around the chicken-and-egg:

- A NAT'd peer does not know its own public `IP:port` until something on the outside tells it
  (that's STUN's whole job — a NAT mapping is created *by outbound traffic* and is only
  observable from outside).
- Even knowing its own mapping, it has no way to learn the *other* peer's current mapping, and
  the other peer's mapping doesn't even exist until that peer sends outbound traffic. Two
  silent NAT'd hosts are mutually invisible. Something both can reach must broker the exchange.

So a **genuinely serverless method for never-before-met NAT'd peers does not exist.** But
"server" here can be **public infrastructure you don't run and that never sees your data** — a
public STUN box and a public DHT satisfy the requirement.

**If they PREVIOUSLY met — this is the interesting case.** If the peers exchanged keys and
some contact info out-of-band (e.g., on a LAN, via QR code, via a shared file), the *rendezvous*
half can sometimes be avoided — but the *address-discovery* half usually can't. NAT mappings
are ephemeral: a peer's public `IP:port` from last week is almost certainly stale (mappings
expire in seconds-to-minutes, and DHCP/carrier-NAT churn changes the public IP entirely). So
**cached info + STUN is generally not sufficient on its own**, because each side still needs to
learn the *other's current* mapping and agree on timing — that's a fresh exchange, which needs a
live channel. Cached keys make the connection *secure and authenticated* without a server; they
don't make it *reachable* without one. The realistic serverless-ish setups still lean on a
public DHT or a pre-shared always-on channel (e.g., both peers subscribe to a known
pubsub topic) to do the live address exchange.

---

## 3. libp2p specifically — the key part

**libp2p's hole-punching (DCUtR — "Direct Connection Upgrade through Relay") is, by design,
coordinated over a circuit-relay connection.** The name is literal. Per the libp2p docs, the
flow is: peer A reaches peer B *through a public relay* (Circuit Relay v2), then **"uses DCUtR
as a synchronization mechanism to coordinate hole punching"** over that relayed connection —
exchanging `Connect` messages (each peer's non-relayed addresses) and a `Sync` message to time
the simultaneous dial. So for **stock libp2p, a circuit-relay connection is the coordination
channel — it is effectively mandatory as the signaling path**, not merely one option among
several. ([libp2p Hole Punching](https://libp2p.io/docs/hole-punching/),
[libp2p/specs hole-punching.md](https://github.com/libp2p/specs/blob/master/connections/hole-punching.md))

But three things sharply narrow what that costs you:

1. **The relay carries no bulk data.** Circuit Relay v2 is deliberately *limited* (byte and
   time caps) — it exists to broker the punch, then the direct connection takes over. The libp2p
   docs note this resource-limited coordination "doesn't require an unlimited relay connection...
   an important advantage." So even in libp2p, **your actual data does not flow through the
   relay** once the punch succeeds. It's a signaling relay, not a data relay.

2. **The relay does not have to be one you run.** libp2p finds relays via the **Kademlia
   DHT** — "IPFS discovers the k-closest public relay nodes using a lookup method via Kademlia
   DHT," and in IPFS "each public node would serve as a Relay." **AutoNAT** is the STUN-analog
   that tells a node it's behind NAT and needs this path at all. So a from-scratch libp2p
   cross-network direct connection can rely entirely on **public IPFS infrastructure** (public
   bootstrap → DHT → public relays) with **no relay you operate**. ([libp2p Hole Punching](https://libp2p.io/docs/hole-punching/))

3. **What a from-scratch libp2p direct connection requires at minimum:** (a) address discovery
   (AutoNAT + observed addresses), (b) a rendezvous to find the peer and a relay (public DHT +
   bootstrap nodes), (c) a circuit-relay connection as the DCUtR signaling channel (can be
   public), then (d) the direct dial. The relay is mandatory *as coordination*; it is **not**
   mandatory *as something you run* and **not** a data path.

**Bottom line for libp2p:** you cannot easily get libp2p to hole-punch using *only* AutoNAT +
DHT with *no relay connection at all* — DCUtR is wired to signal over a relay. But you can get
it to punch with **no relay that you run and no relay carrying your data**, by leaning on the
public IPFS DHT and public relays. That distinction is exactly where the prior "you need a
relay" claim is half-right (a relay *connection* is in the loop) and half-wrong (it needn't be
yours and doesn't carry your data). Real-world success rate for the punch itself is ~70% (see §4).

---

## 4. Real-world systems — who relays data vs. who only coordinates

- **WebRTC — the crucial case, and it confirms the user.** WebRTC gathers ICE candidates,
  uses **STUN** to discover its public mapping, then attempts UDP hole-punching directly between
  peers. **TURN (the data relay) is only a fallback.** Measurements put the STUN-only direct
  success rate around **70–90%**; roughly **10–22%** of sessions fall back to TURN (higher on
  cellular / symmetric-NAT / restrictive enterprise Wi-Fi). So for the majority of peers,
  **WebRTC establishes a direct connection with NO relay carrying data** — STUN reflects
  addresses and is then out of the path. WebRTC's one catch is *signaling*: it does not define
  how the two peers exchange their SDP/candidates, so you supply a signaling channel (commonly a
  small server, but it can be any channel — even a DHT or pre-shared). ([Chat&Messenger STUN/TURN
  explanation](https://chat-messenger.com/en/blog/webrtc-stun-turn-turns-sfu),
  [lazyharu: symmetric NAT wall](https://lazyharu.com/en/webrtc-nat-traversal/))

- **Tailscale (DERP).** DERP is **primarily coordination**: it relays small "DISCO" discovery
  packets to negotiate a direct path, and all connections *start* relayed then upgrade to direct
  UDP. In most environments the upgrade succeeds and DERP drops out of the data path. DERP
  **only carries data (encrypted WireGuard packets) as a fallback** when a direct path can't be
  made (hard/symmetric NAT). So DERP is a coordination server that *can* become a data relay —
  the same dual role as libp2p's relay. Tailscale also runs a separate **coordination server**
  that hands each peer the other's connection details (pure signaling). ([Tailscale connection
  types](https://tailscale.com/docs/reference/connection-types),
  [Tailscale DERP servers](https://tailscale.com/docs/reference/derp-servers))

- **BitTorrent.** Peer discovery uses a **public DHT** (Kademlia, no central server) plus
  trackers/PEX. Its hole-punching extension (BEP 55, "uTP hole punching") uses an
  **already-connected common peer as the rendezvous** to relay a small *connect* signal between
  two NAT'd peers — again, coordination via an existing peer, not a dedicated data relay. Data
  then flows directly. This is a good model of "peers-as-rendezvous, no server you run."

- **Syncthing.** Global discovery servers (address lookup, like signaling) + a **public relay
  pool** (data relay fallback) — direct when possible, relayed when not.

**Pattern across all of them:** address discovery + signaling to punch, direct data path for
the majority, and a *true* data relay reserved as fallback for the un-punchable minority
(symmetric NAT etc.).

---

## 5. Honest verdict, mapped to the goal (desktop app, few peers, no infra you run,
no public data-relay carrying your data)

**What's achievable:** direct cross-network connections for the **majority** of peer pairs
(~70–85%, NAT-type dependent) with **no relay you run and no relay carrying your data.** The
lightest dependency that gets you there is:

- **Address discovery:** public **STUN** (WebRTC/ICE) or libp2p **AutoNAT** — reflects your
  mapping, never touches your data.
- **Rendezvous/signaling:** a public **DHT** (BitTorrent-style or the IPFS Kademlia DHT) so
  peers find each other's *current* addresses without a server you run. If you already exchange
  keys out-of-band on the LAN, the DHT/pubsub still does the live address exchange.

**Where the prior "you need a relay" claim holds vs. breaks:**

- **Breaks (claim too strong):** For punchable peers, **no data relay is needed** — STUN/DHT
  coordinate, data goes direct. WebRTC's 70–90% STUN-only direct rate is the clean disproof.
  And even where a *relay connection* is used (libp2p DCUtR), it need not be one you run and does
  not carry your data.
- **Holds (kernel of truth):** (1) You **cannot** get a never-before-met NAT'd pair connected
  with *zero* coordination point — *some* mutually-reachable broker (STUN/DHT/signaling) is
  mandatory; "fully serverless" is a myth for cold-start. (2) A **~10–30% minority** of peers
  (symmetric NAT, CGNAT, restrictive firewalls) **cannot be punched at all** and genuinely need
  a **data relay (TURN / circuit relay) as fallback** — for those, there is no direct path,
  full stop. If your product must connect *every* pair 100% of the time, you need a data-relay
  fallback somewhere (yours or public).

**Concrete recommendation for this app (few peers, desktop):**

1. If you want **zero coordination infrastructure of your own**: use a **DHT-based stack**
   (libp2p with public bootstrap + DHT + public relays, or a BitTorrent-style DHT) so discovery,
   signaling, and even the fallback relay are public. Data flows direct for most peers; your
   traffic never sits on a server you run. Cost: you depend on public network health, and libp2p
   still routes the *punch signaling* through a (public) relay connection.
2. If you'll accept **one tiny signaling touchpoint but no data relay**: a **WebRTC** direct
   connection with public STUN + a minimal signaling exchange (even piggybacked on an existing
   channel) gives the cleanest "no relay carries my data" story for ~70–85% of pairs.
3. Either way, decide explicitly whether the **un-punchable minority** must connect. If yes,
   you need *a* data relay as fallback (accept a public relay pool, or run a tiny TURN). If a
   small fraction of peer pairs failing to connect directly is acceptable, you can skip data
   relays entirely.

**One-line truth:** "No relay carrying your data" is achievable for most peers via STUN/DHT;
"no coordination server whatsoever for strangers" is not. The prior claim collapsed those two
into one and overstated the requirement.

---

## Sources

- [Hole Punching | libp2p](https://libp2p.io/docs/hole-punching/)
- [Hole punching in libp2p — Overcoming Firewalls | IPFS Blog](https://blog.ipfs.tech/2022-01-20-libp2p-hole-punching/)
- [libp2p/specs — connections/hole-punching.md](https://github.com/libp2p/specs/blob/master/connections/hole-punching.md)
- [libp2p/specs — relay/circuit-v2.md](https://github.com/libp2p/specs/blob/master/relay/circuit-v2.md)
- [Large-Scale Measurement of NAT Traversal (DCUtR in IPFS), arXiv](https://arxiv.org/pdf/2604.12484)
- [Challenging Tribal Knowledge — Decentralized NAT Traversal measurement, arXiv](https://arxiv.org/pdf/2510.27500)
- [STUN/TURN/TURNS/SFU in WebRTC — Chat&Messenger](https://chat-messenger.com/en/blog/webrtc-stun-turn-turns-sfu)
- [STUN, TURN, and the Wall of Symmetric NAT in WebRTC — lazyharu](https://lazyharu.com/en/webrtc-nat-traversal/)
- [Connection types | Tailscale Docs](https://tailscale.com/docs/reference/connection-types)
- [DERP servers | Tailscale Docs](https://tailscale.com/docs/reference/derp-servers)
- [How to Implement UDP Hole Punching for NAT Traversal — OneUptime](https://oneuptime.com/blog/post/2026-03-20-udp-hole-punching-nat/view)
- [How does NAT traversal work? — Pinggy](https://pinggy.io/blog/how_nat_traversal_works/)
