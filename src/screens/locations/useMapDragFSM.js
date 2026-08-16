import { useRef } from 'react'
import { transition, idleState, MOVE } from './mapDragFSM'
import { computeMoveGeometry, computeResizeGeometry } from './mapGeometry'

// Binds the pure mapDragFSM to @dnd-kit and EXECUTES the side effects it
// describes (M6, D8, docs/adr/2026-08-16-locations-optional-map.md). Mirrors
// the SHAPE of src/screens/schedule/useDragFSM.js (its pure/binding split,
// not its content — grid hit-testing has no analogue here): the machine
// stays pure in mapDragFSM.js; everything that touches the DOM or the op-log
// lives here.
//
// Per-location DOM elements are imperatively updated (setAttribute / inline
// style), NOT via React state, for the same reason the schedule grid does
// this: a live drag/resize must update the ONE element under the pointer on
// every pointer-move without re-rendering every other location on the
// canvas. At the map's scale (a few dozen locations, not 480 grid cells)
// this is not strictly load-bearing for performance, but it is the
// consistent, already-reviewed pattern, and it is what keeps position/size
// updates transition-free by construction (D8 — drop feedback stays static:
// a direct style write never animates, whereas moving the number through
// React state and back into an inline style risks a later refactor adding a
// transition that would violate the "never transitions" rule).
export function useMapDragFSM({ writeGeometry, containerRef, onCommitError }) {
  const stateRef = useRef(idleState)
  const activeRef = useRef(null)
  const elsRef = useRef(new Map()) // locationId -> DOM element
  const selectedElRef = useRef(null)
  const liveRef = useRef(null)
  const containerSizeRef = useRef({ width: 0, height: 0 })

  function registerLocationEl(locationId, el) {
    if (el) elsRef.current.set(locationId, el)
    else elsRef.current.delete(locationId)
  }

  function announce(text) {
    if (liveRef.current) liveRef.current.textContent = text
  }

  function applyGeometryStyle(el, geometry) {
    el.style.left = `${geometry.x * 100}%`
    el.style.top = `${geometry.y * 100}%`
    el.style.width = `${geometry.w * 100}%`
    el.style.height = `${geometry.h * 100}%`
  }

  function kindFromActive(active) {
    return active?.data?.current?.kind ?? MOVE
  }

  function locationIdFromActive(active) {
    return active?.data?.current?.locationId ?? null
  }

  function initialGeometryFromActive(active) {
    return active?.data?.current?.geometry ?? { x: 0, y: 0, w: 0.1, h: 0.1 }
  }

  function perform(effect) {
    switch (effect.type) {
      case 'showDragPreview': {
        const el = elsRef.current.get(effect.locationId)
        if (el) {
          el.setAttribute('data-dragging', '')
          el.setAttribute('data-drag-kind', effect.kind)
        }
        announce(`Picked up ${effect.locationId}.`)
        break
      }
      case 'updateDragPreview': {
        const el = elsRef.current.get(effect.locationId)
        if (el) applyGeometryStyle(el, effect.geometry)
        break
      }
      case 'hideDragPreview': {
        const locationId = stateRef.current.context?.locationId
        const el = locationId ? elsRef.current.get(locationId) : null
        if (el) {
          el.removeAttribute('data-dragging')
          el.removeAttribute('data-drag-kind')
        }
        break
      }
      case 'select': {
        if (selectedElRef.current) selectedElRef.current.removeAttribute('data-selected')
        const el = elsRef.current.get(effect.locationId)
        if (el) el.setAttribute('data-selected', '')
        selectedElRef.current = el ?? null
        break
      }
      case 'commit': {
        announce(`Placed ${effect.locationId}.`)
        Promise.resolve()
          .then(() => writeGeometry(effect.locationId, effect.geometry, effect.gestureId))
          .then((outcome) => {
            if (outcome?.dropped) return
            const result = outcome?.result
            if (result && !(result.status === 'applied' || result.status === 'queued')) {
              dispatch({ type: 'COMMIT_FAILURE', gestureId: effect.gestureId, error: 'write failed' })
              return
            }
            dispatch({ type: 'COMMIT_SUCCESS', gestureId: effect.gestureId })
          })
          .catch((error) => dispatch({ type: 'COMMIT_FAILURE', error, gestureId: effect.gestureId }))
        break
      }
      case 'announceCommitFailure':
        announce('That change could not be saved.')
        onCommitError?.(effect)
        break
    }
  }

  function dispatch(event) {
    const { nextState, sideEffects } = transition(stateRef.current, event)
    stateRef.current = nextState
    for (const effect of sideEffects) perform(effect)
  }

  function onDragStart(event) {
    activeRef.current = event.active
    const kind = kindFromActive(event.active)
    const locationId = locationIdFromActive(event.active)
    const geometry = initialGeometryFromActive(event.active)
    const rect = containerRef.current?.getBoundingClientRect()
    containerSizeRef.current = rect ? { width: rect.width, height: rect.height } : { width: 0, height: 0 }
    dispatch({ type: 'POINTER_DOWN', kind, locationId, geometry, gestureId: crypto.randomUUID() })
    dispatch({ type: 'DRAG_START', geometry })
  }

  function onDragMove(event) {
    const ctx = stateRef.current.context
    if (!ctx) return
    const container = containerSizeRef.current
    const geometry =
      ctx.kind === MOVE
        ? computeMoveGeometry(ctx.initialGeometry, event.delta, container)
        : computeResizeGeometry(ctx.initialGeometry, event.delta, container)
    dispatch({ type: 'POINTER_MOVE', geometry })
  }

  function onDragEnd(event) {
    const ctx = stateRef.current.context
    if (!ctx) return
    const container = containerSizeRef.current
    const geometry =
      ctx.kind === MOVE
        ? computeMoveGeometry(ctx.initialGeometry, event.delta, container)
        : computeResizeGeometry(ctx.initialGeometry, event.delta, container)
    dispatch({ type: 'POINTER_UP', geometry })
  }

  function onDragCancel() {
    dispatch({ type: 'CANCEL' })
  }

  // A body-only click (no drag ever started — dnd-kit never fires onDragStart
  // below its activation distance) is not visible to dnd-kit's callbacks at
  // all, so a plain onClick on the location body drives selection directly
  // via the same 'select' side effect a Pointing->Idle POINTER_UP would.
  function selectLocation(locationId) {
    dispatch({ type: 'POINTER_DOWN', kind: MOVE, locationId, geometry: null, gestureId: crypto.randomUUID() })
    dispatch({ type: 'POINTER_UP' })
  }

  return {
    registerLocationEl,
    liveRef,
    dndProps: { onDragStart, onDragMove, onDragEnd, onDragCancel },
    selectLocation,
    peekState: () => stateRef.current,
  }
}
