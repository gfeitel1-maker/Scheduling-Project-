# Recommended future architecture — Shoresh as a shared project

**Conceptual, isolated, not an implementation plan.** Lives only on the
`claude/shoresh-future-architecture-364e03` branch. Nothing here is merged or
scheduled. Written for a non-engineer; the goal is a shared understanding to
decide from, not code.

---

## The one idea

A camp project (**"Camp Achva — Summer 2027"**) is a shared thing that many people
edit through Shoresh's different screens. Every laptop keeps its **own complete copy**
on its own disk (fast, private, works offline). Changes travel between laptops as small
**operations** ("Greg moved Archery to Field 1"). Shoresh uses **whatever way of
reaching the other laptops is available at the moment**, best to worst — and it never
loses a change, no matter which way was used.

That's it. Everything below is detail.

---

## Why "just point it at a shared folder" isn't the whole answer

We tested it, on two real machines and a real OneDrive account. What we learned:

- **A folder is a reliable, order-preserving pipe.** Operations crossed with zero loss
  and in the right order. Good.
- **A folder can't feel live, and can't even be trusted to be prompt.** Delivery was
  slow and bursty; a 5 GB background download stalled everything; and OneDrive's own
  "synced ✓" indicator was **wrong** — it claimed done while files hadn't uploaded.
- **The deep reason:** a folder just sits there. It can't *push* a change to anyone.
  Each laptop only finds out by checking, whenever its sync client gets around to it —
  a queue you don't own and can't see.

**"But Word does it over OneDrive!"** — Word does *not*. Word's live co-authoring runs
over a **live connection to a Microsoft server**, completely separate from the OneDrive
folder. The folder is just the durable copy at rest. *No one's* real-time collaboration
— Microsoft's included — is built on passive folder sync, because that layer can't do
it. Word is proof the experience is possible; it's also proof of *how*: a live channel
the app controls.

---

## The recommended shape: three ways to reach, one source of truth

```
        Each laptop: local SQLite  ← the source of truth, always. Offline-first.
                          │
                 operations (small, durable, idempotent, already built)
                          │
        Shoresh picks the best available path, automatically:
                          │
   ┌──────────────────────┼───────────────────────────┐
   │                      │                             │
1. RELAY (PRIMARY live) 2. Direct LAN (optimization) 3. Shared FOLDER (async)
   both dial OUTWARD to    when the network happens     when no live channel is
   a switchboard —         to allow device-to-device    reachable (peer offline,
   the ONLY live path      (open home Wi-Fi):            no relay): slow, bursty,
   that needs no user      milliseconds, no server.      lossless, zero infra.
   config on managed/      Silent optimization, with     The always-there backstop.
   work networks.          automatic fallback to relay.  NEVER the live path.
   Holds no camp data.
```

- **Why the relay is #1, not the LAN (field-proven 2026-08-19):** two machines on the
  *same subnet* couldn't even ping each other — a managed/work network blocks device-to-
  device by policy, and the user can't (and shouldn't have to) change it. What such
  networks *always* allow is *outbound* connections. So the only live path that works with
  **zero configuration** is both machines dialing *outward* to a relay. Direct LAN is a
  bonus when the network permits it, never a requirement.
- **The camp director picks nothing and configures nothing** — no firewall, no port, no
  network setting. Shoresh uses the relay by default, silently upgrades to a direct LAN
  connection when possible, and falls back to the folder when offline.
- **SQLite on each laptop is always the truth.** None of the three transports is a
  database or an authority — the relay included (it's a switchboard, holds no camp data).
  Lose all three for a week and every laptop still has the whole camp.

### The 1% that makes this honest: delivery must be confirmed by Shoresh, not the pipe
OneDrive lied about "synced." So Shoresh must never trust a transport's word that a
change arrived. The receiving Shoresh writes back its own **"I've got everything through
change #X"** acknowledgment. (The WebSocket path *already does this* — the
`op_applied_ack` watermark; the folder path would drop the same marker as a tiny file.)
Only then does the UI get to say an honest "shared ✓." Losing a durable change is the
one unacceptable outcome, so this is a requirement, not a nicety.

---

## The relay, sketched

**What it is:** a small, always-on program on a computer both laptops can reach over the
internet — a ~$5/month cloud machine, or a little box in the camp office. Think
**switchboard operator**: callers who can't reach each other directly call the operator,
who patches them through.

**What it does — the entire job:**
1. Each online Shoresh keeps an open line to it (like being in a group chat for that camp).
2. When one Shoresh sends an operation, the relay **immediately repeats it** to the other
   laptops on that camp's line.
3. If someone's briefly away, it can **hold their messages** and deliver on reconnect.

