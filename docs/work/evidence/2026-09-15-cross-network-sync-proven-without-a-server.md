---
title: "Cross-network sync works with no server: DHT rendezvous + DCUtR hole-punch, owner-run"
document_type: evidence
status: active
created: 2026-09-15
task: docs/adr/2026-09-14-internet-transport-security-gate.md
archive_when: the internet-transport boundary decision is recorded as an ADR, or the result is re-run and superseded by a measured record
---

# Cross-network sync works with no server

**The claim being recorded.** Two devices pair once on the same Wi-Fi; after that the network no
longer matters. They find each other across different networks and sync directly, with **no server
of any kind** — nothing the project runs, and no relay carrying camp data.

**Why this document exists.** The result was demonstrated by the product owner and existed only in
their memory plus an un-scored run procedure on a parked branch. Everything else in this repo that
settles an architectural question has a written record; this did not, and it is load-bearing for the
internet-transport decision. It was also mis-stated twice in one session by an agent reasoning from
`package.json` on `main` — which is exactly what an unwritten result invites.

## Provenance — read this before citing the result

This is deliberately split, because the parts have different strengths.

**VERIFIED IN THE REPO (2026-09-15).** The harness exists and does what is described below:
- `experiments/future-arch/cr-sqlite-libp2p/cr4-dht-node.mjs` and its run procedure
  `RUN-CR4-DHT.md`, on branch `claude/shoresh-future-architecture-364e03` (unmerged, parked).
- The mechanism is libp2p — a public DHT for address lookup, DCUtR for the hole-punch — carrying
  **Automerge** edits. It is the same transport family the shipped app already uses.
- **No Syncthing is involved.** (A *separate* spike, `SYNCTHING_SPIKE.md`, also achieved
  cross-network sync on 2026-08-19 via Syncthing's relay, ~47 ms one-way. That is a different
  result by a different mechanism, and conflating the two is the specific error made this session.)
- The design is protocol-gated: the node pairs and syncs only with peers speaking the Shoresh
  protocol, so it does not hand the camp document to arbitrary DHT peers.

**OWNER-REPORTED, NOT INDEPENDENTLY OBSERVED.** That the run succeeded. No agent witnessed it and
the repo holds no captured output. This is a first-hand report from the person who ran it, recorded
as such — not a measurement.

**UNKNOWN — worth filling in if the run is ever repeated.** The date; which two networks; whether
the connection came up `DIRECT` or fell back to `via relay` before upgrading; how long DHT discovery
took; whether the two `STATE HASH` values matched. The harness prints all of these.

## The model, in the owner's framing

> Pairing requires the same Wi-Fi. Once paired, the Wi-Fi no longer matters.

This is the right way to hold it, and it maps onto the code: what a device stores about a peer is an
**identity** (a stable peer id and keys), never a route. The address is looked up fresh each time.
So "re-pairing" is never needed, and the network is a detail resolved at connect time.

## What it does NOT establish

- **It is not what the shipped app does.** `main` has no DHT, no relay, no DCUtR, no hole-punching.
  `electron/sync/automerge/transportBoundary.guard.test.js` fails the build if any of that is added
  without a recorded re-assessment (`docs/adr/2026-09-14-internet-transport-security-gate.md`).
  Cross-network is **proven possible, not shipped**.
- **It is not universal.** The run procedure is explicit that a minority of networks cannot be
  punched: symmetric NAT, carrier-grade NAT (common on phone hotspots), and locked-down corporate
  firewalls. Those fall back to a data relay or fail to connect. Home Wi-Fi ↔ home Wi-Fi is the
  best case.
- **Discovery is slow on public infrastructure.** Finding a peer via the public DHT can take
  seconds to minutes, with retries every ~20 s. The procedure notes a private rendezvous would fix
  this; **the owner has ruled that out** (2026-09-15: "I do not want a server of any kind. It is
  unnecessary"), so slow-and-serverless is the accepted shape and the latency is a product
  consequence to design around, not a defect to fix with infrastructure.
- **It says nothing about the security review.** Opening this boundary still requires the full
  re-assessment the gate ADR enumerates. Proven-to-work is not cleared-to-ship.

## Why it matters

Every accepted security tradeoff in this app rests on the transport being LAN-only. This result
means that assumption is a **current setting with a demonstrated alternative**, not a permanent
property. Any document or agent that describes the LAN limit as inherent to the design is wrong, and
the transport-boundary paragraph in `CLAUDE.md` now says so explicitly to stop the error recurring.
