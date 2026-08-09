---
title: "Import & Reconciliation Research — Concept-Extraction Memo"
document_type: research
status: draft
created: 2026-08-08
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
program: onboarding-reconciliation
archive_when: superseded by an approved implementation plan
---

# Import & Reconciliation Research

> **Citation note:** the source systems and mechanisms below are accurate as researched 2026-08-08. Some
> URLs cited by product name only (OneSchema/Flatfile/CSVBox, dbt, Meltano, Splink, dedupe.io, MPI,
> minimal-viable-lineage) are best-effort domain roots reconstructed during drafting — **verify the exact
> link before quoting**. The Salesforce, Gearset, Dataverse, Airtable, and django-import-export URLs were
> given directly by the research and are exact.

A consolidated concept-extraction memo behind the Onboarding & Reconciliation design. It surveys how
established import/reconciliation systems solve each problem, states the mechanism, and records **what
Shoresh takes** along with the **local-first fit caveats** that make Shoresh's answer differ. Siblings:
[`../ONBOARDING_MODEL.md`](../ONBOARDING_MODEL.md) (framing) and
[`../IMPLEMENTATION_SEQUENCE.md`](../IMPLEMENTATION_SEQUENCE.md) (build order).

Shoresh is **local-first**: an append-only op-log replicated across devices, committed atomically by a
single privileged host. That shapes every borrowing below — most importantly, anything **nondeterministic**
(e.g. probabilistic fuzzy matching) would desync the op-log across devices, so it can only ever be a
suggestion-ranker, never an auto-commit.

## Concepts

### Upsert / external-id matching

- **Sources:** Salesforce (External-Id upsert), Microsoft Dataverse (alternate keys),
  django-import-export (`import_id_fields`), dbt snapshots / Singer-Meltano (`unique_key` / `primary_key`).
- **Mechanism:** a stable external key identifies whether an incoming row is a create or an update, so
  re-import matches existing records instead of duplicating them.
- **What Shoresh takes:** the deterministic key hierarchy — Shoresh UUID → source-id → confirmed alias →
  exact-normalized-name → human-confirmed → new — and keyed upsert semantics.
- **Local-first caveat:** the **source-id tier is dormant** until the S4 workbook round-trip, because the
  camp files as delivered carry no stable ids; before then, exact-normalized-name plus human confirmation
  do the matching. Matching is always scoped to entity type.

### Blank vs null vs clear

- **Sources:** Dataverse (unmapped columns left untouched), Salesforce ("Insert Null Values" mode).
- **Mechanism:** distinguishing "field not supplied" from "field explicitly emptied." Dataverse leaves
  unmapped columns untouched; Salesforce offers a global null-insert switch.
- **What Shoresh takes:** default is **absent/blank LEAVES UNTOUCHED and emits no op**, so it can't clobber
  a concurrent edit. **Clear requires an affirmative, visible, per-cell intent** (a `<clear>` sentinel token
  or a dedicated column).
- **Local-first caveat:** an empty spreadsheet cell is **both blank and clear** — the tri-state has no
  encoding in plain xlsx, so S4's workbook needs the explicit clear token, decided before S4. Salesforce's
  global hidden mode switch is rejected as a footgun for a non-technical director.

### Dry-run diff / fix-in-grid preview

- **Sources:** django-import-export (`dry_run` + `RowResult` new/update/skip/error/invalid),
  OneSchema / Flatfile / CSVBox (fix-in-grid preview).
- **Mechanism:** compute the outcome without writing, present a per-row classification and a place to fix
  errors before commit.
- **What Shoresh takes:** the preview is a **pure function → diff object** (no ops), re-run verbatim at
  commit, classifying New / Updated / Unchanged / Clear / Conflict with field before→after. Preview and
  commit are provably identical via the computed op-set.
- **Local-first caveat:** the diff is **pinned to a base version**; rows whose state changed because a
  remote op landed during the review window are recomputed and re-surfaced.

### Relationship imports

- **Sources:** django-import-export, general ETL practice.
- **Mechanism:** child rows reference parents by a match key; parents are imported before children;
  unresolved references are collected rather than silently dropped.
