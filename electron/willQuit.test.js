// @vitest-environment node
//
// T347 (S1): Electron does not await an async will-quit listener, so the punch native cleanup()
// (without which the process cannot exit) could be skipped on a real quit. The handler must veto
// the first will-quit, finish teardown, then re-issue quit exactly once.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createWillQuitHandler } from './willQuit.js'

afterEach(() => vi.useRealTimers())

const flush = () => new Promise((r) => setImmediate(r))

describe('createWillQuitHandler', () => {
  it('vetoes the first will-quit, awaits cleanup, then quits; the second will-quit passes through', async () => {
    const order = []
    let release
    const cleanup = vi.fn(() => new Promise((r) => { release = () => { order.push('cleanup-done'); r() } }))
    const app = { quit: vi.fn(() => order.push('quit')) }
    const handler = createWillQuitHandler({ app, cleanup })

    const e1 = { preventDefault: vi.fn() }
    handler(e1)
    expect(e1.preventDefault).toHaveBeenCalledTimes(1)
    await flush()
    expect(app.quit).not.toHaveBeenCalled()

    release()
    await flush()
    await flush()
    expect(order).toEqual(['cleanup-done', 'quit'])

    const e2 = { preventDefault: vi.fn() }
    handler(e2)
    expect(e2.preventDefault).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('a re-entrant will-quit while cleanup is still running is not vetoed again and does not re-run cleanup', async () => {
    const cleanup = vi.fn(() => new Promise(() => {}))
    const handler = createWillQuitHandler({ app: { quit: vi.fn() }, cleanup, timeoutMs: 1000 })
    handler({ preventDefault: vi.fn() })
    const e2 = { preventDefault: vi.fn() }
    handler(e2)
    expect(e2.preventDefault).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('a hung cleanup cannot block quit: the bounded timeout quits', async () => {
    vi.useFakeTimers()
    const app = { quit: vi.fn() }
    const handler = createWillQuitHandler({ app, cleanup: () => new Promise(() => {}), timeoutMs: 5000 })
    handler({ preventDefault: vi.fn() })
    await vi.advanceTimersByTimeAsync(4999)
    expect(app.quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('a throwing cleanup still quits', async () => {
    const app = { quit: vi.fn() }
    const handler = createWillQuitHandler({ app, cleanup: async () => { throw new Error('boom') } })
    handler({ preventDefault: vi.fn() })
    await flush()
    await flush()
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  // Electron's Browser::NotifyAndShutdown emits will-quit, and only AFTER the JS callback returns
  // (microtasks included) does a vetoed quit reset is_quitting_. A quit() issued inside that window
  // is a silent no-op, so a cleanup that settles at once (punch off) left the app running forever:
  // SIGTERM and app.quit() both hung the packaged app. The fake reproduces that ordering.
  it('re-quits after the vetoed dispatch has unwound, so an instant cleanup still exits', async () => {
    let quitting = false
    let exited = false
    let handler
    const app = {
      quit() {
        if (quitting) return
        quitting = true
        const e = { prevented: false, preventDefault() { this.prevented = true } }
        handler(e)
        if (e.prevented) setImmediate(() => { quitting = false })
        else exited = true
      },
    }
    handler = createWillQuitHandler({ app, cleanup: async () => {} })
    app.quit()
    await flush()
    await flush()
    expect(exited).toBe(true)
  })
})
