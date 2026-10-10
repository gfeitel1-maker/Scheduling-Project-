// @vitest-environment jsdom
//
// T86, narrowed by T332 and T351 — the "Add a device" listening window stays Host-only;
// pending-pairing Approve/Deny show on any admin device, and a deny says it is this-device-only.
// revokeDevice (and the Confirm-removal vote affordance) do NOT: their backend gate
// (authorize()'s role check) has been mode-agnostic since T332's base change, so a Client admin
// now gets the identical Revoke control a Host admin does.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../localClient', () => ({
  localClient: {
    listPendingPairingRequests: vi.fn(),
    listDevices: vi.fn(),
    listPeerErasureState: vi.fn(),
    approveDevice: vi.fn(),
    denyDevice: vi.fn(),
    revokeDevice: vi.fn(),
    renameDevice: vi.fn(),
    getJoinCode: vi.fn(),
    setJoinWindow: vi.fn(),
    listToolAuthorizations: vi.fn().mockResolvedValue([]),
    getPortMappingStatus: vi.fn().mockResolvedValue(null),
    grantToolAuthorization: vi.fn(),
    revokeToolAuthorization: vi.fn(),
    handoffStatus: vi.fn(),
    handoffStart: vi.fn(),
    onHandoffChanged: vi.fn(() => () => {}),
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
  // No purge by default — the erasure column is absent unless a test opts in.
  localClient.listPeerErasureState.mockResolvedValue({ hasErasure: false, states: {}, localDeviceId: null })
  localClient.getJoinCode.mockResolvedValue({
    code: 'K4P72MRQ', formatted: 'K4P7-2MRQ', campName: 'Camp Kinneret', open: false,
  })
  localClient.setJoinWindow.mockImplementation(async (open) => ({ open }))
  localClient.handoffStatus.mockResolvedValue({ isHost: true, eligibleDeviceIds: [], handoff: null, lastResult: null })
  localClient.handoffStart.mockResolvedValue({ ok: true })
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

  it('shows Approve/Deny/Revoke on a non-founding (client-mode) admin device (T351)', async () => {
    localClient.listPendingPairingRequests.mockResolvedValue([pendingDevice()])
    localClient.listDevices.mockResolvedValue([authorizedDevice()])

    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="client" />)

    expect(await screen.findByText('iPad')).toBeTruthy()
    expect(screen.getByText('Approve')).toBeTruthy()
    expect(screen.getByText('Deny')).toBeTruthy()
    expect(screen.getByText('Revoke')).toBeTruthy()
    expect(screen.queryByText(/main computer/i)).toBeNull()
  })

  it('says plainly, inline, that a deny applies to this device only (T351)', async () => {
    const user = userEvent.setup()
    localClient.listPendingPairingRequests.mockResolvedValueOnce([pendingDevice()]).mockResolvedValue([])
    localClient.denyDevice.mockResolvedValue({ deviceId: 'pending-1', denied: true })

    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="client" />)
    await user.click(await screen.findByText('Deny'))

    expect(await screen.findByText('Denied on this device only — other devices are not told.')).toBeTruthy()
  })

  it('a Client STAFF (non-admin) still gets no Revoke control, and an accurate (non-misleading) note instead', async () => {
    localClient.listPendingPairingRequests.mockResolvedValue([pendingDevice()])
    localClient.listDevices.mockResolvedValue([authorizedDevice()])

    render(<DeviceManagerScreen campId="c1" role="staff" deviceMode="client" />)

    expect(await screen.findByText('MacBook')).toBeTruthy()
    expect(screen.queryByText('Revoke')).toBeNull()
    // Staff never had "use the main computer" accuracy either (staff can't approve/deny on ANY
    // device) — the note stays, but without the inapplicable "use the main computer" framing.
    expect(screen.getByText('View only from this device')).toBeTruthy()
    expect(screen.queryByText(/main computer/i)).toBeNull()
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

// T322 S3b — the per-peer purge badge. docs/work/tickets/T322-per-peer-erasure-
// state-ui.md; the four never-claims are the acceptance criteria.
describe('DeviceManagerScreen — per-peer erasure badge', () => {
  it('shows no erasure column until a purge has happened', async () => {
    localClient.listDevices.mockResolvedValue([authorizedDevice()])
    localClient.listPeerErasureState.mockResolvedValue({ hasErasure: false, states: {}, localDeviceId: null })

    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)

    expect(await screen.findByText('MacBook')).toBeTruthy()
    expect(screen.queryByText('Purge status')).toBeNull()
    expect(screen.queryByText('Hidden')).toBeNull()
    expect(screen.queryByText('Not confirmed')).toBeNull()
  })

  it('shows a caught-up peer as suppressed, never deleted or cryptographic', async () => {
    localClient.listDevices.mockResolvedValue([authorizedDevice({ id: 'peer-1', name: 'Front Desk iPad' })])
    localClient.listPeerErasureState.mockResolvedValue({
      hasErasure: true,
      states: { 'peer-1': 'LOGICALLY_ERASED' },
      localDeviceId: 'local-host',
    })

    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)

    expect(await screen.findByText('Purge status')).toBeTruthy()
    const badge = screen.getByText('Hidden')
    expect(badge).toBeTruthy()
    const title = badge.getAttribute('title') || ''
    // never-claim #1 (not destroyed) and #2 (not cryptographic/physical)
    expect(title).toMatch(/suppressed, not deleted/i)
    expect(title).toMatch(/not cryptographic/i)
    expect(title).not.toMatch(/wiped|gone/i)
    // attributed, not stated as independently-verified fact (Red Hat MEDIUM)
    expect(title).toMatch(/reports that it has applied/i)
  })

  it('shows an unreached peer as Not confirmed, never silently erased', async () => {
    localClient.listDevices.mockResolvedValue([authorizedDevice({ id: 'peer-1', name: 'Cabin Laptop' })])
    localClient.listPeerErasureState.mockResolvedValue({
      hasErasure: true,
      states: { 'peer-1': 'UNKNOWN' },
      localDeviceId: 'local-host',
    })

    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)

    const badge = await screen.findByText('Not confirmed')
    expect(badge).toBeTruthy()
    // never-claim #3 — unknown, not a confident erased read
    expect((badge.getAttribute('title') || '')).toMatch(/unknown, never silently treated as erased/i)
    expect(screen.queryByText('Hidden')).toBeNull()
  })

  it('labels the local device row as This device, never a fabricated state', async () => {
    localClient.listDevices.mockResolvedValue([
      authorizedDevice({ id: 'local-host', name: 'Office Mac' }),
      authorizedDevice({ id: 'peer-1', name: 'Front Desk iPad' }),
    ])
    localClient.listPeerErasureState.mockResolvedValue({
      hasErasure: true,
      states: { 'peer-1': 'LOGICALLY_ERASED' },
      localDeviceId: 'local-host',
    })

    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)

    expect(await screen.findByText('This device')).toBeTruthy()
    // the local row is not scored UNKNOWN or Hidden — only the real peer is
    expect(screen.getByText('Hidden')).toBeTruthy()
    expect(screen.queryByText('Not confirmed')).toBeNull()
  })

  it('falls back to Not confirmed for a peer the self-report has no verdict for', async () => {
    localClient.listDevices.mockResolvedValue([authorizedDevice({ id: 'peer-x', name: 'New Tablet' })])
    localClient.listPeerErasureState.mockResolvedValue({
      hasErasure: true,
      states: {}, // purge exists, but this peer has no row yet
      localDeviceId: 'local-host',
    })

    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)

    expect(await screen.findByText('Not confirmed')).toBeTruthy()
  })

  // Red Hat MEDIUM — a revoked device is cut off the authenticated channel and
  // can never report again; "Not confirmed / may catch up" would mislead. It is
  // not an active peer, so its purge status is simply not tracked ("—").
  it('shows a revoked device as not-tracked, never a misleading may-catch-up state', async () => {
    localClient.listDevices.mockResolvedValue([
      authorizedDevice({ id: 'peer-1', name: 'Old Laptop', revoked_at: '2026-09-01T00:00:00.000Z', pairing_status: 'revoked' }),
    ])
    localClient.listPeerErasureState.mockResolvedValue({
      hasErasure: true,
      states: {}, // backend may still carry a stale row, but the UI must not imply catch-up
      localDeviceId: 'local-host',
    })

    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)

    expect(await screen.findByText('Purge status')).toBeTruthy()
    // getByTitle, not getByText('—'): the Authorized-At column can also render
    // '—', so the unique title is what identifies the purge cell.
    expect(screen.getByTitle(/tracked only for devices currently in the camp/i)).toBeTruthy()
    expect(screen.queryByText('Not confirmed')).toBeNull()
    expect(screen.queryByText('Hidden')).toBeNull()
  })

  it('shows a pending (not-yet-approved) device as not-tracked', async () => {
    localClient.listDevices.mockResolvedValue([
      { id: 'peer-2', name: 'Unapproved Tablet', pairing_status: 'pending', authorized_at: null, revoked_at: null },
    ])
    localClient.listPeerErasureState.mockResolvedValue({
      hasErasure: true,
      states: {},
      localDeviceId: 'local-host',
    })

    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)

    expect(await screen.findByText('Purge status')).toBeTruthy()
    expect(screen.getByTitle(/tracked only for devices currently in the camp/i)).toBeTruthy()
    expect(screen.queryByText('Not confirmed')).toBeNull()
  })
})

