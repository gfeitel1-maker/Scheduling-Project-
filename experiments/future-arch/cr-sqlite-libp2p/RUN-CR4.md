# CR4 — two-machine libp2p + Automerge live sync (the Syncthing-free analog)

Runs on your two machines: no Syncthing, no daemon, no public relay, no account. Each machine
runs one `node` process; they find each other and sync an Automerge "schedule" live over encrypted
libp2p. This is the head-to-head against the Syncthing 47ms test.

**Nice property vs the earlier tests: NO native build.** The deps are pure JS + WASM (libp2p +
Automerge), so `npm install` won't need a compiler or the better-sqlite3 rebuild dance.

## Setup (both machines)
1. Copy **`package.json` and `cr4-node.mjs`** from `experiments/future-arch/cr-sqlite-libp2p/` into a
   folder on each machine (a plain local folder — not inside OneDrive/Syncthing).
2. In that folder: `npm install`  (installs libp2p + Automerge; pure JS/WASM, quick, no build tools).

## Test A — same Wi-Fi (auto-discovery via mDNS)
On **each** machine, just run:
```bash
node cr4-node.mjs
```
Each prints its peerId + addresses. Within a few seconds they should auto-discover on the LAN and
print `✔ connected to …`. Then, on **one** machine, type:
```
edit archery location "Field 1"
```
Watch the **other** machine print `◀ update …` with `archery … location=Field 1`. Type `state` on
both — the **STATE HASH matches** = converged. Edit on the other machine, watch it come back.
Try a conflict: with both connected, type `edit archery location "Field 3"` on one and
`edit archery location "Lake"` on the other quickly — both converge to one value AND show
`⚠ CONFLICT: [...]` (the competing values a director would resolve).

## Test B — if mDNS doesn't fire (some Wi-Fi blocks multicast): manual connect
1. On machine **A**: `node cr4-node.mjs` — copy the full address line that starts with your LAN IP,
   e.g. `/ip4/192.168.1.157/tcp/54321/p2p/12D3KooW...` (the whole thing, including `/p2p/...`).
2. On machine **B**:
   ```bash
   node cr4-node.mjs --dial "/ip4/192.168.1.157/tcp/54321/p2p/12D3KooW..."
   ```
   (Tip: for a stable address, start A with `PORT=9701 node cr4-node.mjs` so the port doesn't change.)
3. Then edit as in Test A.

## Test C — different networks (the NAT frontier)
This is the same wall as before: across NATs, the listener isn't directly reachable, so a plain
`--dial` won't connect unless the listener has a public, port-forwarded address. Getting this to work
*without* port-forwarding needs a **relay** (a small host both dial out to) — which `cr4-node.mjs`
does NOT include yet (it has hole-punch support via dcutr, but no relay). So Test C is deferred: it's
exactly the "do we run a relay?" product decision, unresolved by design. Tests A/B prove the LAN case
(the analog of Syncthing's same-Wi-Fi behavior).

## What success proves
- **libp2p (encrypted, mDNS discovery) + Automerge deliver live, converging, conflict-surfacing sync
  between two real machines — no daemon, no public relay, no account.**
- Compare the *feel* to the Syncthing run. Cross-network (Test C) still needs the relay decision, same
  as Syncthing — but on the LAN, this is the pure-P2P, self-contained route working end to end.

Report back: did they auto-connect (Test A) or need `--dial` (Test B), did an edit cross and the
hashes match, and did a conflict surface? That's the CR4 result.
</content>
