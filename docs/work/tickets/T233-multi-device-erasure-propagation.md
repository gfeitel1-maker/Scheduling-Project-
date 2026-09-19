---
title: "Multi-device erasure propagation via signed purge tombstones"
document_type: ticket
status: open
created: 2026-09-19
archive_when: a stale peer's reintroduction of a purged record is refused fleet-wide (the inverted purgeSupportCommand.js "known gap" test passes) and per-peer erasure state is observable
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/adr/2026-09-19-multi-device-erasure-propagation.md]
related_adrs: [docs/adr/2026-09-19-multi-device-erasure-propagation.md, docs/adr/2026-09-19-per-record-envelope-encryption-for-erasure.md]
related_tickets: [docs/work/tickets/T202-camper-record-purge-path.md]
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
- **S3 — Visibility only.** Per-peer erasure state (UNKNOWN → LOGICALLY_ERASED) surfaced to the
  director + the propagation-pending signal (a purge is not reported fleet-complete until its tombstone
  reaches ≥1 live peer). **Physical byte-erasure is out of scope** (owner decision: erasure = logical /
  invisible-forever); the rare physical-scrub case is served by the break-glass (genesis rotation),
  which is where that problem — a coordinated fleet cutover, not a cheap targeted rewrite — actually
  lives.

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
3. **Erasure guarantee — RESOLVED (owner: logical).** "Invisible forever" is the requirement. Physical
   byte-erasure across the fleet is out of scope (there is no stable form of it cheaper than a fleet
   cutover ≈ genesis rotation, which is retained as break-glass). S1+S2 fully meet the requirement.

## Review status

Architect ADR done; **Security + Red Hat review complete (2026-09-19)** — two Security MUST-FIX premise
corrections (trust root off-document; projection-time gating not mid-merge) and three Red Hat HIGH
findings (tombstone-survives-regen; no per-peer whole-device rebuild; Host-only purge) are folded into
the ADR and the slices above. Before Maker starts: S3 needs its own Architect pass; Verifier evidence on
the inverted known-gap test gates any claim of done.

## Implementation notes (2026-09-19, Maker — S1 + S2 + S3 return-value honesty)

**Schema version: v72.** `tombstones (id TEXT PRIMARY KEY, entity TEXT NOT NULL, version INTEGER
NOT NULL, sig TEXT NOT NULL, created_at TEXT)` added to `electron/db/schema.sql`;
`CURRENT_SCHEMA_VERSION` bumped 71→72 in `electron/db/localDb.js` with the usual
`>= 71 && < 72` migration guard (the table itself is created unconditionally by schema.sql on every
db open, same as every other `CREATE TABLE IF NOT EXISTS` in this file — the migration block only
backfills the version marker for a db migrating forward).

**GENESIS_B64 was regenerated (SEVENTH REGENERATION).** `tombstones` was added to
`EXTRA_MODELED_ENTITIES` (`electron/automerge/campDocument.js`) — the same list `camps`/`users` sit
in, for the same reason: a tombstone names no camp, and it needs the same bespoke,
security-sensitive projector handling `users`' credential fields already require. It was added to
`GENESIS_ENTITIES` (alphabetically, between `time_blocks` and `users`) and `GENESIS_B64` was
regenerated using the documented recipe (same pinned `ACTOR`/`TIME`, only the entity list changed).
New pinned head: `885392d2d6af8251adea2f4f7735e478d12d6810d8e066116b580a10a261b698`. Updated the one
test that pins it — `electron/automerge/campDocument.test.js`'s "createEmptyDoc always clones the
same frozen genesis root" — and `electron/automerge/generalize.test.js`'s derived-modeled-set
expectation list. Per the ADR's own accepted pre-production tradeoff, every existing `.automerge`
file is invalidated by this regeneration.

**S1 — `electron/automerge/tombstoneSignature.js` (new)**, TDD'd first in
`tombstoneSignature.test.js` (8 tests): `signTombstone`/`verifyTombstone`/`canonicalTombstoneMessage`,
structurally identical to `electron/auth/authSignature.js`'s `SIGNED_FIELDS`/`canonicalAuthMessage`
pattern, domain-separated under `shoresh-tombstone-sig-v1`, signing `{id, entity, version}` in that
fixed order.

