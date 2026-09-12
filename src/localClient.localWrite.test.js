// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// T123. The sidebar showed "! Groups needed" while Roots, six inches away,
// showed "Groups 33" — and a page reload fixed it, which proved the data was
// right and the view was stale.
//
// Cause: useSetupCounts refreshed only on `onOpApplied`, which is the SYNC
// channel — an op arriving from another device. A director's own write on their
// own device never fired it, so nothing on this device had a refresh path.
//
// `onLocalWrite` is that path. It is deliberately NOT folded into onOpApplied:
// ScheduleScreen, EventGridEditor and SpecialDayGridEditor all read the `op`
// argument to decide whether to reload, so pushing a synthetic op through that
// channel would be a behaviour change for three screens that are not broken.

describe('localClient.onLocalWrite', () => {
  let localClient

  beforeEach(async () => {
    vi.resetModules()
    // Node's own global `localStorage` (backed by --localstorage-file) shadows
    // jsdom's and lacks getItem/setItem — same stub usePendingConflicts.test.js
    // uses, and for the same reason.
    const store = new Map([['shoresh-token', 'mock.demo-admin']])
    vi.stubGlobal('localStorage', {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    })
    ;({ localClient } = await import('./localClient'))
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it('notifies after a field write', async () => {
    const seen = vi.fn()
    const unsub = localClient.onLocalWrite(seen)
    await localClient.write('mock.demo-admin', 'groups', 'g-new', 'name', 'Amber Pines')
    expect(seen).toHaveBeenCalledTimes(1)
    unsub()
  })

  it('notifies after a row delete and after a bulk replace', async () => {
    const seen = vi.fn()
    const unsub = localClient.onLocalWrite(seen)
    await localClient.deleteEntity('mock.demo-admin', 'groups', 'g-new')
    await localClient.bulkReplace('mock.demo-admin', 'groups', 'camp-1', [])
    expect(seen).toHaveBeenCalledTimes(2)
    unsub()
  })

  // 2026-09-12. deleteRecord, mergeLocation and restoreEntity were the three
  // mutations left OUT of the announcing() wrapper, so the sidebar's tick and
  // count stayed on pre-mutation state until something else forced a refetch.
  // Observed live: merging two locations left the table reading "1 LOCATION"
  // beside a sidebar reading "Locations 2".
  it('notifies after a record delete, a location merge and a restore', async () => {
    const seen = vi.fn()
    const unsub = localClient.onLocalWrite(seen)
    await localClient.deleteRecord('activities', 'a-1', 0)
    await localClient.mergeLocation({ loser_id: 'l2', winner_id: 'l1' })
    await localClient.restoreEntity('activities', 'a-1')
    expect(seen).toHaveBeenCalledTimes(3)
    unsub()
  })

  it('stops notifying once unsubscribed', async () => {
    const seen = vi.fn()
    localClient.onLocalWrite(seen)()
    await localClient.write('mock.demo-admin', 'groups', 'g-2', 'name', 'Lanterns')
    expect(seen).not.toHaveBeenCalled()
  })

  it('does not notify when the write rejects — a failed write changed nothing', async () => {
    const seen = vi.fn()
    const unsub = localClient.onLocalWrite(seen)
    // An unknown entity is refused by the mock the same way the real handler
    // refuses it, so this exercises the rejection path rather than a stub.
    await localClient.write('mock.demo-admin', 'not_a_table', 'x', 'name', 'v').catch(() => {})
    expect(seen).not.toHaveBeenCalled()
    unsub()
  })

  it('one subscriber throwing does not stop the others being told', async () => {
    const bad = vi.fn(() => { throw new Error('subscriber blew up') })
    const good = vi.fn()
    const u1 = localClient.onLocalWrite(bad)
    const u2 = localClient.onLocalWrite(good)
    await localClient.write('mock.demo-admin', 'groups', 'g-3', 'name', 'Falcons')
    expect(good).toHaveBeenCalledTimes(1)
    u1(); u2()
  })
})
