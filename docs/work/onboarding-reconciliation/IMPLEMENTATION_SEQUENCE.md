---
title: "Implementation Sequence — Strangler-Fig Build Order & Decision Gate"
document_type: synthesis
status: draft
created: 2026-08-08
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
program: onboarding-reconciliation
archive_when: superseded by an approved implementation plan
---

# Implementation Sequence

This document proposes the build order for the Onboarding & Reconciliation program and the decision
gate that precedes it. It is the sibling of [`ONBOARDING_MODEL.md`](ONBOARDING_MODEL.md) (the framing)
and [`research/IMPORT_RECONCILIATION_RESEARCH.md`](research/IMPORT_RECONCILIATION_RESEARCH.md) (the
concepts behind the design).

> **This is a proposed sequence, not a pre-approved plan.** The program stops after synthesis for
> product-owner approval before any production implementation. Each ADR named in the decision gate
> must clear the Constitution's ADR bar before its slice begins.

## Working method for every slice

The approach is **strangler-fig**: the existing read→propose→preview→commit pipeline stays live and
correct at every step, and new capability grows alongside it until it takes over. For each slice:

- Bounded scope, its **own child worktree** (off the integration branch, not off main).
- **Test-first at the reconciliation, migration, and identity seams** — the important logic, data,
  sync, and migration boundaries where regressions are costly.
- Review, then **merge to the integration branch `work/onboarding-reconciliation` — never straight to
  `main`.** Nothing merges to `main` without owner approval.
- Data that is *captured but not yet enforced* must be **labeled honestly** in the UI.

## Sequence

### PRE-S0 — Paper-design the Plan type against the hardest consumers

Before any code, paper-design the `ReconciliationPlan` type against its **hardest** consumers —
conflict + clock, clear, temporal staffing, cross-source — *before* locking S0. Otherwise S0 proves
only the easy all-New path. On day one the type must be able to hold **New / Updated / Unchanged /
Clear / Conflict**, where a Conflict carries its reason, the staleness clock, and competing source
values. This is design work, not implementation, and it de-risks everything downstream.

### S0 — Commit consumes a `ReconciliationPlan`, behavior provably unchanged

Commit is refactored to **consume** a `ReconciliationPlan`; the plan is **emitted and consumed
together** (an emitted-but-unconsumed plan is busywork that drifts). The gate is a **golden-ops test**
proving byte-identical `appendOp` sequences on both real camp corpora — the plan changes the internal
shape, not the observable output.

### S1 — split into S1a (recognition) and S1b (alias memory)

S1 was split after adversarial (Red Hat) + Security review found real, code-verified problems that
cluster into two independent groups: recognition-path issues (no schema) and `source_aliases`
machinery issues (schema/sync/migration/divergence/atomicity/permissions). The two ship separately.

- **S1a — Recognition** (ADR `docs/adr/2026-08-08-s1a-import-recognizes-existing-entities.md`, proposed):
  wire the real `existing` snapshot into `buildPlan` at commit so an exact-normalized-name match becomes
  `unchanged` (zero ops) **in the plan**; add commit-time re-resolution so a concurrent same-name row or
  a deleted recognized row becomes a **gated `conflict`** (surfaced, no op) instead of a `UNIQUE` throw
  that aborts the whole import; `ambiguous_identity` is live (from the `normalizeName`/raw-`UNIQUE`
  mismatch) with no alias machinery. **No `source_aliases`, no schema change, no sync/migration.** F4 is
  scoped to the six ingestible entities; fixed-event re-import idempotency is deferred to ticket
  **T72**. Shippable safely on its own.
- **S1b — Alias memory** (ADR `docs/adr/2026-08-08-s1b-source-aliases.md`, **design not yet complete**):
  the synced `source_aliases` table, the confirmed-alias tier, and alias-divergence detection **and
  convergent resolution**, with all the sync/migration/atomicity/permission fixes the review raised
  (parked as explicit open obligations in that ADR). Alias writes are **ADMIN-ONLY**. This is where every
  review finding except the two recognition-path ones (R4, R5) lives. Design round + re-review required
  before code.

### S2 — field-merge (update / clear / conflict)

Add the update / clear / conflict field-merge, the full **New / Updated / Unchanged / Clear /
Conflict** preview, and the T36 residual report. S2 depends on S1a's recognition; it no longer needs to
ship jointly with S1 now that recognition (S1a) stands alone.

### S3 — Location first-class (engine work)

Add the `activity_locations` entity and a nullable `activities.location_id`; **soft-migrate** the
free-text location (keep the `location` TEXT column as denormalized fallback/cache); register in
projections; write via `appendOp`. The one engine consequence is re-keying `locationKey` from string
to entity-id — a refactor of existing behavior that changes nothing about scheduling.

### S4 — Enrichment-workbook round-trip

The Shoresh-generated workbook, pre-populated with what Shoresh already knows, carries stable ids and
an **explicit clear token**, and re-enters through the identical preview. This unifies the two import
paths. The explicit-clear encoding must be decided (see decision gate #8) before this slice.

### S5 — Setup Readiness hub

Promote readiness to a real screen: the six-state onboarding hub with the two-doors pattern per
category, wrapping the untouched `getSetupGaps` core. A **minimal read-only hub shell moves earlier**,
alongside S0–S2, so the first slices have somewhere to surface.

### S6 — Durable staffing requirements

Model the durable requirement (person-agnostic), plus the seasonal-assignment and temporary-availability
shapes; enforcement is **soft-flag by default**, hard-optional per activity. Staffing never blocks
readiness.

### S7 — Facility / map-assisted location proposals + paste

Propose a Location catalog from a site-map / facility list for the director to confirm, rename, merge,
or reject — through the same reviewable preview, with **no GIS**. Adds the clipboard/paste adapters.

### Engine enforcement — its own slice

Engine **enforcement** of the new constraints (location re-key feasibility, staffing feasibility) is a
**separate, tested slice** from the modeling slices above. The model captures the box shapes now
(cheap and reversible); enforcement is turned on later, deliberately.

## Standalone tickets (independent of the program)

These are hardening items that do not belong inside any program slice and can proceed on their own:

- **Replace-footgun hardening** — the `replace` mode currently wipes the whole camp scope, ignoring the
  cohort filter. Fix as an independent standalone ticket.
- **Formula-injection sanitizer** — a shared export utility, retrofit onto `exportSchedule.js`; required
  before S4 ships a round-trip workbook.

## Decision gate (ADRs before code)

Per the Constitution, these decisions are ADRs to be settled before the code they govern:

1. **Staffing PII** — RESOLVED: PII is not a concern; record the decision in `SECURITY.md` (updating the
   "not for high-risk PII" line).
2. **Staleness authority mechanism** — source-generation stamp + op seq; stale supplied value → Conflict;
   the edit path stamps `confirmed`.
3. **Alias-conflict policy** — reviewable conflict, not last-writer-wins.
4. **Formula-injection sanitizer** — before S4.
5. **`confirmed`-bit granularity** — per-row.
6. **Cross-source per-field authority** — which source family is authoritative for which field.
7. **Three-look provenance grammar** — a proposed `DESIGN_STANDARD` change (human gate).
8. **Explicit-clear encoding** — before S4.

The eventual **S0 ADR** (Plan as commit input; the field-delta invariant; the new synced `source_aliases`;
`activity_locations` + soft-migrate) is what clears the Constitution's ADR bar for the program's spine.

> **STOP AFTER SYNTHESIS** for product-owner approval before production implementation. Docs may land on
> the integration branch; production behavior may not, until approved.
