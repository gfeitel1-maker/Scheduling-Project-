---
title: "Distributed purge authority: any valid admin signs a purge, rooted in device_identity_key, judged by the T331 causal-ancestor replay"
document_type: adr
authority: normative
status: proposed
date: 2026-10-07
decided: ""
deciders: [product-owner]
program: security-hardening
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - SECURITY.md
supersedes: []
amends:
  - docs/adr/2026-09-19-multi-device-erasure-propagation.md
related_adrs:
  - docs/adr/2026-10-02-distributed-revocation-authority.md
  - docs/adr/2026-09-19-multi-device-erasure-propagation.md
  - docs/adr/2026-09-26-schema-version-gate-before-merge.md
  - docs/adr/2026-09-14-device-identity-and-token-binding.md
related_tickets:
  - docs/work/tickets/T202-camper-record-purge-path.md
  - docs/work/tickets/T233-multi-device-erasure-propagation.md
  - docs/work/tickets/T333-two-device-revocation-recovery.md
implementation_state: not-started
affects:
  - electron/automerge/tombstoneSignature.js
  - electron/automerge/purgeSupportCommand.js
  - electron/automerge/purgeCollateral.js
  - electron/automerge/projector.js
  - electron/automerge/authorityLog.js
  - electron/automerge/authorityLogSignature.js
  - electron/automerge/authorityReplay.js
  - electron/automerge/campDocument.js
  - electron/automerge/seed.js
  - electron/automerge/hostKeyPreservation.js
  - electron/db/schema.sql
  - electron/db/localDb.js
  - electron/db/rollback/
  - SECURITY.md
---

# ADR: Distributed purge authority — any valid admin signs a purge

