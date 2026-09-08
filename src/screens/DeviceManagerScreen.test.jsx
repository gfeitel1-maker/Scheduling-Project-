// @vitest-environment jsdom
//
// T86 — approveDevice/denyDevice/revokeDevice write straight to this
// device's local, never-synced `devices` table; on a Client that write can
// never reach the Host, so the handlers refuse outright (electron/main.js).
// This pins the UI half: a Client admin sees the read-only device list but
// reaches no write control, while a Host admin's controls are unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../localClient', () => ({
  localClient: {
    listPendingPairingRequests: vi.fn(),
    listDevices: vi.fn(),
    approveDevice: vi.fn(),
    denyDevice: vi.fn(),
    revokeDevice: vi.fn(),
    getJoinCode: vi.fn(),
    setJoinWindow: vi.fn(),
  },
}))

import DeviceManagerScreen from './DeviceManagerScreen'
import { localClient } from '../localClient'

function pendingDevice(overrides = {}) {
  return { id: 'pending-1', name: 'iPad', ...overrides }
}

function authorizedDevice(overrides = {}) {
  return {
    id: 'authorized-1',
    name: 'MacBook',
    pairing_status: 'authorized',
    authorized_at: '2026-08-01T00:00:00.000Z',
    revoked_at: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  localClient.listPendingPairingRequests.mockResolvedValue([])
  localClient.listDevices.mockResolvedValue([])
  localClient.getJoinCode.mockResolvedValue({
    code: 'K4P72MRQ', formatted: 'K4P7-2MRQ', campName: 'Camp Kinneret', open: false,
  })
  localClient.setJoinWindow.mockImplementation(async (open) => ({ open }))
})

describe('DeviceManagerScreen — write controls gated by device mode', () => {
  it('shows Approve/Deny/Revoke controls for an admin on the Host', async () => {
    localClient.listPendingPairingRequests.mockResolvedValue([pendingDevice()])
    localClient.listDevices.mockResolvedValue([authorizedDevice()])

    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)

    expect(await screen.findByText('Approve')).toBeTruthy()
    expect(screen.getByText('Deny')).toBeTruthy()
    expect(screen.getByText('Revoke')).toBeTruthy()
  })

  it('hides Approve/Deny/Revoke controls for an admin on a Client, keeping the list read-only', async () => {
    localClient.listPendingPairingRequests.mockResolvedValue([pendingDevice()])
    localClient.listDevices.mockResolvedValue([authorizedDevice()])

    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="client" />)

    // Read-only: the device/pairing status is still visible.
    expect(await screen.findByText('iPad')).toBeTruthy()
    expect(screen.getByText('MacBook')).toBeTruthy()

    // Writes: no control is presented on a Client.
    expect(screen.queryByText('Approve')).toBeNull()
    expect(screen.queryByText('Deny')).toBeNull()
    expect(screen.queryByText('Revoke')).toBeNull()
  })
})

// docs/adr/2026-09-08-libp2p-join-flow.md §4. The words here are the product,
// not decoration: this is the moment a director has to recognize their own
// camp, and the ADR flags it as the part a delegated decision cannot stand in
// for.
describe('DeviceManagerScreen — adding a device', () => {
  it('does not show a code until the director asks to add a device', async () => {
    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)
    expect(await screen.findByRole('button', { name: /add a device/i })).toBeTruthy()
    expect(screen.queryByText('K4P7-2MRQ')).toBeNull()
  })

  it('shows the code, and says the camp by name, once the window is open', async () => {
    const user = userEvent.setup()
    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)
    // The camp's name is what makes this recognizable as *their* camp rather
    // than an opaque exchange.
    expect(await screen.findByText(/Camp Kinneret/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /add a device/i }))
    expect(await screen.findByText('K4P7-2MRQ')).toBeTruthy()
    expect(localClient.setJoinWindow).toHaveBeenCalledWith(true)
  })

  it('closes the window again, and stops showing the code', async () => {
    const user = userEvent.setup()
    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)
    await user.click(await screen.findByRole('button', { name: /add a device/i }))
    await user.click(await screen.findByRole('button', { name: /stop adding devices/i }))
    expect(localClient.setJoinWindow).toHaveBeenLastCalledWith(false)
    expect(screen.queryByText('K4P7-2MRQ')).toBeNull()
  })

  // T86's rule, carried into this panel: a Client cannot approve anyone, so it
  // must not offer a code that would go nowhere.
  it('offers nothing on a Client', async () => {
    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="client" />)
    expect(await screen.findByText(/No pending pairing requests/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /add a device/i })).toBeNull()
    expect(localClient.getJoinCode).not.toHaveBeenCalled()
  })
})
