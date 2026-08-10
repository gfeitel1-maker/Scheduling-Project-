---
title: "ADR: Ingestion Reconciliation Semantics — OBSERVED / INFERRED / CONFIRMED / UNKNOWN"
status: proposed
date: 2026-08-10
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
supersedes: []
extends: [docs/work/onboarding-reconciliation/RECONCILIATION_ARCHITECTURE.md, docs/adr/2026-08-06-inferred-activity-rules-at-ingest.md]
related_discovery: docs/work/specs/2026-08-10-ingestion-phaseA-discovery.md
program: ingestion-reconciliation
---

# ADR: Ingestion Reconciliation Semantics

**Status: PROPOSED — awaiting product-owner approval. No production code is authorized by this ADR.**

## Context

The founding brief (`docs/work/specs/2026-08-09-ingestion-reconciliation-brief.md`) asks Shoresh to
compress hundreds of schedule observations into a reconstructed camp model plus a *small number of
genuine decisions*, distinguishing four information states — OBSERVED, INFERRED, CONFIRMED, UNKNOWN —
where **UNKNOWN is valid and Shoresh must never manufacture certainty**.

Phase A discovery (`docs/work/specs/2026-08-10-ingestion-phaseA-discovery.md`) found that the
reconciliation *mechanics* already exist and are largely landed via the prior
`onboarding-reconciliation` program: the field-delta `ReconciliationPlan` (`src/ingest/buildPlan.js`),
per-field import/human provenance (`operations.source`), `source_aliases` identity, held-conflict
resolution (T73), and the six-state Setup Readiness model (`src/engine/readiness.js`). It also found
three genuine gaps against the brief, and one active bug.

This ADR proposes the semantics that close those gaps **as extensions of the existing spine**. Its
governing constraint is the brief's and Reviewer's shared warning: **do not build a second parallel
model.** Where the prior program already decided something (foundations A–D, readiness six-state,
location slice S3), this ADR defers to it and cites it.

## Decision

### D1 — The four states are DERIVED from existing signals, not a new stored enum

We do **not** add a `state` column. OBSERVED/INFERRED/CONFIRMED/UNKNOWN are computed at read time from
signals that already exist (or are added minimally by D2–D3):

| State | Derivation | Backing signal |
|---|---|---|
| **CONFIRMED** | field's latest op has `source='human'` | `operations.source` (schema v29) — already exists |
| **INFERRED** | `source='import'` AND value came from a heuristic rule (activityRules/fixedEvents), not a literal grid fact | requires the OBSERVED-vs-INFERRED tag of D2 |
| **OBSERVED** | `source='import'` AND value is a literal fact read from the source (a name that appeared, a cell) | requires D2 tag |
| **UNKNOWN** | field never written — column NULL, no op | already representable; the fix is that the importer must *stop writing manufactured values* (D4) |

