---
title: T112-empty-cell-click-opens-inline-editor
document_type: ticket
status: open
created: 2026-08-21
task_class: ui-ux-design
governing_docs: [docs/adr/2026-08-20-in-context-knowledge-and-durability-tiers.md]
related_tickets: [docs/work/tickets/T105-elective-inline-authoring-and-render.md]
archive_when: shipped and merged
---

# T112 — Empty-cell click should open the inline editor (point-of-intent gap)

## The gap (verified live, 2026-08-21, dev app on a dedicated port)

The schedule grid's own hint reads: *"Drag activities from the left panel onto any open cell, **or
click a cell to pick one.** An empty cell just isn't filled yet."* **Clicking an empty cell does
nothing** — `EmptyDropCell` (`src/components/schedule/ManualBuildView.jsx:58-74`) is a static `<div>`
with no onClick, no editing state, no `CellInlineEditor`. Empty cells are **drag-only** (the DndContext
lives in `ScheduleScreen`). And a plain **left-click on a filled cell *selects* it** (SlotCell
`handleClick` returns early via `onSelect` before `setEditing`); the inline editor opens only on
**right-click** (`handleContextMenu`) or **Enter** on a focused cell.

**Pre-existing** on origin/main — not introduced by T105. But it directly defeats the "work at the point
of intent" philosophy the electives/audit work is built on: to author an elective (or any typed
activity) a director must drag *some* activity in first, then right-click and retype. That is
non-obvious, and it's why a live Tester concluded electives were "non-functional" (they clicked empty
cells and left-clicked filled cells — the two gestures that do nothing).

## Why it matters beyond electives

This affects **plain activity create-in-context too** (`createActivityFromCell` is reachable only by the
same right-click-on-filled path). The whole "type a thing that doesn't exist, where you are" story in
the in-context/durability ADR assumes clicking a cell lets you type. Today it does not.

## Scope (design-first — this is a core interaction change)

Make an **empty cell open the inline editor on click** (and fix/replace the misleading hint). This is
NOT trivial: left-click currently drives **selection** and must coexist with the `@dnd-kit` `distance:8`
drag-activation and clipboard selection. Options an Architect/Designer pass must weigh: single-click on
empty opens the editor (empties have nothing to select); keep filled-cell edit on right-click/Enter but
add a discoverable affordance; or a unified click model. Must not regress drag placement, selection,
merge/split, or paste.

## Review loop

**Designer + Architect (the click/selection/DnD interaction model) → Red Hat (regression to
drag/select/merge/paste) → Maker (test-first) → Tester (live director-eye) → Code Reviewer → Verifier →
Grader.**

## Owner decision pending

Priority call: this is what makes electives (and point-of-intent entry generally) actually *reachable*
by a director. Recommend doing it soon as a fast-follow, but it is a genuine interaction redesign with
its own risk, so it is scoped as its own ticket rather than folded into T105.
