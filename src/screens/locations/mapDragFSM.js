// The one drag state machine for the camp map (M6, D8,
// docs/adr/2026-08-16-locations-optional-map.md).
//
// `transition(state, event) -> { nextState, sideEffects }`. Pure: no DOM, no
// React, no @dnd-kit, no localClient. Side effects are *described*, never
// performed — the component wiring this to dnd-kit's pointer/keyboard
// sensors is what executes them.
//
// Idle -> Pointing -> Dragging -> Resolving -> Idle
//
// This MIRRORS the SHAPE of src/screens/schedule/dragFSM.js (same four
// states — Resolving is still "op-log write not yet committed") — it is
// deliberately NOT that file, and does not import it. dragFSM.js's `context`
// payload and DRAG_KINDS are grid-shaped (groupId/dayId/blockId, hit
// resolution against cells); copying the file would mean immediately
// deleting most of what it does, since the map has no lattice — a location's
// rectangle is four continuous fractions of the image's bounding box.
//
// Pointing does NOT reproduce dragFSM.js's click-vs-drag ambiguity role here.
// The map's dnd-kit binding (useMapDragFSM.js's onDragStart) dispatches
// POINTER_DOWN and DRAG_START together, in the same tick, and only once
// dnd-kit's own activation distance has already fired — so a real drag never
// observably sits in Pointing at all. A plain click (never crossing that
// distance) is invisible to dnd-kit entirely and is handled OUTSIDE this
// machine, by LocationMarker's onClick calling selectLocation() directly
// (useMapDragFSM.js), which synthesizes a POINTER_DOWN+POINTER_UP pair
// through Pointing purely to reuse its existing 'select' side effect — not
// because Pointing is disambiguating anything. Pointing still exists (rather
// than collapsing DRAG_START straight into Dragging from Idle) so that
// synthetic click path has a state to synthesize through, and so POINTER_UP
// keeps one shape regardless of caller.
//
// Two drag kinds, both position/extent changes that write the same
// map_geometry field on release via the SAME hook (D7's
// useLocationGeometryMutations) — they differ only in which of x/y/w/h the
// gesture is allowed to change:
export const MOVE = 'move'
export const RESIZE = 'resize'

export const IDLE = 'Idle'
export const POINTING = 'Pointing'
export const DRAGGING = 'Dragging'
export const RESOLVING = 'Resolving'

export const idleState = { name: IDLE, context: null }

function armed(event) {
  return {
    name: POINTING,
    context: {
      kind: event.kind,
      locationId: event.locationId,
      initialGeometry: event.geometry,
      movingGeometry: null,
      finalGeometry: null,
      gestureId: event.gestureId,
    },
  }
}

// A POINTER_DOWN outside Idle means the previous gesture's pointerup was
// lost (pointer left the window, a rerender ate the event) — re-arms rather
// than wedging the machine, same as dragFSM.js's reArm.
function reArm(state, event) {
  return { nextState: armed(event), sideEffects: teardown(state) }
}

function teardown(state) {
  if (state.name === DRAGGING) return [{ type: 'hideDragPreview' }]
  return []
}

const ignore = (state) => ({ nextState: state, sideEffects: [] })

const table = {
  [IDLE]: {
    POINTER_DOWN: (state, event) => ({ nextState: armed(event), sideEffects: [] }),
    DRAG_START: ignore,
    POINTER_MOVE: ignore,
    POINTER_UP: ignore,
    COMMIT_SUCCESS: ignore,
    COMMIT_FAILURE: ignore,
    CANCEL: ignore,
  },

  [POINTING]: {
    POINTER_DOWN: reArm,
    DRAG_START: (state, event) => {
      const movingGeometry = event.geometry ?? state.context.initialGeometry
      return {
        nextState: { name: DRAGGING, context: { ...state.context, movingGeometry } },
        sideEffects: [{ type: 'showDragPreview', kind: state.context.kind, locationId: state.context.locationId, geometry: movingGeometry }],
      }
    },
    // Below the activation threshold — dnd-kit owns that threshold; until it
    // fires DRAG_START there is no preview, so moves change nothing.
    POINTER_MOVE: ignore,
    // The whole reason Pointing is named: this is a click, not a drag. Drives
    // the `data-selected` state (a keyboard user can see the active box
    // before pressing Enter to grab it) rather than any write.
    POINTER_UP: (state) => ({
      nextState: idleState,
      sideEffects: [{ type: 'select', locationId: state.context.locationId }],
    }),
    COMMIT_SUCCESS: ignore,
    COMMIT_FAILURE: ignore,
    CANCEL: () => ({ nextState: idleState, sideEffects: [] }),
  },

  [DRAGGING]: {
    POINTER_DOWN: reArm,
    DRAG_START: ignore,
    POINTER_MOVE: (state, event) => ({
      nextState: { name: DRAGGING, context: { ...state.context, movingGeometry: event.geometry } },
      // Per D8/the Designer spec: live drag position/size updates carry NO
      // transition, ever — 1:1 pointer following, zero interpolation. This
      // side effect is a plain re-render instruction, never an animated one.
      sideEffects: [{ type: 'updateDragPreview', kind: state.context.kind, locationId: state.context.locationId, geometry: event.geometry }],
    }),
    POINTER_UP: (state, event) => {
      const finalGeometry = event.geometry ?? state.context.movingGeometry
      return {
        nextState: { name: RESOLVING, context: { ...state.context, finalGeometry } },
        sideEffects: [
          { type: 'hideDragPreview' },
          {
            type: 'commit',
            kind: state.context.kind,
            locationId: state.context.locationId,
            geometry: finalGeometry,
            gestureId: state.context.gestureId,
          },
        ],
      }
    },
    COMMIT_SUCCESS: ignore,
    COMMIT_FAILURE: ignore,
    CANCEL: (state) => ({ nextState: idleState, sideEffects: teardown(state) }),
  },

  [RESOLVING]: {
    POINTER_DOWN: reArm,
    DRAG_START: ignore,
    POINTER_MOVE: ignore,
    POINTER_UP: ignore,
    // A commit result only belongs to the gesture that issued it — a second
    // gesture can enter RESOLVING while the first gesture's commit is still
    // in flight (POINTER_DOWN re-arms even from RESOLVING); its late result
    // must not act on the gesture now occupying this state.
    COMMIT_SUCCESS: (state, event) => {
      if (event.gestureId !== state.context.gestureId) return ignore(state)
      return { nextState: idleState, sideEffects: [] }
    },
    COMMIT_FAILURE: (state, event) => {
      if (event.gestureId !== state.context.gestureId) return ignore(state)
      return {
        nextState: idleState,
        sideEffects: [{ type: 'announceCommitFailure', kind: state.context.kind, locationId: state.context.locationId, error: event.error ?? null }],
      }
    },
    // Esc during an in-flight write: stop showing in-flight. The write may
    // still land; the op-log, not this machine, is the authority on whether
    // it did.
    CANCEL: () => ({ nextState: idleState, sideEffects: [] }),
  },
}

export function transition(state, event) {
  return table[state.name][event.type](state, event)
}
