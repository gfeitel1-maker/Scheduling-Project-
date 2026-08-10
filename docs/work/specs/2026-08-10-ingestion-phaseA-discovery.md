---
title: "Ingestion Reconciliation — Phase A Discovery Report"
document_type: discovery
status: draft
created: 2026-08-10
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_specs: [docs/work/specs/2026-08-09-ingestion-reconciliation-brief.md]
related_program: docs/work/onboarding-reconciliation/00-INDEX.md
companion_adr: docs/adr/2026-08-10-ingestion-reconciliation-semantics.md
program: ingestion-reconciliation
archive_when: superseded by an approved Phase B implementation plan
---

# Ingestion Reconciliation — Phase A Discovery

Read-only architecture audit answering the founding brief's 13 questions with `file:line` evidence,
plus six independent-perspective findings, a DOMAIN-vs-PRESENTATION split, and a what-exists /
what-is-missing summary. **No production code was written or modified in Phase A.**

## The single most important framing (read first)

This initiative is **not greenfield**. A prior program — `docs/work/onboarding-reconciliation/`
(15 synthesis docs, produced 2026-08-08) — already designed and, per the code present in this
worktree, largely **landed** the reconciliation spine the brief describes: the `ReconciliationPlan`
field-delta layer (`src/ingest/buildPlan.js`), per-field import/human provenance
(`operations.source`, schema v29), the `source_aliases` identity layer, held-conflict resolution
(T73), and the six-state Setup Readiness model (`src/engine/readiness.js`). The founding brief reads
as though written without full awareness of that program's current state (Code Reviewer finding, HIGH).

**Consequence for Phase B/C:** the largest risk in this whole initiative is the one the brief itself
names — building a *second parallel setup/inference model*. It would be realized here by an agent
duplicating a still-live program. Everything below is therefore framed as: **what the prior program
already delivers, and the specific, narrow deltas this brief adds on top.** The three genuine deltas
are (1) a **four-state** model that splits OBSERVED-fact from INFERRED-rule and makes UNKNOWN
first-class; (2) fixing **manufactured certainty** (priority forced to high/low on every activity);
(3) making **evidence survive commit** so "Why does Shoresh think this?" is answerable after the
import session ends. The ADR (`docs/adr/2026-08-10-ingestion-reconciliation-semantics.md`) proposes
those as extensions of the prior spine, not a new model.

---

## The 13 questions, answered with evidence

### Q1 — What portions of the desired model already exist?

Most of the *mechanical* spine; almost none of the *four-state / compression* semantics.

- **Entity reconciliation (create/update/unchanged/clear/conflict):** `src/ingest/buildPlan.js` is a
  genuinely complete pure diff layer — this IS the brief's "ENTITY RECONCILIATION" pipeline stage,
  not a stub.
- **Provenance (import vs human):** `operations.source` column (`electron/db/schema.sql:124-140`,
  migration v29) + `_humanFields`/`humanFieldsFor` in `src/ingest/fieldUpdate.js` and
  `buildPlan.js:139-140,255,270,307`. Per-field, per-write.
- **Identity continuity across re-import:** `source_aliases` table (`schema.sql:108-119`) +
  confirmed-alias tier (`buildPlan.aliasTier.test.js`).
- **Held-conflict resolution UI + round-trip:** `src/screens/ReconciliationLedger.jsx`,
  `electron/ops/ingest.js` hold-the-whole-import gate, T73 tests.
- **Required-vs-optional readiness:** `src/engine/readiness.js` six-state model + `FORWARD_AREAS`
  (`readiness.js:137-149`) already pre-stubs `location`/`staffing` as never-blocking.

Absent: an explicit OBSERVED/INFERRED/CONFIRMED/UNKNOWN vocabulary; a confidence→attention
compression; a reconciliation *report* (counts) as the primary destination; persisted evidence.

### Q2 — How does the current importer represent each concept?