describe('DeviceManagerScreen — approve when the joiner is gone (T346)', () => {
  const COPY = 'The device disconnected before approval — ask it to request again'

  it('shows the flag inside that request row, not in the error banner', async () => {
    localClient.listPendingPairingRequests.mockResolvedValue([pendingDevice(), pendingDevice({ id: 'pending-2', name: 'Tablet' })])
    localClient.approveDevice.mockResolvedValue({ deviceId: 'pending-1', authorized: false, reason: 'joiner_disconnected' })
    const user = userEvent.setup()
    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)

    await user.click((await screen.findAllByText('Approve'))[0])

    const flag = await screen.findByText(COPY)
    expect(flag.closest('tr').textContent).toContain('iPad')
    expect(screen.getAllByText(COPY)).toHaveLength(1)
    expect(screen.queryByText('Failed to approve device')).toBeNull()
    expect(localClient.listPendingPairingRequests).toHaveBeenCalledTimes(2)
  })

  it('clears the flag on the next approve of that device', async () => {
    localClient.listPendingPairingRequests.mockResolvedValue([pendingDevice()])
    localClient.approveDevice
      .mockResolvedValueOnce({ deviceId: 'pending-1', authorized: false, reason: 'joiner_disconnected' })
      .mockResolvedValueOnce({ deviceId: 'pending-1', authorized: true })
    const user = userEvent.setup()
    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)

    await user.click(await screen.findByText('Approve'))
    await screen.findByText(COPY)
    await user.click(screen.getByText('Approve'))
    await vi.waitFor(() => expect(screen.queryByText(COPY)).toBeNull())
  })
})