**Ticket:** T342 (board item `h-purge-survives-fired-founder`). **Status: proposed.** Acceptance is the
organizer's under the owner's standing delegation (Constitution Art. IV), because this applies the
already-accepted T331 model ([`2026-10-02-distributed-revocation-authority.md`](2026-10-02-distributed-revocation-authority.md))
to the one place that ADR named and deliberately left open (its "Related finding: purge-tombstone
signing has the identical single-host assumption"). It makes no new product-direction choice except
the one flagged in "Open questions" (threshold), where a default is recommended.

**Design-only.** No code ships from this document. The eventual build goes through the full security +
battle-test gate.

## Product outcome and non-goals

**Success predicate (observable):** with the founding device fired by quorum, or simply absent, a
remaining valid admin runs the purge command on their own device; the erasure reaches every other
current device through ordinary sync; a purge authored by a device that was *not* a valid admin at the
causal point it signed from is dropped identically on every peer; and an earlier valid purge is never
lost because its signer was later removed, nor because a purge/rebuild ran.

**Non-goals:** a purge UI (the command stays support-level, no preload/IPC surface); changing the
"logical erasure" guarantee the owner decided in the T233 ADR; per-record envelope encryption;
closing the T331 offline-at-the-instant-of-firing residual (inherited, bounded, restated below);
unifying `users.role='admin'` with device admin (separate board item).

## Two premise corrections found by reading the code

1. **A purge is per-camper-record, not whole-camp.** The only tombstone entity the code mints is
   `'campers'` (`electron/automerge/purgeSupportCommand.js:392`), one id per call, and
   `TOMBSTONE_DENYLISTED_ENTITIES` (`electron/automerge/projector.js:445-467`) fans that one id out to
   the camper's dependent tables. Whole-camp erasure is only the *loop* of N purges, and the
   whole-device rebuild collateral (`purgeSupportCommand.js:34-44`) is device-local and not
   propagated. This matters for the threshold decision below: the unit of irreversible harm is one
   camper record per signature.
2. **T331's claim that purge "never touches the document" is false for the purging device.**
   `purgeCamperRecord` regenerates the document from scratch
   (`electron/automerge/purgeSupportCommand.js:400`, `seedAllFromSqlite(oldDb, createEmptyDoc())`),
   saves it over the on-disk `.automerge` (`:415`), and `seedAllFromSqlite` explicitly skips
   `camp_authority_log` (`electron/automerge/seed.js:154`) because it has no SQL mirror. Yet
   `electron/automerge/purgeCollateral.js:70-76` and the T331 ADR (lines 318-331) both justify the
   authority log surviving a purge by "the document was never purged". **After any purge today, the
   purging device's document holds an empty authority log and no genesis entry**, so its replay has no
   founder (`authorityReplay.js:162,169-171`: founder is read from the document's genesis entry) and
   its `authority_cache` is empty until a peer re-syncs the log. This is a latent T331 gap, found here
   because the causal-ancestor rule cannot be applied to a purge at all without closing it (see
   "The regeneration problem" below). It is verified by code reading; the build's first battle test
   (BT-9) reproduces it red before the fix.

## What exists today (cited)

- **Signing is Host-only.** `signTombstone` throws unless the device has a `host_signing_key` row
  (`electron/automerge/tombstoneSignature.js:39-43`); the purge command refuses outright on a device
  without one (`purgeSupportCommand.js:239-245`) and its crash-recovery keys off that same row
  (`:175`, `:219-238`). The signed fields are `id|entity|version` (`tombstoneSignature.js:25`).
- **Verification trusts one key, off-document.** `upsertTombstonesEntity` reads the local
  `camps.signing_public_key` (`projector.js:331`), verifies (`:347`), and applies a `>=` monotonic guard
  against the *local SQLite row* (`:346,352`); refusal is `continue` plus an audit event
  (`:354-367`); no key means skip (`:340-344`).
- **The denylist is projection-time.** `tombstonedIds` reads the SQLite `tombstones` table
  (`:505-507`); gated entities are skipped/deleted (`:538-566`). `tombstones` projects before
  `camp_authority_log` and before every domain entity (`:125`).
- **`version` is vestigial.** The purge command mints `existingTombstone?.version ?? 1`
  (`purgeSupportCommand.js:390-391`); nothing mints a version above 1. Its only live consumers are the
  erasure-propagation handshake (`electron/sync/automerge/syncNode.js:781`,
  `electron/ops/peerErasureState.js:82`), which compare `(id, version)` pairs.
- **Carry-forward of tombstones through a purge** works only because the verified row sits in SQLite
  and is re-seeded into the fresh document (`purgeSupportCommand.js:383-409`, the "regen trap" comment).
- **T331 authority.** Admin authority is rooted in each device's own `device_identity_key`
  (`authorityLogSignature.js:68-83`), the founder is axiomatic from the genesis entry
  (`authorityReplay.js:218`), a signature counts iff the signer held a live admin grant among the
  causal ancestors of the change that completed the entry (`stateAt`, `authorityReplay.js:209-292`;
  `isValidAdminAt`, `:299`). Ordinary removal needs any one admin; admin/founder removal needs
  `floor((N-1)/2)+1` of the other admins (`quorumThreshold`, `:323-325`; fixed point `:276-287`).
  Convergence is a pure function of the change set (header `:1-6`; the round-3/round-4 notes at
  `:176-208`, `:63-84`). Signature trust is `createVerifiedEntryTrust` (`:361-372`), shared with
  discovery; the signed `id` is bound (`authorityLogSignature.js:40-50`) so a captured tuple cannot be
  replayed under a new id.
- **T332 precedence and T333.** Gate A hoists the `authority_cache` row above the legacy
  `devices.revoked_at` check (T331 ADR, Amendment 2026-10-03 §1); in a strict two-device camp a blind
  revoke under sync lag can lock the other admin out until a third device joins, owner-accepted and
  deferred to T333 (T331 ADR "Known limitation (v1)").

## Candidate approaches considered

`adhd` divergence: **closed for decision A** (the owner directed "apply the T331 model"; its
pre-flight gate marks an owner-fixed approach as not open-ended). Decisions B, C and the record
shape were compared inline by the Architect; no parallel-agent fan-out was run, and that is stated
rather than implied.

| # | Shape | Verdict |
|---|---|---|
| 1 | Retarget `signTombstone` to `device_identity_key`, keep one tombstone record per target id, judge by causal ancestry (smallest diff) | Rejected. Per-target record id means two concurrent signers mix `sig`/`signer` fields under last-write-wins (the exact hazard `authorityLog.js:33` documents for entry ids), and any peer can overwrite a valid signature field with junk, hiding a valid purge from a device that has not yet projected it. Still needs its own change index and still hits the regeneration problem. |
| 2 | **A purge is a new `kind` in `camp_authority_log`** (chosen) | Reuses the collection, the genesis registration, entry-id signature binding, `createVerifiedEntryTrust`, the change index, and the replay. The derived denylist is written into the existing SQLite `tombstones` table. |
| 3 | k-of-n co-signed purge (multi-signature) | Rejected for v1. Needs an offline co-signing protocol for a command that runs with the app stopped, and the grant path is any-admin-signs, so a rogue admin can mint extra admins to satisfy any count (the same weakness T331's quorum accepts). |
| 4 | Judge the signer at the document heads ("currently admin") instead of the causal point | Rejected. Firing an admin would silently un-erase every camper they had purged. Un-erasure is the worst failure this feature has. |
| 5 | Judge by "first seen before the removal" (device-local arrival order) | Rejected. Non-convergent: arrival order inside one sync batch is arbitrary, so peers would disagree about which campers are erased. |

## Decision A — signing authority (confidence 85%)

A purge is one signed `camp_authority_log` entry of a new `kind: 'purge'`:

```
{ kind: 'purge', target_entity: 'campers', target_record_id: <camper id>,
  signer_device_id, signature }          // record id = random UUID, bound into the signature
```

- Signed with the acting device's `device_identity_key` (same key-wrapping as
  `authorityLogSignature.js:68-83`; factor the shared helper rather than copying it). **Not**
  `host_signing_key`. The founder is not special.
- New domain-separated context, e.g. `shoresh-purge-sig-v1`, over
  `['id','target_entity','target_record_id','signer_device_id']`. It must be structurally
  non-interchangeable with `shoresh-authority-sig-v2`, `shoresh-tombstone-sig-v1` and
  `shoresh-auth-sig-v2`.
- **Validity** = (1) the signature verifies against the signer's peer id resolved from a trusted
  grant/genesis entry (`resolveAuthorityPeerIds`, `authorityReplay.js:335-351`, via a
  `createVerifiedEntryTrust` that branches on `kind`), **and** (2) the signer held a live admin grant
  among the causal ancestors of a change that completed the entry (`isValidAdminAt`). A purge entry
  does **not** alter admin state: `stateAt`'s fall-through (`authorityReplay.js:245-249`, which treats
  any non-grant as a revoke vote) must explicitly `continue` for `kind==='purge'`, and
  `isCompleteEntry` (`:34-41`) gains a `purge` branch requiring the purge fields.
- Fired founder: a purge authored by the founder *after* the quorum removal reached them is dropped,
  identically on every peer, by the same ancestor rule that already drops a removed admin's revokes
  (T331 ADR hard case 1). The founder's device holding the only `host_signing_key` is irrelevant.
- **Legacy tombstones stay honored.** The existing Host-signed records in the `tombstones` collection
  keep verifying against `camps.signing_public_key` through the unchanged `upsertTombstonesEntity`
  path, read-only: nothing mints a new one. Dropping them would silently un-erase real prior purges.
  (The repo is pre-production and favours clean cutovers, but un-erasure is a privacy regression, not
  a compatibility nicety; the retained verify path is ~15 lines.)

**Fail closed on an unknown signer.** If the signer's grant has not synced yet (no resolvable peer id)
the purge entry is *held*, not applied, and re-evaluated on every projection pass (projection is a
full re-derivation). Contrast Gate A, which falls back to the legacy check when no `authority_cache`
row exists: that fallback is acceptable for a recoverable connection denial and unacceptable for an
irreversible erasure. A held purge is recoverable by a later sync; a wrongly applied one is not.

## Decision B — threshold (confidence 70%; flagged to the owner as a notice, not a blocker)

**Recommendation: (i) any one valid admin, no quorum.** Per camper record, immediate.

| Option | Fired/absent founder | Rogue or mistaken single admin | Cost |
|---|---|---|---|
| **(i) any 1 admin** | Always works: N=1, 2, 3, ... and any number of offline admins; no deadlock at any N | One admin can erase campers (one per signature) and nothing can restore them | None; reuses the replay as-is |
| (ii) two-tier quorum like admin removal | An *absent* (not fired) founder at N=2 blocks the purge; the survivor must first quorum-fire their co-director. Violates "absent founder must not block" | Needs a majority | A multi-signature collection protocol for an app-stopped CLI |
| (iii) stricter (all admins) | Deadlocks on any offline admin | Strongest | Worst availability |

Why (i), from evidence rather than taste:

1. **The quorum buys less than it appears.** Grants are any-admin-signs and additive
   (`authorityReplay.js:239-244`), so a rogue admin can mint the extra admins a count threshold
   requires. T331's own quorum for admin removal accepts the same weakness. A count that a single
   rogue admin can satisfy alone is not a defence against that admin.
2. **It is no wider than today's trust class.** Today one device, the Host, can purge
   (`purgeSupportCommand.js:219-245`). Under (i) any admin can, and T331 already trusts any admin to
   fire ordinary devices and grant admins. The new capability sits inside the existing admin trust
   boundary.
3. **The unit of harm is one camper record per signature** (premise correction 1), every purge is
   attributable (`signer_device_id` is in the signed payload and is audit-logged on every peer on
   apply), and a rogue admin is removable by the existing T331 quorum.
4. **The stale-fork residual is gated by admission, not by this document rule.** A removed admin
   could author a purge on a fork of pre-removal state; the causal rule would call it valid. That is
   the T331 ADR's own offline-at-firing residual, but T331's "symmetric mutual destruction / not a
   silent win" mitigation does **not** transfer: an erasure is neither symmetric nor reversible. What
   bounds it is delivery: the removed device is refused at Gate A and torn down live
   (`syncNode.js:150-159`, T331 ADR Amendment §1), so its forked changes cannot reach the fleet unless
   a currently valid admin relays them, and that admin could have signed directly. **This is the one
   place the owner should be aware the model is weaker than "irreversible" sounds.** The build pins
   the behaviour with a test (BT-4b) so it is documented, not accidental.

**Escalation path, not built:** if a second incident class ever justifies it, add a co-attestation
requirement for purge by a *new* `kind`, without changing this one. Not scoped here (no speculative
mechanism).

**Degradation:** N=1 — the sole admin purges. N=2/3 — either/any admin purges; no deadlock. Offline
admins are irrelevant to validity. The surviving admin of a two-device camp can always purge on their
own device (their local replay lists themselves); delivery to the other device is subject to the
inherited T333 limitation and is not made worse (see "Reconciling with T332/T333").

## Decision C — monotonicity and anti-rollback (confidence 80%)

T233 bound a `version` to the Host signature and compared it with the *local SQLite row*
(`projector.js:346-352`). That guard (1) depends on device-local state, so it is not a pure function of
the change set, and (2) guards a number that is always 1 (see "version is vestigial").

**Redesign: presence, not a counter.** The denylist is the **grow-only set of target ids that have at
least one valid purge entry** — the T331 pattern that replaced the unsigned `camp_epoch` scalar:
an append-only verified set, recomputed, never a number a peer can lower.

- **No rollback surface exists.** Adding entries only grows the set; a replayed older entry is the same
  id (idempotent, id is signature-bound). There is no field a replay can lower.
- **Two admins purge the same camper concurrently** → two entries, one target → one SQLite row. The row
  records the lexicographically smallest valid `authority_entry_id` (a stable-id tie-break, never a
  hash or iteration order) so every peer derives the same row.
- **Insert-only derived rows.** Rows written from an authority-log purge are never deleted by
  projection. Without this, a hostile peer deleting the entry's keys (`campDocument.js:672-677`, the
  `DELETE_FIELD` branch is not entity-restricted) would un-erase on the next re-derivation. The build
  must also check whether that write path should reject `DELETE_FIELD` against `camp_authority_log`
  outright (BT-7c); if it cannot, insert-only rows are the line that holds.
