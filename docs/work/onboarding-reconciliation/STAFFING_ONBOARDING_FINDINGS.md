---
title: "Staffing Onboarding Findings"
document_type: synthesis
status: draft
created: 2026-08-08
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
program: onboarding-reconciliation
archive_when: superseded by an approved implementation plan
---

# Staffing Onboarding Findings

Synthesis of §6 (with resolved product-owner decisions from §2) of the onboarding-reconciliation
synthesis. Pre-approval; no code. This document fixes what staffing *means* in onboarding and draws
the line between what onboarding captures and what remains a future project.

Current state: there is **no staffing model of any kind** in the schema today — `users.role` is
auth-only (admin/staff). Everything below is new modeling shape, not a change to existing behavior.

## 1. Three distinct things — do not collapse them

Staffing is not one concept. Model **three** distinct things (handoff §7):

1. **Requirement** (durable, person-agnostic) — an activity needs a role/qualification and a count.
   "Archery needs 1 certified instructor." Belongs to the activity; survives year to year.
2. **Assignment** (seasonal) — *this year's* person filling a requirement, replaceable. Handles
   "the person changes from year to year" without disturbing the requirement.
3. **Availability** (temporary) — "out week 4," substitute markers, validity windows. A time-shaped
   fact about a specific person.

These are different in kind. Flattening any two together (e.g. treating an assignment as a
requirement, or a temporary substitute as a permanent assignment) loses information the director
depends on.

## 2. One model, two archetypes

Both camp archetypes are **configurations of ONE model**, not two models:

- **"Runs regardless of who"** — requirement is *absent or informational*, not enforced.
- **"Need person X free at time Y"** — requirement is *present and enforced*.

The difference is a **requirement being optional plus an enforcement flag**, not a structural fork.
Confidence: high — a single model with an optional requirement and an enforcement flag covers both
archetypes and avoids a divergent schema.

## 3. Enforcement: soft-flag by default, hard-optional per activity

Resolved by the product owner (2026-08-08):

- **Soft-flag by default.** The engine *places the activity and raises a flag* when a staffing
  requirement is unmet — it does not block placement. This reuses the existing **slot-flags idiom**
  already present in the scheduler, so it is idiomatic, not novel machinery.
- **Hard-optional per activity.** An individual activity may opt into hard enforcement (requirement
  must be satisfiable) — opt-in, per activity, never the global default.

## 4. Staffing is NEVER a blocking readiness category

The schedule must **always generate with zero staffing data.** Staffing must never appear as a
blocking/required readiness category — it surfaces as Optional / Not-applicable in the readiness hub,
never as Missing (red/blocking). A camp with no staffing information at all is still schedule-ready.

## 5. Preserve temporary/substitute markers — reject-with-flag, do not flatten

Temporal validity (availability windows, substitutes, "out week 4") is currently a **non-goal** for
the engine. The correct handling on import is:

- **Preserve** temporary / substitute / validity-window markers where they can be represented.
- If temporal validity remains a non-goal, **reject a temporary fact at import with a flag** rather
  than silently **flattening** it into a permanent assignment (Red Hat R7). A rejected-with-flag row
  is honest and reviewable; a flattened row is a lie that looks like data.

Do not let "we don't schedule staff yet" become "we quietly recorded a substitute as the permanent
staffer."

## 6. PII is resolved — record in SECURITY.md

Product-owner decision (2026-08-08): **staffing PII is NOT a concern** for this program. Staffing
data may live in the replicated op-log. Action item: **update SECURITY.md** — the existing
"not for high-risk PII" line must be amended to record this decision explicitly, so the op-log's
handling of staff names/roles is a documented, intentional posture rather than an oversight.

## 7. Scope boundary: capture durable facts now, defer scheduling

Onboarding **captures the durable facts** — requirements (and the assignment/availability *shapes*)
so a returning camp does not re-enter them. That is the whole staffing job for this program.

Explicitly deferred:

- **Full staff scheduling** — assigning people to slots, balancing loads, resolving conflicts —
  remains a **future project**, a hard non-goal here.
- **Engine feasibility enforcement** of staffing constraints is **deferred to its own tested slice**
  (S6 modeling; enforcement later), consistent with the program-wide "model the box now, enforce
  later" decision. Until then, captured staffing requirements are recorded but not enforced, and the
  UI must label them honestly as captured-not-enforced.

## 8. Decision summary

- Three distinct things: requirement (durable) / assignment (seasonal) / availability (temporary).
  **[required distinction]**
- One model; both archetypes = optional requirement + enforcement flag. **[high confidence]**
- Enforcement: soft-flag default (existing slot-flags idiom), hard-optional per activity.
  **[product-owner resolved]**
- Staffing never a blocking readiness category; schedule always generates with zero staffing.
  **[required]**
- Preserve temporary/substitute markers; reject-with-flag rather than flatten if temporal validity
  stays a non-goal. **[required]**
- PII not a concern; record the decision in SECURITY.md. **[action item]**
- Onboarding captures durable facts; full staff scheduling and engine enforcement deferred to their
  own slices. **[scope boundary]**