**S1 — `electron/automerge/purgeSupportCommand.js`**: `purgeCamperRecord` now refuses outright (no
mutation) on a device with no `host_signing_key` row (`RebuildRefusalError`, before any mutation —
mirrors FIX4's existing early-refusal shape). Inside the existing single transaction, a tombstone
`{id: entityId, entity: 'campers', version}` is signed and `INSERT OR REPLACE`d into `tombstones`
BEFORE `seedAllFromSqlite` runs, so it round-trips into the regenerated document (closing the "regen
trap" the ADR names). Version is idempotent-safe: an existing tombstone for the same id keeps its
already-minted version on a crash-recovery retry rather than incrementing.

Key preservation (Security F4, purge-path only): `host_signing_key`, `device_identity_key`, and
`camps.{signing_secret,signing_public_key}` are captured into plain JS variables (never written to
any file) before `oldDb.close()`, then restored through an ordinary `openLocalDb` connection AFTER
`rebuildProjectionFromDocumentAtPath` completes. **One subtlety discovered during implementation,
not anticipated by the ADR text:** the rebuild's own internal `projectAll` pass runs BEFORE the key
restore (the rebuild deletes and recreates the db file, so there is no earlier point to restore
into), which means the just-minted tombstone cannot verify and project during that first pass — the
no-key branch correctly skips an unverifiable change (same policy as `upsertUsersEntity`). Fixed by
re-running `projectAll` against the same fresh document immediately after the key restore, an
idempotent second pass that lets the tombstone (and anything else gated on the now-present key)
verify and apply. This is the "genuine value applies once the key is present" case
`upsertUsersEntity`'s own comment already documents for credential changes, applied to the same
purge flow. `rebuildSupportCommand.js`'s disaster-recovery rebuild is untouched — it keeps wiping
keys, correctly, for that caller.

Return value adds `tombstone: {id, entity, version}` and `propagationPending: true` — S3's
return-value honesty requirement. Director-facing UI for this (S3's other half, per-peer erasure
state) is explicitly NOT built here, per the brief.

**S2 — `electron/automerge/projector.js`**: `upsertTombstonesEntity` (modeled on `upsertUsersEntity`)
reads the trust root from the LOCAL `camps.signing_public_key` column only (never the document —
Security F1), verifies signature + monotonic version (`>=`, so a re-applied identical tombstone is
an idempotent no-op; a strictly lower version is refused as stale), and on refusal records an audit
event (`outcome: 'deny'`, matching the existing CHECK-constraint gotcha) plus a `console.error` —
never a silent drop. `tombstones` was inserted into `MODELED_ORDER` immediately after `users` (before
every domain entity), so it always projects before the `campers` denylist check reads it.

The denylist itself is a small table (`TOMBSTONE_DENYLISTED_ENTITIES`) mapping `campers` (by its own
`id`) and `elective_preferences`/`elective_assignments` (by their `camper_id` field) to the
`campers`-tombstone set, read fresh once per `projectAll` pass via a plain `SELECT id FROM
tombstones WHERE entity = ?` (safe to trust without re-verifying, because `upsertTombstonesEntity`
already refused to write any row that failed verification). A denylisted row is skipped during
upsert AND actively `DELETE`d if a prior pass (or a pre-tombstone sync) already projected it — this
is the actual erasure mechanism: the record is never visible again, on any device, from that point
forward, even though its raw fields remain mergeable into the CRDT history (accepted — see the
ADR's "erasure guarantee").

New test file `electron/automerge/tombstoneProjection.test.js` (5 tests): valid tombstone
suppresses+deletes; unsigned/forged tombstone refused (with an audit-event assertion); stale
(lower-version) tombstone refused once a newer one has projected; the two elective_* participant
tables are also suppressed+deleted; no local signing key means the tombstone is skipped
(keep-last-known) and the camper still projects.

**S2 — the inverted known-gap test.** `purgeSupportCommand.test.js`'s "known gap" test is renamed
and inverted: the raw document-level fact is UNCHANGED and still asserted (a stale peer's merge
does put the camper's flat fields back into the document — Automerge has no op-level delete, this
is the accepted logical-not-physical-erasure tradeoff), but a new second half now `projectAll`s the
merged document and asserts the camper is refused — never appears in SQLite. This is the ticket's
core success predicate, closing T202's documented gap.

Every other existing purge test needed an `installHostKey` fixture helper added (purge is now
Host-only) and one test (`round 2 FIX2`) had its assertion inverted from "signing key wiped" to
"signing key preserved," since key preservation is now the intended, tested behavior superseding
that prior collateral note. A new test confirms the Host-only refusal itself (no mutation, no
tombstone, camper untouched on a device with no `host_signing_key`).

**Registry drift caught by existing guards, fixed as they demanded** (no scope creep — these are the
project's own "a new entity needs a decision everywhere" tripwires, working as designed):
`electron/ops/projectionsEntityParity.test.js`'s `NON_CAMP_SCOPED_PROJECTIONS` (tombstones names no
camp, same reasoning as `users`) and `electron/ops/restore.js`'s `RESTORE_DECISIONS` (refused — a
signed permanent denylist entry must never be undoable by an ordinary trash/restore action).

**Deviation from the brief:** none identified. S3's UI (director-facing per-peer erasure state) was
deliberately not built, per the brief's own instruction that only the return-value honesty half of
S3 is in scope here.

**Verification run (raw, this session):**
- `tombstoneSignature.test.js`: 8/8 passed.
- `tombstoneProjection.test.js`: 5/5 passed.
- `purgeSupportCommand.test.js`: 8/8 passed.
- `campDocument.test.js`: 16/16 passed.
- `generalize.test.js`: 13/13 passed.
- `electron/automerge electron/auth electron/ops` full suites: 110 files, 1354/1354 passed.
- `npm run check:governance`: no findings.
- `npm run lint`: 0 errors (26 pre-existing warnings, unrelated to this change).
- `npm run test:integration`: 22/22 libp2p scenarios passed.