| Concept | Representation today | Evidence |
|---|---|---|
| **Observations** | Transient in-memory counts, discarded after the plan is built | `extractEntities.js` `seenCounts.activities`, `activityUnitShare`, `activityPages`; `fixedEvents.js:66-79` `occupied`/`operatingDays` |
| **Inferred rules** | `{eligible_group_names, eligibility_known, min_per_week, max_per_week, priority, _inferred:true}` | `activityRules.js:46-95` |
| **Confidence** | Three incompatible ad-hoc schemes, none unified | `activityRules.js:22,82` (priority threshold 0.8); `fixedEvents.js:46` (`confidence:'high'|'low'`); `preview.js:107-111` (`lowConfidence` boolean) |
| **Provenance** | `operations.source` enum `import|human|NULL`, per field | `schema.sql:124-140`; `operations.js` `latestOp()` |
| **Reconciliation** | Field-delta plan `{op, entity, entity_id, fields:{field:{from,to,source}}, evidence}` | `buildPlan.js:80-90` shape |
| **Aliases** | Synced `source_aliases`, host-local confirm, append-only supersede | `schema.sql:108-119`; `confirmAlias.js` |
| **Fixed events** | `ProposedFixedEvent{confidence}`, committed as `anchor_activities` rows | `fixedEvents.js:47`; `ingest.js:687-695` |
| **Activity rules** | Inferred at ingest, written to engine-consumed columns | `activityRules.js`; `ingest.js:590` writes `priority`/`min_per_week` |
| **Locations** | A single free-text `activities.location TEXT` column; **no `locations` table** | `schema.sql:243`; confirmed no `CREATE TABLE ... locations` exists |

### Q3 — Where does current UI expose internal inference state directly to the director?

`src/screens/ImportScreen.jsx` (1734 lines) leaks parser machinery in at least 8 places:

1. `895-899` — raw `×N` observation counts on entity chips.
2. `867-873` — "X appeared only once… likely a misread" (parser confidence heuristic as prose).
3. `846-852` — `orientation.confident` narration ("Read as one page per group…" / "Could not tell how this file is laid out").
4. `900-911` — `isPinOnly`/`isDualUse` routing-classifier subtext.
5. `1036-1041` — fixed-event confidence prose ("appeared on a majority… but not all").
6. `1703-1707` — "Shoresh couldn't tell from this file's layout which groups do which activity."
7. `930-987` — group-unit override 3-state machinery as a raw per-row `<select>`.
8. `ReconciliationLedger.jsx:173-177` — internal conflict-reason enum (`ambiguous_identity`, `missing_target`) falls through to `String(reason).replace(/_/g,' ')` shown to the director.

### Q4 — Can existing output become a reconciliation report WITHOUT rewriting the importer?

**Yes.** `buildPlan.js` already emits a serializable list of `{op, entity, fields, evidence}` items,
and `ReconciliationLedger.jsx` already renders collapsible reassurance-vs-exception sections
(`LedgerSection`, glyph+count+disclosure, `ReconciliationLedger.jsx:46-81`). The report is an
**aggregation layer above the existing plan output**, not an importer rewrite. Two gaps:

- The ledger groups rows by **CRUD op** (`create/update/unchanged/clear/conflict`), not by the brief's
  **semantic** categories (UNDERSTOOD / NEEDS ATTENTION / NOT IN SOURCE / CHANGED). `update`+`clear`≈CHANGED,
  `create`≈understood-new, `conflict`≈NEEDS ATTENTION, but **NOT IN SOURCE has no representation**
  (that category comes from readiness `FORWARD_AREAS`, not the plan).
- The ledger currently sits *after* the full per-entity tick-review, as a confirmation — the brief
  wants it *instead of* that as the primary destination.

The compression layer consumes: `plan.items[]` (op + fields + evidence) **plus** the confidence/state
signals the ADR adds **plus** `getReadiness()` for the NOT-IN-SOURCE category.

### Q5 — What gets inferred WITHOUT sufficient evidence?

- **Priority (worst):** `activityRules.js:82` `priority = share >= 0.8 ? 'high' : 'low'` — a **forced
  binary on every activity**, no "insufficient evidence" branch. Written to the engine-consumed
  `activities.priority` column indistinguishably from a director's explicit choice.
- **Frequency:** `activityRules.js:77-79` `perWeek = Math.round(...)`, floored to ≥1; `max = perWeek+1`
  fixed heuristic; `ingest.js:600-604` forces `min_per_week=1` even when the rule computed falsy.
