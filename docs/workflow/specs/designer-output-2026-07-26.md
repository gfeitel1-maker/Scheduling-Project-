---
title: Manual Grid Editing — Designer Output
document_type: spec
status: active
created: 2026-07-26
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
parent_spec: docs/workflow/specs/2026-07-26-manual-grid-editing.md
archive_when: with its parent spec
---

# Designer Output — Manual Grid Editing Interaction Spec

**Date:** 2026-07-26  
**Status:** Delivered — Governor reviewed, open questions resolved below

---

## 1. Layout — Persistent Sidebar

ActivityPalette becomes a persistent left column in ScheduleScreen's main content area — a two-column flex row below the stats bar:

```
[ sidebar 210px ] [ gap 16px ] [ grid area, flex: 1 ]
```

Applies whenever `setupIncomplete === false`, regardless of view or schedule state.

**Collapse toggle** — `«` / `»` button in sidebar header top-right (18×18px, `var(--font-mono)`, 12px, `color: var(--text-secondary)`, `hover: var(--text)`). Collapsed state: 28px strip, `borderRight: 1px solid var(--border)`. Session-only; always expanded on mount.

**Sidebar interactivity by view:**

| View | Palette chips |
|------|---------------|
| Manual Build | Draggable (existing DnD) |
| Group View | Non-draggable static display |
| Day View | Non-draggable, counts scoped to selectedGroup |
| Activity View | Non-draggable, camp-wide totals |
| No-schedule state | Non-draggable, all counts 0 |

**DnD context boundary:** The DndContext is lifted to ScheduleScreen level, covering both palette and target grid. Day/Activity view chips: `disabled` on `useDraggable`. ManualBuildView's internal DndContext removed.

---

## 2. Selection States

**Interaction change:**

| Interaction | Before | After |
|-------------|--------|-------|
| Single click filled cell | Opens EditModal | Selects cell |
| Double-click filled cell | No handler | Opens EditModal |
| Right-click filled cell | Opens EditModal | Unchanged |
| Ctrl+click filled cell | — | Add/remove from selection |
| Esc | — | Clears selection / exits paste mode |
| Ctrl+A | — | Selects all non-anchor cells in view |

