---
title: "Source aliases — host-local table, no sync (S1b revised)"
document_type: adr
authority: normative
status: accepted
implementation_state: implemented
date: 2026-08-09
supersedes:
  - docs/adr/2026-08-09-s1b-source-aliases.md
  - docs/adr/2026-08-09-s1b-alias-divergence.md
affects:
  - docs/adr/2026-08-08-s1a-import-recognizes-existing-entities.md
  - docs/adr/2026-08-08-reconciliation-plan-as-commit-input.md
  - docs/work/onboarding-reconciliation/MATCH_AND_MERGE_SEMANTICS.md
  - electron/db/schema.sql
  - electron/db/localDb.js
  - electron/ops/ingest.js
  - electron/main.js
  - src/ingest/buildPlan.js
related: []
---

# Source aliases — host-local table, no sync (S1b revised)

**Status: PROPOSED.** This ADR **supersedes both** prior S1b ADRs — `2026-08-09-s1b-source-aliases.md`
(S1b-core, the synced-entity design) and `2026-08-09-s1b-alias-divergence.md` (S1b-divergence, the
cross-device convergence design). The product owner chose the **host-local alias** approach on
2026-08-09: `source_aliases` is a **host-local table, never replicated**, following the existing
`host_signing_key` precedent (`schema.sql` ~90–101, `localDb.js` ~730–772 — "Host-only singleton. NEVER
included in any full-sync ... never sent over the wire").

This decision is possible only because import is **already host-only and admin-only**: `commitPlan`
(`electron/ops/ingest.js`) only ever runs on the host device, gated by the `groups.import` admin action
at the IPC boundary (`main.js` ~254 equivalent). Aliases are therefore created and read **only on the
host** — no client ever writes or reads a `source_aliases` row. This makes cross-device alias divergence
**structurally impossible**, not merely detected-and-resolved. There is only ever one writer, one reader,
one copy.

## Why this reverses the prior two ADRs

The superseded S1b-core ADR made `source_aliases` a synced, projected, op-logged entity specifically to
let the alias survive to "every device." The superseded S1b-divergence ADR then had to build an entire
convergent-resolution protocol (`listAliasDivergences`, host-serialized `resolveAliasDivergence`, a
canonical-row total order, a re-check-inside-transaction invariant, a review surface) because syncing a
human-confirmed identity mapping across devices creates the possibility that two admins, on two devices,
confirm the same label to two different entities before either write reaches the other.

That possibility does not exist if the table never leaves the host. Since import itself never runs
off-host, there is no second device that could ever independently confirm a conflicting mapping — the
entire divergence machinery was solving a problem that a host-local table doesn't have. Dropped
entirely:

- `listAliasDivergences` — no predicate needed; there is nothing to group across devices.
- `resolveAliasDivergence` — no resolution protocol; single-writer means the second confirm simply
  supersedes the first, in-process, no serialization race to guard.
- The version-gated replication guard (`syncServer.js` broadcast gating below v30) — nothing is
  broadcast.
- `DIRECT_CAMP_ENTITIES` / `PROJECTIONS` registration for sync purposes — the table is not a projected,
  op-logged, synced entity at all; it is read and written by direct SQL inside host-only committers, the
  same way `host_signing_key` is read/written directly in `localAuth.js`, not through `appendOp`.
- The client-side apply/full_sync wiring in `syncClient.js` (`DOMAIN_SNAPSHOT_TABLES`,
  `DOMAIN_TABLE_COLUMNS`, `isValidSnapshotRow` coverage) — no client ever receives these rows.
- The canonical-row deterministic-id / total-order tiebreak machinery — needed only to make two
  independent writers converge; there is one writer.
- The review-card IPC pair (`shoresh:list-alias-divergences`, `shoresh:resolve-alias-divergence`) and the
  divergence-specific conflict reason `alias_divergence` **as a cross-device concern** — see item 4 below
  for the one place a similar-shaped conflict still legitimately appears (a single-host race between
  preview and commit, not a cross-device disagreement).

This dissolves the review findings that drove the prior design: **R2-CRIT, R2-XPORT, R2-SKEW, R2-REFORK,
R2-SNAPSHOT, and R1** were all about replication correctness (sync wiring drift, migration/version skew
across replicas, fork/annihilate races between two writers, snapshot inclusion). None of them can occur
when there is no replica and no second writer. They are not "resolved" by a mitigation — they no longer
have a referent.

### Candidate approaches considered

This is a closed case given the product owner's decision — the divergence was already run for S1b twice
(see the superseded ADRs' own `adhd` sections). The only remaining technical question is the shape of the
host-local table, which has one direct precedent (`host_signing_key`) and no genuine alternative worth
weighing: a host-local KV blob was briefly considered and rejected because the alias data is naturally
relational (queried by `entity_type`/`cohort_id`/`source_label`, joined against live entities for
liveness) — the same reasoning that made every other domain table a SQL table rather than a JSON blob in
this codebase.

---

## Decision

### 1. Schema — `source_aliases`, host-local, v30

```sql
-- Host-only table, like host_signing_key. NEVER included in any full-sync
-- SELECT/payload, NEVER sent over the wire, NEVER added to DIRECT_CAMP_ENTITIES
-- or PROJECTIONS. Import (and therefore alias confirmation) only ever runs on
-- the host device, admin-gated — see electron/ops/ingest.js, main.js.
CREATE TABLE IF NOT EXISTS source_aliases (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  entity_type TEXT NOT NULL,     -- one of the 6 ingestible types, validated at the write boundary (§3)
  cohort_id TEXT,                -- populated ONLY for cohort-scoped types (tiers, time_blocks); NULL otherwise
  source_label TEXT NOT NULL,    -- the raw label as it appeared in the imported file
  entity_id TEXT NOT NULL,       -- plain TEXT, not a FK (entity_type varies; no single-table target)
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'superseded'
  confirmed_by TEXT,             -- plain TEXT user id, provenance only
  confirmed_at TEXT NOT NULL,
  superseded_by TEXT             -- id of the alias row that replaced this one, when status='superseded'
);

CREATE INDEX IF NOT EXISTS idx_source_aliases_lookup
  ON source_aliases (camp_id, entity_type, cohort_id);
```

Declared in **both** `schema.sql`'s `CREATE TABLE IF NOT EXISTS` block (placed near `host_signing_key`,
with the same "host-local, never synced" header comment) **and** the v30 migration in `localDb.js`,
following the v28 both-places new-table precedent exactly (`localDb.js` ~1325, gated
`getSchemaVersion(db) >= 29 && getSchemaVersion(db) < 30`). `CURRENT_SCHEMA_VERSION` bumps from 29 to 30.

**No FK on `entity_id`.** `entity_type` names which of six tables it points into; there is no single
table to reference, so `entity_id` stays plain TEXT, matching the schema's existing pattern for
polymorphic references (`template_slots.group_id`, `anchor_activities.group_ids`).

**`status` defaults to `'active'`, not `'pending'`.** The prior design's `pending` status existed to
guard against a torn multi-field op-log write (a partial row visible mid-replication). That hazard does
not exist here: the row is written by a single `INSERT` inside one `db.transaction()` in the confirm
committer (§2) — either the whole row exists or none of it does. No op-log, no field-by-field write
sequence, no partial-write window.

**Scope / uniqueness key.** The logical key is `(camp_id, entity_type, cohort_id, normalizeName(source_label))`
among `status='active'` rows — mirroring the cohort-partitioned scoping of `tiers`/`time_blocks` and the
camp-wide scoping of the other four types. This is enforced by the confirm committer (§2), not by a SQL
`UNIQUE` index, for the same reason as before: `normalizeName` is the real key, not the raw column, and a
raw-column `UNIQUE` would disagree on whitespace/case variants. Because there is a single writer, the
committer can safely read-then-write inside its own transaction without a concurrent-writer race to guard
against — this is the one piece of complexity the host-local model actually removes rather than just
relocates.

**Re-confirmation supersedes, append-only.** If a director confirms the same label to a *different*
target than a prior active row, the committer marks the old row `status='superseded'`,
`superseded_by = <new row id>`, and inserts a new `active` row with a fresh id. History is retained
(never hard-deleted, never overwritten in place) — this is reversible: the audit trail of "what did we
used to think this label meant" survives, and a director can be shown that history if they ask "why did
this change." Because there is one writer, this is a plain sequential operation, not a convergence
protocol — there is no second writer to race against, so no canonical-row total order or re-check
invariant is needed.

### 2. The `confirmAlias` host-local, admin-gated committer

A new function in `electron/ops/` (sibling to `commitPlan`), invoked by a new IPC handler
`shoresh:confirm-alias` in `main.js`. Signature (shape, not code):

```
confirmAlias(db, { camp_id, entity_type, cohort_id, source_label, entity_id, confirmed_by })
```

Behavior, in one `db.transaction()`:

1. Validate `entity_type` against the fixed six-type `INGESTIBLE_ENTITIES` allowlist (§3) before any DB
   access — reject `cohort_id` presence unless the type is cohort-scoped.
2. Verify the target `entity_id` names a **live** row of that type (`idExists`, the same helper
   `ingest.js` already uses ~397) — refuse to confirm onto a Trashed or nonexistent target.
3. If the target has `is_locked` set, surface for confirmation rather than auto-applying (§6).
4. Read the current active row (if any) for the scope key; if one exists and points at a different
   `entity_id`, mark it `superseded` and set `superseded_by` to the new row's id.
5. Insert the new `active` row, stamped `confirmed_by`/`confirmed_at`.

This mirrors `commitPlan`'s architectural shape (one `db.transaction()`, admin-gated at the IPC
boundary, host-only) without the op-log: there is no `appendOp` call here, because this table is never
replicated and never needs replay. It is a direct, transactional SQL write — the same pattern
`localAuth.js`'s `ensureHostSigningKey` uses for `host_signing_key`.

