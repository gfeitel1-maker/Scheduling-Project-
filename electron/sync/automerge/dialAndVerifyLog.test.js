// @vitest-environment node
//
// T359 slice 5 (slice 3 carry item e): a failed remembered-address dial is logged as a fixed string plus the
// error code. The raw error message of a dial names the address it dialled, which for a LAN row is a private
// address that must not reach logs.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dialAndVerify } from './peerAddressBook.js'

afterEach(() => vi.restoreAllMocks())

describe('dialAndVerify failure log', () => {
  it('logs the error code and never the address carried in the error message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dial = async () => { throw Object.assign(new Error('connect ECONNREFUSED 192.168.1.77:41234'), { code: 'ECONNREFUSED' }) }
    expect(await dialAndVerify(dial, 'peer-1', 'target')).toBe(false)
    const text = spy.mock.calls.flat().join(' ')
    expect(text).toContain('ECONNREFUSED')
    expect(text).not.toMatch(/192\.168|41234|connect ECONNREFUSED/)
  })

  it('falls back to the error name when there is no code', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dial = async () => { throw new DOMException('dial to /ip4/10.0.0.5/tcp/1 timed out', 'TimeoutError') }
    await dialAndVerify(dial, 'peer-1', 'target')
    const text = spy.mock.calls.flat().join(' ')
    expect(text).toContain('TimeoutError')
    expect(text).not.toContain('10.0.0.5')
  })
})
