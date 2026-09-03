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

  it('forwards the current token and weekId to shoresh.deleteWeek, dropping any other fields', async () => {
    globalThis.localStorage.setItem(TOKEN_KEY, 'tok-123')
    const { localClient } = await import('./localClient.js')

    await localClient.deleteWeek({ weekId: 'week-1', campId: 'camp-1' })

    expect(deleteWeekSpy).toHaveBeenCalledWith({
      token: 'tok-123',
      weekId: 'week-1',
    })
  })

  it('never lets a caller-supplied token field override the real one', async () => {
    globalThis.localStorage.setItem(TOKEN_KEY, 'tok-123')
    const { localClient } = await import('./localClient.js')

    await localClient.deleteWeek({ weekId: 'week-1', token: 'forged-token' })

    expect(deleteWeekSpy).toHaveBeenCalledWith({
      token: 'tok-123',
      weekId: 'week-1',
    })
  })
})

// docs/adr/2026-08-28-stage-aware-nav-landing.md Decision 1 — the wrapper
// forwards to shoresh.campHasSetupData() with no args (pre-auth, like
// getCamp), and the browser-mock's own implementation (localClient.mock.js)
// must resolve the same false-on-bare/true-once-populated shape so the dev
// path at localhost:5200 lands on the same screen the real app would.
describe('localClient.campHasSetupData', () => {
  beforeEach(() => {
    vi.resetModules()
    globalThis.localStorage = makeLocalStorage()
  })

  it('forwards to shoresh.campHasSetupData() with no arguments', async () => {
    const spy = vi.fn().mockResolvedValue(true)
    globalThis.window = {
      shoresh: { campHasSetupData: spy },
      location: { pathname: '/', search: '', replace: vi.fn() },
    }
    const { localClient } = await import('./localClient.js')

    await localClient.campHasSetupData()

    expect(spy).toHaveBeenCalledWith()
  })

  it('mirror-parity: the browser-mock resolves false on a bare camp', async () => {
    globalThis.window = { location: { pathname: '/', search: '', replace: vi.fn() } }
    const { localClient } = await import('./localClient.js')

    expect(await localClient.campHasSetupData()).toBe(false)
  })

  it('mirror-parity: the browser-mock resolves true once a required-setup table has a row', async () => {
    globalThis.localStorage.setItem('shoresh-mock-state', JSON.stringify({
      camp: { id: 'camp-1', name: 'Camp Test' },
      users: [], conflicts: [], devices: [],
      tiers: [{ id: 't1', camp_id: 'camp-1', name: 'Seniors' }],
    }))
    globalThis.window = { location: { pathname: '/', search: '', replace: vi.fn() } }
    const { localClient } = await import('./localClient.js')

    expect(await localClient.campHasSetupData()).toBe(true)
  })
})

// Red Hat (T118 slice 4 review) — ingestCommit's destructure/passthrough was
// missing `clears`/`humanEditedFields` entirely: real commits through
// ReconciliationScreen.apply() silently dropped the S4b group-unit-clear
// path AND activity-rule human-edit provenance protection on every real
// import, even though the sibling ingestReconcile dry-run had both fields
// correctly wired since commit 820a415 — so the reconciliation PREVIEW a
// director saw could show correct clear/provenance behavior while the actual
// commit did not apply it. Fixed alongside T118 slice 4 (same signature was
// being edited); this test exists so a future "cleanup" of the long
// destructure list can't silently drop these two fields again with nothing
// failing — main.test.js's ingestCommit coverage calls handlers.ingestCommit
// directly and can never catch a regression at this specific wrapper.
describe('localClient.ingestCommit', () => {
  let ingestCommitSpy

  beforeEach(() => {
    vi.resetModules()
    globalThis.localStorage = makeLocalStorage()
    ingestCommitSpy = vi.fn().mockResolvedValue({ held: false, created: {}, total: 0 })
    globalThis.window = {
      shoresh: { ingestCommit: ingestCommitSpy },
      location: { pathname: '/', search: '', replace: vi.fn() },
    }
  })

  it('forwards clears and humanEditedFields to shoresh.ingestCommit', async () => {
    globalThis.localStorage.setItem(TOKEN_KEY, 'tok-123')
    const { localClient } = await import('./localClient.js')

    const clears = { groups: { 'Bunk 1': ['unit'] } }
    const humanEditedFields = { groups: { 'Bunk 1': ['unit'] }, activities: { Swim: ['min_per_week'] } }
    await localClient.ingestCommit({ approved: {}, links: {}, clears, humanEditedFields, mode: 'add' })

    const call = ingestCommitSpy.mock.calls[0][0]
    expect(call.clears).toBe(clears)
    expect(call.humanEditedFields).toBe(humanEditedFields)
    expect(call.token).toBe('tok-123')
  })
})
