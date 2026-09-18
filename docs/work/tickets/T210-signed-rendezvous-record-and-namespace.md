---
title: "Phase B — signed rendezvous record contract and the camp rendezvous namespace"
document_type: ticket
status: open
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
