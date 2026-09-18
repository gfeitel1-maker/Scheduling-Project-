---
title: "Phase B — signed rendezvous record contract and the camp rendezvous namespace"
document_type: ticket
status: completed
created: 2026-09-17
task_class: security-auth
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md, SECURITY.md]
archive_when: "A record signed by a device's libp2p identity key verifies only for that device, tamper of any field fails verification, and the namespace's generation, storage, propagation and rotation are implemented as the ADR specifies"
---

# T210 — Phase B: the signed record and the namespace

## Scope

- Canonical, fixed-order **byte** encoding of the signed material. Signing a `JSON.stringify`
  output is a defect class, not an implementation detail — key order and number formatting are not
  guaranteed stable across producers.
- Signature by the device's own libp2p Ed25519 identity key (self-certifying against the record's
  own `peerId`), per `docs/adr/2026-09-17-wan-rendezvous-seam.md`.
- A monotonic per-peer sequence bound into the signed material, so an intra-TTL replay and an
  out-of-order KV overwrite are both rejected. Precedent: T172's `cred_version`.
- Freshness with an **explicit stated clock-skew tolerance**. The local clock is untrusted input:
  a fast clock rejects every valid record, a slow one accepts expired ones.
- Namespace: 32 bytes from `crypto.randomBytes`, stored on the camp document and propagated by
  ordinary Automerge sync. **Including a rotation path** — the external spec has none, which leaves
  a departed staffer's laptop with permanent bulletin-board visibility.

## Depends on

T207 must land first. Until the guard can see an HTTP rendezvous client, this work is exactly the
silent boundary widening the Tier-4 ADR exists to prevent.

## Does NOT count as done

- Wiring into transport or discovery — that is T211, and it is gated.
- A namespace with no rotation or revocation story.

## Status note (round 2, 2026-09-18)

The `archive_when` condition's own text is met: `rendezvousRecord.js` verifies a record only for
the signing device's own key (33 passing tests including tamper-each-field), and
`rendezvousNamespace.js` implements generation, document-backed storage/propagation, and rotation
per the ADR, with a round-2 fix making the namespace/epoch pair unsplittable under concurrent
rotation (single `rendezvousDiscovery` field — see the ADR's Decision 3a).

_Prior: this status was left `open` anyway, because this ticket's own "Depends on: T207 must land
first" was not yet satisfied — `T207-tier4-guard-blind-to-http-rendezvous.md` was still
`in-progress`. That dependency is now discharged: T207 is `closed` on `main` (#491, which also
wrote the behavioural egress assertion into the ADR that its prose had described but not carried)._

## Closed 2026-09-18 — evidence per clause

Flipped to `completed`. Each clause of `archive_when`, against the tree:

| Clause | Evidence |
|---|---|
| "signed by a device's libp2p identity key verifies only for that device" | `rendezvousRecord.js`'s `verify()` recovers the public key from the record's **own** `peerId` field, never from a caller- or record-supplied key blob; `rendezvousRecord.test.js`'s "a record signed by key A but claiming peerId B fails verification", against real `generateKeyPair('Ed25519')` keys. |
| "tamper of any field fails verification" | `rendezvousRecord.test.js`'s `tamper each field` block loops over every field name, so a field added later without a case is visible rather than silently uncovered. |
| namespace **generation** | `mintRendezvousNamespace` — 32 bytes from `crypto.randomBytes`, epoch starts at 1. |
| namespace **storage** | one scalar `camps.rendezvousDiscovery` document field (ADR Decision 3a). |
| namespace **propagation** | it is a field on a modeled document record, so it replicates by ordinary Automerge sync; exercised by the fork/merge concurrency test, which uses real Automerge rather than a mock. |
| namespace **rotation** | `rotateRendezvousNamespace` changes namespace and epoch together, monotonically, and never touches device-local sequence state. |

**The one judgment call, stated so it can be disagreed with.** The rotation clause reads "implemented
as the ADR specifies", and `rendezvousNamespace.js` deliberately ships no rotation **trigger**. That
is not a shortfall against the clause, because the referent is the ADR, and the ADR's Decision 3
explicitly scopes the trigger out: whether rotation fires automatically on every device revocation
or is a director-initiated action is recorded there as an open **product** question, not an
unfinished implementation task. So the mechanism is what the ADR specifies, and the mechanism is
what shipped. A reader who thinks the clause should have meant an end-to-end rotation a director can
actually perform is disagreeing with the ADR's scoping, not with this ticket — reopen the ADR
question rather than this ticket.

**What is deliberately still not true, and is not this ticket's to make true.** Nothing in
production mints a namespace, so no device has one: these modules are reachable only from their own
tests. Wiring is T211, which is parked and gated. `INTERNET_TRANSPORT_SIGNOFF` remains `false`.
