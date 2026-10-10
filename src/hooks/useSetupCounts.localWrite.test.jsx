// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

// T123 — the sidebar's counts must follow a write made on THIS device, not only
// an op arriving from another one.
vi.mock('../localClient', () => {
  const listeners = { opApplied: [], localWrite: [] }
  return {
    localClient: {
      __listeners: listeners,
      list: vi.fn(async () => []),
      backupProject: vi.fn(async () => ({ backupPath: '/b' })),
      getCamp: vi.fn(async () => ({ name: 'Camp Kinneret' })),
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

  it('tracks the open import questions, so dismissing the last one frees the "setup complete" offer', async () => {
    localClient.listOpenReconciliationDecisions = vi.fn()
      .mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }])
      .mockResolvedValue([])
    const { result } = renderHook(() => useSetupCounts('camp-1'))
    await waitFor(() => expect(result.current.openQuestionCount).toBe(2))

    localClient.__listeners.localWrite.forEach((cb) => cb())
    await waitFor(() => expect(result.current.openQuestionCount).toBe(0))
    delete localClient.listOpenReconciliationDecisions
  })

  it('reports a caution status when the backup saved but the camp document was not included', async () => {
    const { result } = renderHook(() => useSetupCounts('camp-1'))
    localClient.backupProject.mockResolvedValueOnce({ backupPath: '/b', docBackupError: 'disk full' })
    await act(async () => { await result.current.handleBackupNow() })
    expect(result.current.backupStatus).toBe('caution')
  })

  it('keeps the caution status past 3s, until the next backup replaces it', async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useSetupCounts('camp-1'))
      localClient.backupProject.mockResolvedValueOnce({ backupPath: '/b', docBackupError: 'no_camp_document' })
      await act(async () => { await result.current.handleBackupNow() })
      await act(async () => { vi.advanceTimersByTime(60000) })
      expect(result.current.backupStatus).toBe('caution')
      await act(async () => { await result.current.handleBackupNow() })
      expect(result.current.backupStatus).toBe('ok')
      await act(async () => { vi.advanceTimersByTime(3500) })
      expect(result.current.backupStatus).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('a caution right after an ok backup is not cleared by the ok backup\'s pending reset', async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useSetupCounts('camp-1'))
      await act(async () => { await result.current.handleBackupNow() })
      expect(result.current.backupStatus).toBe('ok')
      localClient.backupProject.mockResolvedValueOnce({ backupPath: '/b', docBackupError: 'no_camp_document' })
      await act(async () => { vi.advanceTimersByTime(1000) })
      await act(async () => { await result.current.handleBackupNow() })
      await act(async () => { vi.advanceTimersByTime(60000) })
      expect(result.current.backupStatus).toBe('caution')
    } finally { vi.useRealTimers() }
  })

  it('still reports ok for a clean backup reply', async () => {
    const { result } = renderHook(() => useSetupCounts('camp-1'))
    await act(async () => { await result.current.handleBackupNow() })
    expect(result.current.backupStatus).toBe('ok')
  })
})
