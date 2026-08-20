---
title: T95-reconciliation-multi-select-domain-filter
document_type: ticket
status: open
created: 2026-08-20
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/DESIGN_STANDARD.md, docs/adr/2026-08-18-rootmap-screen-port.md]
archive_when: multi-select is restored, or evidence confirms single-select is the right permanent model
---

# T95 — Reconciliation multi-select domain filtering (audit M2)

**Source:** `docs/work/specs/2026-08-19-roots-reconciliation-audit.md` §12 (deferred, revisit on
evidence). Severity: LOW.

## What was lost

The pre-Roots one-screen reconciliation had **multi-select** domain filter chips (toggle Structure +
Facility together, zero selected = all). The RootMap port narrowed this to **single-select**: the
`selection` union is one tile OR one node OR none (`ReconciliationScreen.jsx`; ADR
`2026-08-18-rootmap-screen-port.md` §5). A director who wants "show me Structure AND Facility at
once" can no longer do it.

## Why deferred

Judged an acceptable narrowing at port time; single-select is simpler and matches the root-map
interaction model. No evidence yet that a director needs multi-domain combination.

## Definition of done (if picked up)

- Either restore multi-select over the RootMap projection (selection becomes a set), OR record an
  explicit decision that single-select is permanent and close.
- Any change must preserve the "quiet at first glance" default and the one-authoritative-model
  invariant (filtering is a lens, never a second inbox).

## Related

- Sibling deferrals from the same audit: T96 (field-level diff), T97 (UNKNOWN detection), T98
  (blast-radius ordering).
