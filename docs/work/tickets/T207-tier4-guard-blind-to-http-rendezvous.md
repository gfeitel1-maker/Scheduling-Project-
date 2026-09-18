---
title: "The Tier-4 transport-boundary guard is blind to an HTTP rendezvous client"
document_type: ticket
status: closed
created: 2026-09-17
task_class: security-auth
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md, SECURITY.md]
archive_when: "The guard fails the build when an internet rendezvous client is wired into the production node without sign-off, proven by a planted defect, and the ADR that defines the boundary says so in prose"
---

# T207 — The Tier-4 guard is blind to an HTTP rendezvous client

## Problem

`electron/sync/automerge/transportBoundary.guard.test.js` enforces the boundary in
`docs/adr/2026-09-14-internet-transport-security-gate.md` with three assertions: no forbidden
libp2p package in `package.json`, no forbidden import in `transport.js`, and
`electron/main.js` still matching `/peerDiscovery:\s*\[\s*createMdnsDiscovery\(/`.

The rendezvous design in `docs/work/specs/2026-09-17-rendezvous-wan-connectivity.md` defeats all
three without malice. An HTTPS `fetch` to a Cloudflare Worker is not an npm libp2p package, is
not imported by `transport.js`, and a rendezvous service appended **after** `createMdnsDiscovery(`
in the `peerDiscovery` array still satisfies the regex. A node could publish its real WAN
addresses to a public bulletin board and dial peers found there with a fully green gate.

This is the same failure shape the guard has had before: the 2026-09-15 assessment found it
asserting a `DEFAULT_LISTEN` constant that was dead in production. The guard is package-shaped and
marker-shaped; the boundary is behavioural.

## Success predicate

- The guard fails when a module performing internet rendezvous is reachable from the production
  node while `INTERNET_TRANSPORT_SIGNOFF` is false.
- The failure message names the ADR, as the existing assertions do.
- **Non-vacuity is proven by planting a defect the guard was NOT specifically designed around**,
  not only the one it was. A test that plants exactly the expected shape proves nothing.

## Does NOT count as done

- Adding names to the npm-package list. A Worker client is not a package.
- A prose comment in the guard.
- Flipping `INTERNET_TRANSPORT_SIGNOFF`. That is an owner action, after a recorded re-assessment.
