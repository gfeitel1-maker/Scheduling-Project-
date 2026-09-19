---
title: "Multi-device erasure: signed purge tombstones (denylist), genesis rotation as break-glass"
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

# Multi-device erasure: signed purge tombstones (denylist), genesis rotation as break-glass

> **Status: PROPOSED (2026-09-19), REVISED after Security + Red Hat review.** Follow-up to T202,
> which built a real single-device purge (`electron/automerge/purgeSupportCommand.js`) but left one
> honest gap: **nothing stops an already-paired stale peer from reintroducing a purged record via
> ordinary sync**, because `sharesGenesis()` is the only admission gate. The envelope-encryption ADR
> (2026-09-19) rejected crypto-shredding and named genesis rotation as the presumed path; this ADR
> examines it and recommends a **signed purge-tombstone denylist** instead — but the first draft of
> that recommendation was over-claimed, and an adversarial review corrected it. **What survives review
> (confidence high):** the denylist cleanly solves *reintroduction* (sub-problem 1) and *immediate
> logical erasure* fleet-wide, cheaply, without the fleet lockout genesis rotation causes. **What the
> review changed (this is not settled):** the byte-erasure half (sub-problem 2) must NOT be built by
> auto-triggering T202's whole-device rebuild on every peer — that reproduces the very blast radius
> this ADR rejected genesis rotation for. Byte-erasure on peers is rescoped to a separate targeted
> slice (S3) and needs an Architect design pass before it is buildable. The two premise errors the
> first draft made about the trust root and the merge seam are corrected below.

## The gap, and the two sub-problems inside it

