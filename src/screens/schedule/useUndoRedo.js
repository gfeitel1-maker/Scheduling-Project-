import { useState, useEffect } from 'react'
import { describeWriteFailure } from '../../utils/writeErrorMessage'

// T5 — undo / redo. Owns the two stacks and the keyboard shortcuts
// (Ctrl/Cmd+Z, Ctrl+Y, Ctrl+Shift+Z). The screen's mutation handlers push
// entries via pushUndo(); each entry carries its own undo()/redo() closures
// (which capture that route's setters and slot ids), so this hook stays a
// dumb stack machine and never knows what an entry does.
//
// Transient across a route switch: the screen calls reset() from its
// transient-reset block so a stack made on one candidate cannot replay into
// the other. setActionError is injected because a failed undo/redo must
// surface on the screen's error banner.
export function useUndoRedo({ setActionError }) {
  const [undoStack, setUndoStack] = useState([])
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
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That undo could not be applied.'))
    }
  }

  async function handleRedo() {
    if (redoStack.length === 0) return
    const entry = redoStack[redoStack.length - 1]
    try {
      await entry.redo()
      setRedoStack(prev => prev.slice(0, -1))
      setUndoStack(prev => [...prev, entry])
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That redo could not be applied.'))
    }
  }

  function reset() {
    setUndoStack([])
    setRedoStack([])
  }

  // T5 — undo/redo keyboard shortcuts: Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z
  useEffect(() => {
    function onKeyDown(e) {
      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const ctrl = isMac ? e.metaKey : e.ctrlKey
      if (!ctrl) return
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); handleUndo() }
      if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) { e.preventDefault(); handleRedo() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoStack, redoStack])

  return { undoStack, redoStack, pushUndo, handleUndo, handleRedo, reset }
}
