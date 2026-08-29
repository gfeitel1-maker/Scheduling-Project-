---
title: "Persisted open reconciliation decisions — host-local journal feeding Roots home's attention list"
document_type: adr
status: accepted
authority: normative
implementation_state: not_started
date: 2026-08-28
approved: owner-approved 2026-08-28 (after two Red Hat passes on the staleness/clearing logic)
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs: [docs/work/specs/2026-08-28-lifecycle-ia-program.md]
refines: [docs/adr/2026-08-28-roots-home-is-a-distinct-screen.md]
affects: [electron/db/schema.sql, electron/db/localDb.js, electron/ops/openReconciliationDecisions.js, electron/ops/ingest.js, electron/main.js, electron/preload.js, src/localClient.js, src/hooks/useOpenReconciliationDecisions.js, src/ingest/openDecisionsToModel.js]
---

# Persisted open reconciliation decisions — host-local journal feeding Roots home's attention list

## Status

Accepted (owner-approved 2026-08-28, after two Red Hat passes hardened the staleness/clearing logic). Follow-up to WS4 of the lifecycle-IA program. Consumed by Governor to brief Maker.

**Owner decision on OQ2 (2026-08-28): the home's resolve control is a plain dismiss (`dismissOpenReconciliationDecisions`, delete-by-id) — ship it first.** A deep-link back into `ReconciliationScreen` for targeted re-triage is explicitly deferred, not built now; the plain dismiss is the guaranteed-safe fallback for every row (including zombies) regardless. This closes OQ2 for the initial implementation.

**Depends on `docs/adr/2026-08-28-roots-home-is-a-distinct-screen.md`** (unmerged, `feat/ws4-roots-home`) for `buildAttentionList`/`RootsHomeScreen` shapes — see Decision §6 for how this ADR sequences against that branch without blocking on its merge.

## Context

`buildAttentionList({ model, decisionsById, structureIssues })` (`src/ingest/attentionList.js`, on `feat/ws4-roots-home`) unions two halves for the Roots home's "needs your attention" list: a reconciliation half (walks `model.domains[].children[].roster[]` for `state === 'attention' | 'changed'` entries) and a structure half. `RootsHomeScreen` currently calls it with `buildRootMapModel(null, { snapshot: collections, mode: 'inspect' })`. `buildRootMapModel` in `mode: 'inspect'` never runs `buildReconciliationReport` (`src/ingest/rootMapModel.js` line ~63, "Inspect mode never runs buildReconciliationReport ... there is no report, no decisions ... ever") — every roster entry's `attributedDecisionFor` lookup is against an empty `decisions` array, so every entry defaults to `state: 'understood'`. **The reconciliation half of the attention list is not incompletely wired — it is structurally unreachable in the current design.** A report needs the imported source file; that file is gone by the time the director is on the home screen, so recomputing it is not an option.

Today, an unresolved decision (a triage item the director left `attention`/`changed`) exists only in `ReconciliationScreen.jsx`'s transient React state (`answers`, `dismissedGaps`, the in-memory `report`). Leaving the screen — by any route, including a successful partial apply — discards it. This ADR designs the persisted store that survives that, and the wiring that lets `RootsHomeScreen` surface it without recomputation.

**SETTLED by owner (2026-08-28), not reopened here:** storage is host-local, never synced, modeled directly on `source_aliases`, `declined_two_row_splits`, and the v32 migration-review journal (`electron/ops/migrationReviews.js`). Rationale: import commit is host-only (T61 — "can only be run on the main computer"), so a decision is always born on the Host; nothing about it needs to exist on a Client. No `operations` row, no sync payload inclusion, no conflict semantics.

## Candidate approaches (divergent pass)

Five parallel frames (regulator, inversion, logistics, 3am-on-call, game-design) were run against the schema/keying/write-point/staleness/home-wiring questions. Convergent findings, clustered by angle:

