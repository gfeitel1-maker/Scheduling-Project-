// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    joinStart: vi.fn(), joinFindHost: vi.fn(), joinRequestPairing: vi.fn(),
    joinAwaitPairingDecision: vi.fn(), joinLogin: vi.fn(), joinAwaitData: vi.fn(), joinCancel: vi.fn(),
  },
}))

import JoinByCodeScreen from './JoinByCodeScreen'
import { localClient } from '../localClient'

const CODE = 'K4P7-2MRQ'
const reset = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  vi.clearAllMocks()
  localClient.joinStart.mockResolvedValue({ status: 'started' })
  localClient.joinFindHost.mockResolvedValue({ status: 'found' })
  localClient.joinRequestPairing.mockResolvedValue({ status: 'approved', deviceSecretIdentifier: 's' })
  localClient.joinCancel.mockResolvedValue({ status: 'cancelled' })
})
afterEach(() => vi.useRealTimers())

const setup = () => ({ click: async (el) => act(async () => { fireEvent.click(el) }), type: async (el, v) => act(async () => { fireEvent.change(el, { target: { value: v } }) }) })
async function submit(user) {
  await user.type(screen.getByLabelText(/camp code/i), CODE)
  await user.click(screen.getByRole('button', { name: /continue/i }))
}
const tick = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

describe('JoinByCodeScreen transient dial failures', () => {
  it('retries ECONNRESET twice, shows plain copy, then succeeds without re-asking the code', async () => {
    localClient.joinStart.mockRejectedValueOnce(reset()).mockRejectedValueOnce(reset())
    const user = setup()
    render(<JoinByCodeScreen />)
    await submit(user)
    expect(screen.getByText("Couldn't reach the camp's computer, trying again…")).toBeTruthy()
    expect(screen.queryByText(/ECONNRESET/)).toBeNull()
    expect(localClient.joinStart).toHaveBeenCalledTimes(1)
    await tick(1000)
    expect(localClient.joinStart).toHaveBeenCalledTimes(2)
    await tick(2000)
    expect(localClient.joinStart).toHaveBeenCalledTimes(3)
    await tick(0)
    expect(screen.getByLabelText(/^pin$/i)).toBeTruthy()
    expect(screen.queryByLabelText(/camp code/i)).toBeNull()
  })

  it('gives a plain final message after the bound and Try again keeps the code', async () => {
    localClient.joinStart.mockRejectedValue(reset())
    const user = setup()
    render(<JoinByCodeScreen />)
    await submit(user)
    await tick(1000); await tick(2000); await tick(4000)
    expect(localClient.joinStart).toHaveBeenCalledTimes(4)
    expect(screen.getByText(/Check that it's on and on the same network, then try again/)).toBeTruthy()
    expect(screen.queryByText(/ECONNRESET/)).toBeNull()
    localClient.joinStart.mockResolvedValue({ status: 'started' })
    await user.click(screen.getByRole('button', { name: /try again/i }))
    expect(localClient.joinStart).toHaveBeenLastCalledWith({ code: CODE })
    await tick(0)
    expect(screen.getByLabelText(/^pin$/i)).toBeTruthy()
  })

  it('does not retry a permanent error', async () => {
    localClient.joinStart.mockRejectedValue(new Error('device revoked'))
    const user = setup()
    render(<JoinByCodeScreen />)
    await submit(user)
    await tick(10000)
    expect(localClient.joinStart).toHaveBeenCalledTimes(1)
    expect(screen.getByText('device revoked')).toBeTruthy()
  })

  it('stops retrying on Back and after unmount', async () => {
    localClient.joinStart.mockRejectedValue(reset())
    const user = setup()
    const { unmount } = render(<JoinByCodeScreen />)
    await submit(user)
    await user.click(screen.getByRole('button', { name: /back/i }))
    await tick(10000)
    expect(localClient.joinStart).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    localClient.joinCancel.mockResolvedValue({ status: 'cancelled' })
    localClient.joinStart.mockRejectedValue(reset())
    const u2 = setup()
    const r2 = render(<JoinByCodeScreen />)
    await u2.type(screen.getAllByLabelText(/camp code/i).at(-1), CODE)
    await u2.click(screen.getAllByRole('button', { name: /continue/i }).at(-1))
    r2.unmount()
    await tick(10000)
    expect(localClient.joinStart).toHaveBeenCalledTimes(1)
    unmount()
  })
})