- **`tombstones.version` stays as a constant `1` for authority-sourced rows**, purely so the existing
  `(id, version)` handshake (`syncNode.js:781`, `peerErasureState.js:82`) keeps working unchanged. It
  has no anti-rollback role any more and the ADR says so.
- **Survives purge/rebuild** by the same mechanism that carries the admin set (next section) — not by
  re-reading a SQLite row the rebuild wipes.

## The regeneration problem — Slice 0, and the design's riskiest element

The causal-ancestor rule needs the signer's grants to be *ancestors of the change that completed the
purge entry*. Purge regenerates the document (`purgeSupportCommand.js:400`), which destroys exactly
that ancestry, and the authority log is not re-seeded at all (`seed.js:154`). Mint-then-regen as
written would produce a purge entry that is permanently invalid under the ancestor rule on every peer
(its ancestors contain no grants). Re-reading the signer's state "at the heads" instead would be
Option 4 above, rejected. So the design requires **Slice 0: carry the authority log through a purge
faithfully**.

1. **Mint in the live document, before regeneration.** The purge command loads the live document
   (`purgeSupportCommand.js:251`), checks that *this device's own replay* lists its device id as a
   currently valid admin (replacing the Host-key refusal at `:239-245`; a device that cannot prove
   admin refuses with a clear reason), writes the purge entry into the live document (full ancestry),
   and projects it to derive the SQLite row. The command must **not** `INSERT` into `tombstones`
   directly (today `:393-397`); that was a verification bypass kept safe only because the Host key
   was the root. Authority-sourced rows come from the projector alone.
