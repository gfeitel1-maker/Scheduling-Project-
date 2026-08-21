---
title: T105-elective-inline-authoring-and-render
document_type: ticket
status: open
created: 2026-08-20
task_class: ui-ux-design
governing_docs: [docs/adr/2026-08-20-electives-authoring.md, docs/adr/2026-08-20-in-context-knowledge-and-durability-tiers.md]
depends_on: [docs/work/tickets/T104-elective-cell-atomic-content-and-mutual-exclusion.md]
archive_when: shipped and merged
---

# T105 — Elective inline authoring + render (create-in-context first)

The primary authoring path per the ratified ADR: a director marks a cell as an elective **in the grid**,
naming it and listing members inline (members create-on-type via the generalized `createActivityFromCell`
interaction), on **both routes**. The management screen (T103) is the secondary surface.

## Scope

- Extend `CellInlineEditor`/`SlotCell` so typing an elective name + members writes the set + members +
  the cell's elective content in one gesture (uses T104's atomic write).
- Elective-cell **render** in `SlotCell` — data-attribute + `scheduleGrid.css` rule, no new tokens
  (schedule-canvas ADR).
- Durability default (tier a) + one-gesture promotion to (b)/(c) per the foundational ADR.
- Export renders an elective cell as its set (member list), not blank.

## Review loop

**Designer (if the cell affordance is UI-significant) → Maker (test-first) → Red Hat (engine-skip still
holds under authored elective writes) → Code Reviewer → Tester (director-eye) → Verifier → Grader.**