describe('DeviceManagerScreen — empty device list copy (audit #22)', () => {
  it('says no other devices have paired yet, not "connected" (a paired-device list is not a live-connection list)', async () => {
    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)
    expect(await screen.findByText('No other devices have paired yet.')).toBeTruthy()
    expect(screen.queryByText(/connected yet/)).toBeNull()
  })
})

describe('DeviceManagerScreen — host handoff control', () => {
  it('shows "Hand hosting to <device>" only on rows the host reports as eligible, and starts the handoff', async () => {
    localClient.listDevices.mockResolvedValue([
      authorizedDevice(),
      authorizedDevice({ id: 'authorized-2', name: 'Front Desk iPad' }),
    ])
    localClient.handoffStatus.mockResolvedValue({ isHost: true, eligibleDeviceIds: ['authorized-1'], handoff: null, lastResult: null })
    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)

    await userEvent.click(await screen.findByRole('button', { name: 'Hand hosting to MacBook' }))
    expect(localClient.handoffStart).toHaveBeenCalledWith('authorized-1')
    expect(screen.queryByRole('button', { name: 'Hand hosting to Front Desk iPad' })).toBeNull()
  })

  it('shows nothing when this computer is not the host', async () => {
    localClient.listDevices.mockResolvedValue([authorizedDevice()])
    localClient.handoffStatus.mockResolvedValue({ isHost: false, eligibleDeviceIds: [], handoff: null, lastResult: null })
    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="client" />)
    expect(await screen.findByText('MacBook')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Hand hosting to/ })).toBeNull()
  })

  it('a staff user never sees the control, even if the host reports the device eligible', async () => {
    localClient.listDevices.mockResolvedValue([authorizedDevice()])
    localClient.handoffStatus.mockResolvedValue({ isHost: true, eligibleDeviceIds: ['authorized-1'], handoff: null, lastResult: null })
    render(<DeviceManagerScreen campId="c1" role="staff" deviceMode="host" />)
    expect(await screen.findByText('MacBook')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Hand hosting to/ })).toBeNull()
  })
})

