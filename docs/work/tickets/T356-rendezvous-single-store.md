---
ticket: T356
document_type: ticket
title: Rendezvous Worker uses one Durable Object for the whole service, with a global write budget
status: in-progress
created: 2026-10-09
archive_when: "the Worker stores every namespace in one Durable Object, tests pin the per-namespace and global budgets, and the keeper has deployed and run the ADR's acceptance checks"
task_class: security-auth
parent: ""
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-10-09-rendezvous-worker-durable-object-storage.md]
related_prs: []
related_tickets: [docs/work/tickets/T355-rendezvous-worker-durable-object-storage.md]
---

# T356 - Rendezvous Worker: single store

Owner ruling, 2026-10-09: "i do not want each camp getting their own storage. this is a tiny relay service".
Supersedes T355's one-DO-per-namespace design (never deployed). See the ADR's "Amendment 2026-10-09 (owner):
single store".

## Success predicate

Every request goes to the one DO id "rendezvous"; per-namespace budget (30 per rolling 60s) and cap (200) stay
exact; a global budget of 7,000 accepted registers per UTC day is exact across fresh namespaces, sized to stay
under ~80k rows written/day; refused requests and unknown-namespace GETs write nothing; no IP is stored.

## Non-goals

Deploying (the keeper does); a paid plan or authenticated register (the stranger-outage of rung 3 until
00:00 UTC is an accepted residual).
