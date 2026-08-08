---
title: "Onboarding Model — Setup Readiness through Progressive Reconciliation"
document_type: synthesis
status: draft
created: 2026-08-08
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
program: onboarding-reconciliation
archive_when: superseded by an approved implementation plan
---

# Onboarding Model

This is the entry-point document for the Onboarding & Reconciliation program. It frames what
onboarding *means* in Shoresh, states the success predicate and the hard non-goals, and gives the
four foundations of the spine at a glance. It links to its siblings:

- [`IMPLEMENTATION_SEQUENCE.md`](IMPLEMENTATION_SEQUENCE.md) — the proposed strangler-fig build order and decision gate.
- [`research/IMPORT_RECONCILIATION_RESEARCH.md`](research/IMPORT_RECONCILIATION_RESEARCH.md) — the concept-extraction memo behind the design.

Everything here is consistent with, and subordinate to, the synthesis source of truth. Nothing in
this program is pre-approved: it stops at synthesis for product-owner approval before any production
implementation.

## What onboarding MEANS in Shoresh

Onboarding is **not "Import."** It is **progressive reconciliation**: a returning camp arrives with
the source materials it already keeps — a prior schedule, a facility list, a staffing sheet, in
whatever files it happens to have — and reaches a schedule-ready Shoresh setup by *reviewing and
correcting proposals*, never by opening dozens of records by hand. Re-importing a corrected source
**updates** prior work rather than duplicating or wiping it.

The enduring product concept is **Setup Readiness**, not a one-time import event. Directors provide
sources across days and weeks; the system continuously reconciles them into one Camp Model and
reports how close the camp is to schedule-ready. The experience is a **hub, not a wizard** — a linear
wizard punishes the real workflow, in which sources trickle in and get corrected over time.

The reconciliation lifecycle is a single arc, expressed as **states of one plan, not pages**:

> **read → propose → resolve → preview → commit → readiness**

More fully, as the director experiences it: **PROVIDE → REVIEW → RESOLVE → FILL → PREVIEW → COMMIT →
(READINESS hub).** The object the director looks at the whole time is one `ReconciliationPlan`; the
in-app editor and the enrichment workbook are two *renderings* of that same object, and both pass
through the identical non-skippable preview and atomic commit.

## Success predicate

A returning camp begins with the source materials it already keeps and reaches a **schedule-ready
Shoresh setup** by **reviewing/correcting proposals** — never opening dozens of records by hand — and
**re-importing a corrected source updates rather than duplicates or wipes** prior work.

The first genuinely usable version of this (the north-star acceptance scenario): a director re-imports
a corrected schedule, their hand-edits survive, and everything is reviewed before commit.

## Hard non-goals

These are out of scope by decision, not by omission. Adjacent findings become tickets, never scope creep.

- MCP / CLI surfaces (parked; the plan carries a seam for them but they are not built here).
- Electives; special-event / one-off-day scheduling.
- Full staff **scheduling** (onboarding *captures* durable staffing facts; scheduling staff is a future project).
- GIS / route optimization; coordinates, walking-distances, spatial optimization of any kind.
- Automatic fuzzy entity merges; learned/probabilistic matching or scheduling policy.
- Perfect arbitrary-PDF understanding.
- A generic plugin framework.
- Unrelated cleanup.

Two constraints deserve emphasis because they are easy to violate by accident:

- **Location is not to absorb the separate `is_outdoor` boolean.** Contention (two groups can't share a
  space at once) is distinct from indoor/outdoor, which stays its own field.
- **Staffing is never a blocking readiness category.** The schedule always generates with zero staffing.

## The four foundations of the spine (A–D) at a glance

The design rests on a four-part spine, validated by a seven-agent review pass plus reference research.
Each foundation is deliberately built out of material the codebase already has, so onboarding *extends*
the verified read→propose→preview→commit pipeline rather than rebuilding it.

- **A. Stable identity + `source_aliases`.** A synced, projected alias entity records how a source label
  maps to a Shoresh entity. Matching is a strict hierarchy: Shoresh UUID → source-id → confirmed alias →
  exact-normalized-name → human-confirmed → new. Matching is **always scoped to entity type** (a location
  label never matches an activity name), aliases are reviewable/revocable (append-only supersede/tombstone,
  never hard-delete), shown each time they fire, and never silently outrank an exact-name match to a
  *different* live entity. Ambiguous matches are never auto-merged.

- **B. `ReconciliationPlan` = a pure decision layer, never a write layer.** The plan is field-delta shaped
  so that commit translates it 1:1 into `appendOp` calls inside the *existing* single transaction — a
  coarser shape would recreate the bulk-replace parallel-write mess the codebase already paid to escape.
  Two boundary methods, `buildPlan(source)→Plan` and `commitPlan(Plan)→outcome`, keep the plan a
  serializable pure-data proposal that is re-validated at commit against the live DB. This is the future
  MCP/CLI seam, and it satisfies Constitution Article V (reviewed proposals re-validated at commit). It
  already exists in embryo as `buildPreview`.

- **C. Persisted provenance = two per-row columns (`confirmed`, `source`), enum not score.** Written through
  `appendOp`; the op-log already persists field-level author/device/timestamp, so no per-field confidence
  table is needed. This yields three visual "looks": **inferred** (muted) / **confirmed** (full) /
  **unknown** (full plus a "worth checking" cue — the absence of evidence must not masquerade as a muted
  confident default). A still-inferred record keeps its muted treatment after commit, so trust-state does
  not evaporate.

- **D. Happens-before / staleness.** `confirmed` answers *who*, not *when*, and structurally cannot provide
  overwrite-protection — so a **time-shaped** mechanism is added: op-log field timestamps/seq plus a
  base-generation stamp on exported sources and workbooks ("pin to base version-vector, warn on drift").
  A supplied value **older** than the field's current last-authoritative-write becomes a **Conflict**,
  never a silent Update. The edit path flips `confirmed=true` and stamps the clock, so a director's
  hand-edit is authoritative on re-import.

## Where the spine surfaces to the director

- **Setup Readiness hub.** The onboarding home base: `getSetupGaps` stays the untouched blocking-truth
  core, wrapped in an additive layer of **six named states** (Ready, Needs-attention, Missing, Optional,
  Not-applicable, In-progress) — never a percentage. The critical distinction the old binary model could
  not express is **Missing** (blocking, red, kept rare and loud) vs **Needs-attention** (bronze, resolvable).
  Each category offers two doors to the same room: *Review on screen* / *Download worksheet*. Locations and
  Staffing appear as Optional / Not-applicable, never blocking. A minimal read-only hub shell moves earlier
  in the build so that the first slices have somewhere to surface.

- **One reconciliation layer, two surfaces.** The in-app Needs-Attention editor (for decisions — identity,
  conflicts, judgment) and the enrichment workbook round-trip (for volume data entry) coexist behind one
  layer, share the six-state vocabulary, and both flow through the same non-skippable preview and atomic
  commit. The workbook is the plan exported as a sheet, pre-populated with what Shoresh already knows; it
  re-enters through the identical preview and is never a bypass path.

## Relationship to current state

Onboarding preserves the verified pipeline: read → propose → non-skippable preview → atomic
single-transaction commit; the shared grid intermediate; op-log commit via `appendOp`; the per-screen
template prior art; and the inference layer. It adds identity/merge/provenance/staleness, multi-source
reconciliation, and the Location and Staffing models. The two existing import paths (per-screen template
upload and clipboard) are unified behind the single reconciliation layer rather than left to diverge.