- **Identity-key cluster** (regulator, inversion, game-design): content-address the row instead of trusting a stored foreign key. `[N7 V9 F9]` — this is what the codebase already does. `reconciliationReport.js`'s `decisionId(entity, entityId, reason, name)` and `fixedEventDecisionId(kind, reason, name, timeBlock, days)` are deterministic hashes of *content*, not random ids — a re-import that reproduces the same unresolved decision reproduces the same id. This resolves the "entityId: null" synthetic-identity problem for free: no new hashing scheme needed, reuse the one that already exists.
- **Audit-trail cluster** (regulator, inversion): never hard-delete, keep a resolution receipt, distinguish human resolution from synthetic auto-clear. `[N8 V4 F3]` — flagged as a **trap**: this project's actual precedent for an open-decisions journal (`migrationReviews.js`) deletes on dismiss with no receipt, and provenance for the *resolved* value already lives elsewhere (`import_evidence`, `source_aliases.confirmed_by/confirmed_at`). Building a second, parallel audit log for the fact of dismissal is unrequested generality — the owner's stated success predicate is "resolving removes it," not "prove who resolved it." Rejected for that reason, kept in mind only for the staleness-must-be-provable point below.
- **Recompute/view cluster** (3am-on-call): skip the table, derive open decisions as a query over `operations`, or recompute lazily on every home mount. `[N6 V2 F1]` — trap: the whole reason this ADR exists is that the source file (and therefore the report) is gone once the director leaves import; there is nothing left to recompute from except the persisted row itself. Rejected — contradicts the stated premise.
- **Batch/manifest cluster** (logistics, inversion): scope re-import staleness handling to an import-run/batch id, diff against it, supersede by lineage rather than per-row judgment. `[N7 V8 F9]` — **kept**, converges with the identity-key cluster: `import_evidence.import_run_id` is exactly this pattern already in `schema.sql`. Reused, not reinvented.
- **Transactional-write cluster** (inversion, game-design "save at the inn"): write the open-decision set in the *same* transaction as the entity mutation it describes, at `apply()`, not on unmount/leave. `[N6 V9 F9]` — kept as the write-point answer; see Decision §3.
- **Zero-signature-change cluster** (inversion, game-design): adapt persisted data into `buildAttentionList`'s existing `{model, decisionsById}` shape rather than widening the function. `[N5 V10 F10]` — kept as the home-wiring answer; see Decision §5. This was independently proposed by two isolated frames, which is the strongest signal in the whole run.

## Decision

### 1. What is persisted per row

One host-local table, `open_reconciliation_decisions`, one row per still-unresolved decision, columns:

| column | notes |
|---|---|
| `id` | PK. The existing deterministic `decisionId`/`fixedEventDecisionId` string, verbatim. Not a new UUID. (Only `confirm_value`/`confirm_change` rows exist — held conflicts are out of scope, see §1a — so this is the whole id vocabulary.) |
| `camp_id` | FK, `camps(id)` |
| `entity_type` | one of the ingestible entity types (`groups`, `tiers`, `activities`, `anchor_activities`, `time_blocks`, `days_of_operation`) |
| `cohort_id` | nullable TEXT — populated ONLY for cohort-scoped types (`tiers`, `time_blocks`), NULL otherwise. Same posture, same column name, as `source_aliases.cohort_id` (`electron/db/schema.sql:108-123`). Required for §4's scoping fix — see §4(c). |
| `entity_id` | nullable TEXT, plain (not FK — same posture as `source_aliases.entity_id`); null for creates, fixed-event decisions, and conflict decisions |
| `identity_key` | NOT NULL. For `entity_id`-bearing rows: `entity_id`. For fixed-event rows (`entity_id IS NULL`): the existing `(entityName, timeBlock, days)` tuple, joined into one string. For conflict rows: `(entity, entityName, heldKind, field)` joined into one string — see §1a. Always populated so matching never depends on `entity_id`'s nullability — one lookup path, not two. |
| `kind` | `confirm_value` \| `confirm_change` — drives `state` (`attention` vs `changed`) the same way `stateOf`/roster-building already does. (`resolve_conflict` is never written here — §1a.) |
| `domain_key` / `child_key` | from `domainOf(d)`/`childOf(d)` (`domainRollup.js`) at write time — precomputed, not re-derived on read, so the home never needs the full `DOMAINS`/`CHILD_OF` machinery just to render a list |
| `entity_name` | display name |
| `reason` | the existing `.reason`/`why` text |
| `import_run_id` | same value `import_evidence.import_run_id` gets for this commit — the batch-lineage key used for staleness (Decision §4) |
| `created_at` | ISO timestamp |

