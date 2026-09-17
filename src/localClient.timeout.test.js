// @vitest-environment jsdom
//
// T203 / docs/adr/2026-09-17-bounded-write-timeout-and-days-of-operation-
// uniqueness.md — localClient.write/deleteEntity/bulkReplace get a bounded
// (8000ms) caller-side timeout. A hang in the main process (the only kind of
// hang the ADR's read of the code found possible post-Stage-6) must not leave
// the renderer's promise unsettled forever: it must REJECT, as an ordinary
// write failure, so T201's existing bootstrap retry/notice handles it with
// zero new UI. It must never resolve a synthetic success — the underlying
// call is never cancelled, so a merely-slow-but-fine write must still
// resolve normally if it finishes inside the bound.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

function makeLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
}

describe('localClient bounded write timeout', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.stubGlobal('localStorage', makeLocalStorage({ 'shoresh-token': 'tok-1' }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('a hung write rejects within the 8000ms bound instead of hanging forever', async () => {
    const hungWrite = vi.fn(() => new Promise(() => {})) // never settles
    globalThis.window = {
      shoresh: { write: hungWrite },
      location: { pathname: '/', search: '', replace: vi.fn() },
    }
    const { localClient } = await import('./localClient.js')

    const pending = localClient.write('tok-1', 'groups', 'g-1', 'name', 'Amber')
    const assertion = expect(pending).rejects.toThrow(/^write timed out after 8000ms/)

    await vi.advanceTimersByTimeAsync(8000)
    await assertion
  })

  it('a slow-but-successful write (settles just inside the bound) resolves normally, not as a failure', async () => {
    let resolveWrite
    const slowWrite = vi.fn(() => new Promise((resolve) => { resolveWrite = resolve }))
    globalThis.window = {
      shoresh: { write: slowWrite },
      location: { pathname: '/', search: '', replace: vi.fn() },
    }
    const { localClient } = await import('./localClient.js')

    const pending = localClient.write('tok-1', 'groups', 'g-1', 'name', 'Amber')

    await vi.advanceTimersByTimeAsync(7999)
    resolveWrite({ status: 'applied' })

    await expect(pending).resolves.toEqual({ status: 'applied' })
  })

  it('a hung deleteEntity rejects with a message carrying the same "write timed out" substring', async () => {
    const hungWrite = vi.fn(() => new Promise(() => {}))
    globalThis.window = {
      shoresh: { write: hungWrite },
      location: { pathname: '/', search: '', replace: vi.fn() },
    }
    const { localClient } = await import('./localClient.js')

    const pending = localClient.deleteEntity('tok-1', 'groups', 'g-1')
    const assertion = expect(pending).rejects.toThrow(/^write timed out/)
    await vi.advanceTimersByTimeAsync(8000)
    await assertion
  })

  it('a hung bulkReplace rejects with a message carrying the same "write timed out" substring', async () => {
    const hungBulkReplace = vi.fn(() => new Promise(() => {}))
    globalThis.window = {
      shoresh: { bulkReplace: hungBulkReplace },
      location: { pathname: '/', search: '', replace: vi.fn() },
    }
    const { localClient } = await import('./localClient.js')

    const pending = localClient.bulkReplace('tok-1', 'template_slots', 'scope-1', [])
    const assertion = expect(pending).rejects.toThrow(/^write timed out/)
    await vi.advanceTimersByTimeAsync(8000)
    await assertion
  })

  it('clears its timer on a normal resolve — no dangling timer left running', async () => {
    const fastWrite = vi.fn().mockResolvedValue({ status: 'applied' })
    globalThis.window = {
      shoresh: { write: fastWrite },
      location: { pathname: '/', search: '', replace: vi.fn() },
    }
    const { localClient } = await import('./localClient.js')

    await localClient.write('tok-1', 'groups', 'g-1', 'name', 'Amber')

    // If the timer were still pending, this would fire a rejection into an
    // already-settled (and no longer observed) promise — vitest's fake-timer
    // teardown would surface that as an unhandled rejection / pending timer.
    expect(vi.getTimerCount()).toBe(0)
  })
})
