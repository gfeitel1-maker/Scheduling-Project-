// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { recoverFromRendererGone, wireActivate } from './windowLifecycle.js'

const fakeWin = (destroyed = false) => ({ isDestroyed: () => destroyed, webContents: { reload: vi.fn() } })

describe('recoverFromRendererGone', () => {
  it('reloads the window after a renderer crash', () => {
    const win = fakeWin(); const createWindow = vi.fn()
    recoverFromRendererGone(win, { reason: 'crashed' }, { createWindow })
    expect(win.webContents.reload).toHaveBeenCalled()
    expect(createWindow).not.toHaveBeenCalled()
  })
  it('recreates the window when it is already destroyed', () => {
    const createWindow = vi.fn()
    recoverFromRendererGone(fakeWin(true), { reason: 'killed' }, { createWindow })
    expect(createWindow).toHaveBeenCalledOnce()
  })
  it('does nothing on a clean exit', () => {
    const win = fakeWin(); const createWindow = vi.fn()
    recoverFromRendererGone(win, { reason: 'clean-exit' }, { createWindow })
    expect(win.webContents.reload).not.toHaveBeenCalled()
    expect(createWindow).not.toHaveBeenCalled()
  })
})

describe('wireActivate', () => {
  it('recreates a window on activate when none is live', () => {
    const app = new EventEmitter(); const createWindow = vi.fn()
    wireActivate({ app, getWindow: () => fakeWin(true), createWindow })
    app.emit('activate')
    expect(createWindow).toHaveBeenCalledOnce()
  })
  it('leaves a live window alone', () => {
    const app = new EventEmitter(); const createWindow = vi.fn()
    wireActivate({ app, getWindow: () => fakeWin(), createWindow })
    app.emit('activate')
    expect(createWindow).not.toHaveBeenCalled()
  })
})
