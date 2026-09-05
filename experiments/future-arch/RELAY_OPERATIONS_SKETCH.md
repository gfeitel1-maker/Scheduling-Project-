# The relay — operational shape (doc-first)

**Conceptual, isolated, not an implementation.** The ADR now makes a **relay the primary
live path** (both computers dial *outward* to a switchboard, because managed networks block
direct connections and the user can't reconfigure them). That promotes one real question from
"deferred maybe" to "must decide": **who runs the relay, where, and how is it paid for?** This
sketch answers it in plain terms, with a recommendation.

## First, what the relay is (so the operational choice is grounded)

A tiny, always-on program on a computer reachable from the internet. Every online Shoresh
opens an **outbound** connection to it (which even locked-down work networks allow). When one
Shoresh sends an operation, the relay **forwards it to the other members of that camp** and can
**briefly hold** messages for someone who's momentarily offline. That's the whole job.

What it is **not**, and this drives everything below:
- **Not a database.** It stores no schedules, no camp state. Lose it entirely and every laptop
  still has the whole camp (local SQLite is the truth; the folder is the async backstop).
- **Not an authority.** It doesn't decide anything. It routes messages by camp and verifies a
  connecting device is a current member (using the signed-membership identity model), then
  forwards. It can forward **sealed envelopes it cannot read** (see the encryption question).
- **Not a single point of failure for your data or your offline work** — only for the *live*
  feature. Relay down ⇒ collaboration silently degrades to async (folder), never breaks.

Technically it's Shoresh's existing LAN WebSocket server (`syncServer.js`), **relocated** to a
reachable host and **stripped** to forward-and-briefly-buffer (it drops the referee and notary
jobs — the peers order operations themselves via logical clocks, and identity is owner-signed).

## How the relay fits the whole transport picture (important framing)

A common mental model is "we're building 3 connection paths: LAN WebSocket, Syncthing, and a
relay." That's misleading, because **Syncthing is not a third path — it is a whole system that
already contains LAN + across-networks + relay + async, and adapts automatically:**

- **Same LAN** → Syncthing connects the two devices **directly** (local discovery). Fast.
- **Different networks, reachable** → Syncthing **hole-punches a direct** connection through the NATs.
- **Different networks, blocked** (a locked-down work laptop) → Syncthing falls back to its **relay**.
- **Everyone offline** → Syncthing is also the **async catch-up** (syncs the folder when a path returns).

So embedding Syncthing collapses the "3 paths" into **one adaptive transport**. The real
architectural choice is:
- **A — Syncthing does everything** (proven; embed + tune; relay = its pool or self-host). Likely
  makes Shoresh's bespoke LAN WebSocket **redundant** (Syncthing does LAN too), unless you
  specifically want sub-millisecond LAN live (cursors), which Syncthing's file-sync can't match.
- **B — Build your own** (WebSocket for LAN + your own relay + discovery + NAT traversal). Full
  control, sub-ms possible, but you build and run the relay/discovery/traversal — the infra to avoid.
- **C — Hybrid** (WebSocket for same-LAN live; Syncthing for everything else). Best-of-both, two
  systems to maintain.

**Three things ride ON TOP of whichever transport, and are separate from it:**
1. **Discovery** — how two devices *find/locate* each other before connecting. On a LAN this is
   mDNS/local broadcast (Shoresh already does this in `electron/sync/discovery.js`). Across networks
   it needs a rendezvous/discovery server (Syncthing's global discovery). **Discovery is separate
   from the relay**: discovery tells you *where* a peer is; the relay is only needed when, even
   knowing where, you *can't reach it directly* (NAT/firewall). This distinction is where the
   "do we even need a relay?" question actually lives — it's a *connection*-layer question, not a
   *discovery*-layer one.
2. **Presence** — "who's online / who's viewing / who's editing this." Ephemeral and losable; must
   not be conflated with durable operations (which can never be lost). May want a live channel of
   its own, distinct from the durable journal.
3. **Identity/authorization** — *who is allowed* (the signed membership ledger). Orthogonal to every
   transport: the transport carries bytes; membership decides whose bytes count. "Can they connect"
   (device pairing / discovery) ≠ "are they a member."

**Latency tiers are not equal** (matters for what you can promise): Shoresh WebSocket on LAN =
sub-ms–low-ms (true live cursors); Syncthing on LAN = tens of ms; Syncthing via relay = tens of ms
to a few seconds. Syncthing even tuned is *fast sync*, not a real-time cursor bus — fine for a
camp's turn-taking, but know the ceiling.

**Open hypothesis being researched (2026-08-19):** whether good discovery + NAT traversal can
connect peers directly across networks reliably enough that the relay becomes a rare fallback (or
unnecessary). The relay lives in the *connection* layer; solving *discovery* alone does not remove
it. See the peer-discovery research report (companion doc) for the honest answer per network type.

## Who could run it — the options

| Option | Who hosts | Camp setup effort | Data sovereignty | Your ops burden | Fit |
|---|---|---|---|---|---|
| **A. Shoresh-run central relay** | You (one cloud service all camps use) | **None** — it just works | Camp data transits your server (unless encrypted) | You operate it (cheap; see below) | Best for small camps; matches "director configures nothing" |
| **B. Self-hosted per camp/org** | The camp/org (a $5 VPS, an office box + tunnel) | **High** — needs IT skills | Total — nobody else touches it | None | Only viable for orgs with IT (e.g. a JCC) |
| **C. Hybrid: default central + optional self-host** | You by default; org can point at its own | **None** by default; opt-in for orgs | Choice: central, or self-host for sovereignty | You run the default | **Recommended** |
| D. Third-party relay service | A vendor | None | Vendor sees traffic; less control | Low, but vendor lock-in | Weak fit; generic relays don't match the membership-auth model |
| E. One camp computer acts as relay | A camp laptop | — | — | — | **Impossible** — that's the inbound-connection problem again; other peers can't reach it on managed networks |

## The cost reality (why this is not scary)

A forwarding relay is **cheap**. Operations are tiny (a field change is a few hundred bytes),
there's **no storage** and **almost no compute** — it shuffles small messages. One small VM can
serve **many** camps at once. At camp scale (a few staff per camp, dozens or hundreds of camps)
the bill is in the low tens of dollars a month, not thousands. Cost is not the deciding factor;
**responsibility and privacy** are.

## The graceful-degradation guarantee (why a central relay is safe to depend on)

Because the relay holds no data and every device is local-first:
- Relay up ⇒ live collaboration.
- Relay down / unreachable ⇒ Shoresh silently falls back to the **folder** (async) and keeps
  working fully offline. Nothing is lost, nothing breaks — you just lose the *live feel* until
  it's back.

So a central relay is **not** the fragile always-on cloud the whole investigation set out to
avoid. It's an optional accelerator for the live feature, not the spine of the product.

## The one question the relay forces us to re-open: encryption

Decision **D1** (identity model) deferred encryption — *integrity-only v1* — and that was right
**for the folder**, where anyone with folder access can already read the data anyway. **A central
relay is different:** it's *Shoresh's own servers* that camp operations would pass through. Even
though camp schedules aren't highly sensitive, "our company's servers transit customers' data in
the clear" is a liability and trust question you'd rather not carry.

The clean fix is **end-to-end encryption on anything crossing a relay**: the peers encrypt each
operation with a project key only members hold, so the relay forwards **sealed envelopes it
cannot read**. Then a central relay is data-less *in fact*, not just in policy — it literally
*cannot* see camp data, which removes the liability entirely and makes "we run the relay" an easy
promise. This is a *scoped* revision of D1: keep integrity-only for the folder, but require E2E
for the relay hop specifically.

## Decisions locked (owner, 2026-08-19)

The owner sharpened the recommendation: **do not build or operate a bespoke Shoresh relay.**
If it comes to paying for / running infrastructure, **reuse an existing managed realtime service,
or have the org's IT provide a server path** — rather than standing up our own. This is the "don't
rebuild existing technology" principle from the founding brief applied directly. (The owner named
Supabase's free tier as an *illustration* of the kind of thing to reuse — "I didn't mean that
literally" — not as a locked vendor choice.)

- **R1 — Relay host: reuse an existing managed realtime broadcast service, or an org-provided
  server; don't build a bespoke relay. Specific provider chosen later.** Any hosted "clients dial
  out and broadcast to a channel" service is a ready-made switchboard. Whichever is picked is used
  **only as a dumb message pipe** — never as the database/auth/RLS backend. Local SQLite stays the
  source of truth. Candidates to evaluate when it's actually built: a managed realtime/pub-sub
  service (Supabase Realtime, Ably, Pusher, an MQTT/WebSocket host, etc.), or an org-IT-provided
  server. The **transport seam makes the relay swappable** without touching Shoresh, so this choice
  is deliberately deferred and reversible — decide it at the paying/build point, not now.
- **R2 — Self-host / org-IT path: YES, offer it.** An org (e.g. a JCC with IT) can point Shoresh at
  its own relay / an IT-opened server connection instead of the managed default.
- **R3 — Encrypt the relay hop: YES (scoped revision of D1).** Peers seal each operation with a
  member-only key; the relay forwards **envelopes it cannot read**. The folder stays integrity-only;
  anything crossing a third-party/managed relay is end-to-end encrypted. This is what makes using a
  third-party pipe (Supabase) safe — it *cannot* see camp data.

### Refinement this unlocks: the relay is pure live broadcast (no durability)
Because the **`.shoresh` package (folder) already provides durability and offline catch-up**, the
relay does **not** need to store or buffer anything. It is **live-only broadcast among currently
connected members** — exactly what Supabase Realtime is. Offline peers catch up through the package,
not the relay. The relay gets even dumber: no state, no buffer, no authority. Just forward sealed
envelopes among who's online now.

### Honest caveats (carried, for whenever a provider is actually chosen)
1. **Free-tier limits** on any managed service (concurrent connections / messages per month). Fine
   at camp scale; the paying point is the trigger to reassess. The transport seam keeps the relay
   swappable, so this stays a late, reversible decision.
2. **If Supabase specifically is ever the chosen provider:** the codebase currently BANS
   `@supabase/*` imports under `src/` and `electron/` (an ESLint rule from the local-first rebuild,
   to stop Supabase returning as a backend). Reusing Supabase Realtime would require a **deliberate,
   narrowly-scoped exception** — a realtime-*transport* module only, never data/auth/RLS — decided
   on purpose, not slipped past the guard. (Not a concern for a non-Supabase provider or an
   org-hosted server; noted only so it isn't a surprise if Supabase is picked.)
