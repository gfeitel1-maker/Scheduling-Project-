---
title: "Source aliases — durable alias memory and the confirmed-alias tier (S1b-core)"
document_type: adr
authority: normative
status: superseded
implementation_state: not-started
date: 2026-08-09
superseded_by: docs/adr/2026-08-09-s1b-host-local-aliases.md
supersedes:
  - docs/adr/2026-08-08-s1b-source-aliases.md
affects:
  - docs/adr/2026-08-08-s1a-import-recognizes-existing-entities.md
  - docs/adr/2026-08-08-reconciliation-plan-as-commit-input.md
  - docs/work/onboarding-reconciliation/MATCH_AND_MERGE_SEMANTICS.md
  - electron/db/schema.sql
  - electron/db/localDb.js
  - electron/ops/projections.js
  - electron/ops/campScopedEntities.js
  - electron/ops/operations.js
  - electron/sync/syncClient.js
  - electron/sync/syncServer.js
  - electron/auth/permissions.js
  - electron/auth/authorize.js
  - electron/main.js
  - src/ingest/buildPlan.js
  - electron/ops/ingest.js
related:
  - docs/adr/2026-08-09-s1b-alias-divergence.md
---

# Source aliases — durable alias memory and the confirmed-alias tier (S1b-core)

**Status: SUPERSEDED (2026-08-09) by [`2026-08-09-s1b-host-local-aliases.md`](./2026-08-09-s1b-host-local-aliases.md)** — the product owner chose the host-local alias approach; this synced-entity design is no longer the plan.

**Status: PROPOSED.** This ADR **supersedes the stub** `2026-08-08-s1b-source-aliases.md`, which parked
the S1b findings for a dedicated design round. It resolves every parked obligation that concerns the
**new synced entity itself** — its schema, its op-log/sync/migration wiring, its write atomicity, its
permission and security posture, and how the confirmed-alias tier goes live in the importer.

The **detection and convergent resolution of alias divergence** (parked obligations O-R2, O-R3, and the
review surface) is genuinely harder and separable; it is designed in the sibling ADR
**`2026-08-09-s1b-alias-divergence.md` (S1b-divergence)** and is a **later slice**. This split is a
deliberate scope recommendation (see §9). S1b-core ships an entity that can be *written* and *read back
convergently on every device*; S1b-divergence adds the read-side conflict that surfaces two admins
disagreeing. S1b-core alone never lets a divergence go unnoticed, because until S1b-divergence lands the
importer's alias tier is gated to fire only on a **single unambiguous** confirmed mapping (§7, §9).

Terminology in this document matches the live code on 2026-08-09 (`CURRENT_SCHEMA_VERSION` is **29**;
S1b takes **v30**), re-confirmed against `schema.sql`, `localDb.js`, `projections.js`,
`campScopedEntities.js`, `operations.js`, `syncClient.js`, `syncServer.js`, `permissions.js`,
`buildPlan.js`, `ingest.js`, and `main.js`.

---

## Context

S1a (accepted) makes re-import *recognize* an entity by exact normalized name, with no schema change.
S1b adds the machinery that lets a director's one-time decision — "yes, the label *Ropes* in this file
means our *Low Ropes* activity" — **survive to the next import on every device**. That memory is a new
synced, projected, op-logged table, `source_aliases`, plus a new **confirmed-alias tier** in the
matching hierarchy (`MATCH_AND_MERGE_SEMANTICS §1`, tier 3: above exact-name, below UUID/source-id).

The parked stub verified — against the code — a set of real hazards that a naive "just add a table"
implementation would hit: client full_sync apply-list drift, migration version-skew, non-atomic
multi-field writes producing phantom rows, FK poisoning of first-pairing sync, an attacker-influenced
`entity_type`, and a silent identity-redirection residual. Each is resolved below.

### Candidate approaches considered

The product owner has already fixed the load-bearing policy (**alias divergence = reviewable conflict,
never LWW**) and the stub recorded the admin-only and plain-TEXT decisions, so the divergence here is
narrow. Two genuinely different *shapes* for the alias write were weighed:

