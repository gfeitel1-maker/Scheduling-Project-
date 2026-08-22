---
title: "ADR: Ingestion Evidence Persistence — the B4 host-local evidence artifact"
document_type: adr
status: accepted
authority: normative
implementation_state: implemented
date: 2026-08-10
decided: 2026-08-22 (frontmatter reconciled with shipped code — the import_evidence table, writeEvidence/listImportEvidence, and per-field observed/inferred tagging are live in electron/db/schema.sql + electron/ops/ingest.js; confirmed during the Roots-as-hub Slice D architecture investigation)
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
supersedes: []
extends: [docs/adr/2026-08-10-ingestion-reconciliation-semantics.md, docs/adr/2026-08-09-s1b-host-local-aliases.md]
program: ingestion-reconciliation
phase: B4
---

# ADR: Ingestion Evidence Persistence (B4 sub-ADR)

**Status: PROPOSED.** This is the sub-ADR the parent ADR (`docs/adr/2026-08-10-ingestion-reconciliation-semantics.md`,
D3 / OQ2) reserved: OQ2 already resolved *where the data lives relative to sync* (host-local, not
synced). This document resolves the *physical shape* — table vs. file, what exactly is stored, how it
links to the inference it supports, and its lifecycle — and needs product-owner approval before any B4
code is written.

## Context

