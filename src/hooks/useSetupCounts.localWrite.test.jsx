// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

// T123 — the sidebar's counts must follow a write made on THIS device, not only
// an op arriving from another one.
vi.mock('../localClient', () => {
  const listeners = { opApplied: [], localWrite: [] }
  return {
    localClient: {
      __listeners: listeners,
      list: vi.fn(async () => []),
      getCamp: vi.fn(async () => ({ name: 'Camp Ramah Tikvah' })),
      onOpApplied: (cb) => { listeners.opApplied.push(cb); return () => {} },
      onLocalWrite: (cb) => { listeners.localWrite.push(cb); return () => {} },
    },
  }
})

const { localClient } = await import('../localClient')
const { useSetupCounts } = await import('./useSetupCounts')

describe('useSetupCounts — refresh channels', () => {
  beforeEach(() => {
    localClient.__listeners.opApplied.length = 0
    localClient.__listeners.localWrite.length = 0
    localClient.list.mockClear()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('subscribes to BOTH the sync channel and the local-write channel', async () => {
    renderHook(() => useSetupCounts('camp-1'))
    await waitFor(() => expect(localClient.list).toHaveBeenCalled())
    expect(localClient.__listeners.opApplied.length).toBe(1)
    expect(localClient.__listeners.localWrite.length).toBe(1)
  })

  it('re-reads the counts when this device writes', async () => {
    renderHook(() => useSetupCounts('camp-1'))
    await waitFor(() => expect(localClient.list).toHaveBeenCalled())
    const before = localClient.list.mock.calls.length

    localClient.__listeners.localWrite.forEach((cb) => cb())

    await waitFor(() => expect(localClient.list.mock.calls.length).toBeGreaterThan(before))
  })
})
