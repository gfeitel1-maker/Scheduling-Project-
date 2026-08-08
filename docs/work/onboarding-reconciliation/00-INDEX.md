---
title: "Onboarding & Reconciliation — synthesis index"
document_type: synthesis
status: draft
created: 2026-08-08
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
program: onboarding-reconciliation
archive_when: superseded by an approved implementation plan
---

# Onboarding & Reconciliation — synthesis deliverables

Pre-implementation synthesis for the program that generalizes Shoresh's single-source schedule importer into a
**multi-source reconciler**. Produced 2026-08-08 from a current-state audit, a seven-lens independent team pass
(Architect · Red Hat · Security · Designer · Tester + two external-research sweeps), and product-owner decisions.

**Status: awaiting product-owner approval.** No production code has been written. These documents may live on the
`work/onboarding-reconciliation` integration branch before the gate; production behavior changes may not.

## Read in this order

| # | Document | What it answers |
|---|---|---|
| 1 | [00-HUMAN-SUMMARY.md](00-HUMAN-SUMMARY.md) | Two pages: what we're building, why, what survives, what's deferred, repo status |
| 2 | [ONBOARDING_MODEL.md](ONBOARDING_MODEL.md) | What onboarding *means* — progressive reconciliation, the four-foundation spine, non-goals |
| 3 | [CURRENT_INGESTION_CAPABILITIES.md](CURRENT_INGESTION_CAPABILITIES.md) | What exists today and must be preserved vs. what's absent |
| 4 | [SOURCE_FAMILIES.md](SOURCE_FAMILIES.md) | The five source families and each one's evidence boundary |
| 5 | [RECONCILIATION_ARCHITECTURE.md](RECONCILIATION_ARCHITECTURE.md) | The spine: ReconciliationPlan as decision-layer, field-delta commit, foundations A–D |
| 6 | [MATCH_AND_MERGE_SEMANTICS.md](MATCH_AND_MERGE_SEMANTICS.md) | Identity hierarchy, blank/clear, staleness, idempotency, cross-source authority |
| 7 | [SETUP_READINESS.md](SETUP_READINESS.md) | Readiness as the onboarding hub; six states, not a percentage |
| 8 | [LOCATION_AND_CAMP_MAP_FINDINGS.md](LOCATION_AND_CAMP_MAP_FINDINGS.md) | Location first-class; the engine already uses it; the NO-GIS boundary |
| 9 | [STAFFING_ONBOARDING_FINDINGS.md](STAFFING_ONBOARDING_FINDINGS.md) | Requirement / assignment / availability; one model, soft-flag default |
| 10 | [ONBOARDING_UX_OPTIONS.md](ONBOARDING_UX_OPTIONS.md) | Hub-not-wizard, ledger-first preview, confirm-identity, two-pens-one-model |
| 11 | [IMPLEMENTATION_SEQUENCE.md](IMPLEMENTATION_SEQUENCE.md) | Strangler-fig slices S0–S7, the decision gate, and the STOP-for-approval |
| — | [research/IMPORT_RECONCILIATION_RESEARCH.md](research/IMPORT_RECONCILIATION_RESEARCH.md) | External concept-extraction memo (Salesforce, Dataverse, django-import-export, dbt, Splink, …) |

## The one-line thesis

*Bring the files your camp already keeps; Shoresh proposes what it can recover; you correct the genuine
ambiguities and fill gaps in bulk; re-importing a corrected file safely updates rather than duplicates or wipes.*

## Decision gate before any code

Product-owner approval of: the onboarding mental model, source-family model, reconciliation architecture,
matching & field-merge semantics, staleness rule, Setup Readiness, Excel/workbook role, Location recommendation,
map-assisted scope, staffing boundary, and the implementation sequence. See `IMPLEMENTATION_SEQUENCE.md` §decision-gate.
