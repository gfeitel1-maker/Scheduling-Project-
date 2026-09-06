# Engine selection — the two-axis framing + the leading route (2026-09-05)

## ★ DECISION (owner, 2026-09-05): Automerge + libp2p is THE route. Productionize.
The owner chose **Automerge (data/merge) + libp2p (transport)** as the direction and greenlit
converting it from an isolated experiment into a real, plugged-in build. Confident it will do a
DIRECT punch across home Wi-Fis (proven cross-network live via relay on a hotspot; direct-punch on a
punchable pair not yet tested — accepted). This ENDS the parked "productionization gate": it is now an
active program. It must be done **responsibly** — main has moved ~405 commits, other sessions are
building on the current sync/op-log code, and this route **retires** parts of it. Plan (owner's order):
(1) message peers to coordinate; (2) audit current main to see what's kept/replaced/removed (the
~9,000 sync/ops lines may carry things this route no longer needs); (3) scope the hookup on a fresh
branch off current main, staged, full review loop. Other routes (Syncthing/Holepunch/op-log) are
retired as primary but the transport/data seams stay so they remain swappable (owner's optionality
principle). Working proof: `cr4-dht-node.mjs` (cross-network), `test-automerge.mjs`, `test-libp2p.mjs`,
`test-projection.mjs`, `test-cr4-live.mjs`.

---


**Owner decision (2026-09-05):** prototype **cr-sqlite + libp2p** as the leading engine, because it
looks more plausible and more native to Shoresh's stack than the routes compiled so far. Keep the
other routes **on hold — held, not killed** (see "the principle" below). Note explicitly the
automerge caveat and the other flagged risks; the prototype exists to test exactly those.

## The principle that governs all of this (owner)
> "For this to be local-first, to me, is about giving the **option** to use another format if wanted."

Local-first here means **optionality/portability**, not a single fixed engine. The camp project is a
**document**; Shoresh is an **editor** over it; SQLite is the **rendered working copy**. The value is
that the format/engine can be **swapped**, and a camp/org can choose. So the architecture keeps the
**seams** that make engines and formats swappable — that swappability *is* the local-first promise.
This is why other routes are held, not deleted: the design must preserve the option.

## The two-axis framing (the real clarification)
The engine decision is **two independent choices**, not one. They mix.

| | **Data / merge layer** (how changes are stored + reconciled) | **Transport / discovery layer** (how changes travel) |
|---|---|---|
| Options | hand-rolled op-log + LWW + conflict table · **cr-sqlite (CRDT)** · Autobase (Holepunch) | WebSocket (LAN) · Syncthing (daemon) · **libp2p (library)** · Hyperswarm (DHT) |
| Seam | (a *data-layer* seam — NOT fully insulated by the transport seam) | the **transport seam already built** (`electron/sync/transport/`) |

**Key consequence:** the transport seam keeps the *second* axis swappable cheaply. The *first* axis
(op-log vs cr-sqlite CRDT) is a **truth-model** choice and is a **bigger migration to change later** —
so if cr-sqlite is the likely endgame, decide the data layer **early**, before building heavily on the
hand-rolled op-log. **This is a "decide sooner" flag, and it's why we prototype now, before security.**

## The leading route to prototype: cr-sqlite + libp2p
- **cr-sqlite** (`@vlcn.io/crsqlite`): a loadable extension that turns the better-sqlite3 DB Shoresh
  already uses into a CRDT — tables auto-merge; `crsql_changes` is a change-feed; `applyChanges()`
  merges a peer's changes. Replaces the hand-rolled op-log + LWW + conflict machinery.
- **libp2p**: an embeddable P2P *library* (Electron main process) — mDNS local discovery + hole-punching
  + encrypted transport, self-hosted relay when needed (**no public relay pool** — addresses the owner's
  Syncthing public-relay concern).

## What the prototype MUST test (the flagged risks, per owner)
1. **The automerge piece + domain-conflict surfacing.** cr-sqlite auto-merges deterministically —
   which can silently pick a winner OR produce an *invalid* schedule (double-booked location) that no
   human reviewed. Shoresh must **detect and surface** genuine domain conflicts on top of the CRDT.
   The prototype must show: (a) automatic convergence on independent edits; (b) a same-slot concurrent
   edit, what cr-sqlite does with it, and how Shoresh can detect it to surface for a human.
