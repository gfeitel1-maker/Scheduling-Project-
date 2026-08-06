import { describe, it, expect } from 'vitest'
import {
  transition,
  idleState,
  IDLE,
  POINTING,
  DRAGGING,
  RESOLVING,
  DRAG_KINDS,
} from './dragFSM'

const EVENT_TYPES = [
  'POINTER_DOWN',
  'DRAG_START',
  'POINTER_MOVE',
  'POINTER_UP',
  'COMMIT_SUCCESS',
  'COMMIT_FAILURE',
  'CANCEL',
]

const hit = (over, extra = {}) => ({ cellKey: over, edge: 'top', ...extra })

const pointing = (kind = DRAG_KINDS.SLOT_MOVE) => ({
  name: POINTING,
  context: { kind, initialHit: hit('a'), movingHit: null, finalHit: null },
})

const dragging = (kind = DRAG_KINDS.SLOT_MOVE, movingHit = hit('b')) => ({
  name: DRAGGING,
  context: { kind, initialHit: hit('a'), movingHit, finalHit: null },
})

const resolving = (kind = DRAG_KINDS.SLOT_MOVE) => ({
  name: RESOLVING,
  context: { kind, initialHit: hit('a'), movingHit: hit('b'), finalHit: hit('b') },
})

const effectTypes = result => result.sideEffects.map(e => e.type)

// ---------------------------------------------------------------------------
// The exhaustive table. Every (state, event) pair has one expected next state.
// Invalid pairs are here on purpose: an unexpected event must be a defined
// no-op, never undefined behaviour.
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
    POINTER_DOWN: POINTING, // re-arm after a lost pointerup
    DRAG_START: DRAGGING,
    POINTER_MOVE: POINTING, // below the activation threshold
    POINTER_UP: IDLE, // a click, not a drag
    COMMIT_SUCCESS: POINTING, // stale result from an earlier gesture
    COMMIT_FAILURE: POINTING,
    CANCEL: IDLE,
  },
  [DRAGGING]: {
    POINTER_DOWN: POINTING,
    DRAG_START: DRAGGING, // duplicate activation
    POINTER_MOVE: DRAGGING,
    POINTER_UP: RESOLVING, // over a valid hit; see the invalid-hit test below
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
          kind: DRAG_KINDS.SLOT_MOVE,
          hit: hit('b'),
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
      const result = transition(state, { type: eventType, hit: hit('z') })
      expect(result.nextState).toBe(state)
      expect(result.sideEffects).toEqual([])
    })
  }
})

// ---------------------------------------------------------------------------
// Pointing: the click-vs-drag fork. Both arms, explicitly.
// ---------------------------------------------------------------------------

