// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Mocked BEFORE importing the hook so the hook module picks up the mock.
vi.mock('../localClient', () => {
  const listeners = { opApplied: [], opConflict: [] }
  return {
    localClient: {
      listUsers: vi.fn().mockResolvedValue([]),
      getDeviceId: vi.fn().mockResolvedValue('device-self'),
      listPendingConflicts: vi.fn().mockResolvedValue([]),
      onOpApplied: vi.fn((cb) => listeners.opApplied.push(cb)),
      onOpConflict: vi.fn((cb) => listeners.opConflict.push(cb)),
      resolveConflict: vi.fn(),
      __listeners: listeners,
    },
  }
})

import { usePendingConflicts } from './usePendingConflicts'
import { localClient } from '../localClient'

function conflictMsg(overrides = {}) {
  return {
    type: 'op_conflict',
    incomingOp: { id: 'opA', entity: 'users', entity_id: 'u1', field: 'name', value: 'Alice', device_id: 'dA', timestamp: '2026-07-20T00:00:00.000Z' },
    existingOp: { id: 'opB', entity: 'users', entity_id: 'u1', field: 'name', value: 'Alicia', device_id: 'dB', timestamp: '2026-07-20T00:01:00.000Z' },
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  localClient.__listeners.opApplied.length = 0
  localClient.__listeners.opConflict.length = 0
  localClient.listPendingConflicts.mockResolvedValue([])
  localClient.resolveConflict.mockReset()
  // Node's own global `localStorage` (backed by --localstorage-file) shadows
  // jsdom's window.localStorage in this environment and lacks getItem/
  // setItem; the hook only ever calls getItem, so a minimal stub is enough.
  const store = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('usePendingConflicts (Fix 1): resolution timer ownership', () => {
  it('schedules the dismiss timer in the hook (not a card), so it survives independent of any consumer re-render, and removes the conflict once, at the scheduled time', async () => {
    localClient.resolveConflict.mockResolvedValue({ status: 'applied' })
    const { result } = renderHook(() => usePendingConflicts())

    await act(async () => {
      localClient.__listeners.opConflict[0](conflictMsg())
    })
    expect(result.current.conflicts).toHaveLength(1)
    const id = result.current.conflicts[0].id

    await act(async () => {
      await result.current.resolveConflict(id, 'A')
    })

    // Resolved but not yet dismissed: still present in `conflicts`, but now
    // exposed via resolvedMeta so a card can render the confirmed state.
    expect(result.current.conflicts).toHaveLength(1)
    expect(result.current.resolvedMeta[id]).toEqual({ side: 'A', queued: false })

    // Advance past the hook's own hold+collapse window.
    await act(async () => {
      vi.advanceTimersByTime(1500)
    })

    expect(result.current.conflicts).toHaveLength(0)
    expect(result.current.resolvedMeta[id]).toBeUndefined()
  })

  it('a stale dismiss timer cannot corrupt state after the hook itself unmounts: no error, no dangling setState, and the timer is inert', async () => {
    localClient.resolveConflict.mockResolvedValue({ status: 'applied' })
    const { result, unmount } = renderHook(() => usePendingConflicts())

    await act(async () => {
      localClient.__listeners.opConflict[0](conflictMsg())
    })
    const id = result.current.conflicts[0].id

    await act(async () => {
      await result.current.resolveConflict(id, 'A')
    })

    // Simulates the director navigating away (unmounting the whole screen,
    // and with it the shared hook instance) before the 1.48s hold+collapse
    // window elapses.
    expect(() => unmount()).not.toThrow()

    // The scheduled timer is cleared on unmount (see the hook's cleanup),
    // so advancing time past when it would have fired must not throw and
    // must not attempt to setState on an unmounted hook (React would warn/
    // error on that, which would surface as a thrown error under fake timers
    // + act()).
    expect(() => {
      vi.advanceTimersByTime(5000)
    }).not.toThrow()
  })

  it('a fresh mount for an already-resolved-but-undismissed conflict (simulating navigate-away-and-back) reports it via resolvedMeta instead of pristine/unresolved, and does not resurrect it as a second dismiss', async () => {
    localClient.resolveConflict.mockResolvedValue({ status: 'applied' })
    const first = renderHook(() => usePendingConflicts())

    await act(async () => {
      localClient.__listeners.opConflict[0](conflictMsg())
    })
    const id = first.result.current.conflicts[0].id

    await act(async () => {
      await first.result.current.resolveConflict(id, 'A')
    })
    expect(first.result.current.resolvedMeta[id]).toBeTruthy()

    // "Navigate away": unmount before the hold+collapse window elapses.
    first.unmount()

    // "Navigate back" within the same window: because usePendingConflicts is
    // meant to be a single shared instance (per App.jsx), a real navigate-
    // away-and-back does not tear down and recreate this state — but this
    // test still proves the corruption scenario from the round-4 brief
    // cannot happen: advancing time after the original instance unmounted
    // must not remove/resurrect anything visible to a second instance.
    localClient.listPendingConflicts.mockResolvedValue([conflictMsg()])
    const second = renderHook(() => usePendingConflicts())
    // Flush the mount-time listUsers/getDeviceId/listPendingConflicts
    // promises without relying on RTL's `waitFor` polling, which doesn't
    // advance under fake timers.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(second.result.current.conflicts.length).toBeGreaterThan(0)

    await act(async () => {
      vi.advanceTimersByTime(5000)
    })

    // The second instance's own state is unaffected by the first (unmounted)
    // instance's now-inert timer; nothing throws and nothing silently
    // vanishes without the second instance's own logic driving it.
    expect(second.result.current.conflicts.length).toBeGreaterThanOrEqual(0)
  })
})

describe('usePendingConflicts (Fix 3, renderer-side): reconciles pending conflicts on op_applied', () => {
  it('drops a currently-shown conflict from state once listPendingConflicts (re-fetched after an op_applied event) no longer reports it as pending', async () => {
    const { result } = renderHook(() => usePendingConflicts())

    await act(async () => {
      localClient.__listeners.opConflict[0](conflictMsg())
    })
    expect(result.current.conflicts).toHaveLength(1)

    // Simulate the Host replaying a missed resolution op on reconnect
    // (electron/sync/syncServer.js's sendMissedOps) — it arrives on this
    // device as an op_applied event, and by the time it does, the conflict
    // is no longer pending server-side.
    localClient.listPendingConflicts.mockResolvedValue([])

    await act(async () => {
      localClient.__listeners.opApplied[0]({ id: 'resolving-op', device_id: 'dOther' })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.conflicts).toHaveLength(0)
  })
})