2. **Native-extension packaging.** Does cr-sqlite (a native SQLite extension) + better-sqlite3 install,
   load, and eventually *package* across Mac/Windows in a real build? (First hurdle; test loading now.)
3. **libp2p complexity/transport.** Can two nodes discover (mDNS) + connect + exchange cr-sqlite
   changesets? (LAN/localhost first; cross-network hole-punch is a later slice needing two machines.)
4. **cr-sqlite maturity/longevity** — verify current maintenance status before committing deeply.

## BUILD FINDINGS (2026-09-05 — first build session)
- **cr-sqlite DEMOTED (maturity risk confirmed, fast).** Last release **Jan 2024**; installer is
  **broken on modern Node** (uses removed `import ... assert` syntax; fails on Node 25). Betting the
  data layer on it is unsafe. The "SQLite-native CRDT" advantage evaporates without a healthy library.
- **Automerge PROMOTED as the data/merge layer (maintained + fits our model + solves the conflict concern).**
  `@automerge/automerge` v3.4.1, updated **Aug 2026**, installs clean. Headless test `test-automerge.mjs`
  = **9/9**: (1) independent edits auto-converge; (2) a genuine same-slot conflict converges to a
  deterministic winner AND `getConflicts()` **exposes both competing values** — so Shoresh can SURFACE
  the conflict to a human (the exact domain-conflict need; cr-sqlite would have silently overwritten);
  (3) produces binary deltas — what libp2p would ship.
- **Reframe:** the "automerge piece" = **Automerge (a CRDT document) projected into SQLite** — NOT
  cr-sqlite. This FITS the model already built (document/log = truth; SQLite = rendered working copy);
  Automerge replaces the *merge/conflict half* of the hand-rolled op-log, keeping the SQLite projection
  (proven 19/19). Note: SQLite becomes a query/engine projection of the Automerge doc.

## Slices (revised)
- **CR1 — CRDT merge + conflict surfacing, headless.** ✅ DONE with Automerge (9/9). cr-sqlite ruled out.
- **CR2 — libp2p transport.** ✅ DONE (`test-libp2p.mjs`, 4/4). Two real libp2p nodes connect over
  TCP + **noise encryption** + yamux muxing, exchange Automerge state over a length-prefixed stream,
  and **converge**. Transport half proven (localhost/LAN). **Finding: libp2p v3 (released ~3 days ago)
  reworked the stream API and broke the documented `it-pipe` pattern (streams reset); had to PIN to
  the stable `libp2p@2.10.0`** where `stream.sink`/`stream.source` + it-pipe work. Concrete evidence
  of the flagged "libp2p is complex/fast-moving" risk — pin versions, expect churn.
- **CR3 — Automerge → SQLite projection + rebuild + conflict flag.** ✅ DONE (`test-projection.mjs`,
  7/7). Automerge doc projects into a queryable SQLite; an edit re-projects; **deleting SQLite and
  rebuilding from the Automerge doc ALONE reproduces state deterministically** (mirrors the 19/19
  reconstruction, now with Automerge as truth); a genuine same-slot conflict lands as a **surfaceable
  flag row** in SQLite (director sees the competing values). Full local story proven.
- **CR4 — two-machine live node.** ✅ BUILT + logic-verified (`cr4-node.mjs`; `test-cr4-live.mjs` 6/6:
  two libp2p nodes connect, live edits flow both ways, converge, same-slot conflict surfaces). It's an
  interactive node (mDNS auto-discovery on the LAN + `--dial` fallback + a CLI) — pure JS/WASM, **no
  native build**. RUN guide: `RUN-CR4.md`. **Needs the owner's two machines** to confirm the live LAN
  link (mDNS + real transport) — the analog of the Syncthing 47ms LAN run. **Cross-network (different
  networks) is deferred: same NAT wall — needs the relay decision** (dcutr hole-punch is in; a relay is
  not). Native-dep *Electron packaging* is a separate later slice.

