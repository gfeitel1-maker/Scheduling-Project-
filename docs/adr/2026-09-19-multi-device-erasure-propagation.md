---
title: "Multi-device erasure: signed purge tombstones, not genesis rotation"
document_type: adr
status: proposed
authority: normative
implementation_state: not_started
date: 2026-09-19
decided: 2026-09-19
deciders: [product-owner]
task_class: database-sync
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
related_adrs:
  - docs/adr/2026-09-19-per-record-envelope-encryption-for-erasure.md
  - docs/adr/2026-09-17-individual-elective-scheduling.md
  - docs/adr/2026-09-08-flat-record-shape.md
  - docs/adr/2026-09-08-crdt-conflict-reconciliation.md
  - docs/adr/2026-09-14-device-identity-and-token-binding.md
related_tickets:
  - docs/work/tickets/T202-camper-record-purge-path.md
  - docs/work/tickets/T-NNN-multi-device-erasure-propagation.md
program: security-hardening
affects: []
---

# Multi-device erasure: signed purge tombstones, not genesis rotation

> **Status: PROPOSED (2026-09-19).** Follow-up to T202, which built a real single-device purge
> (`electron/automerge/purgeSupportCommand.js`) but left one honest gap open: **nothing stops an
> already-paired stale peer from reintroducing a purged record via ordinary sync.** The
> envelope-encryption ADR (2026-09-19) rejected crypto-shredding and named "per-camp genesis rotation"
> as the presumed forward path. **This ADR examines that path and recommends against it**, in favour of
> a **signed, replicated purge-tombstone denylist enforced at the sync-admission seam, which drives a
> per-device local history regeneration.** Confidence: **medium-high** on the mechanism shape;
> two questions are flagged as needing human/legal sign-off (see "What a human must decide").

## The gap this must close, stated exactly

T202 erases a camper on the device that runs it: it regenerates a fresh `.automerge` whose history
never mentions the row (`purgeCamperRecord` → `seedAllFromSqlite(oldDb, createEmptyDoc())`), so the
bytes are genuinely gone *on that device*. What it cannot do is reach the fleet. `sharesGenesis()`
(`electron/automerge/campDocument.js`) is the **only** admission gate `electron/sync/automerge/syncNode.js`
applies, and it cannot distinguish "a peer worth merging" from "a peer whose stale copy of this exact
record must never come back." So the next time a stale peer reconnects, an ordinary merge reintroduces
the record. `purgeSupportCommand.test.js`'s "known gap" test demonstrates this directly.

Two sub-problems hide inside "reach the fleet," and conflating them is what made genesis rotation look
necessary:

1. **Reintroduction:** stop a stale peer's copy from coming *back* into the live projection.
2. **Byte erasure:** get the purged values physically *out* of every device's history, not just the
   originating one.

## What the divergent exploration surfaced

Five independent framings were generated (regulatory, logistics, inversion, on-call, adversarial) and
converged hard. Every single frame independently proposed the same primitive under different names —
quarantine registry, purge manifest, revocation certificate, deletion denylist, committed-deletions
ledger, hash blacklist: **a list of purged record IDs that the sync layer consults to refuse
resurrection.** The adversarial frame added the security requirement (the list must be *signed* and
applied in *causal order*, or a peer forges a pre-purge causality to sneak a record back). The on-call
frame added the operability requirement (per-peer erasure state must be *visible*, and rejection
*loud*, not the silent drop `syncNode.js` does today). A second cluster (epoch/generation counters)
and a third (causal-barrier enforcement) are variants of the same admission-gate idea at different
granularities.

The convergence is not a coincidence. It points at the underlying fact:

> **Deletion is hard in a CRDT because *absence* does not propagate. A tombstone is *presence*, and
> presence propagates trivially.** A grow-only, signed set of purged IDs is a clean CRDT primitive
> (add-only, commutative, idempotent, never contested), whereas "the record is gone" is the case CRDTs
> are worst at. This is why the fix is to add a positive assertion, not to try to make an absence
> replicate.

## Options considered