- **A. Field-level alias write (per-field ops through the ordinary `syncClient.write`/`appendOp` path),
  same as every other entity.** *Rejected as the primary write path.* A `source_aliases` row is only
  meaningful once `entity_id` is bound; a multi-field write over `submit_op` is non-atomic
  (`syncClient.js` per-field ops), so a torn write leaves a half-row. The stub's O-R6/O-E3 findings are
  exactly this. Mitigable with a `pending`-until-`entity_id` status (which this ADR adopts as
  defense-in-depth, §2), but the *creation* of an identity mapping is a single director decision, not a
  field edit stream — modeling it as one is the wrong seam.
- **B. Host-serialized atomic confirm-alias committer (chosen).** Alias creation runs through a single
  privileged, host-local committer (`confirmAlias`, §4) — the same architectural shape as `commitPlan`
  (`ingest.js`): one `db.transaction()`, admin-gated at the IPC boundary, host-only. The whole row is
  written and projected atomically; replication is the ordinary op-log broadcast of the resulting ops.
  This directly closes O-R6/O-E3 (no torn write is observable), matches the existing "ingest is
  host-only and admin-only" posture (O-S1), and gives S1b-divergence a single serialization point to
  build convergent resolution on. **Selected.**

Approach B is the smallest responsible shape: it reuses the `commitPlan` committer pattern, the op-log,
the projection registry, and the full_sync snapshot machinery, adding one table and one committer rather
than a new sync primitive.

---

## Decision

### 1. `source_aliases` schema (v30)

A new synced, projected, op-logged, direct-camp-scoped table. DDL (declared in **both** `schema.sql`'s
`CREATE TABLE IF NOT EXISTS` block **and** the v30 migration — see §5):

```sql
CREATE TABLE IF NOT EXISTS source_aliases (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  entity_type TEXT NOT NULL,          -- one of the 6 ingestible types (validated at the write boundary, §8)
  cohort_id TEXT,                     -- populated ONLY for cohort-scoped types (tiers, time_blocks); NULL otherwise
  source_label TEXT NOT NULL,         -- the raw label as it appeared in the imported file
  entity_id TEXT,                     -- plain TEXT, NOT a FK (see below). NULL while status='pending'.
  status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'active' | 'superseded'
  confirmed_by TEXT,                  -- plain TEXT user id, NOT a FK (see below)
  author_user_id TEXT,                -- provenance (O-S3)
  device_id TEXT,                     -- provenance (O-S3)
  superseded_by TEXT,                 -- id of the alias row that replaced this one (divergence resolution, S1b-divergence)
  created_at TEXT NOT NULL,
  updated_at TEXT
);
```

**Scope key.** The logical uniqueness scope is `(camp_id, entity_type, cohort_id, source_label)`,
mirroring the existing cohort-partitioned uniqueness of `tiers`/`time_blocks`
(`UNIQUE(camp_id, cohort_id, name)`) and the camp-wide uniqueness of the other four types. This scope is
**NOT** enforced by a SQL `UNIQUE` index. Two reasons, both load-bearing:

- **`normalizeName` is the real key, not raw `source_label`.** The divergence predicate groups on
  `normalizeName(source_label)` (O-R3); a raw-column `UNIQUE` would disagree (`"Ropes"` vs `"ropes "`),
  exactly the normalize/raw-UNIQUE mismatch S1a §3 already documents for `name`. Enforcing uniqueness in
  SQL would either be on the wrong (raw) key or require a generated normalized column the op-log can't
  populate through `applyProjection`.
- **Divergence is a first-class state, not a constraint violation.** Two admins confirming the same label
  to different entities must produce **two rows that are then reconciled** (S1b-divergence), never a
  `UNIQUE` throw that aborts a peer's op replay (the `schedule_templates` kind-conflict class of bug,
  `projections.js` ~262). The scope key is therefore an **application-level** invariant enforced by the
  `confirmAlias` committer (§4) and the divergence resolver (S1b-divergence), not by the DB.

