---
title: "Source aliases and identity resolution (S1b)"
document_type: adr
authority: normative
status: proposed
date: 2026-08-08
supersedes: []
implementation_state: not_started
affects:
  - docs/adr/2026-08-08-s1a-import-recognizes-existing-entities.md
  - docs/adr/2026-08-08-reconciliation-plan-as-commit-input.md
  - docs/work/onboarding-reconciliation/MATCH_AND_MERGE_SEMANTICS.md
  - docs/work/onboarding-reconciliation/RECONCILIATION_PLAN_TYPE.md
  - docs/work/onboarding-reconciliation/IMPLEMENTATION_SEQUENCE.md
  - electron/db/schema.sql
  - electron/db/localDb.js
  - electron/ops/projections.js
  - electron/ops/campScopedEntities.js
  - electron/sync/syncClient.js
  - electron/sync/syncServer.js
  - electron/ops/operations.js
  - electron/auth/permissions.js
  - src/ingest/buildPlan.js
  - electron/ops/ingest.js
---

# Source aliases and identity resolution (S1b)

> **DESIGN NOT YET COMPLETE.** This ADR is a **stub that parks the alias findings for their own
> round**. It records the *direction* (durable alias memory) and enumerates every open design
> obligation that must be resolved **before any S1b production code**. It does **not** yet decide the
> schema, the sync wiring, the divergence-resolution rule, the atomicity contract, or the permission
> matrix. Those are the S1b design agenda below. Do not implement against this document as written.

**Status: PROPOSED (design incomplete).** S1b is the second half of the original S1 design, split out
after adversarial (Red Hat) + Security review found real, code-verified problems in the combined
slice. Its sibling, **S1a (`2026-08-08-s1a-import-recognizes-existing-entities.md`)**, delivers
recognition (exact-name matching at commit, commit-time re-resolution, `ambiguous_identity`) with **no
schema change** and ships independently. S1b adds the machinery that lets a director's one-time "yes,
*Ropes* in this file means our *Low Ropes*" decision **survive to the next import on every device**.

S1b **does** clear the "new persistent data shape" ADR bar (it introduces a new synced, projected,
op-logged `source_aliases` table) and **requires a migration/rollback plan**. That plan — and
everything else below — must be completed and re-reviewed before S1b code begins.

---

## Direction (recorded, not yet designed to completion)

The confirmed direction, carrying forward from the approved 7-agent synthesis and the product-owner
decision of 2026-08-08:

- **Durable alias memory.** A synced `source_aliases` table remembers each confirmed mapping of a
  source label to a Shoresh entity, so recognition survives across imports and devices.
- **A confirmed-alias tier in the matching hierarchy.** Above exact-name, below UUID/source-id: a
  confirmed alias resolves a non-identical label to a known entity. Evaluated with the **same
  `normalizeName` predicate** S1a's recognition uses, so the two layers cannot disagree.
- **Alias divergence is a reviewable conflict, never last-writer-wins** (decision-gate item 3). Two
  devices confirming the same label to different entities is *detected and surfaced*, not silently
  resolved. This is the load-bearing sync policy S1b must implement **and** make convergent (see O2).
- **The alias key mirrors existing scoping.** The working direction is
  `(camp_id, entity_type, cohort_id, source_label)` with `cohort_id` populated only for the two
  cohort-scoped types (`tiers`, `time_blocks`), matching their existing `UNIQUE(camp_id, cohort_id,
  name)`. To be confirmed against the obligations below, not locked here.

---

## S1b design agenda — open obligations to resolve BEFORE code

Each item below is a **verified review finding parked as a design obligation**. None is solved here.
S1b's design round must close every one and pass re-review.

### Sync / replication

- **O-R1 — client-side full_sync apply-list drift.** The host sends `source_aliases` via
  `DIRECT_CAMP_ENTITIES` (`syncServer.js` ~177), but the client applies full_sync through the
  **hardcoded** `DOMAIN_SNAPSHOT_TABLES` (`syncClient.js` ~32), `DOMAIN_TABLE_COLUMNS` (~52), and
  `isValidDomainSnapshotBatch` — none of which mention `source_aliases`. A new client would receive
  **zero aliases**, and `sendMissedOps` baselines the watermark without the history. **Obligation:** add
  `source_aliases` to all three client-side lists, FK-ordered after `cohorts`+`users`, **and** add a
  client-side apply test asserting a joining device receives aliases.

- **O-R7 — migration v28↔v29 skew (the bulk_replace/host_seq bug class).** A v28 device durably logs
  `source_aliases` ops it cannot project (`projections.js` ~452 silent no-op) and never replays them on
  upgrade → empty table, silent alias loss; a v28 **host** broadcasts unprojectable aliases as canonical.
  **Obligation:** either version-gate replication of `source_aliases` ops below v29, or add an
  upgrade-time reprojection pass (the `repairMissingScheduleTemplates` precedent, `projections.js`
  ~273). The migration §must cover *skew*, not merely DDL equivalence. Include the fresh-vs-migrated
  DDL-equivalence obligation (`schema.sql` vs the v29 block, `PRAGMA table_info` parity) as well.

### Divergence — the predicate and its resolution

