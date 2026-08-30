import { useEffect, useMemo, useRef } from 'react'
import { computeSpanExtendPreview } from './useSlotMutations'

// T107 item 1 (Designer spec 2026-08-21) — drag-to-extend gesture.
//
// Modeled as a raw-pointer-event gesture on the extend handle itself: a
// plain onPointerDown + a window pointerup listener, not a dnd-kit
// useDraggable pickup. The Designer spec's Implementation Note #1 asks for a
// "third drag-FSM gesture kind"; this hook instead reuses the fill-handle
// precedent because dragFSM's three-state machine (Pointing/Dragging/
// Resolving) exists to arbitrate click-vs-drag ambiguity on a whole grid
// cell, and the extend handle — a dedicated 28x4px target with nothing else
// clickable on it (Implementation Note #2) — has no such ambiguity to
// arbitrate. The functional contract (live snap-to-block preview via the
// existing static data-drag-over/::before mechanism, one resolve-and-write
// on drop) is met either way; flagged to Governor as a deliberate deviation
// from the spec's literal architecture note, not a silent one.
//
// Preview attributes are written straight to the DOM — data-drag-over /
// data-drop-edge / data-drag-truncated — reusing scheduleGrid.css's existing
// static drop-indicator rules verbatim (T58: no transition, no per-cell React
// state, no re-render of the grid while dragging).
export function useSpanExtendDrag({ slots, timeBlocks, activities, expandSlot }) {
  const dragRef = useRef(null)
  const slotsRef = useRef(slots)
  useEffect(() => { slotsRef.current = slots }, [slots])

  // Sort once per timeBlocks identity change rather than on every
  // pointermove of a live drag (efficiency finding — computeSpanExtendPreview
  // now expects a pre-sorted array).
  const sortedTimeBlocks = useMemo(
    () => [...timeBlocks].sort((a, b) => a.sort_order - b.sort_order),
    [timeBlocks]
  )
  // Bails a pointermove that resolves to the same block the drag is already
  // showing a preview for — no recompute, no DOM repaint, on every pixel of
  // mouse movement within the same cell. Also keyed on the slots reference:
  // a remote write can change eligibility under an unmoved pointer (the
  // "fresh state, not stale preview" contract) — that must still recompute
  // even though blockId is unchanged.
  const lastResolvedBlockIdRef = useRef(null)
  const lastResolvedSlotsRef = useRef(null)

  function cellEl(groupId, dayId, blockId) {
    return document.querySelector(`[data-cell-key="${groupId}|${dayId}|${blockId}"]`)
  }

  function clearPreview() {
    const d = dragRef.current
    if (!d) return
    for (const blockId of d.coveredBlockIds) {
      const el = cellEl(d.groupId, d.dayId, blockId)
      el?.removeAttribute('data-drag-over')
      el?.removeAttribute('data-drop-edge')
    }
    if (d.truncatedAtBlockId) {
      cellEl(d.groupId, d.dayId, d.truncatedAtBlockId)?.removeAttribute('data-drag-truncated')
    }
  }

  function paintPreview(coveredBlockIds, truncatedAtBlockId) {
    clearPreview()
    dragRef.current = { ...dragRef.current, coveredBlockIds, truncatedAtBlockId }
    const d = dragRef.current
    for (const blockId of coveredBlockIds) {
      const el = cellEl(d.groupId, d.dayId, blockId)
      el?.setAttribute('data-drag-over', '')
      el?.setAttribute('data-drop-edge', 'bottom')
    }
    if (truncatedAtBlockId) {
      cellEl(d.groupId, d.dayId, truncatedAtBlockId)?.setAttribute('data-drag-truncated', '')
    }
  }

  // Grab — pointerdown directly on .span-extend-handle. Per apple-design's
  // Response principle (Interactions §1), tracking begins immediately, no
  // distance:8 threshold: the handle has no whole-cell click to disambiguate
  // against.
  function startExtend(groupId, dayId, headBlockId, headActivityId) {
    dragRef.current = { groupId, dayId, headBlockId, headActivityId, coveredBlockIds: [], truncatedAtBlockId: null }
    lastResolvedBlockIdRef.current = null
    lastResolvedSlotsRef.current = null
    cellEl(groupId, dayId, headBlockId)?.setAttribute('data-span-dragging', '')
  }

  function resolveBlockIdFromPoint(x, y) {
    const el = document.elementFromPoint(x, y)?.closest('[data-cell-key]')
    if (!el) return null
    const parts = el.getAttribute('data-cell-key').split('|')
    return parts[2]
  }

  useEffect(() => {
    function onMove(e) {
      const d = dragRef.current
      if (!d) return
      const blockId = resolveBlockIdFromPoint(e.clientX, e.clientY)
      if (!blockId) return
      if (blockId === lastResolvedBlockIdRef.current && slotsRef.current === lastResolvedSlotsRef.current) return
      lastResolvedBlockIdRef.current = blockId
      lastResolvedSlotsRef.current = slotsRef.current
      // R1 (Maker note #3): the SAME check expandSlot re-applies at dispatch,
      // never a second divergent preview-only rule.
      const { coveredBlockIds, truncatedAtBlockId } = computeSpanExtendPreview(
        slotsRef.current, sortedTimeBlocks, activities,
        { groupId: d.groupId, dayId: d.dayId, headBlockId: d.headBlockId, headActivityId: d.headActivityId, pointerBlockId: blockId }
      )
      paintPreview(coveredBlockIds, truncatedAtBlockId)
    }

    function finish() {
      const d = dragRef.current
      if (!d) return
      clearPreview()
      cellEl(d.groupId, d.dayId, d.headBlockId)?.removeAttribute('data-span-dragging')
      dragRef.current = null
      // Drop (Interactions §3): the final range is resolved fresh at
      // dispatch time by expandSlot itself (R1/R4) — this hook's job ends at
      // handing over the furthest block the preview reached.
      if (d.coveredBlockIds.length > 0) {
        const toBlockId = d.coveredBlockIds[d.coveredBlockIds.length - 1]
        expandSlot?.(d.groupId, d.dayId, d.headBlockId, toBlockId)
      }
    }

    function onUp() { finish() }
    // Cancel (Interactions §4): Escape clears instantly, no write.
    function onKey(e) {
      if (e.key !== 'Escape' || !dragRef.current) return
      const d = dragRef.current
      clearPreview()
      cellEl(d.groupId, d.dayId, d.headBlockId)?.removeAttribute('data-span-dragging')
      dragRef.current = null
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey)
    }
  // Re-bind whenever the inputs the closures read are replaced.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedTimeBlocks, activities, expandSlot])

  return { startExtend }
}
