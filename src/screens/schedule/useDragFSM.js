import { useRef } from 'react'
import { transition, idleState, POINTING, DRAG_KINDS } from './dragFSM'
import { closestEdge } from './closestEdge'

// Binds the pure dragFSM to @dnd-kit and EXECUTES the side effects it describes.
// The machine stays pure; everything that touches the DOM, the announcer or the
// op-log lives here.
//
// Two rules shape this file (spec §7):
//
//   1. Gesture state never goes through React. `data-drag-over` / `data-drop-edge`
//      are one setAttribute on one element plus one removal on the previous one.
//      Re-rendering 480 cells to tint one is the cost this whole design exists to
//      avoid, so the FSM state itself lives in a ref, not useState.
//   2. Hit resolution is ours, not dnd-kit's. One droppable sits on the grid
//      surface; the cell under the pointer is found with elementFromPoint against
//      the `data-cell-key` T54 put on every cell. This is FullCalendar's
//      HitDragging pattern, and it is the only way to know WHERE within a cell the
//      pointer is — which is what closestEdge needs.

export function resolveHit(point) {
  if (!point) return null
  const pointEl = document.elementFromPoint(point.x, point.y)
  const el = pointEl?.closest('[data-cell-key]')
  if (!el) {
    // A release over the ActivityPalette resolves to a distinct, valid,
    // commit-worthy hit (not null) so the FSM proceeds to commit instead of
    // silently tearing down — that commit is what clears the drag's source
    // slot ("drag a grid card out to the palette clears it").
    if (pointEl?.closest('[data-activity-palette]')) {
      return { toPalette: true, valid: true, el: null }
    }
    return null
  }
  const cellKey = el.getAttribute('data-cell-key')
  const [groupId, dayId, blockId] = cellKey.split('|')
  return {
    cellKey,
    groupId,
    dayId,
    blockId,
    edge: closestEdge(el.getBoundingClientRect(), { y: point.y }),
    el,
    // Preserves exactly what `useDroppable({ disabled })` used to reject: locked
    // cells and anchors. A resolved-but-rejected target makes the FSM tear down
    // instead of commit — see isValidHit in dragFSM.js.
    valid: el.dataset.dropDisabled === undefined,
  }
}

// The kind the FSM is armed with while the gesture is still ambiguous. At
// DRAG_START it is re-derived from dnd-kit's `active.data`, which is
// authoritative, so a wrong guess here self-corrects.
function kindFromTarget(target) {
  if (!target?.closest) return null
  if (target.closest('[data-palette-activity]')) return DRAG_KINDS.PALETTE_DROP
  if (target.closest('[data-cell-key]')) return DRAG_KINDS.SLOT_MOVE
  return null
}

function kindFromActive(active) {
  const data = active?.data?.current || {}
  if (data.paletteActivity) return DRAG_KINDS.PALETTE_DROP
  if (data.slot) return DRAG_KINDS.SLOT_MOVE
  return null
}