## CROSS-NETWORK LIVE RESULT (2026-09-05): PASSED on real hardware
Owner ran `cr4-dht-node.mjs` on two machines on **DIFFERENT networks** (one on a cellular hotspot).
Sequence observed: the public **DHT found the peer across networks** (`🔎 DHT found … at N addr(s)`),
direct dials failed (NAT), and they **connected + synced via a public circuit relay** — an edit crossed
and both converged. **Cross-network sync works with NO infrastructure the owner runs.** It was *via
relay* (not a direct punch) because the **hotspot is CGNAT — un-punchable**, exactly as predicted; a
home↔home pair is the case to test for a true DIRECT punch. Key privacy point: even via the public
relay, the connection is **noise end-to-end encrypted** — the relay forwards sealed bytes it cannot
read. One required fix found live: libp2p blocks app protocols over relayed ("limited") connections by
default — added `runOnLimitedConnection: true` to `handle()` + `dialProtocol()`. So the route is now
proven **cross-network, end to end, on real hardware** — matching Syncthing's cross-network result, and
arguably exceeding it (nothing the owner runs, e2e-encrypted even on the fallback relay, native conflict
surfacing). Remaining: confirm a DIRECT (data-peer-to-peer) punch on a punchable pair; Electron packaging.

## Hole-punch correction + CR4-DHT (2026-09-05)
Prior "hole-punching needs a relay" was TOO STRONG (see `HOLEPUNCH_RESEARCH.md`). Correction:
hole-punching needs *coordination* (STUN/DHT/signaling — public, no data path), NOT a *data relay*.
A data relay is only the fallback for the un-punchable minority (symmetric NAT/CGNAT). WebRTC proves
it: ~70–90% connect directly via STUN, no relay. Built `cr4-dht-node.mjs`: public DHT (peer routing)
+ AutoNAT + dcutr + public circuit-relays for *coordination only* → a DIRECT cross-network connection,
**no relay the user runs, no data through a relay**. Model (owner's simplification): pair on the same
Wi-Fi (mDNS saves stable peer ids), then across networks the DHT resolves current addresses + dcutr
punches. Boot-tested: connects to public DHT; **protocol-gated** so it only pairs/syncs with real
Shoresh peers (a real bug caught + fixed — it was briefly broadcasting the doc to random DHT peers).
Un-punchable minority still needs a data-relay fallback (or async). Files: `cr4-dht-node.mjs`,
`package.cr4dht.json`, `RUN-CR4-DHT.md`. Needs the owner's two machines on different networks to
confirm a live direct punch (public DHT/relay can be slow/flaky).

## LIVE two-machine result (2026-09-05): CR4 Test A PASSED on real hardware
Owner ran `cr4-node.mjs` on both machines (same Wi-Fi). They **auto-discovered via mDNS, connected,
and an edit synced across both machines and converged** — pure libp2p (encrypted) + Automerge, with
**no daemon, no relay, no account, no public infrastructure**. This is the same-Wi-Fi analog of the
Syncthing LAN case, proven on the owner's own machines with the pure-P2P, no-public-relay route.
Still open: cross-network (different Wi-Fis) = the NAT wall + relay decision (same as Syncthing);
and Electron packaging (lighter here — Automerge WASM + libp2p JS, no separate binary).

## Component-level result (2026-09-05): route validated, 20/20
Automerge (data/merge — maintained, surfaces conflicts) + libp2p (transport — encrypted, converges,
**pin v2**) + SQLite projection (queryable, rebuildable). cr-sqlite replaced by Automerge, which is
healthier AND better for schedules (native conflict surfacing). What remains unproven = CR4
(cross-network hole-punch + Electron packaging), which needs two machines — the same frontier
Syncthing already cleared on the owner's hardware (~47ms). Files: `test-automerge.mjs`,
`test-libp2p.mjs`, `test-projection.mjs`.

## Held (not killed), preserving optionality
- **Syncthing** — proven on owner's machines (47ms); lower-risk ship-path; public relay self-hostable.
- **Holepunch (Hypercore/Autobase/Hyperswarm)** — document-native; indexer-quorum risk for often-off laptops.
- **Hand-rolled op-log + WebSocket** — what exists; the fallback data-model if CRDT doesn't fit schedule semantics.
All remain candidates behind the seams; the prototype informs which becomes primary. See the ADR
(`docs/adr/2026-08-17-shared-project-multi-transport-sync.md`) and `NAT_TRAVERSAL_RESEARCH.md` /
`PEER_DISCOVERY_RESEARCH.md`.
</content>