T202 erases a camper on the device that runs it — it regenerates a fresh `.automerge` whose history
never mentions the row. It cannot reach the fleet: the next time a stale peer reconnects, an ordinary
merge reintroduces the record (`purgeSupportCommand.test.js`'s "known gap" test shows this).

"Reach the fleet" is two problems, and conflating them is what over-scoped the first draft:

1. **Reintroduction:** stop a stale peer's copy from coming *back* into the live projection. This is
   the problem that actually bites and the one the denylist solves cleanly.
2. **Physical byte erasure:** get the purged values physically *out* of every device's `.automerge`
   history, not just the originating one. This is genuinely hard, and — as the review established —
   is NOT solved for free by the denylist.

## What the divergent exploration surfaced, and why it converges on a shipped pattern

Five independent framings (regulatory, logistics, inversion, on-call, adversarial) converged on one
primitive: **a list of purged record IDs the sync layer consults to refuse resurrection.** The
adversarial frame added: it must be *signed* (or any staff device could forge an irreversible
erasure) and *monotonic* (or a replay defeats it). The on-call frame added: per-peer state must be
*visible* and rejection *loud*.

The deep reason this is the right primitive: **deletion is hard in a CRDT because *absence* does not
propagate. A tombstone is *presence*, and a grow-only signed set is add-only, commutative,
idempotent, never contested** — exactly the case CRDTs handle trivially.

**Crucially, this codebase already ships this exact pattern.** `users` credential fields
(`role`, `pin_hash`, `pin_salt`) are protected by `CREDENTIAL_FIELDS` / `verifyAuthFields` and a
monotonic `cred_version` in `electron/automerge/projector.js` (`upsertUsersEntity`): a change merges
into the CRDT unconditionally, and is then **gated at projection time** on (a) an Ed25519 signature
and (b) a monotonic version, refusing to *apply* an unsigned or stale change while still merging its
history. The tombstone should be built as a sibling of that mechanism, not as new machinery. This is
what resolves three separate review findings at once (see below).

## Options considered

**Option A — Per-camp genesis rotation.** Mint a new genesis so stale peers fail `sharesGenesis()`.
It *does* achieve full fleet byte-erasure — every device must re-pair, and a re-paired device syncs
the regenerated, camper-free document. But it is a fleet-wide nuke: it refuses **every** device,
honest and offline alike, each needing a human re-pair (`joinStart`/`approveDevice`); genesis
regeneration is not a runtime operation today (`GENESIS_B64` is a pinned constant in
`campDocument.js`); and its transition window drops non-matching docs silently. **Kept as
break-glass** for the case where full physical byte-erasure across the fleet is required *now*, and
for evicting a compromised peer wholesale — a different problem from ordinary erasure.

**Option B — Signed purge-tombstone denylist. RECOMMENDED for sub-problem 1 + logical erasure.**
A purge appends a Host-signed, monotonically-versioned tombstone (purged entity ID + version +
signature — no name, no reason) to a grow-only set that is a **SQLite-backed modeled entity seeded
into the document** (see "The regen trap", below — this is not optional). Enforcement mirrors the
shipped `users`-credential pattern: the tombstone merges into the CRDT unconditionally, and at
**projection time** the projector (a) verifies the signature and monotonic version and (b) refuses to
project — and actively deletes — any record whose ID is tombstoned. A stale peer that reconnects
receives the tombstone as ordinary replicated state and its copy of the record **never reaches the
projection again**. Only that record is refused; the device stays paired and syncs everything else.
This is immediate, targeted, and needs no rebuild and no re-pair.

**Physical byte-erasure on peers (sub-problem 2) is explicitly NOT part of Option B's cheap path.**
The tombstone makes the record permanently *invisible* on every device (never projected); the
ciphertext-or-plaintext bytes remain in each peer's `.automerge` history until physically rewritten.
Rewriting them is deferred to S3 as a **targeted history rewrite**, NOT the per-peer whole-device
T202 rebuild the first draft implied (see "The blast-radius trap").

**Option C — Epoch/generation counter.** Folded into B as the monotonic version field.

**Option D — Do nothing runtime; keep T202 + the documented manual physical re-pair.** The honest
interim truth until B ships; rejected as the endpoint because "physically re-pair every device" is
the operationally-impossible step for a real camp.

## The two traps the first draft fell into (corrected)

**The regen trap (Red Hat, HIGH).** T202's regeneration is `seedAllFromSqlite(oldDb,
createEmptyDoc())` (`purgeSupportCommand.js:151`) — it rebuilds the document *from SQLite*, not by
copying the old document forward. A tombstone that lived only in the Automerge document would be
**discarded by the very rebuild meant to carry it**, and the purging device would produce a fresh
document with no record of the purge it just performed — silent total failure on first use.
Therefore the tombstone set MUST be a SQLite table that `seedAllFromSqlite` re-seeds into the fresh
document, exactly as camp-scoped modeled entities already round-trip. "Sign before regen" is
necessary but not sufficient; "persist in SQLite and seed it back" is the actual requirement.

**The blast-radius trap (Red Hat, HIGH — falsified the first draft's headline).** The first draft
had every peer run T202's *whole-device* rebuild on learning a tombstone. That rebuild wipes, on each
device, camp-wide: `pending_writes` (unsynced local edits — **real data loss**), `conflicts`
(un-triaged), `import_evidence`/`import_decisions`, `schedule_snapshots`, and more
(`purgeSupportCommand.js:28-44`). Firing that on all N devices, silently, on background sync, per
purge, is **worse** than genesis rotation in one dimension: re-pairing is a deliberate human action,
whereas a tombstone-triggered rebuild fires with no confirmation. The first draft's comparison table
claimed "only the purged record is refused" — true for network state, **false for local state**. So
the trigger is redesigned: **learning a tombstone triggers only projection refusal + deletion of that
record (cheap, no rebuild).** Physical history rewrite is a separate, opt-in, targeted operation
(S3), never an automatic per-peer full rebuild.

## Corrected: trust root and enforcement seam (Security, two MUST-FIX)

**The trust root is NOT a document field (Security F1).** The first draft said the verifier key
`camps.signing_public_key` is "document-replicated — reuse it." That is **wrong**, and building on it
would reopen a closed hole. `PROJECTIONS.camps.fields` is `['name']` (`electron/ops/projections.js`);
`signing_public_key` is deliberately **kept off the document** and distributed only via the
authenticated join/login reply (`electron/sync/automerge/joinSession.js`), written straight to SQLite.
Both the read path (`upsertCampsEntity` reads only allowlisted fields) and the write path
(`applyWrite`'s `fields.includes(field)` no-op) exclude it, in both directions. If an implementer
"made it document-replicated to match the ADR," a compromised paired peer could inject its own key
and mint tombstones everyone trusts. **Correction:** the tombstone verifier reads the Host public key
from the same local SQLite column the shipped credential-verification code already uses; the key stays
off the document. If it ever must move into the document, it requires the same signature+monotonicity
guard `CREDENTIAL_FIELDS` already implements.

**"Applied in causal order" is not a real mechanism here (Security F2).** `syncNode.js` merges whole
documents/changesets (`A.merge` / `A.receiveSyncMessage`); there is no per-op, mid-merge rejection by
target ID, and Automerge's own causal metadata is attacker-influenced under the accepted
partial-trust model, so it cannot be the backdating defense. **Correction:** S2 is projection-time
gating, exactly like `upsertUsersEntity` — merge everything, then refuse to apply a record that is
tombstoned, and refuse to apply a tombstone that fails signature/monotonic-version. The anti-backdating
property comes from the signed monotonic version, not from Automerge op ordering.

## Who may purge, and key custody (Red Hat R3 + Security F4)

**Purge/tombstone-minting is inherently Host-only** — only the Host holds `host_signing_key`
(`localAuth.js:277`), so only the Host can sign a tombstone. But `purgeCamperRecord` today has no Host
check, and a director will run it from whatever device is in front of them. **Design requirement:**
either refuse a purge on a non-Host device with a clear message, or provide a delegated flow where a
non-Host admin's purge request is co-signed by the Host. This must be decided in S1, not left implicit
— a purge that "succeeds" locally without minting a tombstone reproduces the exact gap this ADR closes.

**Key preservation across the purge (S1)** captures `host_signing_key` / `device_identity_key` /
`camps.signing_secret` before the rebuild and restores them after, purge-path only (the
disaster-recovery rebuild keeps wiping keys, correctly). Because the Host otherwise re-mints a fresh
key and overwrites the verifier, no prior signature would verify. **Security F4:** this captured key
material must never touch disk unencrypted during the rebuild window — held in memory only, for the
duration of the scoped transaction, and pinned by a test the way T202 pins its host-only-wipe
behaviour.

**The signature is load-bearing, not theater (Security F3, confirmed).** Without it, any paired staff
device could mint an irreversible fleet-wide erasure of any record. With it, that authority is limited
to the Host — the same boundary `issueCampToken` already enforces. Must-keep.

## Why B still beats A — honestly, per sub-problem

| | Genesis rotation (A) | Tombstone denylist (B) |
|---|---|---|
| Reintroduction (sub-problem 1) | Solved by a fleet nuke | **Solved cheaply**; only the record is refused, devices stay paired |
| Immediate logical erasure (never projects) fleet-wide | Only after every device re-pairs | **Immediate** on tombstone propagation, no re-pair |
| Physical byte-erasure on peers (sub-problem 2) | Achieved, via forced fleet re-pair | **Deferred to a targeted S3 rewrite**; not the cheap path |
| Who is disrupted | Every device re-pairs (human step) | Only devices holding the record re-project it; **no rebuild on the cheap path** |
| New mechanism | Runtime genesis regeneration (net-new) | Reuses the shipped signed-credential pattern |
| CRDT fit | Fights it (absence) | Fits it (presence, add-only set) |

The honest summary: **B wins decisively on reintroduction and immediate logical erasure — the common,
important case — using a pattern already proven in this codebase. Full physical byte-erasure across
the fleet is a hard problem both approaches pay for (A via re-pair; B via a future targeted rewrite),
and A is retained as break-glass for when that is required immediately.** The recommendation is
therefore B for the erasure workflow, with A available, not B as a wholesale replacement for A.

## Residual risks (stated, not papered over)

- **Tombstone lost before first propagation (Red Hat).** If the purging device is lost/wiped before
  its tombstone syncs to any peer, erasure silently fails while the director saw local "success."
  `purgeCamperRecord` must NOT report erasure as fleet-complete until the tombstone has replicated to
  ≥1 live peer (or a durable medium); until then it is "erased locally, fleet-propagation pending",
  surfaced to the director. This is the same class of silent-transition failure the ADR faults genesis
  rotation for — so it must be made loud here, not inherited.
- **Concurrency (Red Hat).** A local purge and a tombstone-triggered projection refusal (or two
  tombstones) can race the same SQLite file / `.automerge`. A single per-device purge/regen
  serialization lock is required, with a test for two triggers inside one sync window.
- **Off-device copies** — a backup, an export, a `schedule_snapshots` row on a device that never
  reconnects — are unreachable by any approach.
- **A malicious peer running modified code** can ignore the denylist and re-serve the record — the
  accepted partial-trust staff-device limit. The tombstone defends against the honest-but-stale peer,
  which is the actual T202 gap.
- **The opaque PII-free purged UUID persists forever** in the tombstone set — accepted (see decisions).

## Slices (revised)

1. **S1 — Tombstone model + signing + Host-only purge + key-preservation.** The SQLite-backed,
   seeded-into-the-document, Host-signed, monotonically-versioned tombstone entity, modeled on
   `CREDENTIAL_FIELDS`. Host-only purge enforcement (or delegated co-sign). Key preservation across the
   purge (in-memory only). Tests: valid tombstone verifies and survives the seed/regen round-trip; a
   tampered or stale tombstone is refused; a purge on a non-Host device is refused (or co-signed); a
   purge preserves `host_signing_key`/`camps.signing_public_key`.
2. **S2 — Projection-time admission gate.** In the projector (not mid-merge), refuse to project any
   tombstoned record and delete it if present; refuse to apply an unsigned/stale tombstone. Test: the
   `purgeSupportCommand.test.js` "known gap" scenario now *refuses* reintroduction. No whole-device
   rebuild on this path.
3. **S3 — Physical byte-erasure on peers + visibility. NEEDS ITS OWN ARCHITECT PASS.** A *targeted*
   history rewrite that removes only the tombstoned record's ops while preserving each device's
   host-only local state (`pending_writes`, `conflicts`, etc.) — i.e. the targeted op-prune T202
   deferred, NOT a per-peer whole-device rebuild. Plus per-peer erasure state
   (UNKNOWN → LOGICALLY_ERASED → BYTES_ERASED) surfaced to the director, and the "propagation pending"
   signal from the residual-risks section. This slice is where the remaining hard design work lives;
   until it exists, the shipped guarantee is logical erasure (B) with physical fleet byte-erasure via
   the break-glass (A).

## Human decisions

1. **Legal/product — RESOLVED (owner: yes).** Retaining the opaque, PII-free purged UUID in a
   permanent tombstone satisfies erasure for this data class. Tombstone carries ID + version +
   signature only.
2. **Scope — RESOLVED (in-scope, S1).** `host_signing_key` preservation-across-purge is part of this
   ticket, purge-path only.
3. **NEW — the sub-problem-2 mechanism (S3) needs a decision.** Is "immediate logical erasure
   everywhere + physical byte-erasure via break-glass re-pair" an acceptable *shipped* guarantee, with
   the targeted-history-rewrite as a later enhancement? Or must automatic physical byte-erasure across
   the fleet be in the first release (which requires building the targeted rewrite now, and its own
   Architect + Red Hat pass)? This is the open product/engineering decision this review surfaced.

This ADR settles the mechanism for *reintroduction* and *logical* erasure (signed tombstone denylist,
built on the shipped credential pattern). It scopes but does not finish *physical* fleet byte-erasure,
which is S3's Architect pass. Genesis rotation is retained as break-glass, not discarded.