The brief (`docs/work/specs/2026-08-09-ingestion-reconciliation-brief.md`) requires that "Why does
Shoresh think this?" be answerable **after** the import session ends — SOURCE → OBSERVATION →
INFERENCE → CONFIRMATION must survive compression into a director-facing report. Phase A discovery and
the parent ADR found that the mechanics for INFERENCE and CONFIRMATION already exist
(`buildPlan.js`'s `ReconciliationPlan`, `operations.source`), but the OBSERVATION layer that backs each
inference is computed and then thrown away before it ever reaches a database.

## Premise verification (against live code, this session)

**Claim to verify: is per-inference observation evidence really computed and then discarded, and can
it be captured without rewriting the importer?** Verified true, on three separate paths:

**1. Activity rules (frequency / eligible groups).**
`src/ingest/activityRules.js:50-89` (`inferActivityRules`) computes `matchedGroups` (which group pages
an activity appeared on) and `appearances` (raw occurrence count from `seenCounts.activities`) per
activity, uses them to derive `eligible_group_names`, `min_per_week`, `max_per_week`, then **returns
only the derived fields** (`activityRules.js:82-88`) — `matchedGroups` and `appearances` are local
variables, never attached to the returned rule object, and go out of scope when the function returns.

**2. Fixed events (day/group pinning).**
`src/ingest/fixedEvents.js:70-79` builds `occupied` (per `(group, block, activity)` tuple → the set of
days it appeared) and `operatingDays` (per group → the set of days that group ran at all) from the raw
grid. `fixedEvents.js:126-138` uses `occ`/`operating` (the sizes of those sets) to classify a
`confidence` tier (`'high'|'low'`) per candidate, then **only the tier survives** into the returned
`fixedEvents[]` (`fixedEvents.js:161`, `confidence: tierFromHighFlag(...)`) — the actual day-count
numerator/denominator that justified the tier is discarded with the function's local `collapsed` map.

**3. Confirmed discard point — never reaches Electron/the DB.**
`grep -rn "seenCounts|activityPages|occupied|operatingDays" electron/` returns **zero matches** (one
unrelated hit in a test docstring using the English word "occupied"). `seenCounts`/`activityPages` are
consumed only by `preview.js:96-97` (low-confidence tick-state) and `activityRules.js` — both pure,
renderer-side, in-memory. `commitIngest` (`electron/ops/ingest.js:299`) receives `approved`,
`fixedEvents`, `activityRules` — i.e. the *already-collapsed* rule/event objects — never the raw
`seenCounts`/`occupied`/`operatingDays` that produced them. Once `ImportScreen.jsx`'s import session
state is torn down (navigate away, app restart), the observation layer is gone; nothing in `electron/`
or the SQLite schema references it. **Confirmed: evidence is genuinely discarded today, not already
persisted anywhere.**

**4. Capturable without an importer rewrite — yes, by the same margin Phase A found for the
reconciliation report (its own Q4).** `inferActivityRules` and `inferFixedEvents` already compute the
exact numbers needed (`matchedGroups`/`appearances`; `occ`/`operating`/the day set) as local values
immediately before discarding them; returning a compact summary alongside the existing derived fields
is an **additive return-shape change to two pure functions**, not new inference logic. The one new
plumbing requirement (not free) is that `commitIngest`/`commitPlan` (`electron/ops/ingest.js`) do not
currently know the *entity_id* an inferred rule/event resolves to until the commit transaction runs
(`created` rows get their id inside `commitPlan`'s `db.transaction()`; `buildPlan` items carry `evidence:
{ tier, matched_name }` — identity-match evidence, a different thing from the observation support this
ADR persists) — so persisting evidence keyed to a real `entity_id` must happen from inside that same
commit transaction, using the ids it already resolves, not from a separate pass.

## Decision

### What to persist

Per inferred field (not per activity, not per raw cell) — the minimal unit the brief's progressive
"why?" disclosure needs to answer one question at a time ("why is this eligible for these 3 groups?"
is a different question from "why 2x/week?"):

- **Activity rule fields** (`eligible_group_names`, `min_per_week`/`max_per_week`): `{ matched_groups:
  [names], appearances, eligible_group_count }` — enough to render "seen on Yeladim and Bogrim pages,
  9 times across 6 operating days."
- **Fixed-event fields** (`days`, `scope`): `{ days: [...], occupied_days: N, operating_days: N,
  groups_in_scope: [names] }` — enough to render "held on 5 of 6 operating days for this group."

This is the compressed support the brief asks for, not the raw workbook — no cell coordinates, no page
titles beyond the group/day names already surfaced elsewhere in the plan.

**Tag carried alongside, not redesigned:** each row also carries `tag: 'observed'|'inferred'` — this is
the evidence-record property the parent ADR's D1/OQ1 already decided (`operations.source` stays a
stable enum; this table is where the OBSERVED-vs-INFERRED distinction actually lives). No new tagging
logic is introduced here beyond: an activity rule's `eligible_group_names`/`min_per_week` fields are
`inferred` (heuristic, not a literal fact); the raw fact "this name appeared" — already representable by
`create`/`unchanged` plan items existing regardless — needs no evidence row of its own. B5 (next slice)
owns wiring this tag into the read layer; this ADR only reserves the column.

### Storage shape — candidates considered

1. **New host-local table** (`import_evidence`), reusing the `source_aliases` pattern exactly:
   polymorphic `entity_id` (no FK), `camp_id`-scoped, single writer, never synced.
2. **Host-local file artifact** — one JSON file per import run under app userData, referenced by run id.
3. **Extend an existing structure** — stuff the support blob onto `activities`/`anchor_activities` rows
   themselves (a new JSON column), or widen `buildPlan`'s `evidence` field (currently identity-match
   metadata) to also carry observation support and store *that* somewhere already-persisted.

**Rejected — (2) host-local file.** No transactional coupling to the commit: a crash between the
SQLite commit and the file write leaves evidence silently missing for entities that did get created,
and there is no existing precedent for a host-local *file* artifact in this codebase (`source_aliases`
and `host_signing_key` are both tables). Would also need its own index/lookup layer to answer "give me
the evidence for activity X" without scanning every run file — solving a problem SQLite already solves.

**Rejected — (3) extend synced entities.** Writing evidence directly onto `activities`/
`anchor_activities` rows would either (a) sync host-local-only data to other devices over the LAN
protocol, directly violating the parent ADR's accepted OQ2 decision, or (b) require excluding one
column of an otherwise-synced table from replication — a partial-sync-per-column mechanism this
codebase has never needed and that `source_aliases` was specifically designed to avoid needing (its own
ADR §1 rejected exactly this shape for alias data). Also fails "does not become a second provenance
system": bolting support data onto the entity row conflates it with the row's actual confirmed state.

**Recommended: (1) new host-local table**, modeled directly on `source_aliases`
(`docs/adr/2026-08-09-s1b-host-local-aliases.md`) — same polymorphic `entity_id`, same
never-synced/never-appendOp discipline, same "single writer inside one transaction" argument for why no
`UNIQUE` race-guard beyond an application-level upsert is needed. This is the pattern the parent ADR's
D3 explicitly instructed reusing ("keyed to what... reference how S1b source_aliases already does
host-local-only... as the pattern to reuse, NOT a parallel mechanism"), and it is the only option of the
three that is both transactionally safe and keeps host-local data out of the synced schema.

### Schema — `import_evidence`, host-local, v31

```sql
-- Host-only table, like source_aliases and host_signing_key. NEVER included in
-- any full-sync SELECT/payload, NEVER sent over the wire, NEVER added to
-- DIRECT_CAMP_ENTITIES or PROJECTIONS. Written only from inside commitPlan's
-- commit transaction (electron/ops/ingest.js), admin-gated by the same import
-- IPC boundary as everything else in that transaction.
CREATE TABLE IF NOT EXISTS import_evidence (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  entity_type TEXT NOT NULL,     -- 'activities' | 'anchor_activities' — the two types
                                  -- that carry inferred/observed fields today
  entity_id TEXT NOT NULL,       -- plain TEXT, not a FK (same reasoning as source_aliases.entity_id)
  field TEXT NOT NULL,           -- the plan field this evidence supports, e.g.
                                  -- 'eligible_group_names' | 'min_per_week' | 'days' | 'scope'
  tag TEXT NOT NULL,             -- 'observed' | 'inferred' (parent ADR D1/OQ1)
  confidence TEXT NOT NULL,      -- 'high' | 'low' — reuses CONFIDENCE.* (src/ingest/confidence.js)
  support TEXT NOT NULL,         -- compact JSON: see "What to persist" above
  import_run_id TEXT NOT NULL,   -- groups every row one commitIngest call wrote
  committed_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_import_evidence_latest
  ON import_evidence (camp_id, entity_type, entity_id, field);
```

**Latest-wins, not append-only — the one deliberate divergence from `source_aliases`.**
`source_aliases` is append-only-with-supersede because its history ("what did we used to think this
label meant") is itself a director-facing answer. Evidence is different: a re-import's fresh support
for the *same* field supersedes the old support outright — a director asking "why?" wants the current
source's justification, not an archive of every past import's numbers. `UNIQUE(camp_id, entity_type,
entity_id, field)` plus an application-level `INSERT ... ON CONFLICT DO UPDATE` (single writer, same
transactional-safety argument as `source_aliases` §1) keeps the table's size bounded by "number of
inferred fields the camp currently has," not growing per re-import. `import_run_id` is retained per row
so the "why" panel can still say *when* (which import) — just not carry every prior version's numbers.

**No FK on `entity_id`**, matching `source_aliases`: `entity_type` names which of two tables it points
into, `entity_id` stays plain TEXT.

Declared in both `schema.sql` (near `source_aliases`, same host-local header comment) and a v31
migration in `localDb.js`, following the v29→v30 both-places precedent. `CURRENT_SCHEMA_VERSION` bumps
30 → 31.

### Linkage / provenance

- **To the inference:** `(entity_type, entity_id, field)` is the join key the read layer (Phase C/D)
  uses to fetch "why" for a specific field on a specific activity or fixed event — the same shape
  `buildPlan`'s items already key their `fields` object by.
- **To the confirmed value:** deliberately indirect, not a foreign key into `operations`. The current
  value of the field lives in the entity row / `operations` log as today (D1: CONFIRMED = latest op has
  `source='human'`); `import_evidence` only ever answers "what did the source data show," never "what is
  it now." A director confirming/editing a field does not touch or invalidate its evidence row — the
  evidence remains a true historical fact about the source file regardless of what a human later decided.
  This keeps `import_evidence` an *annotation*, never a second provenance system, matching the parent
  ADR's explicit constraint.
- **To the import run:** `import_run_id` — a UUID minted once per `commitIngest` call (new; no such
  concept exists in the codebase today — confirmed by grep, zero hits for `import_run`/`batch_id`/
  `session_id` outside this design). Minted inside `commitIngest`, threaded to every `import_evidence`
  row the same commit transaction writes, alongside the existing `total`/`created` counts already
  returned to the caller.

### Lifecycle

- **Produced:** during ingest, by widening `inferActivityRules`'/`inferFixedEvents`' return shape to
  include the compact support object alongside their existing derived fields (additive, no behavior
  change to the derivation itself). Threaded through `ImportScreen.jsx`'s existing `activityRules`/
  `fixedEvents` state — already passed to `commitIngest` today — carrying the new `support`/`tag` fields
  alongside the `confidence` field that already exists.
- **Persisted:** inside `commitPlan`'s existing `db.transaction()` (`electron/ops/ingest.js`), at the
  same point an activity or anchor row is created/matched — using the entity_id that transaction just
  resolved. Not a separate committer like `confirmAlias` (which has no dependency on ids born in the
  same transaction); this write must happen *inside* the commit, using ids that don't exist until then.
- **Read:** by Phase C/D's "why?" disclosure, keyed by `(camp_id, entity_type, entity_id, field)` — a
  new read-only lookup function, sibling to `listAliasMap`.
- **On re-import:** upsert per `(camp_id, entity_type, entity_id, field)` — the new commit's support
  replaces the old. If a re-import's plan item for that field is `unchanged` (recognized, no diff), the
  underlying observation may still differ session-to-session (e.g. a slightly different appearance
  count) even though the confirmed value didn't move; recomputing evidence unconditionally whenever
  `inferActivityRules`/`inferFixedEvents` runs (regardless of whether the plan item was `create`,
  `update`, or `unchanged`) is simplest and keeps the evidence honest about "what the source shows now,"
  which is the point of the feature.
- **On protected/CONFIRMED fields:** Policy A (parent ADR D5) already blocks the *value* write when a
  field is human-protected; the *evidence* row is independent of that gate and still upserts (a director
  seeing "why?" on a field they've since hand-edited should still be able to see what the original import
  observed, alongside the fact that a human has since overridden it — that "since overridden" framing is
  a Phase D read-layer job, this ADR only guarantees the raw evidence is there to read).
- **On entity deletion (Trash, tombstone):** no cascade delete and no FK — matching `source_aliases`,
  which has the same polymorphic-no-FK shape and the same non-problem (an orphaned alias/evidence row is
  inert; the read layer joins against live rows, so a deleted entity's evidence simply stops surfacing).
  Explicit GC is not built now; flagged as an open question below.
- **Retention:** none needed beyond the upsert-latest design — the table's size is bounded by the
  camp's current inferred-field count, not by import-run count. No separate GC job.

### What this deliberately does NOT do

- No OBSERVED/INFERRED **tag redesign** beyond adding the `tag` column here — `operations.source` is
  untouched, per parent ADR D1/OQ1.
- No UI — the "why?" panel, progressive disclosure, and report copy are Phase C/D (`C1`/`D2`), out of
  scope for this sub-ADR.
- No schema for synced entities — `import_evidence` is exclusively host-local, following the same
  never-in-`DIRECT_CAMP_ENTITIES`/never-in-`PROJECTIONS`/never-`appendOp` discipline `source_aliases`
  established (its migration test `sourceAliases.migration.test.js` should get a B4 sibling asserting
  `import_evidence` is likewise excluded from full-sync).
- No historical evidence across re-imports (latest-wins, not append-only) — see rationale above.
- No `import_run_id` browsing/audit UI — the column exists for the "when" half of "why," not to build a
  run-history feature.

## Dependency + risk notes

- **All-or-nothing commit (parent ADR decision 3, kept):** unaffected. Evidence rows are written inside
  the same transaction as everything else; if the commit holds (a conflict), no evidence is written
  either — consistent with "nothing commits until the whole import resolves."
- **Re-import:** the upsert-latest design is the one place this ADR diverges from `source_aliases`'
  append-only-supersede pattern; flagged explicitly above so it isn't silently assumed to be the same
  mechanism.
- **B5 (OBSERVED-vs-INFERRED tag) depends on this table existing** (parent ADR: "Depends: B4") — the
  `tag` column reserved here is what B5 wires into the read layer; B5 does not need to touch this
  schema.
- **Migration risk:** additive-only (`CREATE TABLE IF NOT EXISTS`), same low-risk shape as v30. No data
  migration of existing rows — a camp with activities/fixed events already committed before B4 ships
  simply has no evidence rows for them until its next re-import, which is an acceptable, self-healing gap
  (the "why?" panel can render "no import evidence recorded — confirmed by [source] before this feature
  shipped" rather than treating it as an error).

## Open questions for the product owner

1. **Two-type scope.** This ADR scopes `entity_type` to `activities` and `anchor_activities` (fixed
   events) — the two places `inferActivityRules`/`inferFixedEvents` produce support today. If a future
   ingest gap adds inference to another entity type (e.g. `tiers`, `groups`), the same table extends by
   adding a value to `entity_type`, no new table — flagging so it isn't silently assumed out of scope
   forever.
2. **Explicit GC on camp/entity deletion.** No cascade is built now (matches `source_aliases`'s existing
   posture). If orphaned `import_evidence` rows accumulating over years of re-imports/deletions becomes
   an actual size concern, a GC pass belongs in whatever later slice picks up `source_aliases` GC too
   (neither has one today) — not a B4 blocker.
3. **`support` JSON shape stability.** The two shapes above (activity-rule support vs. fixed-event
   support) are proposed at the level of detail the "why?" copy in D2/D1 (Phase D) is expected to need;
   the exact fields may need a small revision once Phase D's UI copy is actually written, since no D2
   mockup exists yet. Not a blocker for building the table — the `support` column is a JSON TEXT blob
   precisely so this can flex without a migration.
