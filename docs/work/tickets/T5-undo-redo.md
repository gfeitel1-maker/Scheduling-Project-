---
title: T5-undo-redo
document_type: ticket
status: open
created: 2026-07-26
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: []
archive_when: fix merged and Verifier PASS recorded
---

# T5 — Undo / Redo for Slot Edits

**Spec:** `docs/work/specs/2026-07-26-manual-grid-editing.md`  
**Risk:** Moderate  
**Depends on:** T3 (paste must exist), T4 (merge/split must exist)  
**Blocks:** nothing

---

## What to build

A session-scoped, in-memory undo/redo stack in `ScheduleScreen` covering all fine-grained slot edits. Accessible via Ctrl+Z / Ctrl+Y keyboard shortcuts and undo/redo buttons in the controls bar.

## Observable completion evidence

1. After placing an activity (drag, paste, or click-edit), pressing Ctrl+Z reverses it — the slot returns to its previous state, the write is applied via `writeFields`.
2. After undo, pressing Ctrl+Y (or Ctrl+Shift+Z) re-applies the action.
3. After undo, performing a new action clears the redo stack.
4. Undo and redo buttons appear in the controls bar between the view toggle and the Weather Mode button. They are disabled (opacity 0.35, `cursor: not-allowed`) when the respective stack is empty.
5. Button title attributes describe the next action: `"Undo: Placed Swimming → Kayaks Mon Block 2"` / `"Nothing to undo"`.
6. Multi-cell paste is a single undo step — pressing Ctrl+Z once undoes all cells placed in that paste batch.
7. Merge-down is a single undo step (reverses both the tail-slot write and the head flags write).
8. Split is a single undo step.
9. `generate()` and `restoreSnapshot()` each clear both stacks. After generating, Ctrl+Z does nothing.
10. Stack depth limit is 50. Adding a 51st entry removes the oldest.
11. If an undo or redo write fails, the `actionError` banner appears and the stack entry is NOT consumed.

## New state and helpers in ScheduleScreen

```js
const [undoStack, setUndoStack] = useState([])  // [{ description, undo, redo }]
const [redoStack, setRedoStack] = useState([])

function pushUndo(entry) {
  setUndoStack(prev => {
    const next = [...prev, entry]
    return next.length > 50 ? next.slice(next.length - 50) : next
  })
  setRedoStack([])
}

async function handleUndo() {
  if (undoStack.length === 0) return
  const entry = undoStack[undoStack.length - 1]
  try {
    await entry.undo()
    setUndoStack(prev => prev.slice(0, -1))
    setRedoStack(prev => [...prev, entry])
  } catch {
    setActionError('Undo failed — check your connection and try again')
  }
}

async function handleRedo() {
  if (redoStack.length === 0) return
  const entry = redoStack[redoStack.length - 1]
  try {
    await entry.redo()
    setRedoStack(prev => prev.slice(0, -1))
    setUndoStack(prev => [...prev, entry])
  } catch {
    setActionError('Redo failed — check your connection and try again')
  }
}
```

## Wrapping each undoable action

Every undoable action must capture before-state, then push an entry. Pattern (example for `placeActivityManual`):

```js
async function placeActivityManual(activityId, groupId, dayId, blockId) {
  // ... existing code ...
  const slot = getSlot(groupId, dayId, blockId)
  const prevActivityId = slot?.activity_id ?? null
  const prevFlags = slot?.flags ?? {}

  // ... existing write ...

  pushUndo({
    description: `Placed ${activity.name} → ${group.name} ${day.label} ${block.name}`,
    undo: async () => {
      await writeFields('template_slots', slot.id, { activity_id: prevActivityId, flags: prevFlags })
      setSlots(prev => prev.map(s =>
        s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId
          ? { ...s, activity_id: prevActivityId, flags: prevFlags }
          : s
      ))
    },
    redo: async () => {
      await writeFields('template_slots', slot.id, { activity_id: activityId, flags })
      setSlots(prev => prev.map(s =>
        s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId
          ? { ...s, activity_id: activityId, flags }
          : s
      ))
    },
  })
}
```

