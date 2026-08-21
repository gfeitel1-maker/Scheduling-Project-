---
title: T113-day-override-undo-redo
document_type: ticket
status: open
created: 2026-08-21
task_class: ui-ux-design
governing_docs: [docs/adr/2026-08-21-day-overrides-repoint-shape.md]
related_tickets: [docs/work/tickets/T108-day-overrides-repoint.md]
archive_when: shipped and merged
---

# T113 — Undo/redo for day-override authoring writes (deferred from T108)

## What it is

T108 ships day-override authoring (swap / pull) via `useSlotMutations` override-mode routing, but those
writes (`placeActivityManual`'s override branch, `pullOverrideCell`, `pullOverrideDay`, and the drag path
once routed) do **not** call `pushUndo`, while every other cell mutation on the grid does (`replaceSlot`,
`expandSlot`, `splitSlot`). So a director who pulls a group by mistake cannot instant-undo (Ctrl-Z) the way
every other edit allows — the only recovery is whole-week snapshot restore (coarse, requires a prior
snapshot).

## Governor decision (2026-08-21)

Accepted as a **deferred follow-up**, NOT a T108 blocker — a UX-consistency gap, not data-loss (snapshot
restore is a real, if coarse, recovery path). Recorded here so it is explicit, not inferred. Do NOT ship
T108 claiming override-undo works; T108 documents this gap in code comments and points here.

## Scope

Add `pushUndo({undo, redo})` to every override-authoring write path (delete/restore the `day_overrides`
row; re-create on redo — mirror the T105 `createElectiveFromCell` undo/redo discipline, including a
fresh-read to avoid clobbering a promoted/edited row). Test-first: undo removes the override + reverts the
rendered cell; redo re-applies. Cover swap, pull, and whole-day-pull.

## Review loop

**Maker (test-first) → Red Hat (undo/redo correctness under the day_overrides diff model) → Code Reviewer
→ Verifier → Grader.**
