// @vitest-environment jsdom
//
// Code Reviewer HIGH finding on the M6 fix round: LocationsScreen.jsx's
// handleMapFileSelected writes camp_maps' four fields WITHOUT camp_id. That's
// correct against the REAL backend — PROJECTIONS.camp_maps.ensureExists
// (electron/ops/projections.js) stamps camp_id server-side on first insert —
// but src/localClient.mock.js's write() only auto-stamps camp_id for
// UNIQUE_KEYS composite entities, and camp_maps is correctly NOT one (it's a
// singleton keyed by id = camp_id, not a (camp_id, name) tuple). So in
// `npm run dev` (the browser mock, no Electron), an uploaded map row ends up
// with no camp_id, and LocationsScreen's loadCampMap
// (`rows.find(r => r.camp_id === campId)`) never matches — the map always
// reverts to "No map yet."
//
// This exercises the REAL src/localClient.mock.js module (no vi.mock) the
// same way `npm run dev` would: import { localClient } bound to the real
// mockShoresh fallback (localClient.js falls back to mockShoresh whenever
// window.shoresh is absent, which is the case in this jsdom test), bootstrap
// a camp, issue the SAME four field writes handleMapFileSelected issues, then
// list('camp_maps') and assert the row is findable by camp_id — i.e. that
// loadCampMap would actually find it.
import { describe, it, expect, beforeEach } from 'vitest'

function makeLocalStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  }
}

beforeEach(() => {
  globalThis.localStorage = makeLocalStorage()
  globalThis.window = { localStorage: globalThis.localStorage, location: { search: '' } }
})

describe('camp_maps upload in the dev mock — camp_id stamping', () => {
  it('a map upload is findable by camp_id afterwards (the exact shape loadCampMap depends on)', async () => {
    const { localClient } = await import('../../localClient')
    const { createSetupCrudRepository } = await import('../../data/setupCrudRepository')
    const repository = createSetupCrudRepository({ localClient })

    const { campId } = await localClient.bootstrapCamp({
      campName: 'Camp Achva', adminName: 'Director', adminPin: '1234',
    })
    localStorage.setItem('shoresh-token', 'token-abc')

    // The EXACT write handleMapFileSelected (LocationsScreen.jsx) issues.
    await repository.writeFields('camp_maps', campId, {
      camp_id: campId,
      image_data: 'abc123',
      image_mime: 'image/jpeg',
      image_width: 800,
      image_height: 600,
    })

    const rows = (await localClient.list('camp_maps')) || []
    const found = rows.find((r) => r.camp_id === campId)
    expect(found).toBeTruthy()
    expect(found.image_data).toBe('abc123')
  })
})