- **What Shoresh takes:** relationship resolution by match key, **parents before children**, with
  **unresolved references as their own error bucket** ("not found in the schedule" is distinct from "parser
  failed" — a source may simply not contain a concept, e.g. cohorts/Programs absent from weekly grids).

### Idempotency

- **Sources:** dbt snapshots (SCD2 + `unique_key` merge), Singer / Meltano (`primary_key` + bookmark).
- **Mechanism:** a stable key plus keyed merge means re-running the same input produces no change;
  ordering is driven by source state, not arrival order.
- **What Shoresh takes:** stable key + keyed upsert op; an identical source yields **all-Unchanged → zero
  ops**; ordering is decided by **source generation, not arrival**.
- **Local-first caveat:** deterministic ordering by source generation is what keeps the replicated op-log
  identical across devices.

### Entity resolution with a human-review band

- **Sources:** Splink (probabilistic vs deterministic matching + a human review band), dedupe.io
  (human-in-the-loop).
- **Mechanism:** confident matches auto-resolve, a middle band of uncertain matches is routed to a human,
  and learned probabilistic models score candidates.
- **What Shoresh takes:** the **human-review band** for ambiguous identity, surfaced as an equal-weight
  confirm-identity decision ("Same — update" / "Different — add new" / "Skip for now"); **fuzzy is a
  suggestion-ranker only** (cheap string-similarity), never auto-commit.
- **Local-first caveat:** learned probabilistic models and blocking are **dropped** — the scale is too
  small to warrant them, and fuzzy scoring is **nondeterministic, so it would desync the op-log across
  devices**. Ambiguous matches are never auto-merged.

### Translation-memory reversibility (aliases)

- **Sources:** Master Patient Index (MPI) identity crosswalk + reversibility; translation-memory practice.
- **Mechanism:** a durable crosswalk remembers how a source label maps to a canonical entity, and the
  mapping can be revised or revoked.
- **What Shoresh takes:** the `source_aliases` crosswalk — **reviewable and revocable**, append-only
  supersede/tombstone (never hard-delete), shown each time it fires, and never silently outranking an
  exact-name match to a *different* live entity.
- **Local-first caveat:** divergent cross-device confirmations of the same `source_label` do **not** collide
  under `detectConflict` (which keys on entity_id/field), so an alias disagreement is surfaced as a
  reviewable conflict (Constitution Article V), not last-writer-wins.

### Cross-source per-field authority

- **Sources:** Airtable (merge-on-a-field — its *silent* multi-update is flagged as the anti-pattern to
  avoid), MPI crosswalk practice.
- **Mechanism:** when multiple sources describe the same entity, define which source is authoritative for
  which field; disagreements are surfaced rather than blindly merged.
- **What Shoresh takes:** **per-field authority by source family** (schedule authoritative for placements,
  location-config for locations, staffing for assignments); disagreement is a **first-class Conflict**, and
  the Plan holds the competing values (value A from schedule, value B from facility).
- **Local-first caveat:** Airtable's silent multi-update is explicitly the anti-pattern — Shoresh never
  merges silently; the competing values live in the Plan for human resolution.

### Minimal provenance (enum, not score)

- **Sources:** minimal-viable-lineage practice; DUPLICATE_VALUE vs DUPLICATE_EXTERNAL_ID handling (Gearset,
  on Salesforce upsert error semantics).
- **Mechanism:** record just enough lineage to answer "where did this come from and is it trustworthy,"
  without a heavyweight per-field confidence store.
- **What Shoresh takes:** **two per-row columns (`confirmed`, `source`), enum not score**, written through
  `appendOp`; the op-log already persists field-level author/device/timestamp, so no separate confidence
  table is needed. This yields the three looks: inferred (muted) / confirmed (full) / unknown (full +
  "worth checking").
- **Local-first caveat:** `confirmed` answers *who*, not *when*, so it cannot by itself protect against
  stale overwrites — the staleness clock (op-log seq + base-generation stamp) is the separate,
  time-shaped mechanism that turns an older-than-current supplied value into a Conflict.

## Citations

- Salesforce External-Id upsert — https://help.salesforce.com/s/articleView?id=000320964
- DUPLICATE_VALUE vs DUPLICATE_EXTERNAL_ID (Gearset) — https://gearset.com/blog/
- Microsoft Dataverse alternate keys + unmapped-columns-untouched — https://learn.microsoft.com
- Airtable merge-on-a-field (silent multi-update anti-pattern) — https://support.airtable.com
- OneSchema fix-in-grid preview — https://www.oneschema.co
- Flatfile fix-in-grid preview — https://flatfile.com
- CSVBox fix-in-grid preview — https://csvbox.io
- django-import-export (dry_run, RowResult new/update/skip/error/invalid, import_id_fields, skip_unchanged) — https://django-import-export.readthedocs.io
- dbt snapshots (SCD2 + unique_key merge) — https://docs.getdbt.com/docs/build/snapshots
- Singer / Meltano (primary_key + bookmark idempotency) — https://sdk.meltano.com
- Splink (probabilistic vs deterministic + human review band) — https://moj-analytical-services.github.io/splink/
- dedupe.io (human-in-the-loop) — https://dedupe.io
- Master Patient Index (MPI) identity crosswalk + reversibility — https://en.wikipedia.org/wiki/Enterprise_master_patient_index
- Minimal-viable-lineage (enum not score) — https://en.wikipedia.org/wiki/Data_lineage