- **O-R2 — convergent divergence *resolution*, not just detection.** The resolution of a divergence is
  itself an undetected cross-row divergence: two directors superseding different rows can both-supersede
  (alias vanishes, `listAliasDivergences` finds 0 active → no conflict) or create two fresh active rows
  (new divergence). `detectConflict` keys per-row (`operations.js` ~455). **Obligation:** resolution must
  be a host-serialized atomic read-and-supersede that **re-runs divergence detection post-write**, or an
  idempotent winner rule so two independent choices *converge* rather than annihilate. Detection alone is
  not sufficient.

- **O-R3 — a single divergence predicate shared by all consumers.** `buildPlan`'s snapshot keys on
  `normalizeName()` (JS); a SQL `GROUP BY` on raw `source_label` disagrees (`"Ropes"` vs `"ropes "`);
  and a dangling `entity_id` counted by `listAliasDivergences` is ignored by `buildPlan`. **Obligation:**
  implement `listAliasDivergences` in JS, grouping on `normalizeName` **and** a per-`entity_type`
  liveness join — byte-for-byte the same predicate the snapshot builder uses. Test that a `"Ropes"`/`"ropes "`
  pair and an entity-deleted pair agree between both uses.

### Atomicity of the alias write

- **O-R6 — atomic / pending alias writes.** Client alias writes are multi-field, **non-atomic** over
  `submit_op` (per-field ops, `syncClient.js` ~775–801). A torn write leaves an `active` row (`status`
  DEFAULT `'active'`, `ensureExists` seeds on first field) with NULL `entity_id` → phantom divergence /
  null resolution. **Obligation:** `status` must **not** default to `'active'`; the row stays `pending`
  until `entity_id` is written; adopt a write-ordering contract (the `schedule_templates` `kind`-first
  precedent) or a host-serialized atomic confirm-alias op; the divergence predicate **and** the snapshot
  must exclude non-`active` / NULL-`entity_id` rows. Test a torn write.

### Permissions & attacker-influenced input (Security)

- **O-S1 — permission matrix (ADMIN-ONLY, recorded).** `source_aliases` is absent from `ENTITIES`
  (`permissions.js` ~15–29), so staff are default-DENIED read+write — contradicting "a client creates an
  alias." **Governor recommendation, recorded here as the S1b decision to implement:** alias
  **create/resolve = ADMIN-ONLY** (consistent with ingest already being admin-only and host-only —
  identity redirection is a director power). Divergence is still possible across two admin devices. **Do
  NOT silently add `source_aliases` to `ENTITIES`** (that would grant staff read+write). Admin-gate the
  confirm-identity and divergence-review UI. *(Note: this narrows S1a's "a client can create an alias"
  framing — S1b restricts alias writes to admins.)*

- **O-S2 — `entity_type` allowlist + static SQL.** `entity_type` and `source_label` are
  attacker-influenced (they come from the imported file). **Obligation:** validate `entity_type` against
  the fixed six-type allowlist at the alias-write boundary (the `validateBulkReplaceRows` precedent,
  `operations.js` ~251); the divergence query and resolver must use **static SQL** with `entity_type`
  bound as a **value only**, never an interpolated identifier; per-type lookups via a fixed table map.
  No CHECK constraint exists today — add validation.

- **O-S3 — locked-entity + provenance (quiet identity-redirection residual).** A planted alias for a
  label with **no** competing exact-name resolves silently to `entity_Y` as `unchanged` ("shown each
  time" is only a UI control, not a gate). **Obligation:** alias resolution to a **locked** entity
  (`is_locked`) is surfaced for confirmation, not auto-applied; alias writes carry author/device
  provenance (`confirmed_by` + `author_user_id` + `device_id`) for attributability. The `update` arm S2
  adds inherits this resolver, so the guard must hold there too.

### Edge cases to specify

- **O-E1 — Trash/restore lifecycle.** A resurrected (Trash-restored) entity can re-activate a stale
  alias or spawn a divergence. Define the alias lifecycle against the target entity's Trash/restore.
- **O-E2 — `confirmed_by` FK poisoning.** `confirmed_by REFERENCES users(id)` can poison the whole
  first-pairing batch if a user row is skipped in FK order. Make `confirmed_by` **plain TEXT** (like
  `entity_id` is proposed to be), or guarantee user-row ordering.
- **O-E3 — transient divergence during a normal complete write.** Same root cause and fix as O-R6 (the
  pending-until-`entity_id` contract must make a normal in-flight alias write invisible to the predicate).

### Carried-forward open product question

- **O-Q1 — per-source scoping ("Group 1" means different things in different files).** The camp-scoped
  key surfaces such collisions as a (safe, reviewable) divergence rather than silently mis-resolving.
  Whether per-source disambiguation is needed is a product-semantics call best made against a real
  multi-source corpus (S7). Recommendation: ship the camp-scoped key, revisit at S7.

---

## Consequences (of the split, recorded now)

- The camp will gain a durable, synced memory of the director's identity decisions once S1b ships —
  but only after every obligation above is closed and re-reviewed.
- S1b introduces a **second conflict mechanism** (read-side `alias_divergence`, layered above the
  field-level `detectConflict`, the `bulk_replace` precedent). It must be documented so a later reader
  does not "simplify" it back into `detectConflict`.
- S1b restricts alias writes to **admins** (O-S1), narrowing the original S1 framing that a client
  could create an alias.
- Nothing in S1b is required for S1a to ship: S1a adds no table and touches no sync path.