export function useDragFSM({ commit, describeDrag, describeHit, isOccupied }) {
  const stateRef = useRef(idleState)
  const activeRef = useRef(null)
  const targetRef = useRef(null)
  const pointRef = useRef(null)
  const ghostRef = useRef(null)
  const liveRef = useRef(null)

  function announce(text) {
    if (liveRef.current) liveRef.current.textContent = text
  }

  function clearTarget() {
    const el = targetRef.current
    if (el) {
      el.removeAttribute('data-drag-over')
      el.removeAttribute('data-drop-edge')
      el.removeAttribute('data-drag-kind')
      el.removeAttribute('data-drag-replace')
      el.removeAttribute('data-drag-ghost-label')
    }
    targetRef.current = null
  }

  // The whole of "drag-over goes straight to the DOM": at most one removal and
  // one write per pointer event, and nothing at all when the target is unchanged.
  function paintTarget(hit, kind) {
    const el = hit && hit.valid !== false ? hit.el : null
    if (targetRef.current === el && el?.getAttribute('data-drop-edge') === hit?.edge) return
    if (targetRef.current !== el) clearTarget()
    if (!el) return
    targetRef.current = el
    el.setAttribute('data-drag-over', '')
    el.setAttribute('data-drop-edge', hit.edge)
    el.setAttribute('data-drag-kind', kind)

    const replaceKinds = kind === DRAG_KINDS.PALETTE_DROP || kind === DRAG_KINDS.SLOT_MOVE
    if (replaceKinds && isOccupied?.(hit)) {
      el.setAttribute('data-drag-replace', '')
      el.setAttribute('data-drag-ghost-label', describeDrag(activeRef.current))
    }
  }

  function moveGhost() {
    const g = ghostRef.current
    const p = pointRef.current
    if (!g || !p) return
    g.style.transform = `translate3d(${p.x + 14}px, ${p.y + 16}px, 0)`
  }

  function perform(effect) {
    switch (effect.type) {
      case 'showDragPreview': {
        const label = describeDrag(activeRef.current)
        const g = ghostRef.current
        if (g) {
          g.textContent = label
          g.setAttribute('data-visible', '')
          moveGhost()
        }
        announce(`Picked up ${label}.`)
        paintTarget(effect.hit, effect.kind)
        break
      }
      case 'updateDropIndicator': {
        moveGhost()
        const previous = targetRef.current
        paintTarget(effect.hit, effect.kind)
        if (targetRef.current && targetRef.current !== previous) {
          announce(`Over ${describeHit(effect.hit)}.`)
        }
        break
      }
      case 'hideDragPreview': {
        ghostRef.current?.removeAttribute('data-visible')
        break
      }
      case 'clearDropIndicator':
        clearTarget()
        break
      // Pointing -> POINTER_UP. Cells keep their own onClick; naming the state is
      // the point, not taking over click dispatch.
      case 'click':
        break
      case 'commit': {
        const active = activeRef.current
        announce(`Dropped on ${describeHit(effect.finalHit)}.`)
        Promise.resolve()
          .then(() => commit(active, effect.finalHit, effect.gestureId))
          .then(() => dispatch({ type: 'COMMIT_SUCCESS', gestureId: effect.gestureId }))
          .catch((error) => dispatch({ type: 'COMMIT_FAILURE', error, gestureId: effect.gestureId }))
        break
      }
      case 'announceCommitFailure':
        announce('That change could not be saved.')
        break
    }
  }

  function dispatch(event) {
    const { nextState, sideEffects } = transition(stateRef.current, event)
    stateRef.current = nextState
    for (const effect of sideEffects) perform(effect)
  }

  // Pointer coordinates: the activator event plus dnd-kit's delta. A keyboard
  // drag has no client coordinates, so it falls back to the centre of the
  // translated drag rect — which is the same thing the pointer path is
  // approximating, and is what makes the keyboard sensor resolve real hits.
  function pointFor(event) {
    const activator = event.activatorEvent
    if (activator && typeof activator.clientX === 'number') {
      const delta = event.delta || { x: 0, y: 0 }
      return { x: activator.clientX + delta.x, y: activator.clientY + delta.y }
    }
    const rect = event.active?.rect?.current?.translated
    if (rect) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    return pointRef.current
  }

  function onPointerDownCapture(e) {
    pointRef.current = { x: e.clientX, y: e.clientY }
    const kind = kindFromTarget(e.target)
    if (!kind) return
    dispatch({ type: 'POINTER_DOWN', kind, hit: resolveHit(pointRef.current), gestureId: crypto.randomUUID() })
  }

  // Only the click branch. Once dnd-kit has crossed its threshold the release is
  // onDragEnd's, and routing both here would fire POINTER_UP twice.
  function onPointerUpCapture() {
    if (stateRef.current.name === POINTING) dispatch({ type: 'POINTER_UP' })
  }

  function onDragStart(event) {
    activeRef.current = event.active
    const kind = kindFromActive(event.active) ?? DRAG_KINDS.SLOT_MOVE
    if (stateRef.current.name !== POINTING || stateRef.current.context.kind !== kind) {
      dispatch({ type: 'POINTER_DOWN', kind, hit: resolveHit(pointRef.current), gestureId: crypto.randomUUID() })
    }
    pointRef.current = pointFor(event) ?? pointRef.current
    dispatch({ type: 'DRAG_START', hit: resolveHit(pointRef.current) })
  }

  function onDragMove(event) {
    pointRef.current = pointFor(event) ?? pointRef.current
    dispatch({ type: 'POINTER_MOVE', hit: resolveHit(pointRef.current) })
  }

  function onDragEnd(event) {
    pointRef.current = pointFor(event) ?? pointRef.current
    dispatch({ type: 'POINTER_UP', hit: resolveHit(pointRef.current) })
  }

  function onDragCancel() {
    dispatch({ type: 'CANCEL' })
  }

  return {
    // Spread straight onto <GridDragSurface> and <DndContext> respectively.
    surfaceProps: { ghostRef, liveRef, onPointerDownCapture, onPointerUpCapture },
    dndProps: { onDragStart, onDragMove, onDragEnd, onDragCancel },
    // Test/debug seam only — nothing renders off this.
    peekState: () => stateRef.current,
  }
}
