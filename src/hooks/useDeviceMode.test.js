// @vitest-environment jsdom
//
// T87 (docs/adr/2026-08-16-client-reauth-on-restart.md): Parts 1 and 3.
//
// Part 1 — the startup effect must verify the stored token BEFORE calling
// chooseMode for the client branch, and hand the verified token (never the
// raw localStorage value) into that chooseMode call.
// Part 3 — a rejected-token push event must run the SAME cleanup as a
// locally-failed verifySession check.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const mockLocalClient = {
  getCamp: vi.fn(),
  campHasSetupData: vi.fn(),
  chooseMode: vi.fn(),
  verifySession: vi.fn(),
  getDevicePairingStatus: vi.fn(),
  onPairingApproved: vi.fn(),
  onPairingDenied: vi.fn(),
  onTokenRenewed: vi.fn(),
  onAuthRejected: vi.fn(),
}

vi.mock('../localClient', () => ({
  get localClient() { return mockLocalClient },
}))

const { useDeviceMode } = await import('./useDeviceMode')

const MODE_KEY = 'shoresh-mode'
const TOKEN_KEY = 'shoresh-token'
const ROLE_KEY = 'shoresh-role'
const JOIN_HOST_KEY = 'shoresh-join-host'

function seedClientDevice({ token, role = 'staff' } = {}) {
  localStorage.setItem(MODE_KEY, 'client')
  localStorage.setItem(JOIN_HOST_KEY, JSON.stringify({ host: '192.168.1.5', port: 7777 }))
  if (token) localStorage.setItem(TOKEN_KEY, token)
  if (role) localStorage.setItem(ROLE_KEY, role)
}

function makeLocalStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  }
}

let authRejectedCallback

beforeEach(() => {
  globalThis.localStorage = makeLocalStorage()
  vi.clearAllMocks()
  authRejectedCallback = undefined
  mockLocalClient.getCamp.mockResolvedValue(null)
  mockLocalClient.campHasSetupData.mockResolvedValue(false)
  mockLocalClient.chooseMode.mockResolvedValue({ mode: 'client' })
  mockLocalClient.getDevicePairingStatus.mockResolvedValue({ isPaired: true })
  mockLocalClient.onAuthRejected.mockImplementation((cb) => { authRejectedCallback = cb })
})

describe('useDeviceMode: startup ordering (T87 Part 1)', () => {
  it('calls verifySession before chooseMode for a returning Client device', async () => {
    seedClientDevice({ token: 'stored-token' })
    mockLocalClient.verifySession.mockResolvedValue({ valid: true, role: 'staff' })

    const { result } = renderHook(() => useDeviceMode())

    await waitFor(() => expect(result.current.phase).not.toBe('loading'))

    expect(mockLocalClient.verifySession).toHaveBeenCalledWith('stored-token')
    expect(mockLocalClient.chooseMode).toHaveBeenCalledTimes(1)

    const verifyOrder = mockLocalClient.verifySession.mock.invocationCallOrder[0]
    const chooseModeOrder = mockLocalClient.chooseMode.mock.invocationCallOrder[0]
    expect(verifyOrder).toBeLessThan(chooseModeOrder)
  })

  it('hands the LOCALLY-VERIFIED token — not the raw localStorage value — into the client chooseMode call', async () => {
    seedClientDevice({ token: 'stored-token' })
    mockLocalClient.verifySession.mockResolvedValue({ valid: true, role: 'staff' })

    const { result } = renderHook(() => useDeviceMode())
    await waitFor(() => expect(result.current.phase).not.toBe('loading'))

    expect(mockLocalClient.chooseMode).toHaveBeenCalledWith({
      mode: 'client', host: '192.168.1.5', port: 7777, token: 'stored-token',
    })
  })

  it('passes token: undefined into chooseMode when the stored token fails local verification, and clears it', async () => {
    seedClientDevice({ token: 'dead-token' })
    mockLocalClient.verifySession.mockResolvedValue({ valid: false })

    const { result } = renderHook(() => useDeviceMode())
    await waitFor(() => expect(result.current.phase).not.toBe('loading'))

    expect(mockLocalClient.chooseMode).toHaveBeenCalledWith({
      mode: 'client', host: '192.168.1.5', port: 7777, token: undefined,
    })
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(localStorage.getItem(ROLE_KEY)).toBeNull()
    expect(result.current.phase).toBe('login')
  })

  it('passes token: undefined into chooseMode when no token is stored at all (a device that has never logged in)', async () => {
    seedClientDevice({ token: null, role: null })

    const { result } = renderHook(() => useDeviceMode())
    await waitFor(() => expect(result.current.phase).not.toBe('loading'))

    expect(mockLocalClient.verifySession).not.toHaveBeenCalled()
    expect(mockLocalClient.chooseMode).toHaveBeenCalledWith({
      mode: 'client', host: '192.168.1.5', port: 7777, token: undefined,
    })
  })
})

