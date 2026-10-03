---
ticket: T338
document_type: ticket
title: "Future complement — CRDT-piggybacked presence/address exchange (deferred, not in T337)"
status: open
created: 2026-10-03
archive_when: "a decision is recorded on whether to build CRDT-piggybacked presence as a complement to the T337 camp-peer coordination relay, and if built, it is gated and merged"
task_class: security-auth
parent: ""
governing_docs: [docs/work/specs/2026-10-03-t337-coordination-layer-design.md, docs/adr/2026-10-02-wan-discovery-transport-ladder.md]
related_prs: []
---

# T338 — CRDT-piggybacked presence (future complement to T337), DEFERRED

## Context

Surfaced independently across two divergence frames during the T337 coordination-layer design
(`docs/work/specs/2026-10-03-t337-coordination-layer-design.md`, Open Question G1) and DEFERRED by
organizer ruling 2026-10-03 — explicitly NOT scoped into T337.

## The idea

Each device merges its own best-known current reachable address into an ephemeral, garbage-collected
"presence" field inside the camp's Automerge document. Any device that syncs the document by any
transient path then learns peers' last-known reachable addresses without a dedicated discovery
protocol — a possible complement to T337's camp-peer coordination relay for the address-exchange step.

## Why deferred, not built now

It has a bootstrap dependency: it only helps once *some* sync path is already live (it cannot create
first contact between two peers that currently have no path to each other), so it is a complement to
the T337 relay, never a replacement. Folding it into T337 would widen the slice. Exposure must be
assessed before any build: the presence field lives in the replicated camp document (camp-admitted
peers only — no public broadcast, consistent with the public-DHT rejection), but ephemerality/GC and
revoked-device handling need design. Revisit after T337 (and T336) land.
