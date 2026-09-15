---
title: "Cross-network sync is proven — but via a PUBLIC RELAY; the serverless direct punch is untested"
document_type: evidence
status: active
created: 2026-09-15
task: docs/adr/2026-09-14-internet-transport-security-gate.md
archive_when: the internet-transport boundary decision is recorded as an ADR, or the result is re-run and superseded by a measured record
---

# Cross-network sync is proven — but not yet serverlessly

**CORRECTED 2026-09-15, same day as first written.** The first version of this document claimed the
proven cross-network result was a **direct** hole-punch with no relay. That was wrong, and the error
is instructive: it was written from the run procedure's "What a success proves" section — which
describes the *aspiration* — instead of from the recorded outcome. The outcome is in
`docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md` lines 87-95 and says something
different. The mistaken version agreed with the framing everyone expected, which is exactly why it
survived a read.

**What is actually proven.** Two devices pair once on the same Wi-Fi; after that they find each
other across different networks and sync. Discovery worked via the public DHT. **The direct dial
FAILED** — one machine was behind CGNAT (a cellular hotspot), which is un-punchable, as predicted —
**and the two nodes connected and synced through a public circuit relay.** Traffic stayed
end-to-end Noise-encrypted even across that relay, so the relay could not read camp data.

**What is NOT proven.** A true **direct** hole-punch (DCUtR) between two punchable home-Wi-Fi peers.
The ADR names this as "the one un-closed item in an otherwise-proven transport story" and schedules
it as Stage 7. Until it is run, **serverless cross-network sync is an expectation, not a result.**

**Why this distinction is now load-bearing.** On 2026-09-15 the owner ruled out infrastructure:
*"I do not want a server of any kind. It is unnecessary."* A public circuit relay is third-party
server infrastructure in the connection path — not one this project runs or pays for, and not one
that can read the data, but a dependency on someone else's machines all the same. The proven path
therefore does **not** satisfy that constraint, and the path that would satisfy it is the one still
untested. That tension is a decision for the owner, not something this record should paper over.

**Why this document exists.** The result was demonstrated by the product owner and existed only in
their memory plus an un-scored run procedure on a parked branch. Everything else in this repo that
settles an architectural question has a written record; this did not, and it is load-bearing for the
internet-transport decision. It was also mis-stated twice in one session by an agent reasoning from
`package.json` on `main` — which is exactly what an unwritten result invites.

## Provenance — read this before citing the result

This is deliberately split, because the parts have different strengths.

**VERIFIED IN THE REPO (2026-09-15).** The harness exists, and the ADR records the outcome:
- `experiments/future-arch/cr-sqlite-libp2p/cr4-dht-node.mjs` and its run procedure
  `RUN-CR4-DHT.md`, on branch `claude/shoresh-future-architecture-364e03` (unmerged, parked).
- The mechanism is libp2p — a public DHT for address lookup, then either a DCUtR hole-punch
  (untested) or a public circuit relay (what actually carried the proven run) — moving **Automerge**
  edits. It is the same transport family the shipped app already uses.
- **No Syncthing is involved.** (A *separate* spike, `SYNCTHING_SPIKE.md`, also achieved
  cross-network sync on 2026-08-19 via Syncthing's relay, ~47 ms one-way. That is a different
  result by a different mechanism, and conflating the two is the specific error made this session.)
- The design is protocol-gated: the node pairs and syncs only with peers speaking the Shoresh
  protocol, so it does not hand the camp document to arbitrary DHT peers.

**OWNER-REPORTED, NOT INDEPENDENTLY OBSERVED.** That the run succeeded. No agent witnessed it and
the repo holds no captured output. This is a first-hand report from the person who ran it, recorded
as such — not a measurement.

**UNKNOWN — worth filling in if the run is ever repeated.** The date; how long DHT discovery took;
whether the two `STATE HASH` values matched. The harness prints these. The direct-vs-relay question
is no longer unknown for the recorded run — it was relay — but it IS unknown for the home-to-home
case, which is the run that would matter for a serverless path.

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
- **It is not universal, and the failure mode is a relay.** A minority of networks cannot be
  punched at all: symmetric NAT, carrier-grade NAT (common on phone hotspots and some home ISPs),
  and locked-down corporate firewalls. Those fall back to a public data relay or fail to connect.
  Home Wi-Fi ↔ home Wi-Fi is the best case. Note what this means for a no-server policy: whether a
  given camp needs third-party relay infrastructure is **decided by that camp's ISP**, not by us —
  so "no server" cannot be guaranteed by choosing not to run one.
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
