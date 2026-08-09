---
title: "Alias divergence — one predicate, convergent resolution (S1b-divergence)"
document_type: adr
authority: normative
status: superseded
implementation_state: not-started
date: 2026-08-09
superseded_by: docs/adr/2026-08-09-s1b-host-local-aliases.md
supersedes: []
depends_on:
  - docs/adr/2026-08-09-s1b-source-aliases.md
affects:
  - docs/adr/2026-08-08-s1a-import-recognizes-existing-entities.md
  - docs/work/onboarding-reconciliation/MATCH_AND_MERGE_SEMANTICS.md
  - electron/ops/operations.js
  - electron/ops/confirmAlias.js
  - electron/sync/syncServer.js
  - src/ingest/buildPlan.js
  - electron/ops/ingest.js
  - electron/main.js
---

# Alias divergence — one predicate, convergent resolution (S1b-divergence)

**Status: SUPERSEDED (2026-08-09) by [`2026-08-09-s1b-host-local-aliases.md`](./2026-08-09-s1b-host-local-aliases.md)** — `source_aliases` is now host-local and never replicated, so cross-device divergence is structurally impossible and this entire resolution protocol is dropped.

**Status: PROPOSED.** This is the second, harder S1b slice. It depends on **S1b-core**
(`2026-08-09-s1b-source-aliases.md`), which delivers the `source_aliases` entity, the atomic
`confirmAlias` committer, and the `confirmed_alias` matching tier gated to fire only on an *unambiguous*
mapping. S1b-divergence adds what makes divergence **reviewable and convergent** rather than merely
possible: the single shared divergence predicate (O-R3) and a cross-device resolution that **converges**
instead of annihilating or re-forking (O-R2).

The product-owner decision this slice implements: **alias divergence is a reviewable conflict, never
last-writer-wins.** `detectConflict` (`operations.js` ~471) keys on `(entity, entity_id, field)` and
provably cannot catch it — two divergent confirmations are writes to different `entity_id` values on the
same alias scope, so they never collide there (`MATCH_AND_MERGE_SEMANTICS §7`, re-confirmed 2026-08-09).
Divergence detection is therefore its **own** read-side policy, layered above `detectConflict`.

### Candidate approaches considered

The genuinely open design question this ADR owns is O-R2: **how do two directors, each resolving the
same divergence on a different device, converge?** The naive "each supersedes the row they don't want"
fails two ways the stub verified: both-supersede (both rows end `superseded`, `listAliasDivergences`
finds zero active → the mapping silently vanishes) or two-fresh-active (each writes a new active row →
a brand-new divergence). Three candidates:

- **A. Detection only, resolve by superseding the losing row (the naive path).** *Rejected — this is the
  O-R2 bug.* Per-row supersede under a per-row `detectConflict` model does not serialize; concurrent
  resolutions annihilate or re-fork. Detection alone is insufficient, exactly as the stub states.
- **B. Host-serialized atomic read-and-supersede with post-write re-check (chosen).** Resolution is a
  single host-local transaction on the canonical (host) DB: read all active rows for the scope, write
  the chosen mapping onto **one canonical row** and mark the others `superseded_by` it, then **re-run
  divergence detection inside the same transaction**. Because it runs only on the host, two resolutions
  serialize (the second sees the first's result and is idempotent — it finds the scope already
  converged). **Selected.**
- **C. Idempotent winner rule (canonical row + derived supersession, no serialization).** Define a total
  order on candidate mappings (e.g. lowest `entity_id` UUID, or earliest `created_at` with id tiebreak);
  every device independently derives the same winner, supersession is a pure function of the row set, so
  two devices reach the same state without a host round-trip. *Rejected as the primary mechanism, kept as
  the tiebreak inside B.* A pure winner rule converges **structurally** but removes the human from the
  decision — and the product owner's whole point is that a director *chooses* which mapping is right, not
  that the system picks by UUID order. C is the right rule for *deterministically ordering the row set*
  the human is shown and for making B's re-check idempotent, but it must not be the thing that *decides
  the mapping*.

**Chosen: B, with C's total order as the internal tiebreak/idempotency key.** This keeps the human as the
decider (product requirement) while giving the serialization point (host) and a deterministic canonical
row (so a replayed/retried resolution is a no-op, not a new fork). It reuses the host-serialization the
`confirmAlias` committer already established in S1b-core, and the `recordConflict`/reviewable-conflict
surface `bulk_replace` and S1a already use.

---

## Decision

### 1. One divergence predicate, shared by every consumer (resolves O-R3)

