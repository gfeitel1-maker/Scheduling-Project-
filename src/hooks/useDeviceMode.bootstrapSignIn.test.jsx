// @vitest-environment jsdom
//
// T128 — creating the camp signs the director in.
//
// Bootstrap collects the director's name and PIN, creates the account, and used
// to hand them a Sign in screen with an EMPTY Name field seconds after they had
// typed their name into it. The honest reading for a non-technical director is
// "it didn't save", at the exact moment they committed to the product.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const mockLocalClient = {
  getCamp: vi.fn(),
  campHasSetupData: vi.fn(),
  chooseMode: vi.fn(),
  bootstrapCamp: vi.fn(),
  login: vi.fn(),
  verifySession: vi.fn(),
  getDevicePairingStatus: vi.fn(),
  onPairingApproved: vi.fn(),
  onPairingDenied: vi.fn(),
  onTokenRenewed: vi.fn(),
  onAuthRejected: vi.fn(),
}
vi.mock('../localClient', () => ({ get localClient() { return mockLocalClient } }))

const { useDeviceMode } = await import('./useDeviceMode')

describe('useDeviceMode.bootstrapCamp', () => {
  beforeEach(() => {
    // Node's own localStorage global (--localstorage-file) shadows jsdom's and
    // is not a full Storage — same stub the other hook tests in this directory
    // use, and for the same reason.
    const store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    })
    for (const fn of Object.values(mockLocalClient)) fn.mockReset?.()
    mockLocalClient.chooseMode.mockResolvedValue({ ok: true })
    mockLocalClient.bootstrapCamp.mockResolvedValue({ ok: true })
    mockLocalClient.login.mockResolvedValue({ token: 'tok-1', role: 'admin' })
    mockLocalClient.getCamp.mockResolvedValue({ id: 'camp-1', name: 'Camp Ramah Tikvah' })
    mockLocalClient.campHasSetupData.mockResolvedValue(false)
    mockLocalClient.getDevicePairingStatus.mockResolvedValue(null)
    for (const k of ['onPairingApproved', 'onPairingDenied', 'onTokenRenewed', 'onAuthRejected']) {
      mockLocalClient[k].mockReturnValue(() => {})
    }
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('signs the director in with the credentials they just chose', async () => {
    const { result } = renderHook(() => useDeviceMode())
    await act(async () => {
      await result.current.bootstrapCamp({
        campName: 'Camp Ramah Tikvah', adminName: 'Dana Feldman', adminPin: '4827',
      })
    })

    expect(mockLocalClient.login).toHaveBeenCalledWith('Dana Feldman', '4827')
    await waitFor(() => expect(localStorage.getItem('shoresh-token')).toBe('tok-1'))
    expect(localStorage.getItem('shoresh-role')).toBe('admin')
  })

  it('goes through the ordinary login path, not a bootstrap-minted session', async () => {
    // The audited path (attemptLogin, lockout tracking, real token issuance) is
    // the only way to become authenticated. A second one would be a new
    // security surface for a convenience fix.
    const { result } = renderHook(() => useDeviceMode())
    await act(async () => {
      await result.current.bootstrapCamp({ campName: 'C', adminName: 'D', adminPin: '1111' })
    })
    expect(mockLocalClient.login).toHaveBeenCalledTimes(1)
  })

  it('surfaces a failure instead of leaving a half-made camp silently', async () => {
    mockLocalClient.bootstrapCamp.mockRejectedValue(new Error('camp already exists'))
    const { result } = renderHook(() => useDeviceMode())
    await act(async () => {
      await result.current.bootstrapCamp({ campName: 'C', adminName: 'D', adminPin: '1111' })
    })
    await waitFor(() => expect(result.current.error).toMatch(/camp already exists/))
    expect(mockLocalClient.login).not.toHaveBeenCalled()
  })
})