**`entity_id` and `confirmed_by` are plain `TEXT`, never `REFERENCES` (resolves O-E2).** A real FK on
`confirmed_by REFERENCES users(id)` (or `entity_id`) would poison the **first-pairing full_sync batch**:
`applyFullSync` (`syncClient.js` ~349) inserts domain tables in one FK-ordered transaction with
`foreign_keys = ON`; an alias row referencing a user or entity row not yet inserted (or skipped by a
per-row validator) makes that INSERT throw and rolls back the *entire* snapshot. Plain TEXT means a
dangling `entity_id` is a *data* condition the liveness join detects (O-R3), not a *constraint* that
aborts sync. This mirrors the deliberate no-declared-FK choices already in the schema
(`template_slots.group_id`, `anchor_activities.group_ids`).

**Status lifecycle (resolves O-R6, O-E3):**

- `pending` — row exists but `entity_id` is not yet bound. **`status` deliberately does NOT default to
  `'active'`.** The stub's O-R6 finding: with a `DEFAULT 'active'` and a projection `ensureExists` that
  seeds on first field, a torn multi-field write would leave an `active` row with `NULL entity_id` — a
  phantom the divergence predicate and the importer's alias map would both read as a real (broken)
  mapping. `DEFAULT 'pending'` makes an incomplete row **invisible** to every consumer (§3, §7).
- `active` — `entity_id` is bound and this is the live mapping. Reached only by the atomic committer
  (§4), which writes the whole row and only then sets `active`.
- `superseded` — replaced by a later resolution; retained append-only (never hard-deleted), carrying
  `superseded_by`. This is the append-only supersede/tombstone discipline `MATCH_AND_MERGE_SEMANTICS §7`
  requires; the read/importer paths ignore non-`active` rows.

**Registration.** `source_aliases` is added to `PROJECTIONS` (`projections.js`) with the full field list
and an `ensureExists` following the direct-camp pattern (look up the singleton camp, `INSERT OR IGNORE`
with placeholder). Because the write path is the atomic committer (§4), `ensureExists` is a safety net,
not the primary create. It is also added to `DIRECT_CAMP_ENTITIES` (`campScopedEntities.js`) so the
host's `list()` read path and the first-pairing snapshot both cover it.

> **Write-ordering guard for the projection path.** Even though `confirmAlias` (§4) is the intended
> writer, replayed ops still flow through `applyProjection`. The projection `ensureExists` seeds a row
> with `status='pending'` and NULL `entity_id`; the committer's op sequence writes `camp_id`,
> `entity_type`, `cohort_id`, `source_label`, `entity_id`, provenance, then finally `status='active'`
> **last** — the same kind-first write-ordering contract precedent (`schedule_templates`,
> `projections.js` ~245). A replica therefore only ever sees a fully-formed row become `active`; any
> prefix of the sequence is a `pending` row that every consumer ignores.

### 2. Atomic alias write (resolves O-R6, O-E3)

Alias creation is a **single host-local transaction** (`confirmAlias`, §4). Within it, all field ops for
the new row are appended in the write-ordering above and `status` is flipped to `active` as the final op,
all inside one `db.transaction()`. A crash mid-transaction rolls back every op and every projected field
together (the `commitPlan` guarantee, `ingest.js` ~599). No `active` row with a NULL `entity_id` is ever
observable — locally or, because op replay is seq-ordered, on any replica. `status DEFAULT 'pending'` is
the defense-in-depth backstop if any future non-committer path ever seeds a row.

### 3. Sync / replication wiring (resolves O-R1)

The host already ships `source_aliases` once it is in `DIRECT_CAMP_ENTITIES` (`syncServer.js` ~177
iterates that set). The **client-side apply path is the drift risk** the stub's O-R1 names — it is
hardcoded, not derived. S1b-core adds `source_aliases` to all three client lists in `syncClient.js`:

- `DOMAIN_SNAPSHOT_TABLES` (~32) — inserted **after `cohorts` and `users`** in FK-respecting order. It
  has no declared FK (entity_id/cohort_id are plain TEXT), so ordering is not strictly forced, but it is
  placed after `cohorts` to keep the list's documented "target-after-referent" convention readable.
- `DOMAIN_TABLE_COLUMNS` (~52) — the full column set from §1, matching `schema.sql` authoritatively.
- `isValidDomainSnapshotBatch`/`isValidSnapshotRow` (~97) — covered automatically once the table is in
  `DOMAIN_SNAPSHOT_TABLES`; the existing row validator (`id` non-empty string, no nested objects/booleans)
  is correct for these rows.
- `applyFullSync`'s loop (~364) already iterates `DOMAIN_SNAPSHOT_TABLES`, so no change beyond the list.

**Completion evidence is a CLIENT-SIDE apply test, not merely "it's in `DIRECT_CAMP_ENTITIES`"**: a test
that a joining device, given a full_sync message containing `source_aliases` rows, ends with those rows
in its local table and — critically — that the same device then reads them back through
`listAliasMap` (§7) identically to the host. This is the exact stub instruction for O-R1.

### 4. The `confirmAlias` host-local committer + admin IPC (resolves O-R6, O-S1, and gives S1b-divergence its seam)

A new privileged committer in `electron/ops/` (sibling to `commitPlan`), invoked by a new IPC handler
`shoresh:confirm-alias` in `main.js`, admin-gated (§7 / O-S1). Signature (shape, not code):

```
confirmAlias(db, { camp_id, entity_type, cohort_id, source_label, entity_id, author_user_id, device_id })
```

Behavior, all in one `db.transaction()`:

1. Validate `entity_type` against the fixed six-type allowlist (§8); reject `cohort_id` presence unless
   the type is cohort-scoped.
2. Compute the deterministic row id (see below), append the field ops in write-order, flip to `active`
   last (§1, §2), stamping `confirmed_by`/`author_user_id`/`device_id` provenance (O-S3).
3. Surface, not silently apply, a resolution to a **locked** target (§8 / O-S3).

**Deterministic alias id.** Like `deriveScheduleTemplateId` and the v27 week id, the alias row id is
derived from `(camp_id, entity_type, cohort_id, normalizeName(source_label))` so two devices that both
confirm *the same label to the same entity* converge on one row (idempotent, no fork). Two devices
confirming the same label to **different** entities derive the **same id but different `entity_id`
values** — which is precisely the divergence S1b-divergence detects and resolves; S1b-core records both
attempts append-only and never lets the later one silently overwrite the earlier via LWW (that is why
resolution is not a plain field overwrite — see S1b-divergence).

> Ops emitted by `confirmAlias` carry `source` = NULL/`'human'` (an alias is a human identity decision,
> not import provenance). They are host-local first-party writes through `appendOp`, exactly as
> `commitPlan` writes its field ops.

### 5. Migration v30 + rollback (both-places + fresh-vs-migrated equivalence + version-skew)

Following the **v28 new-table precedent exactly** (`localDb.js` ~1325):

- **Both places.** The `CREATE TABLE IF NOT EXISTS source_aliases` (+ any helper index) is declared in
  `schema.sql` (re-executed every open) **and** in a v30 migration block, gated
  `getSchemaVersion(db) >= 29 && getSchemaVersion(db) < 30` (the `>=` lower bound matches how v28/v29
  gate, so v30 never stamps while v29 is pending). The migration DDL text must be **byte-identical** to
  `schema.sql`'s copy (the `pendingRestores`/`schema_migrations` equivalence discipline, `localDb.js`
  ~1022).
- **Fresh-vs-migrated equivalence.** A test asserts `PRAGMA table_info(source_aliases)` parity between a
  fresh v30 install and a v29→v30 migrated db (the established migration-test pattern). No `ALTER TABLE`
  column-append ordering concern arises because the whole table is new (unlike v29's `operations.source`
  column, which had to append last).