`listAliasDivergences(db, camp_id)` is implemented **in JS** (not a SQL `GROUP BY`), because the grouping
key is `normalizeName(source_label)` and a raw-column SQL group would disagree (`"Ropes"` vs `"ropes "`)
— the same normalize/raw mismatch S1a §3 documents for `name`. It:

1. Loads all `status='active'` `source_aliases` rows for `camp_id` via static SQL.
2. Filters to rows whose `entity_id` **still names a live row of that `entity_type`** (a
   per-`entity_type` liveness join via the **fixed table map** from S1b-core §8 — static
   `SELECT 1 FROM <mapped_table> WHERE id = ?`, `entity_type` never interpolated). A dangling
   `entity_id` (Trashed target) is dropped, so it can neither manufacture nor mask a divergence.
3. Groups the survivors by `(camp_id, entity_type, cohort_id, normalizeName(source_label))`.
4. A group with **more than one distinct live `entity_id`** is a divergence; returns each with its
   candidate mappings, deterministically ordered by candidate C's total order (id/created_at).

**The importer's `listAliasMap` (S1b-core §7) and `listAliasDivergences` share this exact predicate** —
same normalization, same liveness join, same grouping — so the two cannot disagree about what "the same
label" or "a live target" means. `listAliasMap` returns the resolved `entity_id` for **non-diverging**
groups only (a group in divergence is withheld until resolved, so the importer never mis-resolves); a
resolved (converged) group has exactly one active live mapping and flows through normally. A test proves
`buildPlan`'s alias map and `listAliasDivergences` agree on both a `"Ropes"`/`"ropes "` normalization
pair and an entity-Trashed (dangling) pair — the exact O-R3 test the stub names.

### 2. Convergent resolution (resolves O-R2)

`resolveAliasDivergence(db, { camp_id, entity_type, cohort_id, source_label, chosen_entity_id,
author_user_id, device_id })` — a host-local committer, admin-gated via the
`source_aliases.resolve_divergence` action (S1b-core §8), one `db.transaction()`:

1. **Read** all active rows for the scope key (normalized `source_label`).
2. **Canonical row.** Pick the canonical row deterministically by candidate C's total order over the
   scope's rows (lowest derived key). Write `chosen_entity_id` onto the canonical row (keeping it
   `active`), stamp resolution provenance.
3. **Supersede the rest.** Mark every other active row in the scope `status='superseded'`,
   `superseded_by = <canonical row id>` — append-only, never hard-deleted (`MATCH_AND_MERGE_SEMANTICS
   §7`).
4. **Re-check.** Re-run `listAliasDivergences` for this scope **inside the same transaction**. It must
   now return zero (exactly one active live mapping). If it does not — a candidate the director did not
   pick is itself the canonical row, or a concurrent op landed — the transaction still leaves exactly one
   active row by construction (step 2 writes onto the single canonical row; step 3 supersedes all
   others), so the re-check is an **assertion** that the invariant holds, not a retry loop.

**Why this converges.** Because `resolveAliasDivergence` runs **only on the host** (the canonical DB),
two directors resolving the same divergence serialize through the host's transaction queue:

- Director-1 resolves label→A. Host converges the scope to one active row (mapping A) and supersedes the
  rest. Broadcast as ordinary ops.
- Director-2's resolution (label→B) arrives next. The committer reads the **already-converged** scope
  (one active row, mapping A). Because the canonical row id is deterministic (candidate C), Director-2's
  write targets the **same** canonical row, changing its mapping A→B and re-superseding — a single,
  well-defined state transition, **not** a new fork and **not** a both-superseded annihilation. The
  scope stays at exactly one active row throughout.

So two different human choices do not annihilate (never both-superseded — step 2 always writes onto one
active canonical row) and do not re-fork (never two fresh active rows — the canonical row id is derived,
so concurrent resolutions address the same row). The **last** admin decision wins **as a deliberate,
serialized, reviewable resolution** — which is different from silent field-level LWW: every superseded
mapping is retained with `superseded_by`, the resolution carries provenance, and the review surface shows
the history. This is LWW-free in the sense the product owner requires (no silent arrival-order overwrite
of an unreviewed mapping); it is deterministic-last-*human-decision* wins, which is the only convergent
option when two admins genuinely disagree.

> **A retried/replayed resolution is idempotent.** Same `chosen_entity_id` onto the same deterministic
> canonical row is a no-op field write (the value already equals); the client_write_id idempotency on the
> op path (`operations.js` ~125) plus the deterministic row id means a retry never mints a second fork.

### 3. The review surface

