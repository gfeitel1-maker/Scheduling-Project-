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

## Binding constraints from T103 Red Hat review (MEDIUM — must honor here)

T103 shipped the durability data layer but has **no consuming read path yet**. This ticket wires reads,
so it inherits two guarantees Red Hat flagged (2026-08-20, T103 review):

1. **Every reuse/durable read surface (palette, management list, Context inventory) MUST go through
   `listDurableElectiveSets` (`electron/ops/durableElectiveSets.js`), never the generic
   `list('elective_sets')` IPC.** The generic `list()` path (`electron/main.js`) is a read-everything
   primitive that returns one-offs (`is_reusable=0`) unfiltered — reaching for it by habit silently
   defeats the durability guarantee, and nothing lints/tests would catch it. Add a test asserting the
   reuse surface never shows an `is_reusable=0` set.
2. **`listDurableElectiveSets` gains its first production callers here** — until this ticket, the
   invariant is enforced only in isolation. Wire it as the single seam for "durable/reusable electives."

## Review loop

**Designer (if the cell affordance is UI-significant) → Maker (test-first) → Red Hat (engine-skip still
holds under authored elective writes) → Code Reviewer → Tester (director-eye) → Verifier → Grader.**
