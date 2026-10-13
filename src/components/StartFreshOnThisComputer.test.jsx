// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../localClient', () => ({
  localClient: { getSyncStatus: vi.fn(), startFreshPreview: vi.fn(), onSyncStatusChanged: vi.fn(() => () => {}), startFreshOnThisComputer: vi.fn() },
}))
import { localClient } from '../localClient'
import StartFreshOnThisComputer from './StartFreshOnThisComputer'
import { DEVICE_REVOKED_REASON } from '../hooks/useDeviceMode'

const REMOVED = { mode: 'client', connected: false, state: 'client-disconnected', removedFromCamp: true, startFreshAvailable: true }
const HEALTHY = { mode: 'client', connected: true, state: 'connected', removedFromCamp: false, startFreshAvailable: false }
// A bare refusal sets removedFromCamp; only the verified gate sets startFreshAvailable.
const MARK_ONLY = { ...REMOVED, startFreshAvailable: false }
const store = new Map()

beforeEach(() => {
  vi.clearAllMocks()
  localClient.startFreshPreview.mockResolvedValue({ ok: true, camps: [] })
  store.clear()
  vi.stubGlobal('localStorage', { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) })
})

describe('StartFreshOnThisComputer', () => {
  it('says nothing and offers nothing on a healthy device', async () => {
    localClient.getSyncStatus.mockResolvedValue(HEALTHY)
    const { container } = render(<StartFreshOnThisComputer />)
    await vi.waitFor(() => expect(localClient.getSyncStatus).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 30))
    expect(container.textContent).toBe('')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('a removed mark without the verified gate shows nothing', async () => {
    localClient.getSyncStatus.mockResolvedValue(MARK_ONLY)
    const { container } = render(<StartFreshOnThisComputer />)
    await vi.waitFor(() => expect(localClient.getSyncStatus).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 30))
    expect(container.textContent).toBe('')
  })

  it('names every other camp, tells the director to Save whole camp first, and flags one outside Shoresh\'s folder', async () => {
    localClient.getSyncStatus.mockResolvedValue(REMOVED)
    localClient.startFreshPreview.mockResolvedValue({ ok: true, camps: [
      { name: 'Camp B', file: 'b.sqlite', outsideShoresh: false },
      { name: 'Outside Camp', file: '/Volumes/x/o.sqlite', outsideShoresh: true },
    ] })
    const user = userEvent.setup()
    render(<StartFreshOnThisComputer />)
    await user.click(await screen.findByRole('button', { name: 'Start fresh on this computer' }))
    expect(await screen.findByText(/Before you continue, use Save whole camp in Camp B so you can open it again\./)).toBeTruthy()
    expect(screen.getByText(/Outside Camp.*\/Volumes\/x\/o\.sqlite.*will no longer open/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Yes, start fresh' })).toBeTruthy()
  })

  it('is driven by the verified gate, not by any close-code reason string', async () => {
    localClient.getSyncStatus.mockResolvedValue(HEALTHY)
    const { container } = render(<StartFreshOnThisComputer notice={DEVICE_REVOKED_REASON} />)
    await vi.waitFor(() => expect(localClient.getSyncStatus).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('shows the removed copy and the button when this computer was removed', async () => {
    localClient.getSyncStatus.mockResolvedValue(REMOVED)
    render(<StartFreshOnThisComputer />)
    expect(await screen.findByText('This computer was removed from the camp.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start fresh on this computer' })).toBeTruthy()
  })

  it('does not repeat the removed copy when the sign-in notice already says it', async () => {
    localClient.getSyncStatus.mockResolvedValue(REMOVED)
    render(<StartFreshOnThisComputer notice={DEVICE_REVOKED_REASON} />)
    await screen.findByRole('button', { name: 'Start fresh on this computer' })
    expect(screen.queryByText('This computer was removed from the camp.')).toBeNull()
  })

  it('needs a second explicit click; the first only explains, the second sends the confirmation', async () => {
    localClient.getSyncStatus.mockResolvedValue(REMOVED)
    localClient.startFreshOnThisComputer.mockResolvedValue({ ok: true, restarting: true })
    store.set('shoresh-mode', 'client'); store.set('shoresh-token', 't'); store.set('shoresh-role', 'admin')
    const user = userEvent.setup()
    render(<StartFreshOnThisComputer />)
    await user.click(await screen.findByRole('button', { name: 'Start fresh on this computer' }))
    expect(localClient.startFreshOnThisComputer).not.toHaveBeenCalled()
    expect(screen.getByText(/clears Shoresh on this computer only, including its backups/i)).toBeTruthy()
    expect(screen.getByText(/still on your other computers/i)).toBeTruthy()
    expect(screen.getByText(/changed here after it was removed will be lost/i)).toBeTruthy()
    expect(screen.getByText(/Save whole camp.*still be opened/i)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Yes, start fresh' }))
    expect(localClient.startFreshOnThisComputer).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/restarting/i)).toBeTruthy()
    expect([...store.keys()]).toEqual([])
  })

  it('Cancel goes back without calling anything', async () => {
    localClient.getSyncStatus.mockResolvedValue(REMOVED)
    const user = userEvent.setup()
    render(<StartFreshOnThisComputer />)
    await user.click(await screen.findByRole('button', { name: 'Start fresh on this computer' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Start fresh on this computer' })).toBeTruthy()
    expect(localClient.startFreshOnThisComputer).not.toHaveBeenCalled()
  })

  it('says so, and keeps the sign-in state, when the reset was refused', async () => {
    localClient.getSyncStatus.mockResolvedValue(REMOVED)
    localClient.startFreshOnThisComputer.mockResolvedValue({ ok: false, error: 'not_removed', restarting: true })
    store.set('shoresh-token', 't')
    const user = userEvent.setup()
    render(<StartFreshOnThisComputer />)
    await user.click(await screen.findByRole('button', { name: 'Start fresh on this computer' }))
    await user.click(screen.getByRole('button', { name: 'Yes, start fresh' }))
    expect(await screen.findByText(/nothing was cleared/i)).toBeTruthy()
    expect(store.get('shoresh-token')).toBe('t')
  })
})
