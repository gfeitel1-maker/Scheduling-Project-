---
title: T96-reconciliation-field-level-diff-ledger
document_type: ticket
status: open
created: 2026-08-20
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/DESIGN_STANDARD.md]
archive_when: field-level diff is restored where it adds value, or judged unnecessary given the per-card resolved lines
---

# T96 — Reconciliation field-level `was → will-be` ledger diff (audit M3)

**Source:** `docs/work/specs/2026-08-19-roots-reconciliation-audit.md` §12 (deferred, revisit on
evidence). Severity: LOW-MED.

## What was lost

The retired `ReconciliationLedger.jsx` (S5b) rendered an explicit field-level `was → will-be` diff
for every changed entity, with an Unchanged reassurance count. The one-screen rebuild compressed this
into the understood receipt + per-card "✓ Will set to X" resolved lines — a genuine reduction in
field-level diff visibility. A director can no longer scan a compact ledger of every field that
changes.

## Why deferred

The per-card resolved lines cover the common case; the full ledger view is heavier and may not earn
its place on the "quiet at first glance" surface.

## Definition of done (if picked up)

- Restore a field-level `was → will-be` view where it adds value (e.g. an on-demand disclosure per
  changed entity, or a "review all changes" affordance) WITHOUT reintroducing a second full screen or
  breaking the one-continuous-surface principle.
- OR record that the per-card lines are sufficient and close.

## Related

- Sibling deferrals: T95 (multi-select), T97 (UNKNOWN detection), T98 (blast-radius ordering).