No `resolved_at`, no `resolved_by`, no soft-delete flag. Resolution is a `DELETE`, mirroring `dismissMigrationReviews`. Provenance for the *value itself* once resolved already lands in `import_evidence`/`source_aliases`/the entity row's `source` column — this table only needs to answer "is anything still open," and an open-only table with a delete-to-close lifecycle answers that with the least new surface. Rejected the audit-receipt design from Candidate approaches — the smallest responsible table, not a second audit log the constitution doesn't ask for.

**Confirmed non-issue (Red Hat-verified):** the write happens inside the same SQLite transaction `commitPlan` already opens for the entity mutation itself. A commit that throws — a held conflict that blocks the write, the T61 host-only refusal, an admin-role rejection — rolls the decision rows back atomically along with everything else `commitPlan` touched. There is no code path that leaves a half-written `open_reconciliation_decisions` row without a corresponding committed entity change.

#### 1a. Held/conflict decisions are OUT OF SCOPE for this store (corrected during implementation review, 2026-08-28)

**An earlier revision of this ADR (Finding 3) mandated persisting held/identity conflicts under a normalized `conflictDecisionId`. Implementation review proved that scenario is unreachable, and the mandate was removed.** The reasoning, and why two prior Red Hat passes both over-modeled it, is worth recording so it isn't reintroduced:

Held/identity conflicts (`kind: 'resolve_conflict'`) never reach this store's write step, under *any* design:

- **Hold-the-whole-import.** Any `op:'conflict'` item in the plan pushes onto `conflicts` (`electron/ops/ingest.js:1598`) and trips the unconditional `if (conflicts.length > 0) throw HELD` (`ingest.js` ~1610), rolling the whole transaction back *before* the write step (`ingest.js` ~2021) is ever reached. So when the write step runs, `plan.items` provably contains no conflict item.
- **`classifyItem` only emits `resolve_conflict` for `op:'conflict'`** (`src/ingest/reconciliationReport.js:83-89`) — which, per the point above, is never present at the write step. The write step therefore only ever yields `confirm_value`/`confirm_change`.
- **The UI's commit inputs strip conflicts too.** `filterQueueDecisions` (`src/screens/reconciliationResolutions.js:13-14`) removes every `resolve_conflict` decision from `foldTriageInputs`; held conflicts travel the separate held-resolution lane, are resolved there (becoming a different `op`) or leave the whole import held. They are never committed as durable data.

There is thus no reachable state in which a held conflict is "left unresolved *alongside* a commit" — the hold-the-whole-import invariant precludes it. Persisting them is not under-delivering the success predicate; it is defending a state the architecture makes impossible. `conflictDecisionId` and its `resolve_conflict` write-branch were confirmed dead code (reachable only by a unit test that bypassed `commitPlan` and called the persistence helper directly) and were **deleted**, not kept as forward-safety — a `kind` value no real caller can produce is a false invariant, not defensive code.

If a genuine future need arises to surface a *held* import's conflicts as durable rows (rather than the ephemeral dry-run output they are today), that is new, disclosed scope with its own design — not this branch. The PK-collision hazard the removed mandate worried about is moot: with only `decisionId`/`fixedEventDecisionId`-keyed `confirm_value`/`confirm_change` rows in the table, the third id vocabulary that could have collided no longer exists here.

### 2. Keying / entity attribution

`identity_key` is the single join key `RootsHomeScreen`'s read side uses — it never needs to branch on whether `entity_id` is null, because `identity_key` is always populated and always resolves the same way `attributedDecisionFor` in `rootMapModel.js` already resolves fixed-event decisions (by name + time-block label + day labels) versus ordinary entities (by `entity_id`). This is a direct reuse of `rootMapModel.js`'s existing attribution logic's *shape*, computed once at write time instead of recomputed on every read.

### 3. Write point

