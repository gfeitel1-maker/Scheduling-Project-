---
ticket: T355
document_type: ticket
title: Rendezvous Worker storage moves to one SQLite-backed Durable Object per namespace
status: in-progress
created: 2026-10-09
archive_when: "the Worker stores peers in a per-namespace Durable Object with an exact 200-peer cap and 30/min write budget, tests pin both, and the keeper has deployed and run the ADR's three acceptance checks"
task_class: security-auth
parent: ""
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-10-09-rendezvous-worker-durable-object-storage.md]
related_prs: []
related_tickets: [docs/work/tickets/T209-rendezvous-worker-phase-a.md]
---

# T355 - Rendezvous Worker on a Durable Object

Implements docs/adr/2026-10-09-rendezvous-worker-durable-object-storage.md.

## Success predicate

A burst of 300 registers to one namespace yields exactly 30 accepted; the 201st distinct peer is refused
while an existing peer refreshes; a never-seen namespace works with no setup; an unknown-namespace GET
writes nothing; no IP is stored. HTTP contract and client unchanged.

## Non-goals

Deploying (the keeper does); the client polling change (S4b); account-global exhaustion via random
namespaces (accepted residual in the ADR); migrating KV records.