- **Eligibility:** `activityRules.js:71-72` low-evidence → `eligible_group_names=null` ("all groups").
  Safer (null = engine-tolerant), and it DOES carry `eligibility_known:false` — but nothing downstream
  reads that flag (`buildPlan`, preview UI, ledger all ignore it: a dead signal).

### Q6 — Where is "high priority" assigned and on what basis?

Exactly one place: `activityRules.js:82`, on the basis of `activityUnitShare >= 0.8` — i.e. **how large
a share of a unit's activity-instances this activity occupies**. This is *frequency/prevalence*, and
the brief's explicit non-goal is `frequent != high priority`. Confirmed by Red Hat and Reviewer as a
manufactured-certainty violation baked down to the engine's two-valued contract.

### Q7 — Can UNKNOWN be explicit without breaking the schedule engine?

**Yes for every field the engine reads, EXCEPT `priority`.** `src/engine/buildSchedule.js` already
null-tolerates: `eligible_tier_ids/group_ids` → `|| []` (lines 88-89, 429-430), `prefer_before_day`
`== null` guards (291, 385, 481), `min_per_week` `?? 0` (464), `location` only branches when truthy
(224, 233, 269). The one exception: `runRound(slotsToFill, priority)` filters
`priority === 'high'|'low'` (line 302) — a third/absent value silently makes an activity unplaceable
(the code's own comment at `activityRules.js:19-21` records this was fixed once already). So UNKNOWN
priority needs either a real engine change (a third bucket) or a **generation-time default** applied
outside the engine (resolve absent→low-but-flagged) that never writes a manufactured value into the
column. The ADR recommends the latter for Phase B.

### Q8 — How do confirmed decisions survive re-import today?

Mechanism exists and is tested, but coverage is uneven:

- **Works:** `operations.source='human'` + Policy A field-hold. A protected field whose incoming import
  value differs from a prior hand-edit becomes `op:'conflict', reason:'stale'` (held, not overwritten)
  — `ingest.s2b.test.js` F6, `ingest.unit-provenance.test.js`, `ingest.activityRuleProvenance.test.js`.
- **Gap 1 (field coverage):** the protected-field list at `electron/ops/ingest.js:179` is scoped to
  `activities:['priority','min_per_week','max_per_week','location','eligible_group_ids']`. Groups'
  `tier_id`, tiers, and fixed events are **not** in it (Architect).
- **Gap 2 (deleted fixed events resurrect — HIGH, Red Hat Risk 1):** `deleteRecord.js:236-240` hard-deletes
  an `anchor_activities` row (no tombstone); `ingest.js:687-695` rebuilds anchors only from live rows,
  and recognizes by slot-key presence. A director who **rejects** an inferred fixed event has that
  rejection silently reversed by the next re-import. This is a real destructive-reconciliation bug, not
  a UX gap.

### Q9 — Which Setup Readiness concepts should be reused?

All of them — do not rebuild. `src/engine/readiness.js` already implements the required-vs-optional
distinction: a six-state model (`ready/needs-attention/missing/optional/not-applicable/in-progress`)
with `getSetupGaps` as the untouched blocking-truth core, and `FORWARD_AREAS` (`readiness.js:137-149`)
already registering `location`/`staffing` as never-Missing. This is Q9, most of Q10, and part of Q11,
already answered in code + `docs/work/onboarding-reconciliation/S5-READINESS-HUB-DESIGN.md`. The
NOT-IN-SOURCE report category should be **derived from readiness FORWARD_AREAS**, not from the plan.

### Q10 — Minimal architectural decisions needed NOW for future facility-map?

Very little — the posture is already correct. `readiness.js` FORWARD_AREAS treats location as optional
enrichment (a missing location is not an ingestion failure — exactly the brief's stance). Minimal now:
- **Do NOT** promote `activities.location` to a FK yet (no `locations` table; brief says no GIS now).
- **Do** ensure any new confidence/state wrapper treats `location` as UNKNOWN-by-default and never
  infers-and-writes it from a schedule grid (`fieldUpdate.js:71` already only sets location when a rule
  names it explicitly — never inferred; preserve that).
- **Note for a future session:** `source_aliases.entity_type` (`schema.sql:111`) is a closed enum
  validated against `INGESTIBLE_ENTITIES` (`extractEntities.js:22-24`); a future `locations` ingestible
  type grows *there*. One-line ADR note, no change now. (Prior program's S3 already designs
  `activity_locations` + nullable `location_id` soft-migrate; defer to it.)

### Q11 — Are locations first-class today?

**No.** `location` is a single free-text column on `activities` (`schema.sql:243`), read by the engine
only as a string collision key (`buildSchedule.js:186,202,224-273`). No `locations`/`activity_locations`
table exists (confirmed by scanning every `CREATE TABLE` in `schema.sql`). First-classing is designed
but not built — it is prior-program slice **S3** (`IMPLEMENTATION_SEQUENCE.md:93-97`), an engine slice
deferred by decision. This initiative should not pull it forward; it should preserve room for it (Q10).

### Q12 — What tests protect re-import / idempotency / reconciliation?

Strong on mechanics, weak on the brief's new semantics (Tester). Covered: same-source re-import = zero
ops (`ingest.t72.test.js`, `ingest.s2b.test.js` F4, `workbookToSource.test.js`); human-edit protection
across re-import (`ingest.unit-provenance.test.js`, `ingest.s2c.test.js`, `ingest.s2b.test.js` F6);
inference thresholds (`activityRules.test.js`, `fixedEvents.test.js`); alias tiers
(`buildPlan.aliasTier.test.js`, `confirmAlias.test.js`, `ingest.s1b.test.js`); held-conflict round-trip
(`ingest.t73.test.js`). **Missing (highest risk for this initiative):** no test that a no-evidence field
stays UNKNOWN rather than defaulted; no test that `frequent != high priority`; no test of a modified
source surfacing a CHANGED signal; no reconciliation-report bucketing/compression test; no multi-source
enrichment test; no engine bridge test that inferred priority actually changes scheduling.

### Q13 — DOMAIN vs PRESENTATION

See the dedicated table below (§DOMAIN vs PRESENTATION).

---

## Six-perspective findings (condensed; full evidence above)

- **ARCHITECT:** The four states should be **derived from existing signals, not a new stored enum.**
  CONFIRMED = `operations.source='human'`; INFERRED vs OBSERVED-fact is the one distinction missing
  within `source='import'`; UNKNOWN = column never written (already schema-representable). The real new
  storage is **persisting the evidence bundle** so "why?" survives the session. Confidence is currently
  two incompatible schemes that must be unified before Phase C consumes them. Priority forced-binary is
  the highest-leverage domain fix and the one field the engine can't take as UNKNOWN without a change.
- **UI/UX AUDITOR:** Flow is inverted (tick-review-first, summary-second). A typical import surfaces
  **~70-150 discrete review interactions** before the director reaches the ledger. `ActivityRuleRow`
  (`ImportScreen.jsx:1585-1734`) is a near-literal instance of the brief's rejected "configure Swim
  [freq][priority][groups]" form, rendered per approved activity regardless of confidence. No true
  HIGH/MEDIUM/LOW tier exists — only scattered binaries. `LedgerSection` is reusable scaffolding for the
  target report; the content model beneath it needs a new semantic-category aggregation.
- **RED HAT:** HIGH — deleted fixed events resurrect on re-import (no tombstone; Risk 1). HIGH — priority
  is manufactured certainty with no UNKNOWN, baked to the engine contract (Risk 2). MEDIUM — min/max_per_week
  become binding constraints from raw counts (Risk 3). MEDIUM — fixed-event group-scope drift on re-import
  is silently ignored by design (Risk 4). LOW — hold-the-whole-import gate is incompatible with
  "resolve one decision, the rest already landed" without an incremental-commit primitive (Risk 5).
- **SECURITY:** **No vulnerabilities.** Formula/CSV-injection sanitizer implemented and wired
  (`exportSanitize.js:14-42`, import-side unescape `workbookToSource.js:27-31`); cells never evaluated
  (SheetJS `raw:false`, string ops only); size/complexity caps before parse (`IMPORT_LIMITS`,
  `assertImportFileSize`/`assertWorkbookComplexity`); parsing in renderer, only structured proposal
  crosses IPC; `ingest-commit` is admin-only + host-only (`main.js:239-247`); SQL identifiers all traced
  to frozen `INGESTIBLE_ENTITIES`. Forward note only: future PDF/image/map ingestion is a new binary
  attack surface needing its own review **at design time** — do not build now.
- **TESTER:** ~70% of critical mechanics covered; ~50% of decision-compression behaviors. Highest-risk
  untested: UNKNOWN-state preservation, source-change (CHANGED) detection, report compression metric,
  multi-source enrichment, and the inference→engine bridge.
- **REVIEWER:** The initiative must **consolidate, not add.** Reconcile against
  `docs/work/onboarding-reconciliation/` before any ticket decomposition or the "second parallel model"
  becomes the likely failure mode. Three confidence mechanisms should collapse onto one primitive. The
  auto-accept policy (`ImportScreen.jsx:130,284-299` filtering `confidence==='high'`) is domain logic
  wrongly living in the UI — extract before any CLI/MCP. Reuse: `buildPlan` evidence/provenance,
  `readiness` six-state, `ReconciliationLedger` section pattern.

---

## DOMAIN vs PRESENTATION (Q13)

| Change | Class | Why | Needs ADR? |
|---|---|---|---|
| Un-force `priority` from forced high/low into an evidence-gated value; allow UNKNOWN | **DOMAIN** | Touches engine two-valued contract (`buildSchedule.js:302`) + `activities.priority` column | **Yes** |
| Distinguish OBSERVED-fact from INFERRED-rule within `source='import'` | **DOMAIN** | New read semantics other code depends on (report, "why?") | **Yes** |
| Persist the observation/evidence bundle past the import session | **DOMAIN** | New persistent data shape | **Yes** |
| Extend protected-field list to groups.tier_id + fixed events | **DOMAIN** | Changes re-import overwrite behavior | Yes (small) |
| Fixed-event rejection tombstone (stop resurrection) | **DOMAIN** | New durable record + commit-path change | **Yes** |
| Unify three confidence schemes onto one primitive | **DOMAIN** | Contract other stages consume | Yes (small) |
| Extract auto-accept policy from UI into domain fn | **DOMAIN (refactor)** | CLI/MCP seam; brief's "no semantics in UI" | No (refactor) |
| Reconciliation report (UNDERSTOOD/NEEDS ATTENTION/NOT IN SOURCE/CHANGED counts) | **PRESENTATION** | Aggregation/read view over plan + state + readiness | No |
| "Looks right / Edit" proposal cards replacing per-field forms | **PRESENTATION** | Rendering of MEDIUM-confidence proposals | No |
| Confidence→attention gating (HIGH silent, MEDIUM propose, LOW ask) | **PRESENTATION** | Which proposals render as decisions | No |
| Progressive "Why does Shoresh think this?" disclosure | **PRESENTATION** | Renders persisted evidence (once domain change lands) | No |
| Report-first flow reorder; demote per-entity tick walls to advanced | **PRESENTATION** | Sequencing | No |
| Setup Readiness NOT-IN-SOURCE messaging | **PRESENTATION** | `readiness.js` already correct at domain layer | No |

---

## What already exists vs what must change

**Exists (reuse, do not rebuild):** the field-delta `ReconciliationPlan` (`buildPlan.js`); per-field
import/human provenance (`operations.source`); `source_aliases` identity + alias tiers; held-conflict
resolution + round-trip (T73); the `ReconciliationLedger` section/disclosure pattern; the six-state
Setup Readiness model + FORWARD_AREAS; the whole security envelope (sanitizer, caps, IPC auth); and the
prior program's 15 synthesis docs (especially `RECONCILIATION_ARCHITECTURE.md` foundations A–D and
`S5-READINESS-HUB-DESIGN.md`).

**Must change (the three real deltas + their consequences):**
1. **Four-state model** — split OBSERVED-fact from INFERRED-rule; make UNKNOWN first-class and readable.
2. **Stop manufacturing certainty** — priority becomes evidence-gated with a real UNKNOWN; frequency
   carries confidence; surface the already-computed-but-dead `eligibility_known` signal.
3. **Evidence survives commit** — persist the observation bundle so "why?" is answerable post-session.
4. Consequences: broaden protected fields; add a fixed-event rejection tombstone (fixes Red Hat Risk 1);
   unify confidence onto one primitive; then build the presentation compression (report + proposals).