- **No helper index that names a nullable/late column** — the whole table is created at once, so unlike
  the `schedule_templates.kind` index caveat, a covering index (e.g. on
  `(camp_id, entity_type, cohort_id)` to make `listAliasMap`/`listAliasDivergences` cheap) is safe to
  declare in `schema.sql` directly.

**Version-skew (resolves O-R7).** A pre-v30 peer that receives a `source_aliases` op it cannot project
must not silently drop it. `applyProjection` already no-ops an unregistered entity (`projections.js`
~454) **but keeps the op durable in the log** on the client replay path (`applyRemoteOp` inserts the op
first, then projects — `syncClient.js` ~405). So the op survives on disk. The remaining gap the stub
names is that it is **never replayed on upgrade**. Two mechanisms, and this ADR chooses the first:

- **Chosen: version-gate replication of `source_aliases` ops below v30 on the HOST.** The host does not
  broadcast (and `sendMissedOps` does not baseline over) `source_aliases` ops to a peer whose device
  record shows a schema below v30. This is the safer half of the stub's O-R7 disjunction: a pre-v30
  device never receives an op it cannot project, so there is no durable-but-unreplayed op to reprojected,
  and a pre-v30 **host** never broadcasts unprojectable aliases as canonical. Peers receive aliases only
  once upgraded, at which point the ordinary op catch-up (`sendMissedOps`) delivers the full history.
- **Backstop reprojection pass** (the `repairMissingScheduleTemplates` precedent, `localDb.js` ~1426):
  the v30 migration runs a one-time pass that replays any already-durable `source_aliases` ops in the
  local log through `applyProjection` (seq-ordered), so a device that *did* durably log alias ops while
  on v29 (e.g. received before the version-gate shipped) materializes them on upgrade. This is
  belt-and-braces alongside the version-gate.

Together these satisfy "do NOT let alias ops silently vanish on upgrade" without letting a pre-v30 device
broadcast a canonical-but-unprojectable op.

**Down-migration.** A `v30_down` (the `v25_down`/`v24_down` rollback precedent) drops `source_aliases`
and its index and deletes the v30 `schema_migrations` row. Alias ops in the `operations` log are left in
place (append-only log; a re-upgrade's reprojection pass rebuilds the table). Documented as DDL-only,
data-preserving at the op-log level.

### 6. Trash/restore lifecycle (resolves O-E1)

An alias's `entity_id` points at a domain row that can be Trashed (soft-deleted via the `__deleted__`
tombstone op) and restored. Rules:

- **Alias liveness is derived, not stored.** An `active` alias whose `entity_id` no longer names a live
  row (target Trashed) is **dangling** — the divergence/importer predicates already skip it via the
  per-`entity_type` liveness join (O-R3, §7). The alias row is *not* auto-superseded when its target is
  Trashed: a restore should bring the mapping back without a new confirmation.
- **Restore re-activates naturally.** When the target is restored, the liveness join passes again and the
  alias fires again — no stale re-activation risk, because liveness is evaluated at read time against the
  live target, never cached on the alias row.
- **A confirmation to an already-Trashed target** is refused by `confirmAlias` (the target must be live
  at confirm time), consistent with `commitPlan` never binding to a non-live id.

This makes "Trash/restore re-activating a stale alias" a non-event: there is no stored liveness flag to
go stale.

### 7. The confirmed-alias tier goes live in the importer (integration)

`MATCH_AND_MERGE_SEMANTICS §1` tier 3. Integration points:

- **The S2c snapshot gains an `aliases` map.** `buildExistingSnapshot` (the `existing` object
  `ImportScreen`/`commitIngest` build) adds, per entity type, an alias map keyed on
  `normalizeName(source_label)` → `entity_id`, built by `listAliasMap(db, camp_id)` — active,
  live-target, non-diverging aliases only. `buildPlan` consumes it purely (no DB): a source label with no
  exact-name match but a **single unambiguous** confirmed alias resolves to that `entity_id` with
  `evidence.tier: 'confirmed_alias'`, ranked **above exact-name, below uuid** (`buildPlan.js` matching
  block, ~334–390).
