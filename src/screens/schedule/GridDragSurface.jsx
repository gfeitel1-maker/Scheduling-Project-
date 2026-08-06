import { useDroppable } from '@dnd-kit/core'
import '../../components/schedule/scheduleGrid.css'

// The ONE droppable. Up to 480 cells used to each call useDroppable and evaluate
// isOver on every pointer event; the cell under the pointer is now resolved by
// useDragFSM from coordinates instead (spec §5.3). This wrapper exists so that
// single subscription lives inside the DndContext without any component under
// src/components/schedule/ importing useDroppable.
//
// It also hosts the two gesture-only elements, both written imperatively by the
// FSM and never by React: the drag preview ghost (follows the pointer, says WHAT
// is moving) and the live region. The drop indicator is the separate, static
// `data-drop-edge` mark on the target cell and never follows the pointer.
export default function GridDragSurface({
  ghostRef, liveRef, onPointerDownCapture, onPointerUpCapture, children,
}) {
  const { setNodeRef } = useDroppable({ id: 'schedule-grid-surface' })

  return (
    <div
      ref={setNodeRef}
      onPointerDownCapture={onPointerDownCapture}
      onPointerUpCapture={onPointerUpCapture}
    >
      {children}
      <div ref={ghostRef} className="drag-ghost" aria-hidden="true" />
      <div ref={liveRef} className="drag-live" role="status" aria-live="polite" />
    </div>
  )
}
