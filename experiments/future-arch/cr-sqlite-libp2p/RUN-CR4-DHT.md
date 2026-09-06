# CR4-DHT — cross-network DIRECT connection, no relay you run, no data through a relay

The point you were right about: **hole-punching gets a DIRECT peer-to-peer connection**; the only
"server" is **public coordination** (a STUN-analog + the public DHT to find each other + public relays
that carry *only the punch handshake, not your data*). You run nothing. Your schedule data flows
machine-to-machine once the punch succeeds.

**Model (your simplification):** pair once on the SAME Wi-Fi (each machine saves the other's stable
peer id), then on DIFFERENT networks the DHT resolves that peer's *current* address and dcutr punches
a direct link.

## Setup (both machines)
Copy **`cr4-dht-node.mjs`** and **`package.cr4dht.json`** into a plain local folder. Rename the
package and install (pure JS/WASM, no build tools):
```bash
mv package.cr4dht.json package.json     # (Windows: ren package.cr4dht.json package.json)
npm install
```

## Step 1 — pair on the SAME Wi-Fi (once)
On **both** machines (same Wi-Fi):
```bash
node cr4-dht-node.mjs
```
Within a few seconds each prints `🔑 paired + saved peer …`. That saves the other's **stable** id to
`known-peers.json`, and each machine keeps its own identity in `identity.key`. Type `known` to confirm.
Then `quit` on both. (Keep `identity.key` + `known-peers.json` — they're how the machines recognize
each other later.)

## Step 2 — move to DIFFERENT networks and reconnect
Put the machines on different networks (e.g. one on a phone hotspot). Run again on both:
```bash
node cr4-dht-node.mjs
```
It will: connect to the public DHT → every ~20s try `🔎 DHT found <peer> … dialing` → dcutr attempts a
punch → `✔ connected to paired peer … (DIRECT)` (or `via relay — dcutr will punch` first, then upgrades).
Once connected, type on one machine:
```
edit archery location "Field 1"
```
and watch it appear on the other. `state` on both → matching **STATE HASH** = a direct cross-network sync.

## Honest expectations (this leans on PUBLIC infra, so it can be slow/flaky)
- **The public DHT is slow.** Finding the peer can take **seconds to minutes**, sometimes several
  retries. Be patient; it retries every 20s. (Production would run a small private rendezvous instead.)
- **Public relays must be reachable** for dcutr to coordinate the punch. Usually fine; occasionally not.
- **The un-punchable minority still can't go direct** — symmetric NAT / CGNAT (common on cellular
  hotspots) and locked-down firewalls (your work laptop failed even Syncthing's direct attempt). Those
  will show `via relay` (data through a public relay) or not connect. A **home Wi-Fi ↔ home Wi-Fi** pair
  is the best case for a clean direct punch.
- **Privacy:** no data-relay you run, and for a successful punch **your camp data goes directly** (the
  DHT/relay only saw a handshake). But it IS public coordination infrastructure (a public relay sees
  metadata during setup). The node is **protocol-gated**: it only pairs/syncs with peers that speak the
  Shoresh protocol — it will NOT send your doc to the random DHT peers it connects to.

## What a success proves
Two machines on **different networks** holding a **direct**, hole-punched, end-to-end connection —
**no relay you run, no data through a relay** — carrying live Automerge edits. That's the thing you said
was possible, tested. If your specific networks land in the un-punchable minority, that's the honest case
where a data-relay fallback (or async) is still needed — same minority Syncthing relayed for.
</content>
