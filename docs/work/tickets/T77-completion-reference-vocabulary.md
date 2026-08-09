---
title: T77-completion-reference-vocabulary
document_type: ticket
status: completed
created: 2026-08-09
governing_docs: [docs/governance/standards/WORK_RECORD_STANDARD.md, docs/governance/GOVERNANCE_INDEX.md]
related_adrs:
  - docs/adr/2026-08-09-work-record-status-drift-prevention.md
related_tickets:
  - docs/work/tickets/T76-status-drift-commit-gate.md
archive_when: WORK_RECORD_STANDARD.md normatively defines the completion-reference vocabulary and GOVERNANCE_INDEX.md points to it
---

# T77 — Normative completion-reference vocabulary

**Status: done.** Implements part 1 (process contract) of
`docs/adr/2026-08-09-work-record-status-drift-prevention.md`, product-owner decision 1.

## What

Add a normative definition of the `closes T##` / `Merge S##` completion-reference vocabulary to
`docs/governance/standards/WORK_RECORD_STANDARD.md`, including the ID-resolution and closed-state
rules the `checkStatusDrift` gate (T76) derives its behaviour from — the standard is the source of
truth, the script implements it. Add a pointer to it from `docs/governance/GOVERNANCE_INDEX.md`.

## Done when

- `WORK_RECORD_STANDARD.md` defines the vocabulary, ID resolution, and the closed-state predicate
  per document type.
- `GOVERNANCE_INDEX.md` points at that definition.
- `npm run check:governance` passes on this branch (dogfooded).
