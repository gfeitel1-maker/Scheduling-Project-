import { describe, it, expect } from 'vitest'
import { waitFor } from './waitFor.js'

describe('waitFor', () => {
  it('returns as soon as the condition holds, without waiting out the timeout', async () => {
    let ticks = 0
    const start = Date.now()
    const result = await waitFor(() => (++ticks >= 3 ? 'ready' : false), { timeout: 5000, interval: 5 })

    expect(result).toBe('ready')
    // The point of polling: it does not sit around for the full budget. This
    // is a generous upper bound, not a performance assertion — it only has to
    // separate "polled" from "slept 5000ms".
    expect(Date.now() - start).toBeLessThan(4000)
  })

  it('still fails when the condition never becomes true', async () => {
    await expect(
      waitFor(() => false, { timeout: 50, interval: 5, message: 'the thing never happened' })
    ).rejects.toThrow('the thing never happened')
  })

  it('surfaces the predicate\'s own error rather than a generic timeout', async () => {
    await expect(
      waitFor(() => { throw new Error('row was missing') }, { timeout: 50, interval: 5 })
    ).rejects.toThrow('row was missing')
  })

  it('tolerates a predicate that throws before the condition becomes true', async () => {
    let ticks = 0
    const result = await waitFor(() => {
      if (++ticks < 3) throw new Error('not yet')
      return 'ready'
    }, { timeout: 5000, interval: 5 })

    expect(result).toBe('ready')
  })

  it('accepts an async predicate', async () => {
    let ticks = 0
    const result = await waitFor(async () => (++ticks >= 2 ? 'ready' : null), { timeout: 5000, interval: 5 })
    expect(result).toBe('ready')
  })
})
