---
title: T75-workbook-reconciliation-preview
document_type: ticket
status: done
created: 2026-08-08
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs:
  - docs/adr/2026-08-08-s4-enrichment-workbook-round-trip.md
program: onboarding-reconciliation
archive_when: the workbook re-import shows a reconciliation ledger (New/Updated/Unchanged/Clear/Conflict) before commit
---

# T75 — Reconciliation preview for the workbook re-import

**Status: done (S5b).** Surfaced during S4b implementation; closed by the shared
reconciliation-preview ledger.

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

- [x] A workbook re-import shows a reconciliation ledger (New/Updated/Unchanged/Clear/Conflict counts + field
      diffs) before anything is written.
- [x] The director confirms from that ledger to commit; conflicts still route to the held-resolution surface.
- [x] The schedule and workbook paths share the one preview surface (two pens, one model).

## Resolution (S5b)

- `src/screens/ReconciliationLedger.jsx` — the ledger-first, exception-expanded surface (design
  §7): counts for New/Updated/Unchanged/Clear/Conflict; Unchanged/New collapsed by default; Updated
  field diffs shown with the camp-language `FIELD_LABEL` map (muted was → full will-be); Clear given
  a firmer treatment; Conflict/ambiguous auto-expand and GATE the commit.
- `src/ingest/existingSnapshot.js` — renderer-side dry-run snapshot mirroring the committer's
  `buildExistingSnapshot` (cohort-scoping + `enrichSnapshotRow` FK labels), read via `localClient.list`,
  fed to the PURE `buildPlan`. Commit re-runs `buildPlan` (Article V), so preview and commit agree.
- `src/ingest/fieldLabels.js` — `FIELD_LABEL`/`fieldLabel` extracted from `ImportScreen` so the screen
  and the ledger share ONE camp-language map.
- `src/screens/ImportScreen.jsx` — both the schedule tick-preview (`commit → stageLedger`) and the
  workbook re-import (`handleWorkbookReimport → stageLedger`, no longer straight-to-commit) stage the
  same ledger; its Commit calls the existing atomic `ingestCommit`; a held outcome routes to the
  existing T73 `HeldResolution` surface.
- Tests: `ReconciliationLedger.test.jsx` (7), `ImportScreen.ledger.test.jsx` (3, both paths + held
  routing). No schema/electron change.