Single write point: inside `ReconciliationScreen.jsx`'s `apply()` (`src/screens/ReconciliationScreen.jsx` ~line 152), in the **same commit transaction** `ingestCommit` already opens (`electron/ops/ingest.js`'s `commitPlan`), not a separate follow-up write and not a write on unmount/navigate-away. Concretely: `commitPlan` gains one more step, symmetrical to how it already writes `import_evidence` and (via the resolution loop) `source_aliases` — after applying the resolutions the director confirmed, it computes the decisions that remain `attention`/`changed` (same `isDecisionResolvedFor` predicate the screen's own triage state already uses) and upserts them into `open_reconciliation_decisions`, scoped to `import_run_id` and `cohort_id` (§4c). `commitPlan` already receives `cohort_id` as a parameter (`electron/ops/ingest.js:619`) and stamps it identically to how `source_aliases`/`buildExistingSnapshot` already scope cohort-typed rows — no new plumbing for that part.

**`dismissedGaps` is out of scope for this store (corrected, Red Hat second pass).** An earlier revision of this ADR added a `dismissedDecisionIds` plumbing path from `apply()` through to `commitPlan`'s write step, worried that a director-dismissed gap could resurrect on the Roots home via this table. That concern doesn't apply, and the plumbing was dead machinery: `isDecisionResolvedFor` only ever consults `dismissedGaps` in its `required_gap` branch (`reconciliationTriage.js:163` — `if (decision.kind === 'required_gap') return dismissedGaps.has(decision.id)`), and `required_gap` decisions are synthesized client-side with ids `readiness:${key}` (`reportToLanes.js:63-64`) — they are never part of `report.decisions`, never reach `commitPlan`, and this table's `kind` enum (`confirm_value | confirm_change | resolve_conflict`) excludes `required_gap` by construction. A dismissed gap can therefore never become an `open_reconciliation_decisions` row in the first place; there is nothing for this write step to filter. Removed the `dismissedDecisionIds` parameter entirely — no change to `commitIngest`'s/`commitPlan`'s signature beyond what §4(c) already requires.

**Known adjacent item, explicitly out of scope here:** dismissed *required-gap* items live entirely in the separate, live-recomputed structure half of the attention list (`buildStructureIssues`, not this store), and `buildStructureIssues` recomputes on every read without honoring the transient `dismissedGaps` Set — so a dismissed required-gap can still reappear on the home's structure half today. That is a `feat/ws4-roots-home` structure-half concern, not this persisted-decisions store's, and this ADR does not attempt to fix it.

Rejected: writing on screen-unmount. A director who leaves without ever applying anything has committed nothing — there is no live entity yet for an unresolved decision to attach to, so there is nothing meaningful to persist. The only moment an "unresolved after this" set exists is right after a real commit, which is exactly `apply()`.

### 4. Resolution / clearing (including staleness — the Red Hat risk)

**(a) Resolved from the import flow:** the next `apply()` that reconciles a decision (its `identity_key` becomes `understood`) simply does not re-insert that row; the write step in §3 first deletes every existing open row for this commit's touched `(entity_type, cohort_id)` scope (§4c), then re-inserts only what's still unresolved. Net effect: an `UPSERT`-by-replacement scoped to the entity type **and cohort** this commit actually touched. (Dismissed *required-gap* items never reach this table at all — see §3's corrected note — so there is no dismissal case to fold in here.)

**(b) Resolved from the Roots home:** new IPC `dismissOpenReconciliationDecisions(ids)`, modeled directly on `dismissMigrationReviews` — a plain `DELETE ... WHERE id = ?` loop, host-only, admin-gated at the IPC boundary like `confirmAlias`. This is a *dismiss*, not a re-resolution of the underlying value — it says "stop flagging this," nothing more. Whether the home additionally offers a "review" affordance that deep-links back into `ReconciliationScreen` for a real triage is Designer's call, not this ADR's; the IPC only needs to support delete-by-id either way. **This dismiss control is guaranteed to exist and work for every row in the table, unconditionally** — see the OQ1+OQ2 tie below.

**(c) Staleness / auto-clear on re-import — the top Red Hat risks, addressed explicitly:**

Two distinct amnesty-by-omission failures were found, one general and one cohort-specific:

*Entity-type omission* (original design intent, unchanged): an import that *doesn't* touch a given entity type must never wipe that type's open decisions, or a partial re-import (e.g., activities-only) would silently amnesty every unresolved tiers/groups decision it never even looked at. Mechanism: `commitPlan` deletes open rows only for the `entity_type`s present in *this* commit's decision set before re-inserting, never `DELETE FROM open_reconciliation_decisions WHERE camp_id = ?` unscoped.

*Cohort omission* (Finding 2 — the same failure one level down, missed by the original draft): `tiers` and `time_blocks` are cohort-scoped entity types — a camp can have multiple cohorts, each with its own tiers/time_blocks, exactly why `source_aliases` carries a nullable `cohort_id` and indexes on `(camp_id, entity_type, cohort_id)` (`electron/db/schema.sql:108-123`). Scoping the delete-and-replace by `entity_type` alone means re-importing cohort B's tiers would delete cohort A's still-open tier decisions, even though the import never touched cohort A at all — amnesty by omission one level below the granularity the original design checked. Fix: the delete-and-replace in §4(a) is scoped by `(camp_id, entity_type, cohort_id)` for the entity types in `COHORT_SCOPED` (`electron/ops/ingest.js`'s existing set, same one `ALIAS_COHORT_SCOPED`/`buildExistingSnapshot` already use) and by `(camp_id, entity_type)` for every other type. `commitPlan` already has `cohort_id` in scope for exactly this reason (§3). **The delete predicate must use SQLite's `cohort_id IS ?`, not `cohort_id = ?`** — ordinary `=` never matches `NULL`, and a cohort-scoped row legitimately has `cohort_id = NULL` when the entity itself isn't cohort-scoped-in-practice (or when the app has only one cohort); using `=` would silently fail to clear/replace those rows, reintroducing the exact amnesty-by-omission failure this fix exists to close. Copy the exact idiom already used at `electron/ops/confirmAlias.js:87` (`... AND cohort_id IS ?`) verbatim — do not rediscover this.

Together: a decision whose `(entity_type, cohort_id)` this import never touches is left untouched. A decision that *was* in scope and is now resolved or dismissed (§3/§4a) is correctly dropped — the intended auto-clear, not a zombie. A decision whose underlying entity was deleted outside of import (director deletes the group by hand) is a gap this ADR does not silently paper over — see the OQ1+OQ2 tie immediately below, which makes that gap non-blocking by construction.

**Zombie rows can never be a UI dead end, regardless of the answer to OQ1.** Whatever Governor/owner decide about whether entity-delete IPC paths (`electron/ops/deleteRecord.js`) also clean up matching `open_reconciliation_decisions` rows (OQ1), the Roots home's dismiss control from §4(b) is deliberately **not** conditioned on the underlying entity still existing — `dismissOpenReconciliationDecisions(ids)` is a bare `DELETE ... WHERE id = ?`, with no join back to the live entity table and no liveness check. So even in the accepted-gap version of OQ1 (a hand-deleted entity's row lingers until the next matching import), the director always has a one-click way to clear it from the home — it is never a dead end, only, in the worst case, an extra manual dismiss. This decouples "is the persistence layer's auto-clear perfectly complete" (OQ1, a small and genuinely optional follow-up) from "can a director always get an item off their attention list" (guaranteed unconditionally, not optional).

This makes the whole mechanism idempotent under the same import applied twice (replaying produces the same `identity_key` set, same rows), and immune to both amnesty-by-omission failures the divergent pass and Red Hat converged on as the real risk, without needing the heavier receipt/lineage machinery the audit-trail cluster proposed.

### 5. Home wiring

`attentionList.js`'s signature does **not** change. `RootsHomeScreen` (or a small new adapter module, e.g. `src/ingest/openDecisionsToModel.js`) translates the IPC's rows into exactly the shape `buildAttentionList` already reads:

- a synthetic partial `model` — `{ domains: [{ label, children: [{ key, roster: [{ state, decisionId, entityId, name }] }] }] }` — built by grouping the persisted rows by their precomputed `domain_key`/`child_key` (§1), one roster entry per row, `state` derived from `kind` the same way `stateOf` already does (`confirm_change` → `changed`, else `attention`)
- a `decisionsById` Map of `id -> { reason }`

fed straight into the existing `buildAttentionList({ model, decisionsById, structureIssues })` call. A new hook, `useOpenReconciliationDecisions(campId)` (mirrors `useDeviceMode`-style hooks already in `src/hooks/`), owns the IPC call and the translation, so `RootsHomeScreen` itself only gains one hook call and one line feeding its existing `buildAttentionList` call — not a parallel code path. This is the zero-signature-change candidate two isolated frames converged on independently (★).

### 6. Sequencing against `feat/ws4-roots-home`

Because §5 touches `attentionList.js` not at all and `RootsHomeScreen` only by adding a hook call + a few lines at its existing `buildAttentionList` call site, the schema/migration/IPC/hook work (§1–4, and the hook itself) has **no dependency on `feat/ws4-roots-home`** and can be built and merged to `main` independently, in any order. Only the final one-line wiring into `RootsHomeScreen`'s `buildAttentionList` call depends on that file existing, i.e. on `feat/ws4-roots-home` having merged (or this branch being rebased onto it). Recommendation: land the table/migration/IPC/hook first, against `main`, fully tested in isolation (the hook can be unit-tested against a stubbed IPC without `RootsHomeScreen` existing yet); wire the one call site in as a small follow-up once `feat/ws4-roots-home` merges.

## Files/modules affected

- `electron/db/schema.sql` — new `CREATE TABLE IF NOT EXISTS open_reconciliation_decisions (...)` including `cohort_id`, host-local comment block matching `source_aliases`'/`import_evidence`'s (never in `PROJECTIONS`/`DIRECT_CAMP_ENTITIES`/any full-sync payload), plus an index on `(camp_id, entity_type, cohort_id)` mirroring `idx_source_aliases_lookup`.
- `electron/db/localDb.js` — one migration (next version after current ~v51), guarded `>= N-1 && < N` (never bare `< N` — MEMORY gotcha from the #194 regression), with an accompanying `*.migration.test.js`.
- `electron/ops/openReconciliationDecisions.js` — new module, modeled on `electron/ops/migrationReviews.js`: `listOpenReconciliationDecisions(db, campId)`, `dismissOpenReconciliationDecisions(db, ids)`, plus the `replaceOpenDecisionsForCommit` write helper `commitPlan` calls (§3), all table-absence-guarded (`hasTable`) so a device that paired in after the migration ran elsewhere never throws.
- `electron/ops/ingest.js` — `commitPlan` gains the replace-scoped-by-`(entity_type, cohort_id)` write using `cohort_id IS ?` (§3/§4a/§4c, Finding 2), inside the existing commit transaction. Persisted decisions are recomputed from `plan.items` via `buildReconciliationReport` (`confirm_value`/`confirm_change` only — §1a), filtered to still-unresolved rows. No change to `commitIngest`'s public parameter surface beyond `cohort_id`, which it already accepts.
- `electron/main.js` / `electron/preload.js` / `src/localClient.js` — two new IPC handlers (`listOpenReconciliationDecisions`, `dismissOpenReconciliationDecisions`), modeled on the `listMigrationReviews`/`dismissMigrationReviews` pair, host-only, admin-gated via `authorize()` like every other mutating handler.
- `src/hooks/useOpenReconciliationDecisions.js` — new hook, owns the IPC call + translation to `{model, decisionsById}` shape.
- `src/ingest/openDecisionsToModel.js` (or inlined in the hook — Maker's call, not architecturally significant either way) — the translation in §5, reusing `DOMAINS`/`CHILD_OF` from `domainRollup.js` only if domain/child labels aren't already precomputed at write time; since §1 precomputes `domain_key`/`child_key`, this can be a pure, dependency-free map/group.
- `src/screens/RootsHomeScreen.jsx` — one hook call + wiring into the existing `buildAttentionList` call site (blocked on `feat/ws4-roots-home` per §6).
- `src/screens/ReconciliationScreen.jsx` — no change. Everything the write needs already flows into the existing `ingestCommit` call; the write itself happens server-side in `commitPlan`, and `dismissedGaps` never needs to reach it (§3).

## Reused vs. new

**Reused:** the `source_aliases`/`declined_two_row_splits`/`import_evidence`/`migrationReviews` host-local table pattern and its schema-comment convention, including `source_aliases`'s `cohort_id`/`COHORT_SCOPED` scoping pattern and its `cohort_id IS ?` predicate idiom (`confirmAlias.js:87`) verbatim (§4c); the existing deterministic `decisionId`/`fixedEventDecisionId` content-hash as the row's primary key for non-conflict rows (no new hashing scheme there); `import_evidence.import_run_id`'s batch-lineage pattern for staleness scoping; `domainOf`/`childOf` (`domainRollup.js`) and `isDecisionResolvedFor` (`reconciliationTriage.js`) at write time; the `listX`/`dismissX` IPC shape from `migrationReviews.js` verbatim; `authorize()` gating on the new IPC handlers, same as every other mutating call; `commitPlan`'s existing `cohort_id` parameter (already threaded through for `source_aliases`/`buildExistingSnapshot`).

**New:** the `open_reconciliation_decisions` table itself; the `(entity_type, cohort_id)`-scoped replace-on-commit write inside `commitPlan`; the `identity_key` column (a persisted, always-populated version of the attribution `rootMapModel.js` already computes transiently); the `useOpenReconciliationDecisions` hook and the rows-to-`{model,decisionsById}` adapter — nothing upstream currently needs to produce a `buildAttentionList`-shaped model from anything other than a live report, so this adapter has no existing analog to reuse.

**Removed in this revision:** a `dismissedDecisionIds` parameter proposed in an earlier draft to guard against dismissed required-gaps resurrecting in this table. Confirmed unreachable — `required_gap` decisions never enter `report.decisions`/`commitPlan` at all, so the guard was inert plumbing against a bug that cannot occur here (karpathy: don't add machinery for an unreachable case).

## Open questions for Governor / owner

1. **Direct entity deletion outside import.** If a director deletes a group by hand (not via re-import) whose id an open decision's `identity_key` still points at, that row is not auto-cleared until the next matching import — §4(c)'s scoped-replace only clears rows on the *next matching import*, not on ad-hoc entity deletion. This is explicitly non-blocking: §4(c)'s last paragraph guarantees the home's plain dismiss (§4b) works on every row unconditionally, entity-liveness or not, so an un-auto-cleared row is never a dead end for the director, only a manual dismiss. Options given that floor: (a) accept as a known gap, self-limited by the dismiss guarantee (cheap, matches "bias bold, pre-production" posture); (b) have the existing entity-delete IPC paths (`electron/ops/deleteRecord.js`) also delete matching `open_reconciliation_decisions` rows by `entity_id` (small, targeted, a few call sites, closes the gap instead of just bounding it). Recommend (b) if Maker has appetite — it's strictly better and small — but (a) is now genuinely acceptable (it wasn't, before the dismiss guarantee was made unconditional) and this ADR does not block on the answer.
2. **Home's resolve affordance.** §4(b) intentionally leaves whether the home's control is a plain dismiss vs. a deep-link back into `ReconciliationScreen` to Designer. Confirm that split is right before Designer scopes it, since it changes whether `dismissOpenReconciliationDecisions` is the *only* IPC the home needs or whether it also needs read access into the reconcile flow's triage state for a targeted single-item resolve.
3. **Migration version number.** Current schema is ~v51 on `main`; confirm the next available version at implementation time rather than hardcoding one here, since other in-flight work may claim it first.

## Migration order / test-first notes for Maker

Order, each step gated before the next:
1. `electron/db/schema.sql` table (including `cohort_id`) + `electron/db/localDb.js` migration + `*.migration.test.js` (guard `>= N-1 && < N`; test both a fresh-create db and a migrated-from-N-1 db land on the identical schema).
2. `electron/ops/openReconciliationDecisions.js` — unit tests first: table-absence returns `[]`/`{ok:true, dismissed:0}` never throws; list scoped to `camp_id`; dismiss deletes only the given ids (unconditionally, with no join to entity liveness — the §4c dead-end guarantee, tested directly: dismiss succeeds even for an id whose entity no longer exists).
3. `electron/ops/ingest.js`'s `commitPlan` write step — test-first at this seam per the project's stated bias ("important logic, data, migration seams"). Required cases:
   - a commit whose decisions are all resolved leaves the `(entity_type, cohort_id)` scope's open rows empty; a commit that resolves some and leaves others persists only the remainder;
   - a commit touching `entity_type` A never deletes existing open rows for untouched `entity_type` B (entity-type amnesty-by-omission);
   - **a commit re-importing cohort B's tiers never deletes cohort A's still-open tier decisions** (Finding 2's regression test);
   - **a cohort-scoped entity type whose open row has `cohort_id = NULL` is still correctly matched and replaced by the write step's delete predicate** — asserts `cohort_id IS ?` is used, not `= ?` (Fix 2's precision item; a regression using `=` would pass every other test here and only fail on this one);
   - a commit that throws (held-conflict block, T61 host-only refusal, admin-role rejection) leaves `open_reconciliation_decisions` completely unchanged — the transaction-atomicity non-issue, worth a test even though Red Hat already verified it by inspection.
4. IPC handlers + `authorize()` gating — test host-only refusal on a Client the same way other host-only handlers are tested; test that dismiss works regardless of whether the row's `entity_id` still resolves to a live row (§4c guarantee).
5. `useOpenReconciliationDecisions` hook + adapter — unit-testable against a stubbed IPC response, no `RootsHomeScreen` dependency.
6. `RootsHomeScreen` wiring — only after `feat/ws4-roots-home` merges or this work is rebased onto it (§6).
