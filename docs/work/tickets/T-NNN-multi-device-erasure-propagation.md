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
1. A purges a camper (via `purgeCamperRecord`, run on the Host or Host-co-signed — see S1).
2. When B next reconnects, B **refuses to project** that camper (it never re-appears in the UI/SQLite),
   with no re-pairing and no genesis change, and with A and B still fully syncing every other record.
   This is *logical erasure* and is the core deliverable.
3. `purgeSupportCommand.test.js`'s current "known gap" test is inverted: it must now assert the
   reintroduction is **refused**, not demonstrated.
4. `purgeCamperRecord` does not report fleet-erasure as complete until the tombstone has replicated to
   ≥1 live peer; until then the director sees "erased locally, propagation pending".
5. A director can observe per-peer erasure state.
6. *Physical* byte-erasure of the record from peers' `.automerge` history is S3 (see below) and is NOT
   required for this ticket's core predicate — logical erasure (2) is.

## Non-goals

- **Automatic physical byte-erasure on peers via a per-peer whole-device rebuild.** Explicitly
  rejected by review: T202's rebuild wipes each device's `pending_writes`/`conflicts`/etc camp-wide, so
  firing it fleet-wide per purge is real silent data loss. Physical byte-erasure is a *targeted* rewrite,
  deferred to S3.
- Reaching off-device copies (backups, exports, snapshots on a device that never reconnects).
- Defending against a malicious peer running modified code — accepted partial-trust limit.
- Genesis rotation — retained only as documented break-glass (full fleet byte-erasure now / evicting a
  compromised peer), not this ticket's mechanism.

## Design (from ADR 2026-09-19-multi-device-erasure-propagation, post-review)

A Host-signed, monotonically-versioned purge-tombstone modeled on the **shipped** `CREDENTIAL_FIELDS` /
`verifyAuthFields` / `cred_version` pattern in `electron/automerge/projector.js` (`upsertUsersEntity`):
a **SQLite-backed entity seeded into the document** (so it survives T202's `seedAllFromSqlite` regen —
a tombstone living only in the doc would be discarded), merged unconditionally, then **gated at
projection time** — the projector refuses to project (and deletes) any tombstoned record, and refuses
to apply an unsigned or stale tombstone. Anti-backdating comes from the signed monotonic version, NOT
from Automerge op ordering (there is no mid-merge per-op rejection seam — `syncNode.js` merges whole
changesets). Payload: **ID + monotonic version + Host signature only** — no name, no reason.

## Slices

- **S1 — Tombstone model + signing + Host-only purge + key-preservation.** The SQLite-backed,
  seeded-into-the-document, Host-signed, monotonically-versioned tombstone entity (sibling of
  `CREDENTIAL_FIELDS`). **Host-only purge:** refuse `purgeCamperRecord` on a non-Host device (no
  `host_signing_key`) with a clear message, or provide a Host co-sign path — a local "success" that
  mints no tombstone reproduces the gap this ticket closes. **Key preservation across the purge:**
  capture `host_signing_key`/`device_identity_key`/`camps.signing_secret` before the rebuild, restore
  after, purge-path only, **in memory only — never staged to disk unencrypted** (leave
  `rebuildSupportCommand.js`'s disaster-recovery rebuild wiping keys). The verifier key is read from the
  **local SQLite column** populated by the authenticated join/login reply — it is NOT and must NOT be a
  document-replicated field (`PROJECTIONS.camps.fields` is `['name']`; adding `signing_public_key` there
  would reopen a trust-root-poisoning hole). Verifiers: valid tombstone survives the seed/regen
  round-trip and verifies; tampered/stale tombstone refused; non-Host purge refused (or co-signed);
  purge preserves `host_signing_key`/`camps.signing_public_key`; preserved key material never hits disk.
- **S2 — Projection-time admission gate.** In the projector (NOT mid-merge), refuse to project any
  tombstoned record and delete it if present; refuse to apply an unsigned/stale tombstone; make
  rejection observable, not a silent drop. No whole-device rebuild on this path. Verifier: the inverted
  `purgeSupportCommand.test.js` "known gap" test; plus a concurrency test (two tombstones / a tombstone
  arriving mid-purge) against a single per-device purge/regen serialization lock.
- **S3 — Physical byte-erasure on peers + visibility. NEEDS ITS OWN ARCHITECT PASS BEFORE BUILD.** A
  *targeted* history rewrite removing only the tombstoned record's ops while preserving each device's
  host-only local state — the targeted op-prune T202 deferred, NOT a per-peer whole-device rebuild.
  Plus per-peer erasure state (UNKNOWN → LOGICALLY_ERASED → BYTES_ERASED) and the propagation-pending
  signal. Until S3 ships, the guarantee is logical erasure (S1/S2) + physical fleet byte-erasure via
  the break-glass (genesis rotation).

## Seams that need test-first attention (per constitution rule 5)

- The projector's admission/refusal gate (`electron/automerge/projector.js`) — modeled on
  `upsertUsersEntity`'s existing signed+monotonic guard (security + sync seam).
- `purgeCamperRecord` (`electron/automerge/purgeSupportCommand.js`) — Host-only enforcement, tombstone
  persistence into SQLite, key preservation; must not re-open T202's atomicity guarantees.
- Trust root: read the Host verifier key from local SQLite (join/login-reply channel), never from the
  document.

## Human decisions

1. **Legal/product: RESOLVED — yes** (owner). Opaque PII-free UUID retained in the tombstone → tombstone
   carries ID + version + signature only.
2. **Scope: RESOLVED — in-scope, S1.** `host_signing_key`-across-purge preservation is part of this
   ticket, purge-path only.
3. **OPEN — the S3 guarantee.** Is "immediate logical erasure everywhere + physical byte-erasure via
   break-glass" acceptable as the *shipped* guarantee, with the targeted history rewrite as a later
   enhancement? Or must automatic physical byte-erasure across the fleet be in the first release
   (requires building the targeted rewrite now + its own Architect/Red Hat pass)? Surfaced by the
   Security/Red Hat review; needs a product+engineering decision before S3.

## Review status

Architect ADR done; **Security + Red Hat review complete (2026-09-19)** — two Security MUST-FIX premise
corrections (trust root off-document; projection-time gating not mid-merge) and three Red Hat HIGH
findings (tombstone-survives-regen; no per-peer whole-device rebuild; Host-only purge) are folded into
the ADR and the slices above. Before Maker starts: S3 needs its own Architect pass; Verifier evidence on
the inverted known-gap test gates any claim of done.