**Option A — Per-camp genesis rotation (the presumed path). Rejected.** Mint a new genesis so stale
peers fail `sharesGenesis()` and are refused. It works, but it is a fleet-wide nuke: it refuses
**every** device — honest ones, and the ones offline for the week — not just the record, so each must
re-pair through the human `joinStart`/`approveDevice` flow; genesis regeneration is not a runtime
operation today (`GENESIS_B64` is a pinned constant, regenerated only by a source edit + release); it
compounds with T202's unresolved `host_signing_key` loss; and its transition window fails silently
(`syncNode.js` drops non-matching docs with no surfaced error). It answers sub-problem 1 with a
sledgehammer and does nothing targeted for sub-problem 2. Keep it only as a documented **break-glass**
for a different problem — evicting a *compromised* peer entirely, not erasing one record.

**Option B — Signed purge-tombstone denylist + per-device local regeneration. RECOMMENDED.**
A purge appends a signed tombstone (the purged entity ID + a monotonic erasure version + the director's
signature over both, no name, no reason) to a grow-only set carried in the replicated document. Two
enforcement points:

- **Admission (sub-problem 1):** `syncNode.js` / the merge boundary consults the denylist and **drops
  incoming ops that target a tombstoned ID**, applied in causal order so a forged pre-purge mutation
  cannot slip under it. A stale peer that reconnects receives the tombstone set first (it is ordinary
  replicated state) and its stale copy is refused — the record cannot come back. Only that record is
  refused; the device stays fully paired and syncs everything else.
- **Byte erasure (sub-problem 2):** on *learning* a tombstone it has not yet applied, each device runs
  T202's existing local regeneration for that ID — rewriting its own history without the purged rows.
  Offline peers do this on reconnect. This turns T202's single-device purge into an eventually-
  consistent fleet-wide one, **with no genesis change and no re-pair.**

**Option C — Epoch/generation counter.** A lighter "soft rotation": tag records with a generation,
increment on purge, render only the current generation. Cleaner than full genesis rotation but it is a
coarser denylist (per-epoch, not per-record) and still needs the same signing + visibility machinery
Option B has. Folded into B as the versioning field rather than adopted separately.

**Option D — Do nothing runtime; keep T202 + the manual physical re-pair procedure it already
documents.** Honest and zero-build. Rejected as the primary answer because "physically re-pair every
device" is exactly the operationally-impossible step for a real camp, but retained as the interim
truth until Option B ships.

## Why B beats A, concretely

| | Genesis rotation (A) | Tombstone denylist (B) |
|---|---|---|
| Who is cut off | **Every device**, must re-pair | **Only the purged record** is refused; devices stay paired |
| New mechanism | Runtime genesis regeneration (net-new, `GENESIS_B64` is pinned) | Grow-only signed set + one merge-boundary check + reuse of T202's regen |
| Byte erasure across fleet | Not addressed (rotation ≠ history rewrite) | Yes — each device runs T202 regen on learning the tombstone |
| Granularity | Whole camp | Per record (what the envelope-encryption idea wanted, without its custody problem) |
| CRDT fit | Fights it (absence) | Fits it (presence — add-only set) |
| Operator visibility | Silent transition | Per-peer erasure state, loud rejection (designed in) |

Crucially, B delivers the *targeted, per-record* erasure that made envelope encryption tempting —
**without** envelope encryption's fatal key-custody problem, because a tombstone is a positive
assertion that replicates and merges trivially, whereas a per-record key was a secret that had to be
deleted everywhere.

## Key custody / signing — the analysis

The tombstone's authority comes from a signature, and the only signing key in the system is the
Host's `host_signing_key` (Ed25519, `electron/auth/localAuth.js:277`). Its **public** half is mirrored
into `camps.signing_public_key` (`localAuth.js:304`), a document-replicated field every other device
already uses to verify Host signatures. That existing distribution is the tombstone verifier's trust
root — reuse it, do not mint a second one.

**The sequencing constraint with T202, decided (2026-09-19).** T202's purge wipes `host_signing_key`
(a host-only row destroyed by the whole-device rebuild), and on next boot `ensureHostSigningKey`
(`localAuth.js:277`) mints a *fresh* keypair and **overwrites** `camps.signing_public_key`. So signing
a tombstone with the old key just before regeneration does not survive: the replicated verifier moves
to the new key and the old signature no longer verifies. Sign-before-regen alone is therefore
insufficient. The correct fix is to **preserve the signing key across the purge**:

- **Preserve, do not re-mint.** The purge wrapper captures the host-only key material —
  `host_signing_key`, T162's `device_identity_key`, and `camps.signing_secret` (all in the
  never-replicate exclusion class, `campDocument.js:80`) — *before* the rebuild and restores it
  *after*, so `camps.signing_public_key` stays stable, existing camp/device tokens keep verifying, and
  tombstones signed with that key remain valid on every peer. This is a bounded, **purge-path-only**
  carve-out with exactly the shape of T202's existing purge-only backup-shred (`purgeSupportCommand.js`).
- **The shared disaster-recovery rebuild is left unchanged.** `rebuildSupportCommand.js`'s rebuild
  must keep wiping keys — recovering from a possibly-corrupt or possibly-compromised state should not
  carry old key material forward. Only the *purge* wrapper preserves; the two callers keep their
  different, correct behaviours, the same way the backup-shred is purge-only.
- This also resolves, rather than defers, T202's open "a Host that purges loses its credential-minting
  key and must re-establish identity" gap — it was a latent operational problem independent of
  tombstones, and this fix closes it. That is why it belongs in this ticket (S1) and not a separate
  prerequisite one.
- A tombstone is **never revoked** (erasure is irreversible by design), so the set is grow-only and
  needs no deletion semantics — which is the whole reason it is CRDT-clean.

## Performance

Negligible and not a deciding factor. The denylist is a set of UUIDs (tens to low hundreds over a
camp's life); the admission check is a set-membership test per incoming op; the per-device regeneration
is exactly T202's existing cost, paid once per device per purge. No new hot path.

## What it still cannot reach (stated plainly, not papered over)

- **Off-device copies** — a backup, an export, a `schedule_snapshots` row on a device that never
  reconnects — are untouched. Every erasure approach shares this limit; a copy taken before the
  tombstone existed is beyond the fleet's reach.
- **A malicious peer running modified code** can ignore the denylist and re-serve the record. This is
  the already-accepted partial-trust staff-device limit (SECURITY.md, "Accepted cost"): the tombstone
  defends against the honest-but-stale peer, which is the actual T202 gap, not a determined insider.
- **The purged ID persists forever** in the tombstone set. This is acceptable *only* because Shoresh
  entity IDs are random opaque UUIDs carrying no PII — the tombstone must carry the ID and version and
  signature and **nothing else** (no name, no reason), mirroring T194's guard that already refuses
  free-text for these entities in the audit log.

## Slices

1. **S1 — Tombstone data model + signing.** The grow-only signed set in the document, the sign-before-
   regen ordering in `purgeCamperRecord`, and the key-preservation fix T202 deferred. Test: a purge
   produces a verifiable tombstone; a tampered tombstone fails verification.
2. **S2 — Admission enforcement.** The merge-boundary denylist check in `syncNode.js`, applied in
   causal order; make the rejection loud (an observable event, not a silent drop). Test: the
   `purgeSupportCommand.test.js` "known gap" scenario now *refuses* the reintroduction instead of
   demonstrating it.
3. **S3 — Propagated byte erasure + visibility.** On learning a new tombstone, a device runs local
   regeneration; expose per-peer erasure state (UNKNOWN → ERASED → CONFIRMED) so a director can see
   fleet convergence. Test: two-device scenario — purge on A, tombstone propagates to B, B refuses the
   record AND regenerates its own history; state is observable on both.

## Human decisions — both resolved (2026-09-19)

1. **Legal/product — RESOLVED (product owner: yes).** Retaining the opaque, PII-free purged UUID in a
   permanent tombstone set is accepted as satisfying erasure for this data class, on the basis that a
   random opaque identifier carries nothing about the child. Recorded as the owner's product decision;
   the tombstone therefore must carry the ID + version + signature and **nothing else** (no name, no
   reason), mirroring T194's free-text guard. If a future jurisdiction/legal review disagrees, the
   fallback is genesis rotation (the break-glass below), which retains no per-record identifier.
2. **Scope/sequencing — RESOLVED (in-scope, S1).** The `host_signing_key` preservation-across-purge
   fix is in-scope for this ticket, scoped to the purge path only (see "Key custody / signing"). It is
   a genuine prerequisite for verifiable tombstones *and* closes a latent T202 gap, so it is one design,
   not a separable prerequisite.

Genesis rotation is not discarded — it is repositioned as a documented break-glass for evicting a
compromised peer wholesale, which is a different problem from erasing a record. This ADR's decision is:
**for record erasure across the fleet, build the signed tombstone denylist (Option B), not rotation.**