**IPC gate.** `shoresh:confirm-alias` is authorized via a new admin-only action string
`source_aliases.confirm` (`authorize()`, `permissions.js`/`authorize.js`), following the existing
"admin-only by omission from the staff `ENTITIES` matrix" pattern (`permissions.js` ~15). It is not
derived from `<entity>.write`, so it never leaks to staff by default. There is no `.resolve_divergence`
action — nothing to resolve.

**The generic op-log write path refuses this entity.** `write()`/`submit_op` (`operations.js`) must
reject any op with `entity === 'source_aliases'` — the same "typed committer only, never a raw field-op
entity" treatment `bulk_replace` already gets (`operations.js` ~194: "not listed here is rejected by
validateBulkReplaceRows"). Since `source_aliases` is never registered in `PROJECTIONS` or
`DIRECT_CAMP_ENTITIES`, a raw field op against it has no projection to apply anyway; the explicit refusal
makes the boundary a clear error instead of a silent no-op.

**T73 "Remember this."** The `resolveConflict` path in `main.js` (~674) that lets a director resolve an
`ambiguous_identity` (S1a) conflict by choosing "remember that this label means entity X" calls
`confirmAlias` directly (an in-process function call, not IPC-to-self, since both run on the host) rather
than writing a field op. This is unchanged in spirit from the superseded ADR — only the underlying write
target changed from a synced entity to a host-local table.

