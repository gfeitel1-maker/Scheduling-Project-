// @vitest-environment jsdom
//
// Pair again: the join-by-code screen in its re-pair mode. Pins the words and the outcomes that
// differ from a first join; the mechanism is covered by electron/sync/automerge/pairAgain.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../localClient', () => ({
  localClient: {
    joinStart: vi.fn(),
    joinFindHost: vi.fn(),
    joinRequestPairing: vi.fn(),
    joinAwaitPairingDecision: vi.fn(),
    joinLogin: vi.fn(),
    joinAwaitData: vi.fn(),
    joinCancel: vi.fn(),
  },
}))

import { PairAgainScreen } from './JoinByCodeScreen'
import { localClient } from '../localClient'

beforeEach(() => {
  vi.clearAllMocks()
  localClient.joinStart.mockResolvedValue({ status: 'started' })
  localClient.joinFindHost.mockResolvedValue({ status: 'found' })
  localClient.joinRequestPairing.mockResolvedValue({ status: 'pending' })
  localClient.joinAwaitPairingDecision.mockResolvedValue({ status: 'approved', deviceSecretIdentifier: 'sec' })
  localClient.joinLogin.mockResolvedValue({ status: 'ok' })
  localClient.joinAwaitData.mockResolvedValue({ status: 'ok', camp: { id: 'c1', name: 'Camp Kinneret' } })
  localClient.joinCancel.mockResolvedValue({ status: 'cancelled' })
})

async function enterCode(user) {
  await user.type(screen.getByLabelText(/camp code/i), 'K4P7-2MRQ')
  await user.click(screen.getByRole('button', { name: /continue/i }))
}

describe('Pair again screen', () => {
  it('asks for a code and starts a re-pair, not a first join', async () => {
    const user = userEvent.setup()
    render(<PairAgainScreen onNavigate={() => {}} />)
    expect(screen.getByText('Pair again')).toBeTruthy()
    expect(screen.getByText(/changes on this device are kept/i)).toBeTruthy()
    await enterCode(user)
    expect(localClient.joinStart).toHaveBeenCalledWith({ code: 'K4P7-2MRQ', rejoin: true })
  })

  it('a different camp\'s code gets a plain answer and a way back', async () => {
    localClient.joinRequestPairing.mockResolvedValue({ status: 'not_this_camp' })
    const user = userEvent.setup()
    render(<PairAgainScreen onNavigate={() => {}} />)
    await enterCode(user)
    expect(await screen.findByText('That code is for a different camp')).toBeTruthy()
    expect(screen.getByRole('button', { name: /start over/i })).toBeTruthy()
  })

  it('a removed device is told so, and is not left at a dead end', async () => {
    localClient.joinRequestPairing.mockResolvedValue({ status: 'denied', reason: 'device_revoked' })
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    render(<PairAgainScreen onNavigate={onNavigate} />)
    await enterCode(user)
    expect(await screen.findByText('This device was removed from the camp')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /devices/i }))
    expect(onNavigate).toHaveBeenCalledWith('devices')
  })

  it('ends back in the camp, with the merge named', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    render(<PairAgainScreen onNavigate={onNavigate} />)
    await enterCode(user)
    await user.type(await screen.findByLabelText(/your name/i), 'Sarah')
    await user.type(screen.getByLabelText(/pin/i), '1234')
    await user.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText('Back in Camp Kinneret')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /continue/i }))
    expect(onNavigate).toHaveBeenCalledWith('roots')
  })
})
