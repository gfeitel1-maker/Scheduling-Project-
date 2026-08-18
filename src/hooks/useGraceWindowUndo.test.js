// U1e — renderer-side state scoping (docs/adr/2026-08-17-onescreen-
// reconciliation-undo.md, Invariant 5).
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: { ingestUndo: vi.fn() },
}))

import { useGraceWindowUndo, GRACE_WINDOW_MS } from './useGraceWindowUndo'
import { localClient } from '../localClient'

beforeEach(() => {
  vi.useFakeTimers()
  localClient.ingestUndo.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

const outcome = (overrides = {}) => ({
  invertibleOps: [{ entity: 'days_of_operation', entity_id: 'd1', field: 'sort_order', opId: 'op1', seq: 1, priorValue: '1.0', prior_source: 'import' }],
  createdEntityIds: [{ entity: 'days_of_operation', entity_id: 'd2' }],
  ...overrides,
})

describe('useGraceWindowUndo', () => {
  it('starts idle, becomes live after start(), holds the captured outcome', () => {
    const { result } = renderHook(() => useGraceWindowUndo())
    expect(result.current.status).toBe('idle')
    expect(result.current.isLive).toBe(false)

    act(() => result.current.start(outcome()))
    expect(result.current.status).toBe('live')
    expect(result.current.isLive).toBe(true)
    expect(result.current.createdEntityIds).toEqual([{ entity: 'days_of_operation', entity_id: 'd2' }])
  })

  it('starting a SECOND import while a window is live replaces the prior window (Invariant 5b)', () => {
    const { result } = renderHook(() => useGraceWindowUndo())
    act(() => result.current.start(outcome({ createdEntityIds: [{ entity: 'days_of_operation', entity_id: 'first' }] })))
    expect(result.current.createdEntityIds).toEqual([{ entity: 'days_of_operation', entity_id: 'first' }])

    act(() => result.current.start(outcome({ createdEntityIds: [{ entity: 'days_of_operation', entity_id: 'second' }] })))
    expect(result.current.status).toBe('live')
    expect(result.current.createdEntityIds).toEqual([{ entity: 'days_of_operation', entity_id: 'second' }])
  })

  it('transitions to "used" after a successful undo, so a second click is a no-op', async () => {
    localClient.ingestUndo.mockResolvedValue({ ok: true, reverted: [{ entity: 'days_of_operation', entity_id: 'd1', field: 'sort_order' }], skipped: [] })
    const { result } = renderHook(() => useGraceWindowUndo())
    act(() => result.current.start(outcome()))

    await act(async () => { await result.current.undo() })
    expect(result.current.status).toBe('used')
    expect(localClient.ingestUndo).toHaveBeenCalledTimes(1)

    await act(async () => { await result.current.undo() })
    expect(localClient.ingestUndo).toHaveBeenCalledTimes(1) // no-op: status is no longer 'live'
  })

  it('two fast concurrent undo() calls dispatch only one ingestUndo (no double-submit)', async () => {
    let resolveIngest
    localClient.ingestUndo.mockReturnValue(
      new Promise((resolve) => { resolveIngest = resolve })
    )
    const { result } = renderHook(() => useGraceWindowUndo())
    act(() => result.current.start(outcome()))

    // Fire both calls before the first's await resolves — status is still
    // 'live' for both, so the in-flight ref (not status) must be the guard.
    let p1, p2
    act(() => {
      p1 = result.current.undo()
      p2 = result.current.undo()
    })
    expect(localClient.ingestUndo).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveIngest({ ok: true, reverted: [{ entity: 'days_of_operation', entity_id: 'd1', field: 'sort_order' }], skipped: [] })
      await p1
      await p2
    })
    expect(localClient.ingestUndo).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('used')
  })

  it('reports the skip receipt from ingestUndo', async () => {
    localClient.ingestUndo.mockResolvedValue({ ok: true, reverted: [], skipped: [{ entity: 'days_of_operation', entity_id: 'd1', field: 'sort_order' }] })
    const { result } = renderHook(() => useGraceWindowUndo())
    act(() => result.current.start(outcome()))
    await act(async () => { await result.current.undo() })
    expect(result.current.skipped).toEqual([{ entity: 'days_of_operation', entity_id: 'd1', field: 'sort_order' }])
  })

  it('expires after the grace window elapses', () => {
    const { result } = renderHook(() => useGraceWindowUndo())
    act(() => result.current.start(outcome()))
    act(() => vi.advanceTimersByTime(GRACE_WINDOW_MS + 1))
    expect(result.current.status).toBe('expired')
    expect(result.current.isLive).toBe(false)
  })

  it('clear() resets to idle', () => {
    const { result } = renderHook(() => useGraceWindowUndo())
    act(() => result.current.start(outcome()))
    act(() => result.current.clear())
    expect(result.current.status).toBe('idle')
    expect(result.current.createdEntityIds).toEqual([])
  })
})
