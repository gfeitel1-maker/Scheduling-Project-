---
title: T108-day-overrides-repoint
document_type: ticket
status: closed
created: 2026-08-20
task_class: ui-ux-design
governing_docs: [docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md]
related_adrs: [docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md, docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
archive_when: shipped and merged
---

# T108 — Re-point Day Overrides to a rendered (week, day)

**CLOSED 2026-09-13 — SUPERSEDED by T145, which removed Day Overrides entirely (schema v59, PR #372). The re-point this ticket built did ship; the owner then reversed the decision and the feature was deleted. Closed as superseded, not completed.**

Owner decision: **re-point, don't remove.** The "mostly-normal day with a few swaps" override is the
high-frequency real case. Make an override apply to a specific `(week, day)` and **render on the
schedule**, instead of a reusable template detached from any day that nothing consumes.

## This is its own design pass first (not a small column) — Red Hat scope note

Requires (i) a `(week, day)` binding, (ii) a **new group axis** (`day_override_template_slots` has none
today, `schema.sql:549-563`), and (iii) **live render on both routes**, composing with per-slot flags
(Manual has no `UNFILLABLE`, Generated does). Comparable in size to T106, not smaller.

## Scope

- **Architect design pass**, Red-Hat-challenged before code: the `(week,day)` binding + group axis +
  two-route render, and whether the existing tables carry it or need a small additive migration.
- Remove `frequency_mode` (a conscious reversal of its documented forward-compat intent — pre-production).
- Must not create a third canonical schedule (plural-candidates ADR) — an override renders over an
  existing route, it is not its own route.

## Review loop

**Architect (design) → Red Hat (changes a shipped table's meaning; the group-axis + two-route render) →
Maker (test-first) → Red Hat → Code Reviewer → Tester → Verifier → Grader.**
