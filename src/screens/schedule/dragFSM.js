// The one drag state machine for the schedule grid.
//
// `transition(state, event) -> { nextState, sideEffects }`. Pure: no DOM, no React,
// no @dnd-kit, no localClient. Side effects are *described*, never performed — the
// hook that binds this to dnd-kit (T58) is what executes them.
//
// Idle -> Pointing -> Dragging -> Resolving -> Idle
//
//   Pointing   the named home of click-vs-drag ambiguity (tldraw's pattern). Today
//              that ambiguity is implicit in dnd-kit's `distance: 8` plus the
//              isExpandDragActive / isGroupExpandDragActive / isDayExpandDragActive
//              flags. dnd-kit still owns the threshold; it reports the crossing as
//              DRAG_START. Pointing is where we sit until it does.
//   Resolving  released over a valid target, op-log write not yet committed. It
//              exists because our commits can fail, so there must be one place that
//              means "in flight" and one place that returns to Idle either way.
//
// One machine, four drag kinds. The kind rides in the context payload. Hit
// vocabulary (initialHit / movingHit / finalHit) is FullCalendar's HitDragging
// naming; the three-machine split is not adopted — four drag kinds do not need it.

export const IDLE = 'Idle'
export const POINTING = 'Pointing'
export const DRAGGING = 'Dragging'
export const RESOLVING = 'Resolving'

export const DRAG_KINDS = {
  SLOT_MOVE: 'slot-move',
  PALETTE_DROP: 'palette-drop',
  EXPAND_DRAG: 'expand-drag',
  OVERLAY_FILL: 'overlay-fill',
}

export const idleState = { name: IDLE, context: null }

// A hit is the resolved drop target. `valid: false` marks a resolved-but-rejected
// target (e.g. a locked cell); a missing hit means the pointer resolved to nothing.
function isValidHit(hit) {
  return Boolean(hit) && hit.valid !== false
}

function armed(event, extra) {
  return {
    name: POINTING,
    context: { kind: event.kind, initialHit: event.hit ?? null, movingHit: null, finalHit: null, ...extra },
  }
}

// A POINTER_DOWN outside Idle means the previous gesture's pointerup was lost
// (pointer left the window, a rerender ate the event). Ignoring it would wedge the
// machine forever and the user could never drag again, so it re-arms instead:
// tear down whatever was showing, then start the new gesture. Self-healing by
// design, not by accident.
function reArm(state, event) {
  return { nextState: armed(event), sideEffects: teardown(state) }
}

function teardown(state) {
  if (state.name === DRAGGING) return [{ type: 'hideDragPreview' }, { type: 'clearDropIndicator' }]
  if (state.name === RESOLVING) return [{ type: 'clearDropIndicator' }]
  return []
}

const ignore = state => ({ nextState: state, sideEffects: [] })

const table = {
  [IDLE]: {
    POINTER_DOWN: (state, event) => ({ nextState: armed(event), sideEffects: [] }),
    // Nothing is pointing, so there is nothing for a move, an activation, a release,
    // or a stale commit result to act on. All ignored, deliberately.
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
      const movingHit = event.hit ?? state.context.initialHit
      return {
        nextState: { name: DRAGGING, context: { ...state.context, movingHit } },
        sideEffects: [{ type: 'showDragPreview', kind: state.context.kind, hit: movingHit }],
      }
    },
    // Below the activation threshold. dnd-kit owns that threshold; until it fires
    // DRAG_START there is no preview and no indicator, so moves change nothing.
    POINTER_MOVE: ignore,
    // The whole reason Pointing is named: this is a click, not a drag.
    POINTER_UP: (state) => ({
      nextState: idleState,
      sideEffects: [{ type: 'click', kind: state.context.kind, hit: state.context.initialHit }],
    }),
    // A commit result from an earlier gesture arriving late. Not ours.
    COMMIT_SUCCESS: ignore,
    COMMIT_FAILURE: ignore,
    CANCEL: () => ({ nextState: idleState, sideEffects: [] }),
  },

  [DRAGGING]: {
    POINTER_DOWN: reArm,
    DRAG_START: ignore,
    POINTER_MOVE: (state, event) => ({
      nextState: { name: DRAGGING, context: { ...state.context, movingHit: event.hit ?? null } },
      sideEffects: [{ type: 'updateDropIndicator', kind: state.context.kind, hit: event.hit ?? null }],
    }),
    POINTER_UP: (state, event) => {
      const finalHit = event.hit ?? state.context.movingHit
      if (!isValidHit(finalHit)) {
        return { nextState: idleState, sideEffects: teardown(state) }
      }
      return {
        nextState: { name: RESOLVING, context: { ...state.context, finalHit } },
        sideEffects: [
          { type: 'hideDragPreview' },
          { type: 'commit', kind: state.context.kind, initialHit: state.context.initialHit, finalHit },
        ],
      }
    },
    COMMIT_SUCCESS: ignore,
    COMMIT_FAILURE: ignore,
    CANCEL: (state) => ({ nextState: idleState, sideEffects: teardown(state) }),
  },

  [RESOLVING]: {
    POINTER_DOWN: reArm,
    // The gesture is over; only the commit result can move us out of here.
    DRAG_START: ignore,
    POINTER_MOVE: ignore,
    POINTER_UP: ignore,
    COMMIT_SUCCESS: () => ({ nextState: idleState, sideEffects: [{ type: 'clearDropIndicator' }] }),
    COMMIT_FAILURE: (state, event) => ({
      nextState: idleState,
      sideEffects: [
        { type: 'clearDropIndicator' },
        { type: 'announceCommitFailure', kind: state.context.kind, error: event.error ?? null },
      ],
    }),
    // Esc during an in-flight write: stop showing in-flight. The write may still
    // land; the op-log, not this machine, is the authority on whether it did.
    CANCEL: () => ({ nextState: idleState, sideEffects: [{ type: 'clearDropIndicator' }] }),
  },
}

export function transition(state, event) {
  return table[state.name][event.type](state, event)
}