describe('Pointing resolves click-vs-drag', () => {
  it('Pointing -> Dragging when the activation threshold is crossed', () => {
    const result = transition(pointing(), { type: 'DRAG_START', hit: hit('b') })
    expect(result.nextState.name).toBe(DRAGGING)
    expect(result.nextState.context.movingHit).toEqual(hit('b'))
    expect(result.sideEffects).toEqual([
      { type: 'showDragPreview', kind: DRAG_KINDS.SLOT_MOVE, hit: hit('b') },
    ])
  })

  it('Pointing -> Dragging falls back to initialHit when activation carries no hit', () => {
    const result = transition(pointing(), { type: 'DRAG_START' })
    expect(result.nextState.context.movingHit).toEqual(hit('a'))
  })

  it('Pointing -> Idle on release: a click, not a drag', () => {
    const result = transition(pointing(), { type: 'POINTER_UP' })
    expect(result.nextState).toBe(idleState)
    expect(result.sideEffects).toEqual([
      { type: 'click', kind: DRAG_KINDS.SLOT_MOVE, hit: hit('a') },
    ])
  })

  it('a click never emits a commit', () => {
    const result = transition(pointing(), { type: 'POINTER_UP' })
    expect(effectTypes(result)).not.toContain('commit')
  })

  it('POINTER_DOWN arms Pointing from Idle with the event kind and initial hit', () => {
    const result = transition(idleState, {
      type: 'POINTER_DOWN',
      kind: DRAG_KINDS.EXPAND_DRAG,
      hit: hit('a'),
    })
    expect(result.nextState).toEqual({
      name: POINTING,
      context: { kind: DRAG_KINDS.EXPAND_DRAG, initialHit: hit('a'), movingHit: null, finalHit: null },
    })
    expect(result.sideEffects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Dragging
// ---------------------------------------------------------------------------

describe('Dragging tracks the moving hit', () => {
  it('POINTER_MOVE updates movingHit and refreshes the indicator', () => {
    const result = transition(dragging(), { type: 'POINTER_MOVE', hit: hit('c') })
    expect(result.nextState.context.movingHit).toEqual(hit('c'))
    expect(result.sideEffects).toEqual([
      { type: 'updateDropIndicator', kind: DRAG_KINDS.SLOT_MOVE, hit: hit('c') },
    ])
  })

  it('POINTER_MOVE off any cell clears the moving hit', () => {
    const result = transition(dragging(), { type: 'POINTER_MOVE', hit: null })
    expect(result.nextState.context.movingHit).toBeNull()
    expect(result.sideEffects).toEqual([
      { type: 'updateDropIndicator', kind: DRAG_KINDS.SLOT_MOVE, hit: null },
    ])
  })

  it('release over a valid hit goes to Resolving and describes the commit', () => {
    const result = transition(dragging(), { type: 'POINTER_UP', hit: hit('c') })
    expect(result.nextState.name).toBe(RESOLVING)
    expect(result.nextState.context.finalHit).toEqual(hit('c'))
    expect(result.sideEffects).toEqual([
      { type: 'hideDragPreview' },
      {
        type: 'commit',
        kind: DRAG_KINDS.SLOT_MOVE,
        initialHit: hit('a'),
        finalHit: hit('c'),
      },
    ])
  })

  it('release with no hit returns to Idle without committing', () => {
    const result = transition(dragging(DRAG_KINDS.SLOT_MOVE, null), { type: 'POINTER_UP', hit: null })
    expect(result.nextState).toBe(idleState)
    expect(effectTypes(result)).toEqual(['hideDragPreview', 'clearDropIndicator'])
  })

  it('release over a rejected target returns to Idle without committing', () => {
    const result = transition(dragging(), { type: 'POINTER_UP', hit: hit('c', { valid: false }) })
    expect(result.nextState).toBe(idleState)
    expect(effectTypes(result)).not.toContain('commit')
  })

  it('release with no hit on the event falls back to the last movingHit', () => {
    const result = transition(dragging(DRAG_KINDS.SLOT_MOVE, hit('b')), { type: 'POINTER_UP' })
    expect(result.nextState.name).toBe(RESOLVING)
    expect(result.nextState.context.finalHit).toEqual(hit('b'))
  })

  it('CANCEL tears the preview and indicator down', () => {
    const result = transition(dragging(), { type: 'CANCEL' })
    expect(result.nextState).toBe(idleState)
    expect(effectTypes(result)).toEqual(['hideDragPreview', 'clearDropIndicator'])
  })
})

// ---------------------------------------------------------------------------
// Resolving: the op-log write can fail, so both arms must land back in Idle.
// ---------------------------------------------------------------------------

describe('Resolving returns to Idle on both commit outcomes', () => {
  it('Resolving -> Idle on commit success', () => {
    const result = transition(resolving(), { type: 'COMMIT_SUCCESS' })
    expect(result.nextState).toBe(idleState)
    expect(result.sideEffects).toEqual([{ type: 'clearDropIndicator' }])
  })

  it('Resolving -> Idle on commit failure, announcing the failure', () => {
    const error = new Error('op-log write rejected')
    const result = transition(resolving(), { type: 'COMMIT_FAILURE', error })
    expect(result.nextState).toBe(idleState)
    expect(result.sideEffects).toEqual([
      { type: 'clearDropIndicator' },
      { type: 'announceCommitFailure', kind: DRAG_KINDS.SLOT_MOVE, error },
    ])
  })

  it('Resolving -> Idle on cancel, leaving the in-flight write to the op-log', () => {
    const result = transition(resolving(), { type: 'CANCEL' })
    expect(result.nextState).toBe(idleState)
    expect(result.sideEffects).toEqual([{ type: 'clearDropIndicator' }])
  })
})

// ---------------------------------------------------------------------------
// Re-arming: a lost pointerup must not wedge the machine.
// ---------------------------------------------------------------------------

describe('POINTER_DOWN outside Idle re-arms rather than wedging', () => {
  it('from Pointing, re-arms with the new payload and no teardown', () => {
    const result = transition(pointing(), {
      type: 'POINTER_DOWN',
      kind: DRAG_KINDS.PALETTE_DROP,
      hit: hit('z'),
    })
    expect(result.nextState.name).toBe(POINTING)
    expect(result.nextState.context.kind).toBe(DRAG_KINDS.PALETTE_DROP)
    expect(result.nextState.context.initialHit).toEqual(hit('z'))
    expect(result.sideEffects).toEqual([])
  })

  it('from Dragging, tears the stale preview down first', () => {
    const result = transition(dragging(), {
      type: 'POINTER_DOWN',
      kind: DRAG_KINDS.SLOT_MOVE,
      hit: hit('z'),
    })
    expect(result.nextState.name).toBe(POINTING)
    expect(effectTypes(result)).toEqual(['hideDragPreview', 'clearDropIndicator'])
  })

  it('from Resolving, clears the stale indicator first', () => {
    const result = transition(resolving(), {
      type: 'POINTER_DOWN',
      kind: DRAG_KINDS.SLOT_MOVE,
      hit: hit('z'),
    })
    expect(result.nextState.name).toBe(POINTING)
    expect(result.sideEffects).toEqual([{ type: 'clearDropIndicator' }])
  })
})

// ---------------------------------------------------------------------------
// All four drag kinds go through the one machine.
// ---------------------------------------------------------------------------

describe('all four drag kinds use the same machine', () => {
  const kinds = [
    DRAG_KINDS.SLOT_MOVE,
    DRAG_KINDS.PALETTE_DROP,
    DRAG_KINDS.EXPAND_DRAG,
    DRAG_KINDS.OVERLAY_FILL,
  ]

  it('exposes exactly the four kinds', () => {
    expect(kinds).toEqual(['slot-move', 'palette-drop', 'expand-drag', 'overlay-fill'])
  })

  for (const kind of kinds) {
    it(`${kind} runs Idle -> Pointing -> Dragging -> Resolving -> Idle carrying its kind`, () => {
      const down = transition(idleState, { type: 'POINTER_DOWN', kind, hit: hit('a') })
      expect(down.nextState.context.kind).toBe(kind)

      const start = transition(down.nextState, { type: 'DRAG_START', hit: hit('a') })
      expect(start.nextState.name).toBe(DRAGGING)
      expect(start.sideEffects[0]).toMatchObject({ type: 'showDragPreview', kind })

      const move = transition(start.nextState, { type: 'POINTER_MOVE', hit: hit('b') })
      expect(move.sideEffects[0]).toMatchObject({ type: 'updateDropIndicator', kind })

      const up = transition(move.nextState, { type: 'POINTER_UP', hit: hit('b') })
      expect(up.nextState.name).toBe(RESOLVING)
      expect(up.sideEffects[1]).toMatchObject({ type: 'commit', kind, finalHit: hit('b') })

      const done = transition(up.nextState, { type: 'COMMIT_SUCCESS' })
      expect(done.nextState).toBe(idleState)
    })

    it(`${kind} can end as a click instead of a drag`, () => {
      const down = transition(idleState, { type: 'POINTER_DOWN', kind, hit: hit('a') })
      const up = transition(down.nextState, { type: 'POINTER_UP' })
      expect(up.nextState).toBe(idleState)
      expect(up.sideEffects).toEqual([{ type: 'click', kind, hit: hit('a') }])
    })
  }
})

describe('purity', () => {
  it('does not mutate the state it is given', () => {
    const state = dragging()
    const snapshot = JSON.parse(JSON.stringify(state))
    transition(state, { type: 'POINTER_MOVE', hit: hit('zzz') })
    transition(state, { type: 'POINTER_UP', hit: hit('zzz') })
    expect(state).toEqual(snapshot)
  })

  it('is deterministic', () => {
    const a = transition(pointing(), { type: 'DRAG_START', hit: hit('b') })
    const b = transition(pointing(), { type: 'DRAG_START', hit: hit('b') })
    expect(a).toEqual(b)
  })
})
