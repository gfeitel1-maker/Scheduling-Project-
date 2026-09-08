// @vitest-environment jsdom
//
// docs/adr/2026-09-08-libp2p-join-flow.md §4. These pin the WORDS and the
// FAILURE STATES, which is where the value is — the mechanism is covered by
// electron/sync/automerge/joinSession.test.js against real nodes.
//
// A join can fail in five distinct ways that mean five different things to the
// person standing there. Article V says the engine surfaces problems rather
// than absorbing them; a single "couldn't connect" would send a director to
// check their Wi-Fi over a mistyped character. Each state is pinned separately
// so a later tidy-up cannot quietly collapse them.
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

import JoinByCodeScreen from './JoinByCodeScreen'
import { localClient } from '../localClient'

const CODE = 'K4P7-2MRQ'

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

async function enterCode(user, code = CODE) {
  await user.type(screen.getByLabelText(/camp code/i), code)
  await user.click(screen.getByRole('button', { name: /continue/i }))
}

async function signIn(user) {
  await user.type(await screen.findByLabelText(/your name/i), 'Sarah')
  await user.type(screen.getByLabelText(/^pin$/i), '1234')
  await user.click(screen.getByRole('button', { name: /sign in/i }))
}

describe('JoinByCodeScreen — the whole way through', () => {
  it('asks for a code, never an address', async () => {
    render(<JoinByCodeScreen />)
    expect(screen.getByLabelText(/camp code/i)).toBeTruthy()
    // The old picker's vocabulary must not survive here.
    expect(screen.queryByText(/port/i)).toBeNull()
    expect(screen.queryByText(/\d+\.\d+\.\d+\.\d+/)).toBeNull()
  })

  // The payoff, and the reason the flow is shaped this way: the camp's name is
  // never broadcast on the LAN, so recognition happens at the first moment it
  // safely can — as something the director confirms, not something they took
  // on faith from an IP address.
  it('names the camp once the device is actually in it', async () => {
    const user = userEvent.setup()
    const onJoined = vi.fn()
    render(<JoinByCodeScreen onJoined={onJoined} />)
    await enterCode(user)
    await signIn(user)

    expect(await screen.findByText(/You've joined Camp Kinneret/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /continue/i }))
    expect(onJoined).toHaveBeenCalledWith({ id: 'c1', name: 'Camp Kinneret' })
  })

  it('tells the director the code is wrong instead of searching for nothing', async () => {
    localClient.joinStart.mockResolvedValue({ status: 'invalid_code' })
    const user = userEvent.setup()
    render(<JoinByCodeScreen />)
    await enterCode(user, 'NOPE')
    expect(await screen.findByText(/doesn't look right/i)).toBeTruthy()
    // Still on the code step, with the field to fix.
    expect(screen.getByLabelText(/camp code/i)).toBeTruthy()
    expect(localClient.joinFindHost).not.toHaveBeenCalled()
  })

  it('distinguishes "nobody answered" from a bad code', async () => {
    localClient.joinFindHost.mockResolvedValue({ status: 'not_found' })
    const user = userEvent.setup()
    render(<JoinByCodeScreen />)
    await enterCode(user)
    expect(await screen.findByText(/No camp answered that code/i)).toBeTruthy()
    // The three things that are actually worth checking, named.
    expect(screen.getByText(/Add a device/)).toBeTruthy()
  })

  // The impostor / wrong-camp case. A computer answered but could not prove it
  // holds this code, which is a different problem from silence and must read
  // differently.
  it('stops, and says why, when a host cannot confirm the code', async () => {
    localClient.joinRequestPairing.mockResolvedValue({ status: 'wrong_camp' })
    const user = userEvent.setup()
    render(<JoinByCodeScreen />)
    await enterCode(user)
    expect(await screen.findByText(/couldn't confirm the code/i)).toBeTruthy()
    expect(localClient.joinLogin).not.toHaveBeenCalled()
  })

  it('says so plainly when the director turns the device away', async () => {
    localClient.joinAwaitPairingDecision.mockResolvedValue({ status: 'denied' })
    const user = userEvent.setup()
    render(<JoinByCodeScreen />)
    await enterCode(user)
    expect(await screen.findByText(/wasn't allowed in/i)).toBeTruthy()
  })

  // The state that could not exist under the op-log, where identity and data
  // arrived in one message. Under a CRDT they are two steps, and the gap is a
  // real place a device gets stuck. A spinner here would be a lie.
  it('names the "signed in but nothing arrived" state instead of spinning', async () => {
    localClient.joinAwaitData.mockResolvedValue({ status: 'timeout' })
    const user = userEvent.setup()
    render(<JoinByCodeScreen />)
    await enterCode(user)
    await signIn(user)
    expect(await screen.findByText(/nothing arrived/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy()
  })

  it('keeps a wrong PIN on the sign-in step rather than restarting the join', async () => {
    localClient.joinLogin.mockResolvedValue({ status: 'failed' })
    const user = userEvent.setup()
    render(<JoinByCodeScreen />)
    await enterCode(user)
    await signIn(user)
    expect(await screen.findByText(/didn't match/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy()
  })

  // Leaving must tear the session down: it holds a live libp2p node.
  it('cancels the join when the director backs out', async () => {
    const onBack = vi.fn()
    const user = userEvent.setup()
    render(<JoinByCodeScreen onBack={onBack} />)
    await user.click(screen.getByRole('button', { name: /back/i }))
    expect(localClient.joinCancel).toHaveBeenCalled()
    expect(onBack).toHaveBeenCalled()
  })
})