- **Alias-vs-exact-name divergence.** Per `MATCH_AND_MERGE_SEMANTICS §1`, a confirmed alias must **not
  silently outrank** an exact-name match to a *different* live entity. When the alias says label→A but an
  exact-name match points at a live entity B, `buildPlan` emits `op:'conflict'`,
  `reason:'alias_divergence'` (the second conflict reason S1b introduces, alongside S1a's
  `ambiguous_identity`) carrying both candidates — surfaced, never auto-picked. Detection of this
  *read-side* conflict, and the cross-device convergent resolution, is **S1b-divergence**; S1b-core wires
  the `reason` and the buildPlan branch and gates `listAliasMap` to return only **unambiguous** aliases
  (a scope key with more than one active live-target mapping is withheld until S1b-divergence resolves
  it), so S1b-core never mis-resolves.
- **The T73 "Remember this" path creates an alias via the admin committer.** Today `resolveConflict`
  (`main.js` ~674) writes a field op to pick a conflict side. The alias-creating variant — a director
  resolving an `ambiguous_identity` (S1a) or, later, an `alias_divergence` (S1b-divergence) by choosing
  "remember that this label means entity X" — calls the new admin-gated `shoresh:confirm-alias`
  (§4), NOT a raw field write. This keeps alias creation on the single serialized, admin-only,
  provenance-stamped path.

### 8. Security (resolves O-S1, O-S2, O-S3)