describe('useDeviceMode: rejected-token cleanup (T87 Part 3)', () => {
  it('registers an onAuthRejected listener', async () => {
    seedClientDevice({ token: 'stored-token' })
    mockLocalClient.verifySession.mockResolvedValue({ valid: true, role: 'staff' })

    renderHook(() => useDeviceMode())
    await waitFor(() => expect(mockLocalClient.onAuthRejected).toHaveBeenCalled())
  })

  it('runs the SAME cleanup as a locally-failed verifySession check when the Host rejects the token', async () => {
    seedClientDevice({ token: 'stored-token' })
    mockLocalClient.verifySession.mockResolvedValue({ valid: true, role: 'staff' })

    const { result } = renderHook(() => useDeviceMode())
    await waitFor(() => expect(result.current.phase).not.toBe('loading'))
    expect(result.current.phase).toBe('session')

    expect(typeof authRejectedCallback).toBe('function')
    authRejectedCallback(4404)

    await waitFor(() => expect(result.current.phase).toBe('login'))
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(localStorage.getItem(ROLE_KEY)).toBeNull()
    expect(result.current.role).toBeNull()
  })
})

describe('useDeviceMode: sessionEndedReason (T87 fix round — director-facing explanation)', () => {
  it('sets a device-revoked explanation on 4404 and clears the token', async () => {
    seedClientDevice({ token: 'stored-token' })
    mockLocalClient.verifySession.mockResolvedValue({ valid: true, role: 'staff' })

    const { result } = renderHook(() => useDeviceMode())
    await waitFor(() => expect(result.current.phase).toBe('session'))

    authRejectedCallback(4404)

    await waitFor(() => expect(result.current.phase).toBe('login'))
    expect(result.current.sessionEndedReason).toMatch(/removed|revoked/i)
    expect(result.current.sessionEndedReason).toMatch(/director|admin/i)
  })

  it('sets a device-revoked explanation on 4403 too', async () => {
    seedClientDevice({ token: 'stored-token' })
    mockLocalClient.verifySession.mockResolvedValue({ valid: true, role: 'staff' })

    const { result } = renderHook(() => useDeviceMode())
    await waitFor(() => expect(result.current.phase).toBe('session'))

    authRejectedCallback(4403)

    await waitFor(() => expect(result.current.phase).toBe('login'))
    expect(result.current.sessionEndedReason).toMatch(/director|admin/i)
  })

  it('sets a benign, non-technical explanation on 4401 without leaking the close code', async () => {
    seedClientDevice({ token: 'stored-token' })
    mockLocalClient.verifySession.mockResolvedValue({ valid: true, role: 'staff' })

    const { result } = renderHook(() => useDeviceMode())
    await waitFor(() => expect(result.current.phase).toBe('session'))

    authRejectedCallback(4401)

    await waitFor(() => expect(result.current.phase).toBe('login'))
    expect(result.current.sessionEndedReason).toMatch(/sign in again/i)
    expect(result.current.sessionEndedReason).not.toMatch(/4401|4402|4403|4404/)
    expect(result.current.sessionEndedReason).not.toMatch(/director|admin/i)
  })

  it('leaves sessionEndedReason null after a locally-failed verifySession (benign, not a host rejection)', async () => {
    seedClientDevice({ token: 'dead-token' })
    mockLocalClient.verifySession.mockResolvedValue({ valid: false })

    const { result } = renderHook(() => useDeviceMode())
    await waitFor(() => expect(result.current.phase).toBe('login'))

    expect(result.current.sessionEndedReason).toBeNull()
  })

  it('clears sessionEndedReason on a successful login', async () => {
    seedClientDevice({ token: 'stored-token' })
    mockLocalClient.verifySession.mockResolvedValue({ valid: true, role: 'staff' })
    mockLocalClient.login = vi.fn().mockResolvedValue({ token: 'new-token', role: 'staff' })

    const { result } = renderHook(() => useDeviceMode())
    await waitFor(() => expect(result.current.phase).toBe('session'))

    authRejectedCallback(4404)
    await waitFor(() => expect(result.current.phase).toBe('login'))
    expect(result.current.sessionEndedReason).not.toBeNull()

    await result.current.login('Sarah', '1234')
    await waitFor(() => expect(result.current.sessionEndedReason).toBeNull())
  })
})

// docs/adr/2026-08-28-stage-aware-nav-landing.md Decision 1 — campIsEmpty is
// resolved inside the same init() effect that already blocks first paint
// (App.jsx's `phase === 'loading'` gate), from a single campHasSetupData()
// call, not getReadiness's five-collection engine pass.
describe('useDeviceMode: campIsEmpty (stage-aware landing, ADR Decision 1)', () => {
  it('calls campHasSetupData once per init, alongside getCamp/verifySession', async () => {
    const { result } = renderHook(() => useDeviceMode())
    await waitFor(() => expect(result.current.phase).not.toBe('loading'))

    expect(mockLocalClient.campHasSetupData).toHaveBeenCalledTimes(1)
  })

  it('is true when campHasSetupData resolves false (a bare, untouched camp)', async () => {
    mockLocalClient.campHasSetupData.mockResolvedValue(false)

    const { result } = renderHook(() => useDeviceMode())
    await waitFor(() => expect(result.current.phase).not.toBe('loading'))

    expect(result.current.campIsEmpty).toBe(true)
  })

  it('is false once any required-area row exists', async () => {
    mockLocalClient.campHasSetupData.mockResolvedValue(true)

    const { result } = renderHook(() => useDeviceMode())
    await waitFor(() => expect(result.current.phase).not.toBe('loading'))

    expect(result.current.campIsEmpty).toBe(false)
  })
})