A read-only IPC (`shoresh:list-alias-divergences`, admin-gated) feeds a divergence-review card built on
`listAliasDivergences`. The director picks the correct mapping; the pick calls
`shoresh:resolve-alias-divergence` → `resolveAliasDivergence`. This is the same
"director resolves a held conflict" shape S1a uses for `ambiguous_identity` and the T73 path in S1b-core
§7 — no new review primitive. Presentation detail (where the card lives in the S5 hub) is a Designer
concern; this ADR fixes only the data the card consumes (per-scope candidate mappings, deterministically
ordered) and the resolution behavior.

### 4. buildPlan integration (the read-side `alias_divergence` conflict)

S1b-core wires the `reason:'alias_divergence'` branch in `buildPlan` (alias says A, exact-name says a
different live B). S1b-divergence makes that branch *reachable and resolvable*: the snapshot's `aliases`
map now also carries, per scope, whether the scope is in divergence, so `buildPlan` can emit
`alias_divergence` when the confirmed alias and an exact-name match disagree, carrying both candidates.
Resolution routes through `resolveAliasDivergence` (for two-alias divergence) or `confirmAlias` (for the
alias-vs-exact-name "remember the exact-name entity instead" case). No auto-pick, per
`MATCH_AND_MERGE_SEMANTICS §1`.

---

## Files / modules affected

- **New:** `electron/ops/aliasDivergence.js` (`listAliasDivergences`, `resolveAliasDivergence`).
- **`electron/ops/confirmAlias.js`** — shares the deterministic canonical-id + liveness-map helpers.
- **`src/ingest/buildPlan.js` / `electron/ops/ingest.js`** — `listAliasMap` withholds diverging scopes;
  `alias_divergence` conflict fully live.
- **`electron/main.js`** — `shoresh:list-alias-divergences`, `shoresh:resolve-alias-divergence` (both
  admin-gated).
- **`electron/sync/syncServer.js`** — no new mechanism; resolution ops broadcast like any op.

## Reused vs. new

- **Reused:** the S1b-core host-serialized committer pattern; the append-only supersede/tombstone
  discipline; `normalizeName`; the reviewable-conflict surface pattern (`recordConflict`/S1a hold-the-
  import); the fixed `entity_type`→table map and static-SQL discipline from S1b-core §8.
- **New:** `listAliasDivergences` (the shared predicate); `resolveAliasDivergence` (the convergent,
  host-serialized read-and-supersede + re-check); the divergence-review IPC + card data contract.

## ADR required: yes

It sets the cross-device consistency model for a synced entity's conflict — a not-obviously-reversible
tradeoff (host-serialized convergence vs. a pure winner rule), warranting its own durable record separate
from the entity's schema ADR.

## Consequences

- Two admins can safely disagree about a mapping: the disagreement surfaces for review and resolves
  convergently, never silently, on every device.
- The convergence guarantee depends on `resolveAliasDivergence` running **host-only** and on the
  **deterministic canonical row id**. A future refactor that let a client resolve locally, or that
  randomized the canonical id, would reintroduce the fork/annihilate failure — this is called out so it
  is not "simplified" away.
- The predicate is JS, not SQL `GROUP BY`, on purpose (normalization). A later reader must not "optimize"
  it into a raw-column SQL group.

## Completion evidence

1. **One predicate (O-R3).** A test proves `buildPlan`'s alias map and `listAliasDivergences` agree on a
   `"Ropes"`/`"ropes "` normalization pair and on an entity-Trashed dangling pair.
2. **Convergent resolution (O-R2).** A test with two devices resolving the same divergence to *different*
   entities ends with **exactly one active row** on both devices (not zero, not two), same mapping on
   both, and every superseded row retained with `superseded_by`.
3. **Idempotent retry.** A replayed `resolveAliasDivergence` (same client_write_id / same choice) mints
   no second row and no new divergence.
4. **Importer safety.** While a scope is diverging, `listAliasMap` withholds it and the importer does not
   mis-resolve the label; once resolved, the label resolves via the `confirmed_alias` tier.
5. **Reviewable, not LWW.** A test asserts two divergent confirmations do NOT collide under
   `detectConflict` (proving the read-side policy is required) and that neither is silently dropped —
   both are retained, one active, one superseded, with provenance.

## Open questions for Governor

- **Presentation of the divergence-review card** (S5 hub placement, how a director is alerted a
  divergence exists) is a Designer detail; this ADR fixes only the data contract and resolution behavior.
- **Whether S1b-divergence ships in the same release as S1b-core or a later one** is the scope call in
  S1b-core §9 — this ADR is written so it can land independently on top of S1b-core.
