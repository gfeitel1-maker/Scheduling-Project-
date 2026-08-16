import { describe, it, expect } from 'vitest'
import { transition, idleState, IDLE, POINTING, DRAGGING, RESOLVING, MOVE, RESIZE } from './mapDragFSM'

const EVENT_TYPES = [
  'POINTER_DOWN',
  'DRAG_START',
  'POINTER_MOVE',
  'POINTER_UP',
  'COMMIT_SUCCESS',
  'COMMIT_FAILURE',
  'CANCEL',
]

const geom = (x) => ({ x, y: 0, w: 0.1, h: 0.1 })

const pointing = (kind = MOVE) => ({
  name: POINTING,
  context: { kind, locationId: 'loc-1', initialGeometry: geom(0), movingGeometry: null, finalGeometry: null, gestureId: 'g1' },
})

const dragging = (kind = MOVE, movingGeometry = geom(0.2)) => ({
  name: DRAGGING,
  context: { kind, locationId: 'loc-1', initialGeometry: geom(0), movingGeometry, finalGeometry: null, gestureId: 'g1' },
})

const resolving = (kind = MOVE) => ({
  name: RESOLVING,
  context: { kind, locationId: 'loc-1', initialGeometry: geom(0), movingGeometry: geom(0.2), finalGeometry: geom(0.2), gestureId: 'g1' },
})

const effectTypes = (result) => result.sideEffects.map((e) => e.type)

// ---------------------------------------------------------------------------
// The exhaustive table — mirrors dragFSM.test.js's shape exactly.
// ---------------------------------------------------------------------------
const EXPECTED = {
  [IDLE]: {
    POINTER_DOWN: POINTING,
    DRAG_START: IDLE,
    POINTER_MOVE: IDLE,
    POINTER_UP: IDLE,
    COMMIT_SUCCESS: IDLE,
    COMMIT_FAILURE: IDLE,
    CANCEL: IDLE,
  },
  [POINTING]: {
    POINTER_DOWN: POINTING,
    DRAG_START: DRAGGING,
    POINTER_MOVE: POINTING,
    POINTER_UP: IDLE, // a click, not a drag — selects the location
    COMMIT_SUCCESS: POINTING,
    COMMIT_FAILURE: POINTING,
    CANCEL: IDLE,
  },
  [DRAGGING]: {
    POINTER_DOWN: POINTING,
    DRAG_START: DRAGGING,
    POINTER_MOVE: DRAGGING,
    POINTER_UP: RESOLVING,
    COMMIT_SUCCESS: DRAGGING,
    COMMIT_FAILURE: DRAGGING,
    CANCEL: IDLE,
  },
  [RESOLVING]: {
    POINTER_DOWN: POINTING,
    DRAG_START: RESOLVING,
    POINTER_MOVE: RESOLVING,
    POINTER_UP: RESOLVING,
    COMMIT_SUCCESS: IDLE,
    COMMIT_FAILURE: IDLE,
    CANCEL: IDLE,
  },
}

const START_STATES = {
  [IDLE]: idleState,
  [POINTING]: pointing(),
  [DRAGGING]: dragging(),
  [RESOLVING]: resolving(),
}

describe('the exhaustive state x event table', () => {
  for (const stateName of Object.keys(EXPECTED)) {
    for (const eventType of EVENT_TYPES) {
      const expected = EXPECTED[stateName][eventType]
      it(`${stateName} + ${eventType} -> ${expected}`, () => {
        const result = transition(START_STATES[stateName], {
          type: eventType,
          kind: MOVE,
          locationId: 'loc-1',
          geometry: geom(0.3),
          gestureId: 'g1',
        })
        expect(result.nextState.name).toBe(expected)
        expect(Array.isArray(result.sideEffects)).toBe(true)
      })
    }
  }

  it('covers every event type in every state', () => {
    expect(Object.keys(EXPECTED)).toHaveLength(4)
    for (const stateName of Object.keys(EXPECTED)) {
      expect(Object.keys(EXPECTED[stateName]).sort()).toEqual([...EVENT_TYPES].sort())
    }
  })
})

describe('ignored (invalid) pairs produce no side effects and no context churn', () => {
  const ignored = [
    [IDLE, 'DRAG_START'],
    [IDLE, 'POINTER_MOVE'],
    [IDLE, 'POINTER_UP'],
    [IDLE, 'COMMIT_SUCCESS'],
    [IDLE, 'COMMIT_FAILURE'],
    [IDLE, 'CANCEL'],
    [POINTING, 'POINTER_MOVE'],
    [POINTING, 'COMMIT_SUCCESS'],
    [POINTING, 'COMMIT_FAILURE'],
    [DRAGGING, 'DRAG_START'],
    [DRAGGING, 'COMMIT_SUCCESS'],
    [DRAGGING, 'COMMIT_FAILURE'],
    [RESOLVING, 'DRAG_START'],
    [RESOLVING, 'POINTER_MOVE'],
    [RESOLVING, 'POINTER_UP'],
  ]

  for (const [stateName, eventType] of ignored) {
    it(`${stateName} + ${eventType} is an exact no-op`, () => {
      const state = START_STATES[stateName]
      const result = transition(state, { type: eventType, geometry: geom(0.9) })
      expect(result.nextState).toBe(state)
      expect(result.sideEffects).toEqual([])
    })
  }
})

