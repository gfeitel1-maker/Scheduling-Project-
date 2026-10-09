// @vitest-environment jsdom
//
// The successor's one confirm (docs/adr/2026-10-09-host-succession-simple.md, UI): "<this computer>
// becomes the host for <camp>", warning that both apps will restart. Appears on whichever screen the
// director is on when an offer arrives.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../localClient', () => ({
  localClient: {
    handoffStatus: vi.fn(),
    handoffAccept: vi.fn(),
    handoffDecline: vi.fn(),
    onHandoffChanged: vi.fn(),
  },
}))

import HostHandoffConfirm from './HostHandoffConfirm'
import { localClient } from '../localClient'

const offered = {
  isHost: false, eligibleDeviceIds: [], lastResult: null,
  selfName: 'Front Desk iPad', campName: 'Camp Kinneret', peerName: 'Office iMac',
  handoff: { role: 'taker', peerDeviceId: 'dev-h', state: 'offered' },
}

let changed
beforeEach(() => {
  vi.clearAllMocks()
  changed = null
  localClient.onHandoffChanged.mockImplementation((cb) => { changed = cb; return () => {} })
  localClient.handoffAccept.mockResolvedValue({ ok: true })
  localClient.handoffDecline.mockResolvedValue({ ok: true })
})
afterEach(cleanup)

describe('HostHandoffConfirm', () => {
  it('renders nothing when no offer is pending', async () => {
    localClient.handoffStatus.mockResolvedValue({ isHost: true, eligibleDeviceIds: [], handoff: null, lastResult: null })
    const { container } = render(<HostHandoffConfirm />)
    await waitFor(() => expect(localClient.handoffStatus).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })

  it('asks once, names this computer and the camp, and warns that both apps restart', async () => {
    localClient.handoffStatus.mockResolvedValue(offered)
    render(<HostHandoffConfirm />)
    expect(await screen.findByText('Front Desk iPad becomes the host for Camp Kinneret')).toBeTruthy()
    expect(screen.getByText(/both apps will restart/i)).toBeTruthy()
    expect(screen.getByText(/keep Office iMac open/i)).toBeTruthy()
  })

  it('confirming accepts the handoff; declining declines it', async () => {
    localClient.handoffStatus.mockResolvedValue(offered)
    render(<HostHandoffConfirm />)
    await userEvent.click(await screen.findByRole('button', { name: 'Make this the host' }))
    expect(localClient.handoffAccept).toHaveBeenCalledTimes(1)
  })

  it('Cancel declines', async () => {
    localClient.handoffStatus.mockResolvedValue(offered)
    render(<HostHandoffConfirm />)
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(localClient.handoffDecline).toHaveBeenCalledTimes(1)
    expect(localClient.handoffAccept).not.toHaveBeenCalled()
  })

  it('a failed accept says nothing changed here, inline, and offers no banner', async () => {
    localClient.handoffStatus.mockResolvedValue(offered)
    localClient.handoffAccept.mockResolvedValue({ ok: false, reason: 'peer_unreachable' })
    render(<HostHandoffConfirm />)
    await userEvent.click(await screen.findByRole('button', { name: 'Make this the host' }))
    expect((await screen.findByRole('status')).textContent).toContain('Handoff did not complete. Nothing was changed on this computer')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('once the key is stored and the old computer has not yet confirmed, it says so and offers no choice', async () => {
    localClient.handoffStatus.mockResolvedValue({ ...offered, handoff: { role: 'taker', peerDeviceId: 'dev-h', state: 'stored' } })
    render(<HostHandoffConfirm />)
    expect((await screen.findByRole('status')).textContent).toContain('Waiting for Office iMac to finish')
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('in stored, a failed activation says why and that the key is kept, inline, with no choice to throw it away', async () => {
    localClient.handoffStatus.mockResolvedValue({
      ...offered,
      handoff: { role: 'taker', peerDeviceId: 'dev-h', state: 'stored' },
      lastResult: { ok: false, reason: 'activation_failed', detail: 'disk I/O error', peerDeviceId: 'dev-h' },
    })
    render(<HostHandoffConfirm />)
    const text = (await screen.findByRole('status')).textContent
    expect(text).toContain('could not finish taking over (disk I/O error)')
    expect(text).toContain('hosting key is kept on this computer')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('re-reads the status when the main process says the handoff changed', async () => {
    localClient.handoffStatus.mockResolvedValue({ isHost: true, eligibleDeviceIds: [], handoff: null, lastResult: null })
    const { container } = render(<HostHandoffConfirm />)
    await waitFor(() => expect(changed).toBeTypeOf('function'))
    expect(container.textContent).toBe('')
    localClient.handoffStatus.mockResolvedValue(offered)
    await act(async () => { changed() })
    expect(await screen.findByText('Front Desk iPad becomes the host for Camp Kinneret')).toBeTruthy()
  })
})