describe('DeviceManagerScreen — rename', () => {
  it('saves a new name for a peer row and reloads the list', async () => {
    localClient.listDevices.mockResolvedValue([authorizedDevice()])
    localClient.renameDevice.mockResolvedValue({})
    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Rename MacBook' }))
    const input = screen.getByLabelText('Device name')
    await userEvent.clear(input)
    await userEvent.type(input, 'Office laptop')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(localClient.renameDevice).toHaveBeenCalledWith('authorized-1', 'Office laptop')
  })

  it('this computer’s own row says "This computer" once when it still has the default name', async () => {
    localClient.listDevices.mockResolvedValue([authorizedDevice({ name: 'This computer', isSelf: true })])
    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)
    await screen.findByRole('button', { name: 'Rename This computer' })
    expect(document.body.textContent.match(/this computer/gi).filter((t) => t === 'This computer' || t === 'this computer')).toHaveLength(
      document.body.textContent.match(/this computer/gi).length,
    )
    expect(screen.queryByText(/\(this computer\)/)).toBeNull()
    expect(document.body.textContent).not.toMatch(/This computer·|This computer · this computer/i)
  })

  it('tags a renamed own row so it can still be found', async () => {
    localClient.listDevices.mockResolvedValue([authorizedDevice({ name: 'Office Mac', isSelf: true })])
    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)
    expect(await screen.findByText(/\(this computer\)/)).toBeTruthy()
    expect(screen.getByText(/Office Mac/)).toBeTruthy()
  })

  it('does not tag another device', async () => {
    localClient.listDevices.mockResolvedValue([authorizedDevice({ name: 'Office Mac' })])
    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)
    await screen.findByText('Office Mac')
    expect(screen.queryByText(/\(this computer\)/)).toBeNull()
  })

  it('shows the refusal instead of failing silently', async () => {
    localClient.listDevices.mockResolvedValue([authorizedDevice({ isSelf: true })])
    localClient.renameDevice.mockRejectedValue(new Error('A device name cannot be empty.'))
    render(<DeviceManagerScreen campId="c1" role="admin" deviceMode="host" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Rename MacBook' }))
    await userEvent.clear(screen.getByLabelText('Device name'))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('A device name cannot be empty.')).toBeTruthy()
  })

  it('offers no rename to staff', async () => {
    localClient.listDevices.mockResolvedValue([authorizedDevice()])
    render(<DeviceManagerScreen campId="c1" role="staff" deviceMode="host" />)
    await screen.findByText('MacBook')
    expect(screen.queryByRole('button', { name: /Rename/ })).toBeNull()
  })
})
