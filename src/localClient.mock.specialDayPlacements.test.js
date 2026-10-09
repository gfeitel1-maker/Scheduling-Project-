// @vitest-environment jsdom
//
// T350 slice 2: mock parity with electron/main.js write() — special_day_placements is written only
// by bindSpecialDay/unbindSpecialDay, so the generic write() refuses it in dev mode too.
import { describe, it, expect, beforeEach } from 'vitest'

beforeEach(() => {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  }
  globalThis.window = { localStorage: globalThis.localStorage, location: { search: '' } }
})

describe('mockShoresh.write — special_day_placements', () => {
  it('refuses a generic write and stores nothing', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    await expect(
      mockShoresh.write({ entity: 'special_day_placements', entity_id: 'p1', field: 'special_day_id', value: 'sd-1' })
    ).rejects.toThrow(/special_day_placements cannot be written via write\(\)/)
    expect(JSON.parse(globalThis.localStorage.getItem('shoresh-mock-state') || '{}').special_day_placements ?? []).toEqual([])
  })
})