### 3. Security — entity_type allowlist, static SQL, fail-closed

`entity_type` and `source_label` are attacker-influenced (sourced from the imported file). `entity_type`
is validated against the frozen six-type `INGESTIBLE_ENTITIES` allowlist at the `confirmAlias` boundary —
the `validateBulkReplaceRows` precedent (`operations.js` ~257) — before any DB access.

Every read (`listAliasMap`, below) uses **static SQL** with `entity_type` bound as a value only, never
interpolated as an identifier. Per-type liveness lookups go through a **fixed table map**
(`entity_type` → table name, a frozen object), never string-built from input. A row whose `entity_type`
does not appear in the fixed map is **skipped per-row** when read — it never reaches an identifier slot,
and it never aborts the read for the rest of the map. There is no CHECK constraint on the column (a CHECK
would reject a row from a future type added by a later version — not a replication concern here since the
table isn't synced, but the validate-at-boundary-not-at-schema discipline is kept consistent with the
rest of the codebase).

### 4. The confirmed-alias tier in `buildPlan` (still pure)

`MATCH_AND_MERGE_SEMANTICS §1` tier 3, unchanged in intent from the superseded ADR: a source label with no
exact-name match but a confirmed alias resolves to that `entity_id`, ranked **above exact-name, below
uuid** (`buildPlan.js` matching block, ~334–390). `buildPlan` itself stays pure — no DB access — by
reading the alias map out of the snapshot object, exactly as it reads the existing recognition maps.

