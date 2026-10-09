// @vitest-environment node
//
// A director shutting Windows down mid-day must not lose edits: session-end / query-session-end
// (Windows) and powerMonitor 'shutdown' (macOS) may allow only seconds, so the same synchronous
// flush that will-quit runs must run FIRST, then the graceful quit is attempted.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createQuitFlush, wireSessionEndFlush, createWillQuitHandler } from './willQuit.js'

const tick = () => new Promise((r) => setImmediate(r))

function rig() {
  const win = new EventEmitter()
  const powerMonitor = new EventEmitter()
  const order = []
  const app = { quit: vi.fn(() => order.push('quit')) }
  const flush = vi.fn(() => order.push('flush'))
  wireSessionEndFlush({ app, powerMonitor, win, flush })
  return { win, powerMonitor, app, flush, order }
}

// Mimics Electron: a vetoed will-quit resets is_quitting_ only after the dispatch unwinds.
function fakeApp() {
  const state = { exited: false, willQuit: null }
  let quitting = false
  state.app = {
    quit() {
      if (quitting) return
      quitting = true
      const e = { prevented: false, preventDefault() { this.prevented = true } }
      state.willQuit(e)
      if (e.prevented) setImmediate(() => { quitting = false })
      else state.exited = true
    },
  }
  return state
}

describe('createQuitFlush', () => {
  it('runs every step in order, and one throwing step does not skip the rest', () => {
    const calls = []
    const quitFlush = createQuitFlush([
      ['a', () => calls.push('a')],
      ['b', () => { throw new Error('boom') }],
      ['c', () => calls.push('c')],
    ])
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    quitFlush()
    expect(calls).toEqual(['a', 'c'])
    spy.mockRestore()
  })
})

describe('wireSessionEndFlush', () => {
  it.each([
    ['Windows session-end', (r) => r.win.emit('session-end', {})],
    ['macOS powerMonitor shutdown', (r) => r.powerMonitor.emit('shutdown', {})],
  ])('%s flushes exactly once, synchronously, before quitting', (_name, fire) => {
    const r = rig()
    fire(r)
    expect(r.flush).toHaveBeenCalledTimes(1)
    expect(r.order).toEqual(['flush', 'quit'])
  })

  it('Windows query-session-end flushes exactly once and neither vetoes nor quits', () => {
    const r = rig()
    const e = { preventDefault: vi.fn() }
    r.win.emit('query-session-end', e)
    expect(r.flush).toHaveBeenCalledTimes(1)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(r.app.quit).not.toHaveBeenCalled()
  })

  it('the session-end flush is idempotent with the later will-quit: pending writes reach disk once', async () => {
    let pending = 1
    let writes = 0
    const quitFlush = createQuitFlush([['doc', () => { if (pending) { writes++; pending = 0 } }]])
    const s = fakeApp()
    s.willQuit = createWillQuitHandler({ app: s.app, cleanup: async () => { quitFlush() } })
    const win = new EventEmitter()
    wireSessionEndFlush({ app: s.app, powerMonitor: new EventEmitter(), win, flush: quitFlush })
    win.emit('session-end', {})
    expect(writes).toBe(1)
    await tick(); await tick()
    expect(s.exited).toBe(true)
    expect(writes).toBe(1)
  })

  it('macOS logout through a vetoed will-quit still flushes first and exits', async () => {
    const flush = vi.fn()
    const s = fakeApp()
    s.willQuit = createWillQuitHandler({ app: s.app, cleanup: async () => flush() })
    const powerMonitor = new EventEmitter()
    wireSessionEndFlush({ app: s.app, powerMonitor, win: new EventEmitter(), flush })
    powerMonitor.emit('shutdown', {})
    expect(flush).toHaveBeenCalled()
    await tick(); await tick()
    expect(s.exited).toBe(true)
  })
})