2. **Carry `camp_authority_log` — including that entry and every earlier purge entry — into the
   regenerated document, preserving the entry-level partial order.** Each entry is re-authored as its
   own change on a fork that contains exactly its original ancestor-entries (so its `deps` are the
   maximal ancestors, concurrency is preserved, and no new ordering is invented); entries are processed
   in topological order. **Trap the Maker must not walk into:** each fork needs its own fresh Automerge
   actor id, or two forks reuse sequence numbers. The regenerated domain data is seeded as today and
   merged with the authority branch; the two share only genesis, so they stay concurrent.
3. **Make the replay entry-id-keyed, not change-hash-keyed.** Peers hold the original changes and the
   purging device holds re-authored copies of the same entry ids, so after a merge an entry has more
   than one completing change. `buildEntryChangeIndexFrom` (`authorityReplay.js:91-106`) keeps only
   the first completing change in `getAllChanges` order, which the file itself proves is not canonical
   (`:176-182`); with copies it could pick an original for one entry and a copy for another, and the
   ancestor test between them would silently fail (the copies' ancestors are copies). Required change:
   an entry is "among the ancestors of change *h*" iff **any** of its completing changes is; an entry
   counts iff its signer is valid at **any** completing change; the tie-break in
   `isCausallyAtLeastAsLate` (`:117-124`, raw hash comparison) must be re-keyed on the stable entry id
   so a re-authored copy cannot flip which grant wins peer-id resolution.
4. **Legacy tombstone rows are still seeded from SQLite as today** (`rows with authority_entry_id IS
   NULL` only); authority-sourced rows are re-derived from the carried entries and must **not** be
   seeded into the legacy `tombstones` collection (they would be unsigned there and refused with an
   audit event on every pass).

**Acceptance gate for Slice 0 (decides whether the design stands):** a property test over random
concurrent authority DAGs requires `replay(original) == replay(carried copy) == replay(merge(original,
carried copy))` for the admin set, revoked set and purge denylist, under every merge order.

**Fallback if that gate cannot be made green** (decision rule recorded now, not left to the Maker):
purge refuses unless the purge entry has first replicated to at least one live peer, then regenerates
(the T233 ADR already requires this acknowledgement before reporting fleet erasure, residual-risk
bullet 1), and a lone-device purge is refused with a clear message. Confidence that the faithful
carry is achievable: ~60%; the fallback is why the overall design is still ~75%.

## Decision D — production-path enforcement (hard acceptance criterion)

Verification and application live in **one place**: the projector's authority-log pass
(`upsertCampAuthorityLogEntity`, `projector.js:396`) writes the derived rows; it runs inside
`projectAll` (`projector.js:868`), reached in production from:

- `syncNode.js:508` — `handleSyncMessage` → `projectAndNotify` (the real `generateSyncMessage` /
  `receiveSyncMessage` path);
- `syncNode.js:309` — `handleReceived` → `projectAndNotify` (documented adversarial/direct-send);
- `syncNode.js:863` — `applyLocal`;
- the purge command's reprojections (`purgeSupportCommand.js:280,467`) and the rebuild
  (`rebuildSupportCommand.js:129`).

The T271 / T329 wrong-path class has recurred three times (the T331 ADR names it: "gated on the
PRODUCTION path (handleSyncMessage ...), not merely handleReceived"). **Hard acceptance criteria:**

1. An integration test drives a purge entry from device A to device B through the real
   `generateSyncMessage` / `receiveSyncMessage` / `handleSyncMessage` round trip, and asserts
   `handleReceived` was **not** the path exercised.
2. **Non-vacuity:** the same test with verification neutralised (a planted always-true verifier) must
   *fail* — a forged purge is then applied. A test that passes in both states is rejected.
3. **Choke-point guard:** a test fails if any production module other than the projector writes a
   `tombstones` row with a non-null `authority_entry_id`, or if `purgeSupportCommand.js` issues a
   direct `INSERT` into `tombstones` for a new purge.
4. No mocks for the crypto or the merge: real Ed25519 keys, real Automerge documents, real
   `device_identity_key` rows.

## Decision E — schema (confidence 85%)

- **Schema version:** `CURRENT_SCHEMA_VERSION` is **90** today (`electron/db/localDb.js:44`); this
  design bumps it to **91**.
- **One additive, nullable column:** `tombstones.authority_entry_id TEXT` (NULL = legacy Host-signed
  row). Optionally `signer_device_id TEXT` for the audit surface; the Maker may derive it from the
  entry instead. No new table, no new genesis-registered collection: `camp_authority_log` is already
  registered (`campDocument.js:105`) and the genesis document is untouched.
- **Document-field allowlist:** extend `CAMP_AUTHORITY_LOG_FIELDS` (`campDocument.js:658`) with
  `target_entity` and `target_record_id`. The document stores flat per-field keys, so a new field name
  inside an existing registered collection needs no genesis regeneration; **the build asserts
  `GENESIS_B64` is byte-identical** (`electron/automerge` genesis-parity tests) rather than assuming it.
- **Delete-reconcile:** `deleteReconcileEntity` for `tombstones` (`projector.js:717-719`) must be
  limited to legacy rows (`authority_entry_id IS NULL`), or it will delete every authority-derived row,
  none of which has a matching record in the legacy collection.
- **Migration** guarded `>= 90 && < 91` (never a bare `< 91`), written in both `schema.sql` and
  `localDb.js` (the two-places discipline v86/v88/v90 follow); pre-existing rows keep NULL, no
  back-fill.
- **Rollback module required:** `electron/db/rollback/v91_down.js` with a test, following
  `v90_down.js`; it must drop the column via the repo's table-rebuild pattern (SQLite column drop) and
  must not touch legacy rows. `npm run schema:check` is the required pre-push step.
- **Fleet effect:** peers at different schema versions pause syncing until both upgrade
  (`syncNode.js:271`, ADR 2026-09-26-schema-version-gate-before-merge). Expected and acceptable
  pre-production; state it in the release note.
- **Unknown `kind` on an older peer:** an older build ignores a `purge` entry (`isCompleteEntry`
  requires `target_device_id`, which a purge entry lacks), and the version gate blocks the sync before
  that matters.

## Reconciling with the T332 precedence amendment and T333

- **Same precedence principle, stricter on the unknown case.** The amendment says an `authority_cache`
  row is authoritative over `devices.revoked_at`. For purge, authority comes **only** from the replay
  of `camp_authority_log`; `devices.revoked_at`, token state and key presence are never consulted. The
  differing case is "no opinion about this signer": Gate A falls back to legacy, a purge holds
  (fail closed) — justified in Decision A.
- **No new lockout class.** Validity is a function of the document, not of Gate A, so a purge cannot
  deadlock itself. In a strict two-device camp the surviving admin always purges locally; delivering
  that entry to the peer is subject to the inherited T333 limitation (a blind revoke denies the only
  connection over which anything could arrive). T342 neither fixes nor worsens that; **it must not
  attempt to**, because T333 re-touches the admission gate's no-readmission guarantee.
- **T333 interaction to re-check at build time:** if T333 lands first and adds an "uncorroborated
  revoke" marker, a purge entry must not count as corroboration of anything (purge entries are excluded
  from admin-state derivation by design).

## `org-interface-contracts` checklist

- **Idempotency / retry:** the entry id is random-UUID and signature-bound; re-sending or re-merging
  the same entry is a no-op; re-running the purge command mints a new entry for the same target and the
  derived row collapses to the smallest id (no double-apply, no version regression). Crash recovery:
  re-run is safe because the mint step is skipped when a valid entry for the target already exists in
  the loaded document.
- **Concurrent retries:** two devices purging the same camper converge (smallest id wins the row);
  two devices purging different campers never conflict.
- **Unknown outcome:** the command already returns `propagationPending: true`
  (`purgeSupportCommand.js:495`); keep it. Fleet-complete is still not claimed until at least one peer
  reports the id in `peer_tombstone_reports` (T322 S3a), unchanged.
- **Error shape:** the command's refusals stay `RebuildRefusalError` with distinct messages: not an
  admin on this device's view; nothing to purge; unresolved identity contest. The projector's refusal
  stays audit-event + `console.error`, never silent; add an `applied` audit event carrying
  `signer_device_id` (attribution, Decision B point 3).
- **Authority boundary:** crosses the `authorize()`/camp boundary only through the existing support
  command; no new IPC or preload surface. Data arriving by sync is a trust boundary and is verified
  there (signature, peer-id resolution, ancestor validity), never trusted for being "in our database".
- **Gap flagged, not hidden:** the entry-delete hazard (BT-7c) and the stale-fork residual
  (Decision B point 4) are the two places this contract is weaker than "irreversible" implies.

## Files affected

`electron/automerge/tombstoneSignature.js` (legacy verify retained; v2 sign/verify added or moved
beside `authorityLogSignature.js`), `authorityLogSignature.js`, `authorityLog.js` (`mintPurgeEntry`),
`authorityReplay.js` (id-keyed replay, `purge` kind, trust branch), `projector.js`
(`upsertCampAuthorityLogEntity` derives rows; `deleteReconcileEntity` scope; denylist unchanged),
`campDocument.js` (field allowlist), `seed.js` (authority carry; filtered legacy seed),
`purgeSupportCommand.js` (admin gate, mint-in-live-doc, no direct INSERT, key-recovery re-keyed on
`device_identity_key`), `hostKeyPreservation.js`/`purgeCollateral.js` (comment corrected; behaviour
unchanged — `device_identity_key` is already preserved), `electron/db/schema.sql`, `localDb.js`,
`electron/db/rollback/v91_down.js` + test, `SECURITY.md` (Known limitations: stale-fork purge
residual; Host-only claim removed), and a correcting note on the T331 ADR's "document never purged"
passages.

## Reused vs new

**Reused:** `camp_authority_log` and its registration; `device_identity_key` and its preservation
across purge; `createVerifiedEntryTrust`/`resolveAuthorityPeerIds`; the causal-ancestor `stateAt`; the
projection-time denylist and `TOMBSTONE_DENYLISTED_ENTITIES`; the `tombstones` SQLite table and the
`(id, version)` propagation handshake; the support-command lock and key preservation.
**New, and why nothing existing covers it:** the `purge` kind and its signature context (no existing
signed shape binds a target record); entry-id-keyed replay and the faithful authority carry (the
existing change-hash index cannot survive document regeneration); one nullable column to separate
authority-derived rows from legacy ones.

## ADR required: yes

This is that ADR. It changes a stored schema other code depends on (`tombstones`), an existing
signed-shape contract (tombstone signing) and a security tradeoff that is not obviously reversible
(any-one-admin irreversible erasure).

## Slices (ticket-sized, each through the full security + battle-test gate)

- **S0 — authority carry-forward through purge** (fixes the latent T331 gap; ships independently).
  BT-8, BT-9, BT-10. Decides the fallback rule.
- **S1 — the `purge` kind end to end** (sign/verify, mint, replay, projector derivation, schema v91 +
  rollback). BT-1 to BT-7, BT-11 to BT-14.
- **S2 — rewire the purge command and key recovery**, docs and SECURITY.md. BT-1, BT-2, BT-15.

## Red-before-green battle tests

Every test uses real keys, real Automerge documents and the real projector; each states the red state
that must exist first.

- **BT-1 Fired founder, survivor purges.** Three admins (founder F, A, B); A and B quorum-remove F; A's
  device (no `host_signing_key` row at all) runs the purge; B and a third ordinary device receive it
  over the real sync path and erase the camper. *Red:* today the command refuses on A
  (`purgeSupportCommand.js:239-245`).
- **BT-2 Absent founder.** Two admins, founder offline for the whole test; the survivor purges alone;
  the founder reconnects and converges to the same denylist.
- **BT-3 Rogue removed admin, post-removal purge dropped.** S removed by quorum and the removal synced;
  S (still holding its key) authors a purge on the post-removal document; every peer drops it, no
  `tombstones` row, camper still projected, refusal audit-logged. Variant: purge by a never-admin
  paired device is dropped.
- **BT-4 Unknown signer is held, then applied.** The purge arrives before the signer's grant: not
  applied (fail closed); after the grant arrives the next pass applies it. **BT-4b (pin):** a purge
  authored on a pre-removal fork is *honored*; asserted and labelled as the documented residual so no
  one "fixes" it silently or relies on it being rejected.
- **BT-5 Forgery and replay.** Wrong signer, tampered `target_record_id`, tampered `target_entity`, a
  captured valid tuple replayed under a new entry id, and a grant/revoke signature presented as a
  purge (and the reverse) are all rejected.
- **BT-6 Legacy compatibility.** An existing Host-signed v1 tombstone still verifies and erases; new
  code cannot mint one; a v1 record is not deleted by the narrowed delete-reconcile.
- **BT-7 Anti-rollback / grow-only.** (a) Adding junk records for the same target cannot remove a
  valid purge; (b) two admins purging one camper concurrently yield one row with the smallest entry
  id, identically under both merge orders; (c) a `DELETE_FIELD` write against a purge entry cannot
  un-erase an already-projected camper, and a fresh device's behaviour is pinned either way.
- **BT-8 Convergence property/fuzz.** Random concurrent authority DAGs mixing grants, revokes, quorum
  votes and purges; every merge-order permutation; denylist, admin set and revoked set identical on
  every peer **and** equal to an independent naive oracle (so agreement cannot be vacuous). Includes the
  regeneration equivalence `replay(original) == replay(carried) == replay(merge(original, carried))`.
- **BT-9 Purge carries forward.** On a *lone* device with no peer reachable: authority log, derived
  admin set and every earlier purge (including one by a since-removed signer) are identical before and
  after a second purge. *Red first:* today the log is empty after a purge (`seed.js:154`).
- **BT-10 Rebuild idempotence.** `rebuildSupportCommand` over a document holding purge entries
  reproduces the identical derived rows and does not duplicate or lose any.
- **BT-11 Production path + non-vacuity.** Decision D criteria 1 and 2, exactly as written.
- **BT-12 Choke point.** Decision D criterion 3.
- **BT-13 Non-admin cannot purge.** The command refuses on a non-admin device with a distinct message;
  a forged entry from a non-admin is dropped (overlaps BT-3, kept separate so a regression names
  itself).
- **BT-14 Concurrency.** Two purges plus an incoming tombstone-bearing sync inside one window
  serialize through the existing support-command lock without a split state.
- **BT-15 Schema.** Fresh-install `schema.sql` equals the migrated schema; `v91_down` round-trips and
  preserves legacy rows; `GENESIS_B64` byte-identical; `npm run schema:check` family green.

## Residual risks (stated, not papered over)

1. **Stale-fork purge** by a removed admin (Decision B point 4): bounded by admission, not by the
   document rule; irreversible when it lands. Inherited from T331, sharper here.
2. **Any-one-admin** can erase campers (one per signature); the quorum alternative is rejected on
   evidence above and is the owner's to revisit.
3. **Slice 0 feasibility** (~60%); the fallback is a refusal on lone-device purge, not a silent
   degradation.
4. **Entry deletion** by a hostile peer: insert-only rows hold on devices that already projected; a
   device that never saw the entry cannot know.
5. **Unchanged from T233:** off-device copies; a modified-code peer ignoring the denylist; the opaque
   purged id persisting in the set forever.

## Open questions for the owner

**None blocking.** One notice with a recommended default:

1. **Threshold — any one admin may purge a camper record (recommended, 70%).** If you would rather
   require a second admin to agree for every purge, say so; the cost is that an absent co-director
   would have to be removed before you could erase a record, and a rogue admin could still satisfy the
   count by granting themselves more admin devices. The default proceeds as written.

Defaults taken without asking: legacy Host-signed tombstones stay honored (read-only); purge stays a
support-level command with no UI; the T331 ADR's "document never purged" passages get a correcting note
rather than a rewrite.
