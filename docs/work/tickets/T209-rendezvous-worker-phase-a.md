---
title: "Phase A — Cloudflare Worker and KV rendezvous bulletin board (source and tests only)"
document_type: ticket
status: open
created: 2026-09-17
task_class: architecture
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md, SECURITY.md]
archive_when: "The Worker source and its tests live in the repository, round-trip a record in a local harness, and the owner has either deployed it or decided not to"
---

# T209 — Phase A: the Worker and KV bulletin board

## Problem

The rendezvous design needs a bulletin board: `POST /v1/register` and
`GET /v1/peers/<namespace>`, backed by Workers KV with a short TTL (~2h), no Durable Objects, no
SQL, no WebSockets.

## Blocked on, deliberately

The record's wire contract is **not settled**: rotation, a monotonic sequence for KV
last-write-wins ordering across edge PoPs, whether the address card body is encrypted so Cloudflare
stores ciphertext, and the Worker's request-logging posture are all open in
`docs/adr/2026-09-17-wan-rendezvous-seam.md` and the 2026-09-17 security assessment. Writing the
Worker before those are decided bakes in an API that then has to change. Sequence this after T210.

## Owner ruling, 2026-09-17 — configurability, not plurality

Deployment under the owner's own Cloudflare account and domain is **approved as the default** and is
not treated as an operational risk: Shoresh is open source, and anyone who does not want the
project's infrastructure forks it, disables it, or self-hosts. What this requires of the design
instead is a first-class off switch — the endpoint is configuration, and **rendezvous-off must be a
supported, tested configuration** that degrades to exactly today's LAN-only behaviour rather than a
code path nobody exercises.

## Success predicate

- The rendezvous endpoint is configurable, and a test asserts the disabled configuration behaves
  exactly as a LAN-only node does.
- Worker source and unit tests in-repo; two independent HTTP clients round-trip a record,
  including across a TTL boundary.
- Zero change to Shoresh runtime code. This ticket is server-only.

## Does NOT count as done

- **Deployment.** Creating, registering or deploying anything to the owner's Cloudflare account or
  to a public domain is an **owner action**, outside this ticket and outside any agent's authority.
- Any Electron or libp2p integration — that is T210/T211.
