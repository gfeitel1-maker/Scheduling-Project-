// Regression test for the P0 bug: DeleteWeekDialog.jsx called
// localClient.deleteWeek(...) but localClient.js had no such method, so the
// call evaluated to undefined, threw a TypeError, and the dialog's bare
// `catch { setConfirming(false) }` swallowed it — permanent week delete
// silently did nothing (commit a5655b8). This proves the wrapper exists, is
// a function, and forwards a token the way every other authorized wrapper
// in this file does via currentToken().
import { describe, it, expect, beforeEach, vi } from 'vitest'

const TOKEN_KEY = 'shoresh-token'

function makeLocalStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  }
}

describe('localClient.deleteWeek', () => {
  let deleteWeekSpy

  beforeEach(() => {
    vi.resetModules()
    globalThis.localStorage = makeLocalStorage()
    deleteWeekSpy = vi.fn().mockResolvedValue({ ok: true })
    globalThis.window = {
      shoresh: {
        deleteWeek: deleteWeekSpy,
      },
      location: { pathname: '/', search: '', replace: vi.fn() },
    }
  })

  it('exists and is a function', async () => {
    const { localClient } = await import('./localClient.js')
    expect(typeof localClient.deleteWeek).toBe('function')
  })

  it('forwards the current token and weekId to shoresh.deleteWeek', async () => {
    globalThis.localStorage.setItem(TOKEN_KEY, 'tok-123')
    const { localClient } = await import('./localClient.js')

    await localClient.deleteWeek({ weekId: 'week-1', campId: 'camp-1' })

    expect(deleteWeekSpy).toHaveBeenCalledWith({
      token: 'tok-123',
      weekId: 'week-1',
      campId: 'camp-1',
    })
  })
})
