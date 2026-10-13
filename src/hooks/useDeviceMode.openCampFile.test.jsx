// @vitest-environment jsdom
//
// T381 phase 2: opening a saved camp. The file is picked and checked BEFORE the camp is made; the camp is then made
// and signed in as usual; the load runs after login and BEFORE the renderer learns the camp exists, so the screen
// keeps its progress up. A camp left half-loaded is a phase of its own.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const mockLocalClient = {
  getBootFailure: vi.fn(), getCamp: vi.fn(), campHasSetupData: vi.fn(), chooseMode: vi.fn(), bootstrapCamp: vi.fn(),
  login: vi.fn(), verifySession: vi.fn(), getDevicePairingStatus: vi.fn(), onAuthRejected: vi.fn(),
  pickCampFile: vi.fn(), beginCampFileLoad: vi.fn(), loadCampFile: vi.fn(), startOverCampFile: vi.fn(),
}
vi.mock('../localClient', () => ({ get localClient() { return mockLocalClient } }))
const { useDeviceMode } = await import('./useDeviceMode')

let store
beforeEach(() => {
  store = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  })
  for (const fn of Object.values(mockLocalClient)) fn.mockReset?.()
  mockLocalClient.chooseMode.mockResolvedValue({ ok: true })
  mockLocalClient.bootstrapCamp.mockResolvedValue({ ok: true })
  mockLocalClient.login.mockResolvedValue({ token: 'tok-1', role: 'admin' })
  mockLocalClient.getCamp.mockResolvedValue(null)
  mockLocalClient.campHasSetupData.mockResolvedValue(false)
  mockLocalClient.onAuthRejected.mockReturnValue(() => {})
  mockLocalClient.pickCampFile.mockResolvedValue({ ok: true, fileName: 'f.shoresh-camp', campName: 'C', counts: {} })
  mockLocalClient.beginCampFileLoad.mockResolvedValue({ ok: true })
  mockLocalClient.loadCampFile.mockResolvedValue({ ok: true, counts: { groups: 2 } })
  mockLocalClient.startOverCampFile.mockResolvedValue({ ok: true })
})
afterEach(() => { vi.unstubAllGlobals() })

const ready = async () => {
  const hook = renderHook(() => useDeviceMode())
  await waitFor(() => expect(hook.result.current.phase).toBe('mode-select'))
  return hook
}
const creds = { campName: 'C', adminName: 'Ruth', adminPin: '123456' }

describe('open a saved camp', () => {
  it('is its own phase from the start screen choice until the camp exists', async () => {
    const { result } = await ready()
    act(() => result.current.chooseOpenFile())
    expect(result.current.phase).toBe('open-file')
    act(() => result.current.cancelOpenFile())
    expect(result.current.phase).toBe('mode-select')
  })

  it('picks before any camp is made', async () => {
    const { result } = await ready()
    await act(async () => { await result.current.pickCampFile() })
    expect(mockLocalClient.pickCampFile).toHaveBeenCalledTimes(1)
    expect(mockLocalClient.bootstrapCamp).not.toHaveBeenCalled()
  })

  it('bootstraps, signs in, loads, and does not reveal the camp to the app until finish', async () => {
    const { result } = await ready()
    act(() => result.current.chooseOpenFile())
    let outcome
    await act(async () => { outcome = await result.current.bootstrapFromCampFile(creds) })
    expect(outcome).toEqual({ ok: true, counts: { groups: 2 } })
    expect(mockLocalClient.bootstrapCamp).toHaveBeenCalledWith(creds)
    expect(mockLocalClient.login).toHaveBeenCalledWith('Ruth', '123456')
    expect(mockLocalClient.loadCampFile).toHaveBeenCalledTimes(1)
    expect(mockLocalClient.login.mock.invocationCallOrder[0]).toBeLessThan(mockLocalClient.loadCampFile.mock.invocationCallOrder[0])
    expect(result.current.phase).toBe('open-file')

    mockLocalClient.getCamp.mockResolvedValue({ id: 'c1', name: 'C', loadIncomplete: false })
    await act(async () => { await result.current.finishOpenFile() })
    expect(result.current.phase).toBe('session')
    expect(localStorage.getItem('shoresh-mode')).toBe('host')
  })

  it('marks the profile incomplete before the camp is made, and makes no camp if it cannot', async () => {
    const { result } = await ready()
    act(() => result.current.chooseOpenFile())
    await act(async () => { await result.current.bootstrapFromCampFile(creds) })
    expect(mockLocalClient.beginCampFileLoad.mock.invocationCallOrder[0]).toBeLessThan(mockLocalClient.chooseMode.mock.invocationCallOrder[0])
    mockLocalClient.chooseMode.mockClear()
    mockLocalClient.beginCampFileLoad.mockResolvedValue({ ok: false, reason: 'no_file_picked' })
    let outcome
    await act(async () => { outcome = await result.current.bootstrapFromCampFile(creds) })
    expect(outcome).toMatchObject({ ok: false })
    expect(mockLocalClient.chooseMode).not.toHaveBeenCalled()
  })

  it('reports a failed load with its reason and does not refresh the camp', async () => {
    mockLocalClient.loadCampFile.mockResolvedValue({ ok: false, reason: 'load_incomplete', detail: { message: 'boom' } })
    const { result } = await ready()
    act(() => result.current.chooseOpenFile())
    const calls = mockLocalClient.getCamp.mock.calls.length
    let outcome
    await act(async () => { outcome = await result.current.bootstrapFromCampFile(creds) })
    expect(outcome).toMatchObject({ ok: false, reason: 'load_incomplete' })
    expect(mockLocalClient.getCamp.mock.calls.length).toBe(calls)
    expect(result.current.phase).toBe('open-file')
  })

  it('reports a bootstrap that throws as a failure the screen can show', async () => {
    mockLocalClient.bootstrapCamp.mockRejectedValue(new Error('camp already exists'))
    const { result } = await ready()
    act(() => result.current.chooseOpenFile())
    let outcome
    await act(async () => { outcome = await result.current.bootstrapFromCampFile(creds) })
    expect(outcome).toMatchObject({ ok: false, reason: 'load_incomplete' })
    expect(mockLocalClient.loadCampFile).not.toHaveBeenCalled()
  })

  it('start over forgets this device\'s mode and session, then asks main to switch to a fresh profile', async () => {
    const { result } = await ready()
    localStorage.setItem('shoresh-mode', 'host')
    localStorage.setItem('shoresh-token', 'tok-1')
    localStorage.setItem('shoresh-role', 'admin')
    let outcome
    await act(async () => { outcome = await result.current.startOver() })
    expect(outcome).toEqual({ ok: true })
    expect(mockLocalClient.startOverCampFile).toHaveBeenCalledTimes(1)
    expect(['shoresh-mode', 'shoresh-token', 'shoresh-role'].map((k) => localStorage.getItem(k))).toEqual([null, null, null])
  })
})

describe('a camp left half-loaded', () => {
  it('is its own phase, ahead of sign-in and ahead of the session', async () => {
    localStorage.setItem('shoresh-mode', 'host')
    localStorage.setItem('shoresh-token', 'tok-1')
    mockLocalClient.verifySession.mockResolvedValue({ valid: true, role: 'admin' })
    mockLocalClient.getCamp.mockResolvedValue({ id: 'c1', name: 'C', loadIncomplete: true })
    const { result } = renderHook(() => useDeviceMode())
    await waitFor(() => expect(result.current.phase).toBe('load-incomplete'))
  })
})