For multi-cell paste, capture all affected slots' before-states before the paste loop begins. Push a single undo entry whose `undo()` reverses all of them.

For merge (`expandSlot`): capture head slot flags and tail slot fields before the write. Push a single undo entry.

For split (`splitSlot`): capture head slot flags, tail slot fields, and whether the displaced activity was in DisplacedPalette before. Push a single undo entry.

## Keyboard listener

Add a `useEffect` in `ScheduleScreen` that registers and removes a `keydown` handler:

```js
useEffect(() => {
  function onKeyDown(e) {
    const isMac = navigator.platform.toUpperCase().includes('MAC')
    const ctrl = isMac ? e.metaKey : e.ctrlKey
    if (!ctrl) return
    // Don't fire if focus is inside an input / modal
    if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return
    if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); handleUndo() }
    if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) { e.preventDefault(); handleRedo() }
  }
  window.addEventListener('keydown', onKeyDown)
  return () => window.removeEventListener('keydown', onKeyDown)
}, [undoStack, redoStack]) // must capture latest stack via closure
```

## UI buttons in controls bar

Add two buttons between the view toggle group and the Weather Mode button:

```jsx
<button
  onClick={handleUndo}
  disabled={undoStack.length === 0}
  title={undoStack.length > 0 ? `Undo: ${undoStack[undoStack.length - 1].description}` : 'Nothing to undo'}
  style={{
    padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6,
    background: 'var(--surface)', cursor: undoStack.length === 0 ? 'not-allowed' : 'pointer',
    opacity: undoStack.length === 0 ? 0.35 : 1, fontSize: 14, fontFamily: 'inherit',
  }}
>↩</button>
<button
  onClick={handleRedo}
  disabled={redoStack.length === 0}
  title={redoStack.length > 0 ? `Redo: ${redoStack[redoStack.length - 1].description}` : 'Nothing to redo'}
  style={{
    padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6,
    background: 'var(--surface)', cursor: redoStack.length === 0 ? 'not-allowed' : 'pointer',
    opacity: redoStack.length === 0 ? 0.35 : 1, fontSize: 14, fontFamily: 'inherit',
  }}
>↪</button>
```

## Files expected to change

- `src/screens/ScheduleScreen.jsx` — add `undoStack`, `redoStack` state; `pushUndo`, `handleUndo`, `handleRedo` helpers; keyboard listener `useEffect`; undo/redo buttons in controls bar; wrap `placeActivityManual`, `editSlotSave`, `swapSlots`, `expandSlot`, `splitSlot` with `pushUndo`; clear stacks in `generate()` and `regenFromScratch()` and `restoreSnapshot()`.

## Test seam

- Unit: `pushUndo` enforces 50-entry limit — push 51 entries, verify `undoStack.length === 50`, oldest dropped.
- Unit: `handleUndo` calls `entry.undo()` and moves entry to `redoStack`; on failure, actionError set, stack unchanged.
- Unit: `handleRedo` symmetric.
- Unit: `placeActivityManual` — after placing, `undoStack` top entry has correct `description`; calling `undo()` restores previous `activity_id`.
- Unit: `generate()` call → both stacks cleared.
- Integration (dev mode): place activity, Ctrl+Z → slot reverts. Ctrl+Y → re-applied.

## Notes

- `handleUndo` and `handleRedo` are async. The keyboard listener must handle the returned promise (`.catch` on the call site or wrap in a try/catch inside the listener).
- `editSlotSave` (EditModal save path) must also push to the undo stack. Capture the slot's previous state before writing.
- `swapSlots` should push a single undo entry (swap A→B and B→A simultaneously; undo re-swaps).
- Do NOT wrap `generate()` or `restoreSnapshot()` in undo — the auto-snapshot system is their rollback. Just clear the stacks.
