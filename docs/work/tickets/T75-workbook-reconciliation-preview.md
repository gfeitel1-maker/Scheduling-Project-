---
title: T75-workbook-reconciliation-preview
document_type: ticket
status: open
created: 2026-08-08
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs:
  - docs/adr/2026-08-08-s4-enrichment-workbook-round-trip.md
program: onboarding-reconciliation
archive_when: the workbook re-import shows a reconciliation ledger (New/Updated/Unchanged/Clear/Conflict) before commit
---

# T75 — Reconciliation preview for the workbook re-import

**Status: open.** Surfaced during S4b implementation.

## What exists

S4b (`2026-08-08-s4-enrichment-workbook-round-trip.md`) wires a workbook upload straight through
`workbookToSource → buildPlan → commitIngest`, reusing the **held-conflict resolution surface** (T73) for
the cases that need a human (stale, missing_target, ambiguous, validation). The dangerous cases are therefore
protected — any conflict holds the whole import for review, and hold-the-whole atomicity means nothing is
half-written.

## The gap

The workbook path does **not** show a **reconciliation preview before commit** for the *non-conflict* case.
The schedule path shows a tick-preview; the Designer's `ONBOARDING_UX_OPTIONS.md` specifies a **ledger-first
reconciliation preview** (New / Updated / Unchanged / Clear counts, with the field-level diff on demand) as the
"nothing is saved until you commit" surface. The workbook re-import currently commits directly (the rationale:
the director already curated the file in Excel), so a director doesn't see "42 updated, 3 new, 1 cleared"
before the write lands.

This is a transparency gap, not a data-safety gap (held conflicts + hold-the-whole protect the risky writes),
but it is inconsistent with the program's "non-skippable preview" principle for the clean case.

## Scope / sequencing

Belongs with the **S5 readiness-hub / reconciliation-preview UX** work (the ledger-first preview surface the
Designer specced). Build the workbook path to render the same ledger the schedule path will, before commit.

## Acceptance

- [ ] A workbook re-import shows a reconciliation ledger (New/Updated/Unchanged/Clear/Conflict counts + field
      diffs) before anything is written.
- [ ] The director confirms from that ledger to commit; conflicts still route to the held-resolution surface.
- [ ] The schedule and workbook paths share the one preview surface (two pens, one model).