- **O-S1 — ADMIN-ONLY, and `source_aliases` stays OUT of the staff `ENTITIES` matrix.** Adding
  `source_aliases` to `ENTITIES` (`permissions.js` ~15) would auto-grant staff `read`+`write` via
  `staffReadWrite`. It is deliberately **omitted**, so staff are default-DENIED (identity redirection is
  a director power, consistent with ingest being host-only and admin-only). Two new admin-only actions
  are gated at their IPC boundaries via `authorize()` (they resolve to admin only because
  `PERMISSIONS.admin = ['*']` and they are absent from the staff array):
  `source_aliases.confirm` (the `confirmAlias` committer / `shoresh:confirm-alias`) and
  `source_aliases.resolve_divergence` (S1b-divergence's review path). Because these are new action
  strings not derived from `<entity>.write`, they never leak to staff. **Read** of aliases for the
  importer runs host-local inside the already-admin-gated ingest/preview path, so no `source_aliases.read`
  is granted to staff either.
- **O-S2 — `entity_type` allowlist + static SQL.** `entity_type` and `source_label` are
  attacker-influenced (they come from the imported file). `entity_type` is validated against the fixed
  six-type allowlist (`INGESTIBLE_ENTITIES`) at the `confirmAlias` boundary — the `validateBulkReplaceRows`
  precedent (`operations.js` ~257) — before any DB access. `listAliasMap`, `listAliasDivergences`, and
  the resolver use **static SQL** with `entity_type` bound as a **value only**, never interpolated as an
  identifier; per-type target-liveness lookups (`SELECT 1 FROM <table> WHERE id = ?`) go through a
  **fixed table map** (`entity_type` → table name from a frozen object), never string-built from the
  input. There is **no CHECK constraint** on the column today and none is added (a CHECK would reject a
  future-type op replicated from a newer peer, the same NOT-NULL-vs-replication trap v29's comment
  names); validation lives at the write boundary instead.
- **O-S3 — locked target + provenance.** A confirmed-alias resolution whose target has `is_locked`
  set (`activities.is_locked`, `schema.sql` ~220) is **surfaced for confirmation, not auto-applied** —
  both at confirm time (`confirmAlias` refuses to silently bind to a locked entity; the director must
  confirm) and at import time (an alias firing onto a locked entity is shown, echoing the "shown each
  time" rule of `MATCH_AND_MERGE_SEMANTICS §1`, but now as a *gate*, not just a UI control). Every alias
  row carries `author_user_id` + `device_id` + `confirmed_by` provenance for attributability. The
  S2-added `update` arm inherits the same importer resolver, so this guard holds there too.

### 9. Recommended decomposition (scope / split)

S1b is large — a new synced entity, a new committer, a migration, a matching-tier change, and a
cross-device consistency model. The Architect recommendation is to **ship it as two sequenced slices**,
each bounded and independently testable:

- **S1b-core (this ADR)** — the `source_aliases` entity, v30 migration + rollback, sync wiring (O-R1,
  O-R7), the atomic `confirmAlias` committer (O-R6, O-E3), Trash/restore lifecycle (O-E1), permissions
  and security (O-S1, O-S2, O-S3), and the `confirmed_alias` matching tier **gated to fire only on an
  unambiguous mapping**. Ships a feature that works end-to-end for the common case (one director, one
  device, or multiple devices that agree): a remembered mapping survives to the next import everywhere.
  `listAliasMap` withholding any diverging scope is what makes this safe to ship *before* divergence
  resolution — a disagreement simply doesn't fire the tier, it never mis-resolves.
- **S1b-divergence (`2026-08-09-s1b-alias-divergence.md`)** — the shared `listAliasDivergences` predicate
  (O-R3), the convergent host-serialized `resolveAliasDivergence` (O-R2), and the review surface. Adds
  the ability for two admins to safely disagree and converge.

Why split rather than one slice: the two halves have different risk profiles and different review needs.
S1b-core is schema + wiring + input-security — verifiable with migration-equivalence and client-apply
tests. S1b-divergence is a **distributed-consistency** design whose correctness rests on a two-device
convergence test and the host-serialization invariant — a different, harder verification that benefits
from landing on a stable, already-reviewed entity rather than being reviewed simultaneously with the
schema. The gating of `listAliasMap` to unambiguous scopes is the seam that makes the split safe rather
than a half-feature. If Governor prefers a single slice, the two ADRs still stand as the design; only the
ticket sequencing changes.

---

## Files / modules affected

- **New:** `electron/ops/confirmAlias.js` (the committer); `electron/db/rollback/v30_down.js`.
- **`electron/db/schema.sql`** — `CREATE TABLE IF NOT EXISTS source_aliases` + covering index.
- **`electron/db/localDb.js`** — bump `CURRENT_SCHEMA_VERSION` to 30; v30 migration block (both-places
  DDL, reprojection backstop); v30 down.
- **`electron/ops/projections.js`** — `source_aliases` PROJECTIONS entry (fields + write-ordered
  `ensureExists`).
- **`electron/ops/campScopedEntities.js`** — add `source_aliases` to `DIRECT_CAMP_ENTITIES`.
- **`electron/sync/syncClient.js`** — add to `DOMAIN_SNAPSHOT_TABLES`, `DOMAIN_TABLE_COLUMNS`.
- **`electron/sync/syncServer.js`** — version-gate `source_aliases` op broadcast / `sendMissedOps`
  baseline below v30.
- **`electron/auth/permissions.js` + `authorize.js`** — new admin-only actions `source_aliases.confirm`,
  `source_aliases.resolve_divergence`; `source_aliases` stays OUT of `ENTITIES`.
- **`electron/main.js`** — `shoresh:confirm-alias` IPC handler (admin-gated); the T73 "Remember this"
  path routes here.
- **`src/ingest/buildPlan.js`** — the `confirmed_alias` tier + `alias_divergence` conflict branch.
- **`electron/ops/ingest.js`** — `buildExistingSnapshot` gains the `aliases` map via `listAliasMap`.

## Reused vs. new

- **Reused:** the `commitPlan` single-committer pattern; the op-log (`appendOp`); `PROJECTIONS`/
  `applyProjection`; `DIRECT_CAMP_ENTITIES` snapshot machinery; the v28 both-places new-table migration
  pattern; the `repairMissingScheduleTemplates` reprojection precedent; `v25_down` rollback precedent;
  the `validateBulkReplaceRows` input-allowlist precedent; the `authorize()` admin-only-by-omission
  pattern; `deriveScheduleTemplateId` deterministic-id precedent; `normalizeName`.
- **New:** the `source_aliases` table; the `confirmAlias` committer; two admin action strings; the
  `confirmed_alias` matching tier and `alias_divergence` conflict reason (branch only in S1b-core;
  detection/resolution in S1b-divergence). Nothing existing covers a durable, synced,
  human-confirmed identity crosswalk — `detectConflict` is per-`(entity,entity_id,field)` and cannot
  express it (`MATCH_AND_MERGE_SEMANTICS §7`, re-confirmed at `operations.js` ~471).

---

## ADR required: yes

This introduces a new persistent, synced data shape (`source_aliases`) other code depends on, changes
the importer's matching contract (a new tier + conflict reason), and requires a migration/rollback — all
three ADR-bar triggers. Filed here; the divergence-resolution consistency model is filed separately in
`2026-08-09-s1b-alias-divergence.md`.

---

## Consequences

- The camp gains a durable, synced memory of the director's identity decisions, replicated to every
  device via the existing full_sync + op-log paths, with no new sync primitive.
- Alias creation is funneled through **one** admin-only, host-serialized committer — the same discipline
  as ingest — which is also the seam S1b-divergence builds convergent resolution on.
- S1b-core is safe to ship before S1b-divergence **because `listAliasMap` withholds any non-unambiguous
  scope key**: until divergence resolution exists, a diverging alias simply does not fire (the label
  falls through to exact-name/new), so no mis-resolution occurs. This is the property that makes the
  split honest rather than a half-feature.
- `source_aliases` introduces a read-side conflict mechanism (`alias_divergence`) layered above the
  field-level `detectConflict`, like `bulk_replace`'s per-scope detection. It must be documented so a
  later reader does not "simplify" it back into `detectConflict`.

---

## Completion evidence

1. **v30 migration.** Fresh-vs-migrated `PRAGMA table_info(source_aliases)` parity test passes; v30 down
   drops the table and its `schema_migrations` row.
2. **Client apply (O-R1).** A joining device given a full_sync with `source_aliases` rows ends with those
   rows locally AND reads them back through `listAliasMap` identically to the host.
3. **Atomic write (O-R6/O-E3).** A test simulating a torn/partial alias write shows no `active`/NULL-
   `entity_id` row is ever observable to `listAliasMap` or the divergence predicate; a completed
   `confirmAlias` yields exactly one `active` row.
4. **Version-skew (O-R7).** A pre-v30 peer is not sent `source_aliases` ops; a device that durably logged
   alias ops on v29 materializes them via the v30 reprojection pass.
5. **Confirmed-alias tier.** A label with a single confirmed alias and no exact-name match resolves
   `evidence.tier:'confirmed_alias'`; a label with a confirmed alias AND a different-entity exact-name
   match emits `reason:'alias_divergence'` (no auto-pick).
6. **Security.** Staff are denied `source_aliases.confirm`/`.resolve_divergence` (admin-only); an invalid
   `entity_type` is rejected at the `confirmAlias` boundary before any DB access; a confirmation to a
   locked target is surfaced, not auto-applied; alias rows carry author/device/confirmed_by provenance.

---

## Open questions for Governor

- **O-Q1 (carried from the stub): per-source scoping.** The camp-scoped key surfaces "Group 1 means
  different things in different files" as a (safe, reviewable) divergence rather than mis-resolving.
  Recommendation unchanged: ship the camp-scoped key, revisit whether per-source disambiguation is needed
  at S7 against a real multi-source corpus. No decision needed now.
- **Slice split (see §9 and the sibling ADR): does Governor accept shipping S1b-core and S1b-divergence
  as two sequenced slices?** This is a product/scope call, recorded here as the Architect's
  recommendation, not baked into the design.
