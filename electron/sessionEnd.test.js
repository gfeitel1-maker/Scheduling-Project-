// @vitest-environment node
//
// A director shutting Windows down mid-day must not lose edits: session-end / query-session-end
// (Windows) and powerMonitor 'shutdown' (macOS) may allow only seconds, so the same synchronous
// flush that will-quit runs must run FIRST, then the graceful quit is attempted.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createQuitFlush, wireSessionEndFlush, createWillQuitHandler } from './willQuit.js'

const tick = () => new Promise((r) => setImmediate(r))

function fakeWindow() {
  const win = new EventEmitter()
  win.destroyed = false
  win.isDestroyed = () => win.destroyed
  return win
}

function rig() {
  const powerMonitor = new EventEmitter()
  const order = []
  const app = Object.assign(new EventEmitter(), { quit: vi.fn(() => order.push('quit')) })
  const flush = vi.fn(() => order.push('flush'))
  wireSessionEndFlush({ app, powerMonitor, flush })
  const win = fakeWindow()
  app.emit('browser-window-created', {}, win)
  return { win, powerMonitor, app, flush, order }
}

// Mimics Electron: a vetoed will-quit resets is_quitting_ only after the dispatch unwinds.
function fakeApp() {
  const state = { exited: false, willQuit: null }
  let quitting = false
  state.app = Object.assign(new EventEmitter(), {
    quit() {
      if (quitting) return
      quitting = true
      const e = { prevented: false, preventDefault() { this.prevented = true } }
      state.willQuit(e)
      if (e.prevented) setImmediate(() => { quitting = false })
      else state.exited = true
    },
  })
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

  it('every BrowserWindow gets the session-end listeners, not just the first', () => {
    const r = rig()
    const second = fakeWindow()
    r.app.emit('browser-window-created', {}, second)
    second.emit('session-end', {})
    expect(r.flush).toHaveBeenCalledTimes(1)
  })

  it('a destroyed window is ignored rather than wired', () => {
    const r = rig()
    const dead = fakeWindow()
    dead.destroyed = true
    r.app.emit('browser-window-created', {}, dead)
    expect(dead.listenerCount('session-end')).toBe(0)
  })

  it('powerMonitor shutdown is wired with no window ever created', () => {
    const powerMonitor = new EventEmitter()
    const flush = vi.fn()
    wireSessionEndFlush({ app: Object.assign(new EventEmitter(), { quit: vi.fn() }), powerMonitor, flush })
    powerMonitor.emit('shutdown', {})
    expect(flush).toHaveBeenCalledTimes(1)
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
    wireSessionEndFlush({ app: s.app, powerMonitor: new EventEmitter(), flush: quitFlush })
    const win = fakeWindow()
    s.app.emit('browser-window-created', {}, win)
    win.emit('session-end', {})
    expect(writes).toBe(1)
    await tick(); await tick()
    expect(s.exited).toBe(true)
    expect(writes).toBe(1)
  })

  it('powerMonitor shutdown into a will-quit that vetoes once: flush runs before the veto and the deferred re-quit exits', async () => {
    const flush = vi.fn()
    const s = fakeApp()
    s.willQuit = createWillQuitHandler({ app: s.app, cleanup: async () => flush() })
    const powerMonitor = new EventEmitter()
    wireSessionEndFlush({ app: s.app, powerMonitor, flush })
    powerMonitor.emit('shutdown', {})
    expect(flush).toHaveBeenCalled()
    await tick(); await tick()
    expect(s.exited).toBe(true)
  })
})

// main.js only runs under Electron, so pin its wiring at the source level: removing any of these
// silently reopens the lost-edits-on-shutdown hole.
describe('main.js session-end wiring', () => {
  const src = readFileSync(new URL('./main.js', import.meta.url), 'utf8')
  it('imports powerMonitor from electron', () => {
    expect(src).toMatch(/import \{[^}]*\bpowerMonitor\b[^}]*\} from 'electron'/)
  })
  it('wires session end with app, powerMonitor and quitFlush', () => {
    expect(src).toMatch(/wireSessionEndFlush\(\{ app, powerMonitor, flush: quitFlush \}\)/)
  })
  it('quitFlush runs both the Automerge and camp-data flushes', () => {
    const body = src.match(/const quitFlush = createQuitFlush\(\[([\s\S]*?)\]\)/)?.[1] ?? ''
    expect(body).toMatch(/flushAutomergeDoc\(\)/)
    expect(body).toMatch(/flushCampDataRecordOnQuit\(liveHandlers\)/)
  })
  it('will-quit runs quitFlush', () => {
    expect(src).toMatch(/app\.on\('will-quit', createWillQuitHandler\(\{ app, cleanup: async \(\) => \{\s*quitFlush\(\)/)
  })
})
