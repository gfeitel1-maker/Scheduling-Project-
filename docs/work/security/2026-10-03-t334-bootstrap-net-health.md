---
title: "T334 §8.3 — public libp2p bootstrap-net health check (verify-at-pickup)"
document_type: security
authority: evidence
status: partial
task_class: security-auth
created: 2026-10-03
governing_docs: [docs/work/specs/2026-10-03-t334-slice3-dht-discovery-design.md, docs/adr/2026-10-02-wan-discovery-transport-ladder.md]
archive_when: the T334 capability+battle-test gate records the dial-level bootstrap liveness result and the §8.3 check is closed
---

# T334 §8.3 — public bootstrap-net health (verify-at-pickup)

Per the organizer ruling 2026-10-03, §8.3 (is the public libp2p/IPFS bootstrap
network healthy enough to remain the accepted default primary WAN entry point?)
is a **verify-at-pickup technical check recorded in gate evidence**, NOT an owner
question. Only a **NOT-healthy** result escalates to organizer→owner (because then
the public-bootstrap default is in question and a Shoresh-run bootstrap = spend
goes on the table). The default itself is already accepted in T327.

## Governor pre-check result (2026-10-03, DNS layer): HEALTHY at the DNS layer

Resolved the canonical public libp2p bootstrap set via DNSADDR:

```
TXT _dnsaddr.bootstrap.libp2p.io returns 4 geographically-distributed nodes:
  sv15.bootstrap.libp2p.io  /p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN  -> 147.135.44.132   (San Francisco)
  ny5.bootstrap.libp2p.io   /p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa  -> 51.81.93.51      (New York)
  am6.bootstrap.libp2p.io   /p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb  -> 54.38.47.166     (Amsterdam)
  sg1.bootstrap.libp2p.io   /p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt  -> 15.235.144.210   (Singapore)
```

All four DNSADDR records resolve to live, routable public IPs (OVH ranges),
globally distributed across four regions. The bootstrap infrastructure is
published and DNS-live — the positive health signal at the layer this
environment can measure.

## What this pre-check does NOT yet establish (deferred to the gate)

Raw outbound TCP to the p2p port (4001) is **filtered in this build sandbox**
(`nc -z` to 147.135.44.132:4001 returned closed/filtered while DNS egress
succeeded) — an **environment egress artifact, not a bootstrap-net health
signal**. A genuine dial-level liveness check must run with the real
`@libp2p/bootstrap` + `@libp2p/kad-dht` transport stack (wss/webtransport, not
bare tcp/4001) from an egress-capable runner, which is exactly the
security-assessment / battle-test gate environment.

## Gate task (carried into the T334 capability + battle-test gate)

The gate MUST record a dial-level bootstrap liveness result: start a libp2p node
with the public bootstrap list, confirm it joins the DHT ring (at least one
bootstrap peer dialled successfully) and can complete a `findProviders` round.
A healthy result closes §8.3 with no owner involvement. A NOT-healthy result
(bootstrap set unreachable/unreliable at dial level) is the escalation trigger
to organizer→owner per the ruling.