**What it deliberately is NOT:**
- **Not a database.** It doesn't know what a schedule is. It can pass **sealed
  (encrypted) envelopes it cannot read** — it only needs to know which camp's line an
  envelope belongs to.
- **Not an authority.** It doesn't decide anything or own any data.
- **Not required** when laptops are offline or on the same Wi-Fi.
- **Not a single point of failure for your data.** If it dies or you unplug it, **nothing
  is lost** — laptops fall back to Wi-Fi-direct or the folder until it's back.

**Why it's small:** Shoresh's current "Host" already runs a WebSocket server that
forwards changes between laptops on a LAN. The relay is *that same server*, moved to a
spot reachable over the internet and **stripped down to just forward-and-briefly-buffer**.
Today's Host also plays referee (assigns order) and notary (mints security tokens); the
relay drops both of those jobs — the laptops handle ordering themselves (a logical clock
+ last-writer-wins, proven in the `run.cjs` experiment), and identity is handled by keys
the camp sets up once, not by the relay.

**Why it's needed at all (the unavoidable bit):** two laptops on two different home/office
networks are each hidden behind a router — there is no direct address from one to the
other. *Something both can reach* has to pass the first hello. A folder can't (it can't
ring anyone). The relay is the smallest possible "something." Where the networks allow it,
the two laptops can even connect **directly** (peer-to-peer) and the relay only helps them
find each other — but a relay fallback is what makes it reliable, which is exactly how
Syncthing reaches your devices "anywhere."

---

## What Shoresh already has (so this is evolution, not rebuild)

| Needed for the shared-project model | Already in Shoresh today? |
|---|---|
| Changes as small, replayable operations | **Yes** — field-level op-log, `electron/ops/` |
| Ignore duplicate / retried changes | **Yes** — `client_write_id` + op ids |
| Record real conflicts for a human, never drop them | **Yes** — `conflicts` table + resolve flow |
| Delivery acknowledgment (not trusting the pipe) | **Yes, on WebSocket** — `op_applied_ack` watermark |
| Operation logic separate from the network | **Yes** — `electron/ops/` touches no socket |
| A forwarding server between laptops | **Yes, on LAN** — the Host's WebSocket server |
| Keep private data off the wire | **Yes** — host-local tables never sync |

## What has to be added or changed

1. **A "transport seam":** one small interface so operations can flow over WebSocket,
   relay, *or* folder without the rest of the app knowing which.
2. **Referee-less ordering:** logical clock + last-writer-wins so laptops agree on order
   without a permanent Host. *(Proven in `run.cjs`: 24/24.)*
3. **The folder transport:** append-only, immutable, uniquely-named operation files +
   its own acknowledgment markers. *(Prototyped; convergence proven.)*
4. **The relay:** relocate + simplify the existing WebSocket server; add "which camp"
   routing and a short outbox. Optional direct P2P on top.
5. **A portable project + rebuild-from-scratch path** and a **schema-version check**, so
   a fresh laptop can open a project and refuse a mismatched app version. *(Gaps today.)*
6. **Batch operations for the folder:** one file per burst, not per keystroke — OneDrive
   chokes on storms of tiny files (measured), and handles a few larger files well.

---

## Honest bottom line

- **The shared-document mental model is sound** — *if* you copy both halves of how Word
  actually works: a durable copy at rest **and** a live channel the app controls.
- **Generic shared storage is a real, reliable *asynchronous* transport** and a poor
  *live* one. Keep it as the no-infrastructure backstop, not the live path.
- **The live feel needs a channel Shoresh owns** — WebSocket on a LAN (have it), a tiny
  relay across networks (small, dumb, holds no data — not the cloud database you wanted
  to avoid).
- **None of this dents local-first.** SQLite on each laptop stays the source of truth;
  every transport is optional; nothing is ever lost.

The provider-agnostic instinct was right in the way that matters most: **Shoresh should
never contain OneDrive/Dropbox/Google code.** It should speak "operations," and let a
folder, a relay, or a LAN carry them.

---

## Confidence & open questions
- **High:** the operation engine is reusable; referee-less convergence works; folders
  carry operations reliably-but-slowly; the relay is a small relocation of existing code.
- **Still to settle:** identity/permissions once the Host notary is gone (who's allowed
  into a camp, and how keys are handed out); how long a folder keeps history before
  compaction; and the actual warm-idle latency numbers for OneDrive/Syncthing (the
  two-machine test was blocked by an unrelated 5 GB background download).
- **Deliberately NOT recommended yet:** a full cloud backend. It hasn't earned its
  complexity against what the three-transport, local-first design already delivers.

---

See also: `ARCHITECTURE_REPORT.md` (full findings), `README.md` (experiments + the
measured OneDrive field test), `run.cjs` (24/24 convergence), `propagation.cjs`
(latency instrument + two-machine protocol).
