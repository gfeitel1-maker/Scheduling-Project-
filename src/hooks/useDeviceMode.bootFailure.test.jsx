// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const mockLocalClient = {
  getBootFailure: vi.fn(),
  getCamp: vi.fn(),
  campHasSetupData: vi.fn(),
  chooseMode: vi.fn(),
  verifySession: vi.fn(),
  getDevicePairingStatus: vi.fn(),
  onAuthRejected: vi.fn(),
}
vi.mock('../localClient', () => ({ get localClient() { return mockLocalClient } }))

const { useDeviceMode } = await import('./useDeviceMode')

describe('useDeviceMode boot failure', () => {
  beforeEach(() => {
    const store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    })
    for (const fn of Object.values(mockLocalClient)) fn.mockReset()
    mockLocalClient.getCamp.mockResolvedValue(null)
    mockLocalClient.campHasSetupData.mockResolvedValue(false)
  })

  it('reports phase error with bootFailure and touches nothing else when main reports one', async () => {
    mockLocalClient.getBootFailure.mockResolvedValue({ code: 'db_unreadable' })
    const { result } = renderHook(() => useDeviceMode())
    await waitFor(() => expect(result.current.phase).toBe('error'))
    expect(result.current.bootFailure).toEqual({ code: 'db_unreadable' })
    expect(mockLocalClient.getCamp).not.toHaveBeenCalled()
  })

  it('proceeds normally when main reports none', async () => {
    mockLocalClient.getBootFailure.mockResolvedValue(null)
    const { result } = renderHook(() => useDeviceMode())
    await waitFor(() => expect(result.current.phase).toBe('mode-select'))
    expect(result.current.bootFailure).toBeNull()
  })

  it('reconciles stored host mode to client when main reports the role it actually holds', async () => {
    localStorage.setItem('shoresh-mode', 'host')
    mockLocalClient.getBootFailure.mockResolvedValue(null)
    mockLocalClient.getCamp.mockResolvedValue({ id: 'c1', name: 'Camp' })
    mockLocalClient.chooseMode.mockResolvedValue({ mode: 'client' })
    const { result } = renderHook(() => useDeviceMode())
    await waitFor(() => expect(result.current.mode).toBe('client'))
    expect(localStorage.getItem('shoresh-mode')).toBe('client')
  })
})