describe('Pointing resolves click-vs-drag', () => {
  it('Pointing -> Dragging when the activation threshold is crossed, carrying the kind (move or resize)', () => {
    const result = transition(pointing(RESIZE), { type: 'DRAG_START', geometry: geom(0.2) })
    expect(result.nextState.name).toBe(DRAGGING)
    expect(result.nextState.context.kind).toBe(RESIZE)
    expect(result.nextState.context.movingGeometry).toEqual(geom(0.2))
    expect(result.sideEffects).toEqual([
      { type: 'showDragPreview', kind: RESIZE, locationId: 'loc-1', geometry: geom(0.2) },
    ])
  })

  it('Pointing -> Dragging falls back to initialGeometry when activation carries no geometry', () => {
    const result = transition(pointing(), { type: 'DRAG_START' })
    expect(result.nextState.context.movingGeometry).toEqual(geom(0))
  })

  it('Pointing -> Idle on release selects the location instead of committing (a click, not a drag)', () => {
    const result = transition(pointing(), { type: 'POINTER_UP' })
    expect(result.nextState).toBe(idleState)
    expect(result.sideEffects).toEqual([{ type: 'select', locationId: 'loc-1' }])
    expect(effectTypes(result)).not.toContain('commit')
  })

  it('POINTER_DOWN arms Pointing from Idle with the event kind, locationId, and initial geometry', () => {
    const result = transition(idleState, {
      type: 'POINTER_DOWN',
      kind: MOVE,
      locationId: 'loc-9',
      geometry: geom(0.5),
      gestureId: 'g9',
    })
    expect(result.nextState).toEqual({
      name: POINTING,
      context: { kind: MOVE, locationId: 'loc-9', initialGeometry: geom(0.5), movingGeometry: null, finalGeometry: null, gestureId: 'g9' },
    })
    expect(result.sideEffects).toEqual([])
  })
})

describe('Dragging tracks the moving geometry, no transition ever animates it (D8 — drop feedback stays static)', () => {
  it('POINTER_MOVE updates movingGeometry and describes a static (non-animated) preview update', () => {
    const result = transition(dragging(), { type: 'POINTER_MOVE', geometry: geom(0.4) })
    expect(result.nextState.context.movingGeometry).toEqual(geom(0.4))
    expect(result.sideEffects).toEqual([
      { type: 'updateDragPreview', kind: MOVE, locationId: 'loc-1', geometry: geom(0.4) },
    ])
  })

  it('release commits the final geometry and clears the preview', () => {
    const result = transition(dragging(RESIZE), { type: 'POINTER_UP', geometry: geom(0.6) })
    expect(result.nextState.name).toBe(RESOLVING)
    expect(result.nextState.context.finalGeometry).toEqual(geom(0.6))
    expect(result.sideEffects).toEqual([
      { type: 'hideDragPreview' },
      { type: 'commit', kind: RESIZE, locationId: 'loc-1', geometry: geom(0.6), gestureId: 'g1' },
    ])
  })

  it('release with no explicit geometry falls back to the last movingGeometry', () => {
    const result = transition(dragging(MOVE, geom(0.7)), { type: 'POINTER_UP' })
    expect(result.nextState.context.finalGeometry).toEqual(geom(0.7))
  })
})

describe('Resolving — commit results are gated by gestureId (a late result from a superseded gesture is ignored)', () => {
  it('COMMIT_SUCCESS for the CURRENT gesture returns to Idle', () => {
    const result = transition(resolving(), { type: 'COMMIT_SUCCESS', gestureId: 'g1' })
    expect(result.nextState).toBe(idleState)
  })

  it('COMMIT_SUCCESS for a DIFFERENT (stale) gestureId is ignored — stays in Resolving', () => {
    const state = resolving()
    const result = transition(state, { type: 'COMMIT_SUCCESS', gestureId: 'stale-gesture' })
    expect(result.nextState).toBe(state)
    expect(result.sideEffects).toEqual([])
  })

  it('COMMIT_FAILURE for the CURRENT gesture returns to Idle and announces the failure', () => {
    const result = transition(resolving(), { type: 'COMMIT_FAILURE', gestureId: 'g1', error: 'boom' })
    expect(result.nextState).toBe(idleState)
    expect(result.sideEffects).toEqual([
      { type: 'announceCommitFailure', kind: MOVE, locationId: 'loc-1', error: 'boom' },
    ])
  })

  it('COMMIT_FAILURE for a DIFFERENT (stale) gestureId is ignored', () => {
    const state = resolving()
    const result = transition(state, { type: 'COMMIT_FAILURE', gestureId: 'stale-gesture', error: 'boom' })
    expect(result.nextState).toBe(state)
  })
})

describe('A lost pointerup self-heals via re-arm (POINTER_DOWN from any non-Idle state)', () => {
  it('POINTER_DOWN while Dragging tears down the preview and arms a fresh gesture', () => {
    const result = transition(dragging(), {
      type: 'POINTER_DOWN', kind: RESIZE, locationId: 'loc-2', geometry: geom(0.1), gestureId: 'g2',
    })
    expect(result.nextState.name).toBe(POINTING)
    expect(result.nextState.context.locationId).toBe('loc-2')
    expect(result.sideEffects).toEqual([{ type: 'hideDragPreview' }])
  })
})
