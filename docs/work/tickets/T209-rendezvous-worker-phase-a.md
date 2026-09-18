---
title: "Phase A — Cloudflare Worker and KV rendezvous bulletin board (source and tests only)"
document_type: ticket
status: in-progress
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

## ~~Blocked on, deliberately~~ (superseded 2026-09-18)

_Prior: this section originally sequenced T209 after T210, because the record's wire contract was
unsettled. `docs/adr/2026-09-18-rendezvous-record-encoding-and-namespace-rotation.md` (on branch
`claude/t210-rendezvous-record-contract`) settled encoding, sequence and rotation, and its
"Consequences" section explicitly reads: "T209 is unblocked to proceed in parallel... The worker
treats every KV value as an opaque signed blob and never decodes or verifies it — verification is
entirely client-side — so T209 can build POST/GET against a fixture today with no format
renegotiation later." That is the premise this implementation proceeded under._

The record's wire contract — rotation, the `(epoch, seq)` monotonic watermark for defeating stale
KV reads across edge PoPs, and the decision to leave the address body plaintext for Phase B — is
settled by that ADR. None of it constrains this Worker's implementation, because the Worker never
inspects the blob it stores. The Worker's own request-logging posture (see `worker.js` and
`README.md`) was never gated on the record format and is addressed directly in this ticket's
implementation.

## Owner ruling, 2026-09-17 — configurability, not plurality

Deployment under the owner's own Cloudflare account and domain is **approved as the default** and is
not treated as an operational risk: Shoresh is open source, and anyone who does not want the
project's infrastructure forks it, disables it, or self-hosts. What this requires of the design
instead is a first-class off switch — the endpoint is configuration, and **rendezvous-off must be a
supported, tested configuration** that degrades to exactly today's LAN-only behaviour rather than a
code path nobody exercises.

## Success predicate

- ~~The rendezvous endpoint is configurable, and a test asserts the disabled configuration behaves
  exactly as a LAN-only node does.~~ **Ruling, this implementation (2026-09-18): this bullet
  conflicts with "Zero change to Shoresh runtime code / this ticket is server-only" below, and the
  two cannot both be honoured — a rendezvous on/off switch is necessarily client-side code (it has
  to gate whether the Electron sync node ever calls out to the Worker), and wiring the client is
  T211, which is explicitly parked pending the owner's Tier-4 sign-off (see the spec's §4 phase
  table). This implementation honours "server-only" and does not add a client-side off switch. The
  configurability predicate belongs to T211, not here — carrying it forward rather than silently
  dropping it or building both halves of a contradiction.**
- Worker source and unit tests in-repo; two independent HTTP clients round-trip a record,
  including across a TTL boundary. **Met** — `workers/rendezvous/worker.test.js` exercises the
  handler's `fetch(request, env)` directly against an in-memory fake KV (`fakeKv.js`) with an
  injectable clock; the TTL-boundary case advances the clock past the ~2h TTL between two
  independent calls into the handler. This is a handler-level round-trip, not a live network one —
  see `workers/rendezvous/README.md`'s Testing section.
- Zero change to Shoresh runtime code. This ticket is server-only. **Met** — nothing under `src/`
  or `electron/` changed; `workers/rendezvous/` is not imported by either tree, and the Tier-4
  guard (`electron/sync/automerge/transportBoundary.guard.test.js`) and its detection module
  (`internetRendezvousScan.js`) still pass unmodified with `INTERNET_TRANSPORT_SIGNOFF` at `false`.

## Does NOT count as done

- **Deployment.** Creating, registering or deploying anything to the owner's Cloudflare account or
  to a public domain is an **owner action**, outside this ticket and outside any agent's authority.
  **Not done, deliberately** — no `wrangler deploy`, no Cloudflare account or domain action was
  taken. `workers/rendezvous/wrangler.toml` is configuration for the owner to deploy with, not a
  deployment.
- Any Electron or libp2p integration — that is T210/T211. **Not done** — confirmed by the guard
  tests above.