**The alias map is a host-local read.** `buildExistingSnapshot` (`ingest.js`) gains a `listAliasMap(db,
camp_id, cohort_id)` call that loads `active` rows from `source_aliases`, filters to **live** targets only
(a Trashed target is dropped — the alias does not resolve to a dead row; restoring the target later makes
it resolve again, since liveness is evaluated at read time, never cached), and returns a map keyed on
`normalizeName(source_label)` → `entity_id`, scoped by `entity_type`/`cohort_id`. Because import only ever
runs host-side, this read never needs to cross an IPC boundary into "renderer reads a synced table" — it
is called from inside the same host-only ingest code path that already builds the rest of the snapshot.
If the renderer's import-preview screen needs to display the resolved alias (not just consume it inside
`buildPlan`), it goes through the existing host-only ingest/preview IPC round-trip, not a new synced read
path.

**Alias-vs-exact-name divergence within a single host is still a real (much narrower) case.** Even with
no cross-device concern, a single preview→commit window can see the world change: the alias map says
label→A, but a same-label live entity B now exists that didn't when the alias was confirmed (or an
exact-name match resolves to B). Per `MATCH_AND_MERGE_SEMANTICS §1`, the alias must not silently outrank a
live, different-entity exact-name match. `buildPlan` emits `op:'conflict'`, `reason:'alias_divergence'`
carrying both candidates (A from alias, B from exact-name) — surfaced, never auto-picked. This is **not**
the cross-device divergence the superseded ADR built a whole protocol around; it is the same
single-host, single-writer "the world changed between preview and commit" case `ingest.js` already
handles for `ambiguous_identity` (~397, "A peer created this same-name entity... or the camp holds two
rows... Either way the world changed under the plan"). It needs only the same treatment: add
`alias_divergence` to the accepted-conflict-reason allowlist in `commitPlan` (`ingest.js` ~736, which
currently throws on an unrecognized reason) so it goes **held**, never throws.

**Commit-time re-resolution (the preview→commit window).** The confirmed-alias tier's resolution needs
the same commit-time liveness re-check the exact-name tier already gets: if the alias's target became
Trashed between preview and commit, `commitPlan` must hold it as a conflict (`missing_target`-shaped),
never write to a dead row. This reuses the existing `idExists` check already in `commitPlan`'s
`unchanged` case (~397) — the confirmed-alias resolution is threaded through the same gate.

### 5. Trash/restore lifecycle

An alias's `entity_id` may point at a row that gets Trashed and later restored. Liveness is **derived at
read time**, never stored on the alias row: `listAliasMap` (§4) already filters to live targets, so a
Trashed target simply makes the alias not fire (falls through to exact-name/new); a restore makes it fire
again automatically, with no re-confirmation needed and no stale-flag risk, because there is no cached
flag to go stale.

### 6. Locked-target guard

A `confirmAlias` call whose target has `activities.is_locked` set is surfaced for confirmation, not
auto-applied — both at confirm time (the committer refuses to silently bind) and at import time (an alias
firing onto a locked entity is shown to the director, not silently applied), matching the "shown every
time" rule in `MATCH_AND_MERGE_SEMANTICS §1`.

### 7. Migration v30 and rollback

Following the v28 both-places precedent (`localDb.js` ~1325):

- **Both places.** `CREATE TABLE IF NOT EXISTS source_aliases` (+ its index) declared in `schema.sql`
  (re-executed every open, alongside `host_signing_key`) **and** in a v30 migration block gated
  `getSchemaVersion(db) >= 29 && getSchemaVersion(db) < 30`. DDL text byte-identical between the two.
- **Fresh-vs-migrated parity test.** `PRAGMA table_info(source_aliases)` must match between a fresh v30
  install and a v29→v30 migrated db.
- **No version-skew concern.** Because the table is never replicated, a pre-v30 peer never receives a
  `source_aliases` op (there are no ops for this table at all) — the entire version-gated-broadcast
  mechanism the superseded ADR needed (O-R7) has no referent. A pre-v30 host simply doesn't have the
  table or the confirm-alias feature until it upgrades; that is an ordinary local-only feature gate, not a
  sync hazard.
- **Rollback.** `v30_down` drops `source_aliases` and its index and removes the v30 `schema_migrations`
  row — the `v25_down`/`v24_down` precedent. Nothing else references this table (no FK from another
  table, no op-log entries), so the rollback is complete and self-contained: revert = revert.

---

## Files / modules affected

- **New:** `electron/ops/confirmAlias.js` (the committer); `electron/db/rollback/v30_down.js`.
- **`electron/db/schema.sql`** — `CREATE TABLE IF NOT EXISTS source_aliases` + index, host-local header
  comment alongside `host_signing_key`.
- **`electron/db/localDb.js`** — bump `CURRENT_SCHEMA_VERSION` to 30; v30 migration block (both-places
  DDL); v30 down.
- **`electron/ops/operations.js`** — `write()`/`submit_op` refuses `entity === 'source_aliases'`.
- **`electron/auth/permissions.js` + `authorize.js`** — new admin-only action `source_aliases.confirm`;
  `source_aliases` stays OUT of `ENTITIES` and out of `DIRECT_CAMP_ENTITIES`/`PROJECTIONS`.
- **`electron/main.js`** — `shoresh:confirm-alias` IPC handler (admin-gated); T73 "Remember this" routes
  here.
- **`src/ingest/buildPlan.js`** — `confirmed_alias` tier + `alias_divergence` conflict branch (pure,
  reads the snapshot's alias map).
- **`electron/ops/ingest.js`** — `buildExistingSnapshot` gains the alias map via a host-local
  `listAliasMap`; `commitPlan` accepts `alias_divergence` in its conflict-reason allowlist (~736) and
  gives the alias resolution the same commit-time liveness re-check the exact-name tier gets.

**Explicitly NOT touched (dropped from the superseded design):** `electron/ops/projections.js`,
`electron/ops/campScopedEntities.js`, `electron/sync/syncClient.js`, `electron/sync/syncServer.js` — no
projection entry, no `DIRECT_CAMP_ENTITIES` registration, no client snapshot/apply wiring, no broadcast
gating. No new file for divergence detection/resolution (`listAliasDivergences`,
`resolveAliasDivergence` do not exist in this design).

## Reused vs. new

- **Reused:** the `host_signing_key` host-local-table precedent (schema placement, header comment
  convention, direct-SQL read/write instead of op-log); the `commitPlan`/`ensureHostSigningKey`
  transactional-write pattern; the v28 both-places migration pattern; the `v25_down` rollback precedent;
  the `validateBulkReplaceRows` input-allowlist precedent; the `authorize()` admin-only-by-omission
  pattern; `normalizeName`; `idExists`; the existing `ambiguous_identity`/held-conflict machinery in
  `commitPlan` that `alias_divergence` now piggybacks on for the single-host preview→commit case.
- **New:** the `source_aliases` table; the `confirmAlias` committer; one admin action string
  (`source_aliases.confirm`); the `confirmed_alias` matching tier and the narrowed single-host
  `alias_divergence` conflict reason.
- **Dropped (was new in the superseded design, not carried forward):** op-log wiring for
  `source_aliases`, `PROJECTIONS`/`DIRECT_CAMP_ENTITIES` registration, client sync/apply wiring, version-
  gated broadcast, `listAliasDivergences`, `resolveAliasDivergence`, the canonical-row deterministic-id
  total order, the divergence review IPC pair and card data contract, `source_aliases.resolve_divergence`.

---

## ADR required: yes

This introduces a new persistent data shape (`source_aliases`) that other code (the importer, T73's
"Remember this" path) will depend on, and it makes a not-obviously-reversible tradeoff (host-local,
never-synced vs. the previously-designed synced-and-convergent model) — both ADR-bar triggers per the
constitution. Filed here, as a single ADR, replacing the two it supersedes.

---

## Consequences

- Cross-device alias divergence is **structurally impossible**, not detected-and-resolved: there is one
  writer (the host) and one copy (the host's local DB). This is a stronger and simpler guarantee than the
  superseded design's convergent-resolution protocol.
- The entire divergence-detection/resolution surface (predicate, resolver, review card, canonical-row
  ordering) is dropped — not deferred, not simplified, gone. A later reader must not try to "re-add sync"
  to this table without re-opening this ADR: if `source_aliases` is ever synced, the fork/annihilate
  hazards the superseded ADR solved for come back and need that machinery again.
- Aliases are tied to the host device's database. If the host device is lost or reset without a backup,
  confirmed aliases are lost (directors would re-confirm on next import) — this is the same exposure
  `host_signing_key` already has, and is judged acceptable on the same basis (host loss is already a
  bigger event than losing alias memory).
- The `alias_divergence` conflict reason survives in a narrower form: a same-host preview→commit race, not
  a cross-device one. It is folded into `commitPlan`'s existing held-conflict allowlist rather than
  needing a dedicated resolution protocol.

---

## Completion evidence

1. **v30 migration.** Fresh-vs-migrated `PRAGMA table_info(source_aliases)` parity test passes; v30 down
   drops the table and its `schema_migrations` row.
2. **Never synced.** A test/assertion that `source_aliases` is absent from `PROJECTIONS`,
   `DIRECT_CAMP_ENTITIES`, `DOMAIN_SNAPSHOT_TABLES`, and any full_sync payload — i.e., a client that joins
   fresh never receives these rows.
3. **Single-writer transactional write.** `confirmAlias` produces exactly one `active` row per scope after
   a confirm; a re-confirm to a different target supersedes the prior row and inserts a new one, both
   inside one transaction; no partial row is ever observable.
4. **Confirmed-alias tier.** A label with a single confirmed alias and no exact-name match resolves
   `evidence.tier:'confirmed_alias'`; a label with a confirmed alias AND a different-entity exact-name
   match emits `reason:'alias_divergence'`, held not thrown, via `commitPlan`'s allowlist.
5. **Security.** Staff are denied `source_aliases.confirm` (admin-only); an invalid `entity_type` is
   rejected at the `confirmAlias` boundary before any DB access; a confirmation to a locked or non-live
   target is refused/surfaced, not auto-applied; the generic `write()` path rejects
   `entity==='source_aliases'`.
6. **Trash/restore.** An alias whose target is Trashed does not fire (falls through); restoring the target
   makes it fire again with no re-confirmation.

---

## Open questions for Governor

- **O-Q1 (carried forward unchanged): per-source scoping.** The camp-scoped key surfaces "Group 1 means
  different things in different files" as a (safe, reviewable) same-host conflict rather than
  mis-resolving. Recommendation unchanged: ship the camp-scoped key, revisit whether per-source
  disambiguation is needed at S7 against a real multi-source corpus. No decision needed now.
- No slice-split question remains — the host-local design is small enough to ship as one slice (no
  separate "-divergence" ADR is needed or produced).
