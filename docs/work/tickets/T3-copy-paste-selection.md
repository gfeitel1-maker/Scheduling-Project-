---
title: T3-copy-paste-selection
document_type: ticket
status: open
created: 2026-07-26
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: []
archive_when: fix merged and Verifier PASS recorded
---

# T3 — Cell Selection and Copy/Paste (Single and Multi-Cell)

**Spec:** `docs/work/specs/2026-07-26-manual-grid-editing.md`  
**Risk:** Moderate  
**Depends on:** T2 (DnD context must be stable before adding selection click handlers)  
**Blocks:** T5 (undo stack needs paste as a known undoable action)

---

## What to build

Add Excel-style cell selection and copy/paste to the Group View and Manual Build View grids.

## Observable completion evidence

1. Single-clicking a filled SlotCell selects it (primary outline `2px solid var(--primary)`, `outlineOffset: -2px` on outer `<td>`). EditModal does NOT open on single click.
2. Double-clicking a filled SlotCell opens EditModal (existing behavior preserved via double-click, not single-click).
3. Right-clicking a filled SlotCell still opens EditModal (existing `onContextMenu` unchanged).
4. Ctrl+clicking adds/removes a slot from the selection. Multi-selected cells show the outline + 6% primary fill tint. The first-clicked cell shows a 6×6px `var(--primary)` dot at `top: 4, left: 4` of its inner div.
5. Clicking an empty or anchor cell deselects all.
6. Pressing Escape clears selection (if not in paste mode) or cancels paste mode first (if armed).
7. Pressing Ctrl+C with ≥1 selected filled cells arms paste mode. An inline status line appears below the stats bar: `⊡ N slot(s) copied — click cells to paste, or press Esc to cancel`.
8. In paste mode, hovering over a target cell shows a crosshair cursor and the highlight (`color-mix(in srgb, var(--primary) 12%, transparent)` + `2px dashed var(--primary)` border).
9. Clicking a valid target cell in paste mode places the next clipboard item via `placeActivityManual`, evaluates flags, persists. Status line updates: `⊡ N of M to paste — click a cell to place [Activity Name]`. When all placed, status line disappears and clipboard is cleared.
10. Clicking a locked or anchor cell in paste mode shows an error in the status line for 2 seconds, does NOT decrement the clipboard counter, and does NOT open EditModal.
11. Selection is cleared when switching groups.
12. Ctrl+A selects all non-anchor, non-locked cells in the current view.

## New state in ScheduleScreen

```js
const [selectedSlotKeys, setSelectedSlotKeys] = useState(new Set()) // Set<"groupId|dayId|blockId">
const [clipboardItems, setClipboardItems] = useState([])  // [{ activityId, activityName, colorIdx }]
const [pasteMode, setPasteMode] = useState(false)
const [pasteModeIndex, setPasteModeIndex] = useState(0)   // which clipboard item is next
const [pasteError, setPasteError] = useState(null)        // null | string, auto-clears after 2s
```

## Files expected to change

- `src/screens/ScheduleScreen.jsx` — add above state, keyboard listener (Ctrl+Z/Y in T5; Ctrl+C/V/A/Esc here), paste click handler, status line render.
- `src/components/schedule/SlotCell.jsx` — add `isSelected`, `isMultiSelected`, `isPasteTarget` (hover), `onSelect` props. Change single-click from `onEdit` to `onSelect`. Add double-click → `onEdit`.
- `src/components/schedule/ManualBuildView.jsx` — wire selection props through to SlotCell.
- `src/components/schedule/ScheduleGroupView.jsx` — same.
- `src/styles/shared.js` — add `cellSelected`, `cellMultiSelectedFill`, `pasteStatusLine`, `pasteStatusLineError` style constants (see Designer spec Section 11).

## Design spec reference

Designer spec Sections 2 (Selection States), 3 (Clipboard State), 4 (Paste Interaction).

## Governor resolutions

- **OQ-2:** Clear selection on group switch — yes.
- **OQ-3:** Ctrl+C arms paste mode; subsequent clicks in paste mode auto-place (no Ctrl+V required per step). Ctrl+V is a no-op.

## Test seam

- Unit: `SlotCell` with `isSelected=true` renders `outline: '2px solid var(--primary)'` on the outer `<td>`.
- Unit: Paste onto locked slot — mock a slot with `is_anchor=true`, verify `placeActivityManual` is NOT called and error message is set.
- Unit: Multi-cell paste — clipboard of [A, B], two valid targets → two `placeActivityManual` calls in order, clipboard cleared after second.
- Integration (dev mode): select 2 cells, Ctrl+C, click 2 targets → both placed, status line clears.

## Notes

- `placeActivityManual` must be called for every paste — do not bypass it or duplicate its flag-evaluation logic.
- The inline status line sits between the stats bar and the sidebar+grid row. It is NOT a floating toast. It pushes the grid down by ~32px while visible.
- The status line is rendered regardless of which view is active (group, day, activity, manual) so paste mode is obvious even if the user navigates away.
- Paste mode survives group/day switches — the clipboard is retained.
