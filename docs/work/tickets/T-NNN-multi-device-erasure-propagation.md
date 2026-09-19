---
title: "Multi-device erasure propagation via signed purge tombstones"
document_type: ticket
status: open
created: 2026-09-19
archive_when: a stale peer's reintroduction of a purged record is refused fleet-wide (the inverted purgeSupportCommand.js "known gap" test passes) and per-peer erasure state is observable
task_class: database-sync
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/adr/2026-09-19-multi-device-erasure-propagation.md
related_adrs:
  - docs/adr/2026-09-19-multi-device-erasure-propagation.md
  - docs/adr/2026-09-19-per-record-envelope-encryption-for-erasure.md
related_tickets:
  - docs/work/tickets/T202-camper-record-purge-path.md
---

# T-NNN — Multi-device erasure propagation via signed purge tombstones

> **Ticket number is a placeholder.** Do NOT assume `NNN`. This repo has a documented cross-worktree
> ticket-number collision hazard: at creation time, scan **every** worktree and open PR for the next
> free T-number and assign it in the same step, then rename this file. See the multi-session
> coordination note in project memory.

## Why

T202 built a real single-device camper purge but left one honest, tested gap: an already-paired stale
peer reintroduces the purged record on its next sync, because `sharesGenesis()` is the only admission
gate and it cannot refuse a specific record. This ticket closes that gap for the whole fleet.

## Success predicate (observable)

Given two paired devices A and B sharing a camp:
1. A purges a camper (existing `purgeCamperRecord`).
2. When B next reconnects, B **refuses** to reintroduce that camper into its projection, **and** B
   erases the camper's values from its own `.automerge` history — with no re-pairing and no genesis
   change, and with A and B still fully syncing every other record.
3. `purgeSupportCommand.test.js`'s current "known gap" test is inverted: it must now assert the
   reintroduction is **refused**, not demonstrated.
4. A director can observe per-peer erasure state (which devices have confirmed the erasure).

## Non-goals

- Reaching off-device copies (backups, exports, snapshots on a device that never reconnects) — out of
  reach for any approach; stated as a limit, not solved.
- Defending against a malicious peer running modified code — the accepted partial-trust limit.
- Genesis rotation — explicitly the rejected alternative (see the ADR); it survives only as a
  documented break-glass for evicting a compromised peer, which is a separate concern.

## Design (from ADR 2026-09-19-multi-device-erasure-propagation)

Signed, grow-only purge-tombstone set in the replicated document; merge-boundary denylist check in
`syncNode.js` applied in causal order; per-device local regeneration triggered on learning a tombstone.
Tombstone payload is **ID + monotonic erasure version + Host signature only** — no name, no reason
(mirrors T194's free-text guard for participant entities).

## Slices

- **S1 — Tombstone model + signing + key-preservation.** Grow-only signed set; sign-tombstone BEFORE
  regeneration in `purgeCamperRecord` (the current order destroys `host_signing_key` first); resolve
  the signing-key-preservation-across-purge follow-up T202 deferred. Verifier: valid tombstone
  produced; tampered tombstone rejected.
- **S2 — Admission enforcement.** Denylist check at the merge boundary, causal-order applied, loud
  (observable) rejection rather than the current silent drop. Verifier: the inverted "known gap" test.
- **S3 — Propagated byte erasure + visibility.** Local regeneration on learning a tombstone; per-peer
  erasure state (UNKNOWN → ERASED → CONFIRMED) surfaced to the director. Verifier: two-device
  propagation scenario.

## Seams that need test-first attention (per constitution rule 5)

- The merge-admission gate in `electron/sync/automerge/syncNode.js` (security + sync seam).
- The purge ordering in `electron/automerge/purgeSupportCommand.js` (data-erasure seam; must not
  re-open T202's atomicity guarantees).
- Signature verification trust root — reuse device-identity distribution (ADR 2026-09-14), do not mint
  a second one.

## Human decisions blocking start

1. Legal/product sign-off that retaining an opaque, PII-free purged UUID in a permanent tombstone set
   satisfies erasure obligations.
2. Confirm the `host_signing_key`-across-purge fix is in-scope here vs. a prerequisite ticket.

## Review

Architecturally-significant + touches auth/sync/erasure seams → Architect (done: the ADR), then the
full loop with **Security** and **Red Hat** mandatory (this is a security-critical erasure gate), plus
Verifier evidence on the inverted known-gap test before any claim of done.