**Visual treatment (all via `outline` on outer `<td>` — does not affect inner div's activity color border):**

- **Unselected:** no change
- **Selected (single):** `outline: 2px solid var(--primary); outlineOffset: -2px`
- **Multi-selected:** same outline + inner div `background: color-mix(in srgb, var(--primary) 6%, transparent)`
- **Selection origin (first clicked):** 6×6px `var(--primary)` dot, absolutely positioned `top: 4, left: 4` of inner div, `borderRadius: 99, zIndex: 3`
- **Anchor cell:** not selectable; no outline; no feedback on click
- **Locked cell:** selectable for copy; selection outline sits outside amber inner border; paste into it is refused

**Keyboard selection:**
- Tab / Shift+Tab: move focus in reading order
- Space / Enter: select focused cell
- Ctrl+Space: add to selection
- Ctrl+A: select all non-anchor cells in view
- Esc: clear selection (or exit paste mode first if armed)

---

## 3. Clipboard State Machine

```
IDLE ──(Ctrl+C on selection)──► ARMED ──(all pasted or Esc)──► IDLE
```

**IDLE, with selection:** Selection outlines only. No clipboard indicator.

**After Ctrl+C (IDLE → ARMED):** Inline status line below stats bar (NOT floating — pushes grid down ~32px):
```
⊡ N slot(s) copied — click cells to paste, or press Esc to cancel
```
Style: `var(--surface-elevated)` background, `1px solid var(--border)`, `borderRadius: 7`, `var(--font-mono)`, `11px`.

Status line auto-dismisses after 2 seconds ONLY if user does not begin pasting. Once user clicks first target, it transitions to paste-progress.

**Paste in progress:** `⊡ N of M to paste — click a cell to place [Activity Name]`

**After all pasted or Esc:** Status line disappears. Clipboard cleared. Selection cleared.

---

## 4. Paste — Step-by-Step (multi-cell)

1. Ctrl+C → status line: `⊡ 3 of 3 to paste — click a cell to place Swimming`
2. Hover target: `crosshair` cursor, `color-mix(in srgb, var(--primary) 12%, transparent)` bg, `2px dashed var(--primary)` border
3. Click target: activity placed, flags evaluated, status line: `⊡ 2 of 3 to paste — click a cell to place Soccer`
4. Hover/click next target: same
5. Final paste: status disappears, clipboard cleared, IDLE

**Paste on locked/anchor cell:** Error for 2 seconds: `⊠ Cannot paste into a locked slot — choose an unlocked cell.` Text color `var(--warning)`. Counter NOT decremented. No EditModal. Reverts to progress text.

**Paste mode survives group/day navigation.**

---

## 5. Merge-Down

**Existing ExpandHandle (bottom-edge drag):** unchanged.

**New one-click merge button** (appears on hover when `cellHovered && !isMerged && hasNextBlock`):
- Position: `top: 4, right: 4` of inner div, absolute
- Size: 16×16px, `borderRadius: 4`
- Default: `border: 1px solid var(--border)`, `background: var(--surface-elevated)`, `color: var(--text-secondary)`
- Hover: `background: var(--primary)`, `color: #fff`, `borderColor: var(--primary)`
- Content: `↕` (U+2195)
- Title: `"Extend to next block"`
- `onClick`: `e.stopPropagation()` then calls `onExpandSlot` (one block down)
- Not shown: last block of day, or next slot is anchor

---

## 6. Split

**Split button** (appears on hover when `cellHovered && isMerged`, i.e. `is_span_head !== false && flags?.expanded`):
- Same position and size as merge button; never coexists with it
- Default: same as merge button base style
- Hover: `border: 1px solid var(--warning)`, `background: color-mix(in srgb, var(--warning) 10%, var(--surface-elevated))`, `color: var(--warning)`
- Content: `↕` (same glyph — context disambiguates)
- Title: `"Split into separate blocks"`
- `onClick`: `e.stopPropagation()` then calls `onSplitSlot`
- Behavior: tail block(s) → `activity_id: null, is_span_head: true`. If `flags.expanded.displacedActivityId` exists → re-add to DisplacedPalette. All tail blocks cleared in one operation (multi-block spans fully split).

---

## 7. DisplacedPalette

**Keep as-is.** Serves a different purpose than the sidebar (reactive vs. proactive). The contextual metadata (`fromBlockName`, `dayLabel`) would be lossy if merged. Future layout risk: if a right-side panel opens in the same area as the floating DisplacedPalette, a collision will occur — Governor to track.

---

## 8. Empty and Error States

**Sidebar, no activities (defensive fallback):** Renders "ACTIVITIES" header and a centered `var(--font-mono)` 11px `var(--text-secondary)` message: "No activities defined.\nGo to Camp Setup to add some." No nav link.

**Paste refused — locked slot:** Error 2s in status line (`⊠` prefix, `var(--warning)` color). Counter not decremented. No EditModal.

**Paste refused — anchor slot:** Same. Text: `⊠ Cannot paste into an anchor — choose a regular cell.`

**Merge button — no next block:** Not rendered (`hasNextBlock = false`). ExpandHandle also already hidden in this case.

**Split — missing displaced activity metadata:** Split proceeds; no DisplacedPalette entry created. No error surfaced.

---

## 9. Acceptance Examples (from Designer spec)

See AE-1 through AE-8 in the Designer output. These are the Tester's primary oracle.

**AE-1:** Setup complete, no schedule → sidebar visible at 210px, all activities 0/max, right area shows empty state.  
**AE-2:** Click `«` → sidebar 28px strip, grid expands; click `»` → restored.  
**AE-3:** Single click filled cell → no modal, primary outline on `<td>`.  
**AE-4:** Click A, Ctrl+click B, Ctrl+click C → all three cells show primary outline + 6% fill; A has the 6×6px dot.  
**AE-5:** Select 2 cells, Ctrl+C → status line appears; click 2 targets → both placed, status disappears.  
**AE-6:** Paste mode, 1 remaining, click locked cell → error text 2s, counter unchanged, retry on unlocked cell succeeds.  
**AE-7:** Hover filled cell with next block → `↕` button appears top-right; click → cell extends, displaced activity in DisplacedPalette.  
**AE-8:** Hover merged cell → `↕` button with amber hover; click → tail becomes empty, displaced activity re-surfaces in DisplacedPalette.

---

## 10. Open Questions — Governor Resolutions

| # | Question | Resolution |
|---|----------|------------|
| OQ-1 | Sidebar count scoping in non-Manual views | Group View + Day View: scope to `selectedGroup`. Activity View: camp-wide sum. |
| OQ-2 | Clear selection on group switch? | Yes — clear on group switch. |
| OQ-3 | Ctrl+V arm paste, or Ctrl+C arm + clicks auto-place? | Ctrl+C arms paste mode; subsequent clicks auto-place. Ctrl+V is a no-op. |
| OQ-4 | DnD context boundary | Lift to ScheduleScreen level. Day/Activity view chips: `disabled` on `useDraggable`. ManualBuildView internal DndContext removed. |

---

## 11. Style Constants (for shared.js)

```js
pasteStatusLine: {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '6px 12px',
  background: 'var(--surface-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 7,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--text-secondary)',
  marginBottom: 8,
},
pasteStatusLineError: {
  color: 'var(--warning)',
  borderColor: 'color-mix(in srgb, var(--warning) 35%, var(--border))',
},
cellSelected: {
  outline: '2px solid var(--primary)',
  outlineOffset: -2,
},
cellMultiSelectedFill: {
  background: 'color-mix(in srgb, var(--primary) 6%, transparent)',
},
cellActionBtn: {
  position: 'absolute', top: 4, right: 4,
  width: 16, height: 16,
  borderRadius: 4,
  border: '1px solid var(--border)',
  background: 'var(--surface-elevated)',
  cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 10,
  color: 'var(--text-secondary)',
  zIndex: 3,
  padding: 0,
  fontFamily: 'inherit',
},
```
