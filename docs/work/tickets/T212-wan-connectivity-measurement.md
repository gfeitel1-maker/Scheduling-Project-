---
title: "Phase E — measure whether WAN failure is discovery or direct dial"
document_type: ticket
status: open
created: 2026-09-17
task_class: test-infrastructure
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md, SECURITY.md]
archive_when: "The WAN test matrix has been run with logs that distinguish rendezvous success from direct-dial failure, and the result is recorded as data the D/F decision can rest on"
---

# T212 — Phase E: measure before deciding on NAT traversal

## Problem

The external spec orders Phase D (UPnP — a gated, internet-facing, production-behaviour-changing
capability) **before** Phase E (measurement), while insisting elsewhere that a circuit relay must
be measured for first. That is an internal inconsistency, and followed literally it walks an
implementer into flipping the Tier-4 gate without the evidence the gate exists to require.

Measurement comes first here.

## Scope

Instrumentation only — the event vocabulary from the spec's §21, logging no secrets, keys, document
content or camp data. The load-bearing distinction is `RENDEZVOUS_PEER_DISCOVERED` +
`DIRECT_DIAL_FAILED` versus `DISCOVERY_FAILED`: they are different failures with different fixes.
Add an operational failure class the spec lacks — "the rendezvous service is gone", as distinct
from "your network is bad".

## Why it matters

Whether two devices *can* connect directly is decided by their ISPs' NAT type, not by our effort.
Two peers both behind symmetric NAT/CGNAT cannot be connected directly — a networking invariant.
On a TCP-only stack, hole punching is additionally weak. The D/F decision must rest on measured
success rates, not on the spec's assumption.

## Does NOT count as done

- A binary works/doesn't-work result. The point is to identify the failing layer.
- Any log line containing a key, token, PIN, namespace, or document content.
