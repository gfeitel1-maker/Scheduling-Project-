---
title: "ADR: Per-Field UNKNOWN Reconciliation State (Scoped: min_per_week, priority)"
document_type: adr
status: accepted
authority: normative
implementation_state: implemented
date: 2026-08-20
decided: 2026-08-20
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
supersedes: []
extends: [docs/adr/2026-08-10-ingestion-evidence-persistence.md, docs/adr/2026-08-08-s2a-field-provenance-and-hand-edit-protection.md, docs/adr/2026-08-17-onescreen-reconciliation-projection.md, docs/adr/2026-08-19-roots-census-and-persistent-inspector.md]
depends_on_external: []
related_discovery: []
program: v1-closure-audit
---

# ADR: Per-Field UNKNOWN Reconciliation State (Scoped: min_per_week, priority)

**Status: ACCEPTED (owner-approved 2026-08-20) — implemented, import-time slice.**

## Context

Reconciliation state today is entity/domain-grained: Roots node states are `understood |
attention | changed | absent | not_set_up` (`src/ingest/rootMapModel.js`). This vocabulary can
say "this domain was not imported" (`absent`/`not_set_up`) but cannot say "this entity IS
present and otherwise fine, except one specific field could not actually be judged." Two commit
paths currently fabricate a confident-looking value in that gap:

1. **`electron/ops/ingest.js:1008-1010`** — when an activity is eligible for ≥1 group but no rule
   supplied a `min_per_week`, the commit path floors it to `1` (T61, "an eligible activity asked
   for zero times a week is scheduled zero times"). The floor is scheduling-necessary, but the
   committed value is a plain integer `1`, byte-identical to a director-typed `1` — nothing
   downstream can tell them apart.
2. **`src/ingest/resolvePriorityForGeneration.js:8-12`** — at schedule-generation time, any
   activity whose stored `priority` is not `'high'`/`'low'` (i.e. genuinely never judged) is
   coerced to `'low'` so the engine's two-valued round filter (`buildSchedule.js:302`) doesn't
   silently drop it. This one does NOT fabricate a committed value — `activities.priority` stays
   honestly `NULL` in the database — but nothing in the reconciliation/Roots layer ever surfaces
   that the value was never judged; a director inspecting Roots sees a clean, "understood" entity.

A `decision.unknowns: []` field is already reserved on every decision branch in
`src/ingest/reconciliationReport.js` (six call sites, all hardcoded `[]`, commented "C1 does not
build UNKNOWN-field detection — deferred, see module doc"). A per-field provenance table,
`import_evidence` (`electron/db/schema.sql:130-146`), already exists: keyed
`(camp_id, entity_type, entity_id, field)` unique, `tag ∈ {observed, inferred}`,
`confidence ∈ {high, low}`, host-local (never synced), written only from inside `commitPlan`'s
transaction via the `writeEvidence` helper (`electron/ops/ingest.js:281`). Field-level provenance
also already exists independently on `operations.source` (`'import' | 'human' | NULL`,
2026-08-08 ADR) — the signal that tells `commitPlan`'s protection/staleness gates whether a
director has hand-touched a field.

This ADR closes the concentrated honesty gap: it does not attempt full per-field UNKNOWN across
every column reconciliation touches, only the two fields named above.

## Candidate approaches considered

1. **New `unknowns` table, one row per unknown field, independent lifecycle.** Rejected: the
   exact shape already exists as `import_evidence` (same key, same host-local/never-synced
   contract, same write boundary). A second table with the same grain would be the "second source
   of truth" failure mode this codebase already names and avoids elsewhere (see the projection/
   adapter ADR's rationale for keeping `reportToLanes` a pure function over one report rather than
   a parallel classification path).
2. **Sentinel value on the field itself** (e.g. `min_per_week: -1` meaning "unknown", or a
   magic string on `priority`). Rejected outright: it repeats the exact bug this ADR exists to
   fix — a plain column value standing in for "we don't know," indistinguishable from a real
   value to every other reader of `activities` (the engine, exports, any future query). The
   owner's hard constraint ("do not fake per-field certainty") rules this out directly.
3. **Extend `import_evidence`'s `tag` vocabulary with `'unknown'`, and read it back into
   `decision.unknowns` at report-build time.** (Chosen.) `import_evidence` already carries exactly
   the grain needed (per entity, per field), is already host-local (matches the "not a synced
   contract" shape an honesty-tracking mechanism should have — it is process metadata about the
   *import*, not committed camp data), and already has a write boundary (`writeEvidence`) and a
   read boundary (`fieldProvenance`/`evidenceSupport`, already threaded into
   `buildReconciliationReport` as an additive optional input, same pattern as
   `blastRadiusIndex`/`evidence` in the projection ADR). This is a vocabulary widening, not a
   schema change — no migration, no new table, no new column.
4. **New decision `kind` (e.g. `'confirm_unknown_field'`) with its own resolution branch in
   `isDecisionResolvedFor`/`rootMapModel.js`.** Rejected in favor of reusing the existing
   `confirm_value` kind (see Decision below): `confirm_value`'s resolution semantics
   ("looks_right" | "edited") already mean exactly "confirm this proposed value or replace it,"
   which is precisely what an unknown-field decision needs. A new kind would require touching
   `isDecisionResolvedFor`, `rootMapModel.js`'s `stateOf`/`attributedDecisionFor`, and every UI
   consumer that switches on `decision.kind` — none of which needs to change if the existing kind
   already fits. ★ non-obvious-but-viable: reuse buys the entire Roots attribution pipeline
   (per-row roster state, lane placement, salience) for free, with zero changes to
   `rootMapModel.js`.
5. **Surface unknown-field state in both import-time reconciliation AND steady-state Inspect
   mode (the no-active-import census view).** Rejected for this slice, named as an explicit
   non-goal (see Scope): Inspect mode structurally never runs `buildReconciliationReport` or
   produces decisions at all (2026-08-19 Census ADR, `mode === 'inspect'` short-circuit in
   `buildRootMapModel`) — extending it would mean a second, decision-free read path over
   `import_evidence` directly, a materially bigger design than "stop fabricating certainty during
   reconciliation." Flagged as a real limitation, not silently absorbed into this ADR's scope.

## Decision

**Reuse the existing `import_evidence` table and the existing `confirm_value` decision kind.**
No new table, no new decision kind, no changes to `rootMapModel.js`, `isDecisionResolvedFor`, or
the Roots state vocabulary.

### 1. Widen `import_evidence.tag` to include `'unknown'`

`electron/ops/ingest.js:270-272`:
```js
const EVIDENCE_ENTITY_TYPES = new Set(['activities', 'anchor_activities'])
const EVIDENCE_TAGS = new Set(['observed', 'inferred', 'unknown'])   // + 'unknown'
const EVIDENCE_CONFIDENCE = new Set(['high', 'low'])
```
`tag: 'unknown'` rows always carry `confidence: 'low'` by construction (an unjudged field cannot
be high-confidence by definition — no new confidence tier needed). `schema.sql` has no `CHECK`
constraint on `tag`, so this is a pure application-level vocabulary widening: **no migration.**

### 2. Write `tag: 'unknown'` evidence at the two commit sites

- **`min_per_week` floor** (`electron/ops/ingest.js`, inside the `if (groupIds.length > 0 &&
  !(...))` block at line ~1008, immediately after `fields.min_per_week = 1` is set):
  ```js
  writeEvidence(db, {
    camp_id, entity_type: 'activities', entity_id: entityId, field: 'min_per_week',
    tag: 'unknown', confidence: 'low',
    support: { reason: 'no rule value supplied; floored to the scheduling minimum' },
    import_run_id: evidenceRunId, committed_at: evidenceCommittedAt,
  })
  ```
- **`priority`** (same `commitCreate`/`commitUpdate` neighborhood): when `rule.priority` is not
  `'high'`/`'low'` — i.e. the branch that currently writes *nothing* to `fields.priority` — write:
  ```js
  writeEvidence(db, {
    camp_id, entity_type: 'activities', entity_id: entityId, field: 'priority',
    tag: 'unknown', confidence: 'low',
    support: { reason: 'no priority in source; never inferred or judged' },
    import_run_id: evidenceRunId, committed_at: evidenceCommittedAt,
  })
  ```
  This does not change what gets written to `activities.priority` (stays `NULL`, unchanged) —
  it only records that the gap is known, not silent.
- `resolvePriorityForGeneration.js`'s runtime coercion to `'low'` **is unchanged and stays as
  the engine's scheduling-safety fallback**, per the owner's hard constraint. This ADR does not
  touch that file. What changes is that the reconciliation/Roots layer, reading the persisted
  `import_evidence` row, never claims the coercion was a judged director decision.

Both writes are ordinary calls to the existing `writeEvidence` helper — same upsert
(`ON CONFLICT (camp_id, entity_type, entity_id, field) DO UPDATE`), same host-local table, same
transaction. No new write path.

### 3. Read-time definition of "still unknown" — self-healing by construction

**A field is treated as unknown at report-build time IFF both hold:**
`import_evidence` has a `tag: 'unknown'` row for `(entity_type, entity_id, field)` **AND** the
field's current latest op (`operations`, per the existing `source` column) does **not** have
`source === 'human'`.

This is the load-bearing correctness choice: a persisted `unknown` evidence row can go stale (the
director later hand-edits the field through the normal UI, with no reason to know an evidence row
exists to update). Rather than requiring every write path that could touch `min_per_week` or
`priority` to also remember to clear/update `import_evidence`, "unknown" is computed as an AND
against the field's own provenance at read time — the same `source` column the 2026-08-08
provenance ADR already threads through `commitPlan`'s protection gates. The moment a director
hand-edits either field, `source` flips to `'human'` and the field stops reading as unknown on
the very next report build, with **zero changes needed** to the (now-stale) `import_evidence` row.

`buildReconciliationReport` gains one more optional input, `unknownFieldEvidence` (a
`Map<"entity_id:field", true>` pre-filtered against `source !== 'human'` by the caller, same
additive-degradation contract `fieldProvenance`/`blastRadiusIndex` already use — defaults to an
empty Map, degrades to "nothing unknown" if omitted).

### 4. Decision synthesis — reuse `confirm_value`, populate the reserved `unknowns` field

For each activity with ≥1 field in `unknownFieldEvidence`, `reconciliationReport.js` emits (or
augments, if a decision for that entity already exists from another cause — e.g. a genuine
create) a `confirm_value`-kind decision:
```js
{
  kind: 'confirm_value',
  entity: 'activities',
  entityId: activity.id,           // null only for a brand-new create, same as today
  entityName: activity.name,
  field: 'min_per_week' | 'priority',   // primary field named, for existing single-field UI
  unknowns: ['min_per_week', 'priority'].filter(f => unknownFieldEvidence.has(`${activity.id}:${f}`)),
  unknownField: true,               // NEW discriminator — lets the UI/copy layer say "we
                                     // couldn't tell" instead of "here's a proposed change",
                                     // without touching kind-based branching anywhere else
  proposedValue: activity.min_per_week ?? null,  // whatever is currently committed (1, or null)
  confidence: 'low',
  reason: '...',                    // Designer/copy call, not this ADR's
}
```
This is the one, and only, live consumer of the reserved `decision.unknowns` field named in the
problem statement — every other call site keeps writing `[]` (unaffected; still correct, since
this ADR doesn't add unknown-tracking anywhere else).

**Resolution** reuses `isDecisionResolvedFor`'s existing `confirm_value` branch unchanged
(`a.action === 'looks_right' || a.action === 'edited'`):
- **`'edited'`** — director writes a real value through the normal field-write path. `source`
  flips to `'human'`. Per step 3, the field self-heals to "no longer unknown" on the next report
  build. No extra write needed.
- **`'looks_right'`** — director explicitly confirms the manufactured default is fine (e.g. "yes,
  1x/week is correct" or "yes, low priority is correct"). The committed value does not change and
  `source` stays `'import'`, so step 3's read-time rule alone would keep re-flagging it forever.
  **This is the one genuinely new write this ADR introduces:** resolving `'looks_right'` on an
  `unknownField: true` decision additionally calls `writeEvidence` to flip that row's `tag` from
  `'unknown'` to `'inferred'` (same upsert, same helper, `support: { confirmedBy: author_user_id,
  confirmedAt: ... }`). This is what makes "confirm the default" durable across future
  reconciliation runs without inventing a second, ephemeral resolved-state store.

### 5. Roots display — no changes to `rootMapModel.js`

`buildRootMapModel`'s existing `attributedDecisionFor`/`buildRoster` already resolves any
unresolved decision whose `kind !== 'confirm_change'` to Roots state `'attention'`
(`rootMapModel.js:161-163`). Because step 4 reuses `confirm_value` and a real `entityId`, an
activity with an unresolved unknown field automatically renders `attention` at both the roster-row
level (`buildRoster`) and the child/domain rollup level (`stateOf`) — the "distinct from clean
understood" requirement is satisfied by the state machine that already exists, not a new state
token. **Scope boundary, stated explicitly:** this only fires during active import-time
reconciliation. Inspect mode (steady-state census with no active import) never builds decisions
at all (2026-08-19 ADR) and is untouched by this slice — a field that has been unknown for weeks
with no re-import will not show as `attention` in the steady-state Roots view. See Open Questions.

## Scope / non-goals

**In scope:** `activities.min_per_week` (floor-to-1 case) and `activities.priority` (never-judged
case), both surfaced only during import-time reconciliation.

**Explicitly out of scope, not silently absorbed:**
- Per-field UNKNOWN for any other column (`max_per_week`, `eligible_group_ids`, `location_id`,
  anchor/fixed-event fields, or anything on non-`activities` entities).
- Surfacing unknown-field state in steady-state Inspect mode (no active import) — see Open
  Questions.
- A durable, synced, cross-device audit record of "which fields were ever unknown" —
  `import_evidence` stays host-local and unsynced, matching every other row in that table today.
- Changing `resolvePriorityForGeneration`'s runtime coercion — it remains the engine's
  scheduling-safety fallback, untouched.

## Host-view scope (accepted, matches the alias precedent)

`import_evidence` is host-local and never synced (`schema.sql:130-149`), so the `attention`
badge an unknown field produces is a **Host-view property**. A synced Client receives the
`activities` row and its `operations` but not the evidence row, so a read-time consumer on a
Client would find no unknown-tag row and treat the field as clean. This is the *same* accepted
tradeoff already established for host-local reconciliation state (`source_aliases`/`confirmAlias`,
`ingest.js` header) and is low-exposure today because `ReconciliationScreen` is import-session-
scoped (a Client does not independently run reconciliation). Accepted as-is for V1: the honesty
surface lives where the import is run, which is the Host. Widening `import_evidence` to a synced
contract is explicitly out of scope and would be a separate decision.

## Consistency with durability/census ADRs

The task brief for this ADR names two peer documents as owner-ratified and in-flight:
`docs/adr/2026-08-20-in-context-knowledge-and-durability-tiers.md` and
`docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md`. **Neither file exists
yet in this worktree, on `main`, or in any other worktree searched** (`git log --all` and a
filesystem search across every active worktree under `/private/tmp/claude-501/` both came back
empty) — they were not available to read at design time. This section is therefore based only on
the one-paragraph description in the task brief (a durability→census invariant keyed off
`INGESTIBLE_ENTITIES`, and a follow-on `T107` wiring `special_days` into Roots' `Context`
domain/`buildContextChildren`), not on the peer ADRs' actual text.

Cross-checked against what this design touches:
- **`INGESTIBLE_ENTITIES` membership is unchanged.** This ADR adds no new ingestible entity type
  and does not touch `src/ingest/extractEntities.js`. `EVIDENCE_ENTITY_TYPES` (`activities`,
  `anchor_activities`) is also unchanged — both fields in scope already belong to `activities`,
  already an evidence-carrying entity type today.
- **`Context` domain / `buildContextChildren` / `special_days` are untouched.** This ADR's Roots
  effect lands entirely inside the domain(s) `activities` already rolls up into via
  `domainOf`/`childOf` (not `Context`), through the existing `confirm_value` → `attention`
  pipeline `rootMapModel.js` already runs for every other decision kind. No new branch is added
  to `buildRootMapModel`, `buildContextChildren`, or the Context/`special_days` path the peer
  work is landing.
- **No visible schema/contract collision** given the description provided. Both slices touch
  `rootMapModel.js`'s general vicinity (this one not at all in code, the peer one directly via
  `Context`), so a fast textual diff-check between the two branches before either merges is cheap
  insurance — flagged below as an open item rather than assumed clear.

## Data-model change summary

- `electron/ops/ingest.js`: `EVIDENCE_TAGS` gains `'unknown'`. Two new `writeEvidence` call sites
  (min_per_week floor, priority never-set). No IPC surface change.
- `electron/db/schema.sql`: comment-only update documenting the widened `tag` vocabulary; no
  `CREATE TABLE`/`ALTER` needed (no `CHECK` constraint exists on `tag` today).
- `src/ingest/reconciliationReport.js`: gains one new optional input (`unknownFieldEvidence`,
  additive, defaults to empty Map) and populates `decision.unknowns`/`decision.unknownField` for
  the two in-scope fields. Every other decision branch's `unknowns: []` is unchanged.
- No change to `electron/ops/projections.js` (`PROJECTIONS`) — `import_evidence` is a host-only
  table, already excluded from `PROJECTIONS`/`DIRECT_CAMP_ENTITIES` per its own header comment,
  and this ADR writes no new *committed camp field* (only evidence rows and, for `'looks_right'`,
  another evidence row) — so `electron/ops/projectionsCoverage.test.js`'s writable-field scan
  needs **no update**. If a future slice widens this to fields on entities whose writes ARE
  projected, that guard becomes load-bearing and must be re-run.
- No change to `src/ingest/rootMapModel.js`, `src/screens/reconciliationTriage.js`
  (`isDecisionResolvedFor`), or the Roots state vocabulary.

## Test plan (what makes a regression fail)

1. **`writeEvidence` accepts `tag: 'unknown'`.** Unit test: call with `tag: 'unknown'` on an
   `activities` entity, assert the row persists and an unrecognized tag still rejects (existing
   guard behavior preserved for everything else).
2. **Commit-path regression test — the fabricated-certainty bug itself.** Commit an activity with
   no rule `min_per_week` and ≥1 eligible group: assert `activities.min_per_week === 1` (existing
   T61 behavior, unchanged) **and** assert an `import_evidence` row exists with
   `(entity_id, 'min_per_week', tag: 'unknown')`. Same shape for `priority` unset. This is the
   test that fails today (no evidence row exists) and is the direct fix-verification for this ADR.
3. **Self-healing read-time rule.** Given an `import_evidence` row with `tag: 'unknown'` for a
   field, then a normal human field-write (source becomes `'human'`), assert
   `buildReconciliationReport` (with `unknownFieldEvidence` built fresh) no longer includes that
   field in any decision's `unknowns` — proves the AND-against-`source` rule self-heals without a
   delete/update to the stale evidence row.
4. **`'looks_right'` durability.** Resolve an `unknownField: true` decision with `action:
   'looks_right'` (value NOT changed, `source` stays `'import'`): assert the `import_evidence` row
   flips to `tag: 'inferred'`, and a SECOND report build (simulating a later re-import or
   re-reconciliation) does not re-surface the same decision.
5. **Roots attribution, no `rootMapModel.js` changes required to pass.** Build a report with one
   unresolved unknown-field decision on a live activity; run the existing `buildRootMapModel`
   unchanged; assert that activity's roster row state is `'attention'` (not `'understood'`) and
   its parent child/domain rolls up to `'attention'` too — this is the acceptance test proving the
   reuse-not-extend decision (#4 in Candidates) actually holds, by exercising code this ADR does
   not modify.
6. **Golden-report/golden-decisions parity** (per the projection ADR's existing discipline):
   extend the existing fixture set with one `unknownField: true` case so a future change to
   `reportToLanes`'s exhaustive `kind` switch cannot silently drop it (it still matches on
   `kind: 'confirm_value'`, so no new branch is needed there either — this test proves that, not
   just asserts it).

## Migration / rollback notes

- **Migration: none.** No `ALTER TABLE`, no schema version bump. `tag` has no `CHECK` constraint;
  widening the application-level `Set` is forward- and backward-compatible — an older build
  reading a `tag: 'unknown'` row simply fails its `EVIDENCE_TAGS.has(tag)` guard on *write* (it
  would refuse to write one, which is fine, it never will) but has no read-time gate on `tag`
  today (`writeEvidence` is the only place `EVIDENCE_TAGS` is checked; nothing filters reads by
  tag value), so a mixed-version fleet degrades safely.
- **Rollback:** revert the two `writeEvidence` call sites and the `EVIDENCE_TAGS` widening. Any
  already-written `tag: 'unknown'` rows become inert (no reader treats them specially without the
  `reconciliationReport.js` change also being present) — no data loss, no orphaned FK, no cleanup
  required. `import_evidence` is host-local and unsynced, so rollback on one device cannot leave
  another device in a different state for this table.

## Success predicate

1. Given an activity committed with a floored `min_per_week` or an unset `priority`, the NEXT
   reconciliation report for that camp includes an unresolved decision naming that field as
   unknown — not silently absent from the report.
2. That activity's Roots roster row renders `attention`, never `understood`, until the director
   either supplies a real value or explicitly confirms the default.
3. Once confirmed either way, the SAME field on a LATER reconciliation report (no further edits)
   never re-surfaces as unknown.
4. `npm run verify` stays green with the new tests from the Test Plan added, and
   `electron/ops/projectionsCoverage.test.js` requires no floor/canary changes (confirmed by the
   Data-model section's reasoning, verified in CI).

## Open questions for Governor

1. **Steady-state Inspect-mode surfacing** (candidate #5, rejected for this slice) — **RESOLVED
   2026-08-20 by the product owner: import-time-only is accepted for V1 closure.** Surfacing
   unknown fields in steady-state Inspect mode (no active import) is a deferred follow-on slice
   (a decision-free read path over `import_evidence` directly, feeding a Roots state independent
   of `buildReconciliationReport`) — a materially different, larger design, not part of this ADR.
   Known trade-off accepted: a director who imported weeks ago and never resolved an unknown
   field sees a clean Roots until the next import/reconciliation run.
2. **Cross-check with the peer durability/census ADRs before merge.** Neither peer document was
   readable at design time (see Consistency section). Recommend a five-minute textual diff check
   once both are committed: confirm this ADR's `activities`-domain `confirm_value` reuse and the
   peer's `Context`-domain `special_days` wiring don't both restructure
   `buildRootMapModel`'s domain loop in incompatible ways, since both branches touch the same file
   without touching the same code path.
3. **UI copy for `unknownField: true`** ("we couldn't tell" vs. a generic proposed-value card) is
   a Designer call, not architecture — flagging so it isn't dropped between this ADR and a Maker
   brief.
