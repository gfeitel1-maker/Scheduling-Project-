// @vitest-environment jsdom
//
// T86 — approveDevice/denyDevice/revokeDevice write straight to this
// device's local, never-synced `devices` table; on a Client that write can
// never reach the Host, so the handlers refuse outright (electron/main.js).
// This pins the UI half: a Client admin sees the read-only device list but
// reaches no write control, while a Host admin's controls are unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    listPendingPairingRequests: vi.fn(),
    listDevices: vi.fn(),
    approveDevice: vi.fn(),
    denyDevice: vi.fn(),
    revokeDevice: vi.fn(),
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