This reuses `RECONCILIATION_ARCHITECTURE.md` Foundation C (per-row `source`/`confirmed`, "enum not
score") and extends it with exactly one new distinction — OBSERVED-fact vs INFERRED-rule — which that
program collapsed. A separate confidence/state table is rejected: the op-log already persists
field-level author/device/timestamp, so state is derivable, and a parallel table is precisely the
duplication the brief forbids.

**Open question for the owner (OQ1):** is the OBSERVED-vs-INFERRED distinction stored as (a) a widened
`operations.source` enum (`import_observed` | `import_inferred` | `human`), or (b) a property of the
persisted evidence record (D3) that the read layer joins against? Recommendation: **(b)** — it keeps
`operations.source` stable and puts the "why" next to the evidence. Confidence: medium.

### D2 — Confidence is one primitive, computed in the domain, driving director attention

Today three incompatible schemes exist: `activityRules.js:82` (priority threshold 0.8),
`fixedEvents.js:46` (`confidence:'high'|'low'`), `preview.js:107-111` (`lowConfidence` boolean). We
introduce **one** confidence primitive (a small domain module, e.g. `src/ingest/confidence.js`, or a
field on `buildPlan` items — the existing `evidence` field is the natural home) that these call sites
normalize into, with three tiers mapping to the brief's attention model:

- **HIGH** → reconstruct silently; appears only in the UNDERSTOOD count. No decision surfaced.
- **MEDIUM** → a "Looks right / Edit" proposal (not a form).
- **LOW / CONFLICT** → a focused decision surfaced in NEEDS ATTENTION.

The auto-accept policy currently living in the UI (`ImportScreen.jsx:130,284-299`) moves into this
domain module so a future CLI/MCP inherits it (brief: "no critical semantics exclusively in UI").
This is DOMAIN (a contract other stages consume) but requires no schema change.

### D3 — Evidence survives commit (persist the observation bundle)

Today the observation layer (`extractEntities.js` `seenCounts`/`activityPages`;
`fixedEvents.js:66-79` `occupied`/`operatingDays`) is transient and discarded when the import session
ends, so "Why does Shoresh think this?" is **unanswerable after commit** — directly violating the
brief's transparency principle. We persist a per-import-run evidence record keyed to the entities/fields
it justifies, so the reconciliation report and progressive-disclosure "why?" panels read real evidence.

This is the one genuinely **new persistent data shape** and the part most likely to need its own
focused ADR under the Constitution's ADR bar. It must be host-local or synced consistently with how
`source_aliases` is handled; it must not become a second provenance system (it *annotates* provenance,
it does not replace `operations.source`).

**Open question (OQ2):** synced entity (like `source_aliases`) or host-local artifact? Evidence is
large and import-run-scoped; it does not need to drive engine behavior. Recommendation: **host-local,
projected for read**, revisited if multi-device "why?" is required. Confidence: low — owner/Architect
call in the D3 sub-ADR.

### D4 — Priority stops being manufactured; UNKNOWN never reaches the engine as a fake value

`activityRules.js:82` forces every activity to `high|low` from prevalence (`share>=0.8`) — the brief's
explicit `frequent != high priority` violation, written to the engine-consumed `activities.priority`
column indistinguishably from a director's choice. We change inference to emit **UNKNOWN priority when
evidence is insufficient** and never write a manufactured value pre-confirmation.

Because `buildSchedule.js:302` (`runRound` filtering `priority==='high'|'low'`) cannot accept a third
value, we resolve UNKNOWN priority to a **safe default at generation time, outside the engine and
outside the stored column** — treat absent priority as low-but-flagged-NEEDS-ATTENTION. The engine is
untouched; the column stays NULL until a director confirms; the report surfaces the decision. The
symmetric treatment applies to frequency (`min/max_per_week`): carry confidence, and stop `ingest.js:600-604`
force-defaulting `min_per_week=1` where that manufactures a binding constraint.

**Open question (OQ3):** does the owner prefer (a) generation-time default (engine untouched, recommended,
low risk) or (b) a real engine change adding an unknown-priority bucket? Recommendation: **(a)** for
Phase B; (b) only if directors need unknown-priority activities to schedule distinctly. Confidence: high in (a).

### D5 — Confirmed decisions survive re-import uniformly; rejections are durable

Extend the protected-field list (`ingest.js:179`, currently activities-only) to `groups.tier_id`,
tiers, and fixed events, so CONFIRMED persists across re-import for every entity — the explicit backing
for the brief's "confirmed decisions survive re-import," not an incidental side effect. **Additionally,
fix the deleted-fixed-event resurrection bug (discovery Red Hat Risk 1, HIGH):** a director's rejection
of an inferred fixed event must leave a durable tombstone so re-import does not silently recreate it
(`deleteRecord.js:236-240` hard-deletes; `ingest.js:687-695` rebuilds from live rows only). This reuses
the append-only supersede/tombstone discipline already used for `source_aliases`.

### D6 — The reconciliation report is an aggregation over existing outputs (PRESENTATION)

UNDERSTOOD / NEEDS ATTENTION / NOT IN SOURCE / CHANGED is a read view, not an importer rewrite (Q4):
- UNDERSTOOD ← HIGH-confidence plan items (`create`/`unchanged`).
- NEEDS ATTENTION ← LOW/CONFLICT items + held conflicts.
- CHANGED ← `update`/`clear` items with a `from`≠`to`.
- NOT IN SOURCE ← `readiness.js` FORWARD_AREAS (location/staffing), **not** the plan.

It reuses `ReconciliationLedger.jsx`'s `LedgerSection` pattern with a new semantic-category aggregation
above it, and becomes the **primary post-import destination**, demoting per-entity tick-walls and
`ActivityRuleRow` forms to on-demand "advanced/inspect" affordances reached from a decision.

### D7 — Future facility-map: preserve room, build nothing

No `locations` table now (Q10/Q11). Keep `activities.location` as free text; keep `readiness.js`
FORWARD_AREAS treating location as optional-not-blocking; never infer-and-write location from a schedule
grid. First-classing (`activity_locations` + nullable `location_id` soft-migrate) is the prior program's
slice **S3** — deferred, not pulled forward. One-line forward note: a future `locations` ingestible type
grows at `source_aliases.entity_type` / `INGESTIBLE_ENTITIES` (`extractEntities.js:22-24`).

## Consequences

- **Positive:** director workload becomes proportional to genuine uncertainty; "why?" is answerable
  post-commit; the priority/`frequent` anti-pattern is removed; a real re-import bug (rejection
  resurrection) is fixed; no parallel model is created; the security envelope is untouched.
- **Costs / risks:** D3 (evidence persistence) is new storage needing its own sub-ADR and migration;
  D4 requires care that generation-time defaults never leak back into stored columns; D5's tombstone
  touches the commit path (test-first at that seam). All changes are additive/reversible except the
  evidence-persistence migration.
- **Explicitly NOT decided here (deferred to prior program or later):** location first-classing (S3),
  staffing model (S6), map/paste adapters (S7), MCP/CLI (seam only), engine enforcement of new
  constraints (its own slice).

## Recommended Phase B/C/D decomposition (domain before UI)

Dependency-ordered; each slice is test-first at its seam, on a child worktree off this integration
branch, merged to the integration branch (never straight to `main`) after review + Verifier gate.

**Phase B — DOMAIN (must land before any UI):**
- **B0 — Reconcile & confirm baseline.** Diff this brief against `docs/work/onboarding-reconciliation/`
  landed state; confirm which spine pieces are on `main` vs the onboarding branch. *Blocks everything.*
- **B1 — One confidence primitive** (D2). Unify the three schemes; surface `eligibility_known`. Extract
  auto-accept policy out of `ImportScreen.jsx`. Depends: B0.
- **B2 — Priority/frequency de-manufacturing** (D4). UNKNOWN priority; generation-time default; stop
  min_per_week force-default. Test: `frequent != high priority`; UNKNOWN stays UNKNOWN. Depends: B1.
- **B3 — Protected-field + rejection tombstone** (D5). Broaden `ingest.js:179`; fixed-event rejection
  durability. Test: deleted fixed event does not resurrect on re-import. Depends: B0.
- **B4 — Evidence persistence** (D3) — *own sub-ADR first* (OQ2). New storage + migration. Depends: B1.
- **B5 — OBSERVED-vs-INFERRED tag** (D1/OQ1). Depends: B4.

**Phase C — COMPRESSION LAYER (read/aggregation):**
- **C1 — Semantic-category aggregation** over `plan.items` + confidence + readiness → the four report
  buckets, including CHANGED via `from`≠`to` and NOT-IN-SOURCE via FORWARD_AREAS. Depends: B1–B5.
- **C2 — Director-decision generation** from LOW/CONFLICT + held items ("Looks right / Edit"). Depends: C1.

**Phase D — EXPERIENCE (presentation):**
- **D1 — Reconciliation report as primary destination** (D6), reusing `LedgerSection`; demote tick-walls.
- **D2 — Focused decision resolution** cards; progressive "why?" reading persisted evidence.
- **D3 — Setup Readiness integration** for NOT-IN-SOURCE ("Ready to build a week. Locations not configured.").

**Phase E — VALIDATION:** real import, re-import same, modified import (CHANGED), incomplete import
(UNKNOWN), multi-source enrichment, regression suite, UI/UX audit against the success test (decisions,
not fields).

## Open questions for the product owner

1. **OQ1 (D1):** store OBSERVED-vs-INFERRED as a widened `operations.source` enum, or as a property of
   the persisted evidence record? (Recommend: evidence-record property.)
2. **OQ2 (D3):** evidence bundle — synced entity or host-local artifact? (Recommend: host-local; own sub-ADR.)
3. **OQ3 (D4):** UNKNOWN priority — generation-time default (engine untouched) or a real engine bucket?
   (Recommend: generation-time default for Phase B.)
4. **OQ4 (Red Hat Risk 4):** should fixed-event group-scope drift on re-import surface as a CHANGED
   decision (brief's re-import philosophy) rather than being silently ignored by current design
   (`ingest.js:786-788`)? This contradicts an existing deliberate decision — owner must choose.
5. **OQ5 (Red Hat Risk 5):** the "hold-the-whole-import" gate is incompatible with "resolve one
   decision, the rest already landed." Accept the current all-or-nothing commit for now, or scope an
   incremental-commit primitive? (Affects whether Phase D can deliver true exception-driven review.)
6. **OQ6:** confirm this initiative is a *continuation/course-correction* of the
   `onboarding-reconciliation` program (recommended reading of the evidence), not a fresh initiative —
   so B0 reconciles rather than rebuilds.
