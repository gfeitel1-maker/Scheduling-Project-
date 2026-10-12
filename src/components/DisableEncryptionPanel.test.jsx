// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../localClient', () => ({ localClient: { disableAtRestEncryption: vi.fn() } }))
import { localClient } from '../localClient'
import DisableEncryptionPanel from './DisableEncryptionPanel'
import DeviceManagerScreen from '../screens/DeviceManagerScreen'

beforeEach(() => vi.clearAllMocks())

async function openConfirm() {
  const user = userEvent.setup()
  render(<DisableEncryptionPanel />)
  await user.click(screen.getByRole('button', { name: /turn off encryption/i }))
  return user
}

describe('DisableEncryptionPanel', () => {
  it('shows nothing destructive until the director asks, then states the consequence', async () => {
    render(<DisableEncryptionPanel />)
    expect(screen.queryByLabelText(/type/i)).toBeNull()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /turn off encryption/i }))
    expect(screen.getByText(/readable by anyone who can open the files on this computer/i)).toBeTruthy()
    expect(screen.getByText(/only this computer/i)).toBeTruthy()
    expect(screen.getByText(/older backups/i)).toBeTruthy()
    expect(localClient.disableAtRestEncryption).not.toHaveBeenCalled()
  })

  it('keeps the confirm button disabled until the exact phrase is typed', async () => {
    const user = await openConfirm()
    const confirm = screen.getByRole('button', { name: /^turn off encryption$/i, hidden: false })
    const input = screen.getByLabelText(/type DISABLE ENCRYPTION/i)
    await user.type(input, 'disable encryption')
    expect(confirm.disabled).toBe(true)
    await user.clear(input)
    await user.type(input, 'DISABLE ENCRYPTION')
    expect(confirm.disabled).toBe(false)
  })

  it('sends the phrase and says the computer is restarting on success', async () => {
    localClient.disableAtRestEncryption.mockResolvedValue({ ok: true, restarting: true })
    const user = await openConfirm()
    await user.type(screen.getByLabelText(/type DISABLE ENCRYPTION/i), 'DISABLE ENCRYPTION')
    await user.click(screen.getByRole('button', { name: /^turn off encryption$/i }))
    expect(localClient.disableAtRestEncryption).toHaveBeenCalledWith('DISABLE ENCRYPTION')
    expect(await screen.findByText(/encryption is off.*restart/i)).toBeTruthy()
  })

  it('forgets the stored sign-in on success, so the relaunch opens on sign-in; keeps it on failure', async () => {
    const store = new Map()
    vi.stubGlobal('localStorage', { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) })
    localStorage.setItem('shoresh-token', 'tok')
    localClient.disableAtRestEncryption.mockResolvedValue({ ok: false, error: 'rekey_failed', restarting: true })
    let user = await openConfirm()
    await user.type(screen.getByLabelText(/type DISABLE ENCRYPTION/i), 'DISABLE ENCRYPTION')
    await user.click(screen.getByRole('button', { name: /^turn off encryption$/i }))
    await screen.findByText(/still on/i)
    expect(localStorage.getItem('shoresh-token')).toBe('tok')
    cleanup()

    localClient.disableAtRestEncryption.mockResolvedValue({ ok: true, restarting: true })
    user = await openConfirm()
    await user.type(screen.getByLabelText(/type DISABLE ENCRYPTION/i), 'DISABLE ENCRYPTION')
    await user.click(screen.getByRole('button', { name: /^turn off encryption$/i }))
    await screen.findByText(/encryption is off.*restart/i)
    expect(localStorage.getItem('shoresh-token')).toBeNull()
    vi.unstubAllGlobals()
  })

  it('surfaces a failed disable and says encryption is still on', async () => {
    localClient.disableAtRestEncryption.mockResolvedValue({ ok: false, error: 'rekey_failed', message: 'disk I/O error', restarting: true })
    const user = await openConfirm()
    await user.type(screen.getByLabelText(/type DISABLE ENCRYPTION/i), 'DISABLE ENCRYPTION')
    await user.click(screen.getByRole('button', { name: /^turn off encryption$/i }))
    expect(await screen.findByText(/encryption is still on/i)).toBeTruthy()
    expect(screen.getByText(/disk I\/O error/)).toBeTruthy()
  })

  it('says refusals in plain words, never as a raw code', async () => {
    localClient.disableAtRestEncryption.mockResolvedValue({ ok: false, error: 'unknown_state' })
    const user = await openConfirm()
    await user.type(screen.getByLabelText(/type DISABLE ENCRYPTION/i), 'DISABLE ENCRYPTION')
    await user.click(screen.getByRole('button', { name: /^turn off encryption$/i }))
    expect(await screen.findByText(/encryption is still on/i)).toBeTruthy()
    expect(screen.queryByText(/unknown_state/)).toBeNull()
    expect(screen.getByText(/shoresh will restart/i)).toBeTruthy()
  })

  it('surfaces a thrown error (refused session) and says encryption is still on', async () => {
    localClient.disableAtRestEncryption.mockRejectedValue(new Error('admin role required'))
    const user = await openConfirm()
    await user.type(screen.getByLabelText(/type DISABLE ENCRYPTION/i), 'DISABLE ENCRYPTION')
    await user.click(screen.getByRole('button', { name: /^turn off encryption$/i }))
    expect(await screen.findByText(/encryption is still on/i)).toBeTruthy()
  })
})

describe('placement', () => {
  const base = {
    listPendingPairingRequests: vi.fn().mockResolvedValue([]),
    listDevices: vi.fn().mockResolvedValue([]),
    listPeerErasureState: vi.fn().mockResolvedValue({ hasErasure: false, states: {}, localDeviceId: null }),
    getJoinCode: vi.fn().mockResolvedValue({ code: 'K4P72MRQ', formatted: 'K4P7-2MRQ', campName: 'C', open: false }),
    listToolAuthorizations: vi.fn().mockResolvedValue([]),
    getPortMappingStatus: vi.fn().mockResolvedValue(null),
    handoffStatus: vi.fn().mockResolvedValue(null),
    onHandoffChanged: vi.fn(() => () => {}),
  }
  it('staff never see the control; admins do', async () => {
    Object.assign(localClient, base)
    const staff = render(<DeviceManagerScreen campId="c" role="staff" deviceMode="host" />)
    await screen.findByText(/all devices/i)
    expect(screen.queryByRole('button', { name: /turn off encryption/i })).toBeNull()
    staff.unmount()
    render(<DeviceManagerScreen campId="c" role="admin" deviceMode="host" />)
    expect(await screen.findByRole('button', { name: /turn off encryption/i })).toBeTruthy()
  })
})
