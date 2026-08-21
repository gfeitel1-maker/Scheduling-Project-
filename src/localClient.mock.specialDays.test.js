// @vitest-environment jsdom
//
// T40 slice 1 (docs/work/specs/2026-08-20-special-days-data-shape-design.md):
// "Mock parity: a drift test that the mock's special-days behavior matches
// the real path (UNIQUE(camp_id,name), create/read/delete)." Mock-parity
// gaps have bitten before (T74) — this exercises mockShoresh.write/list
// directly, the way the real app's flow would under `npm run dev`.

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

describe('mockShoresh — special_days create/read/delete', () => {
  it('write(name) creates a row stamped with the singleton camp id, readable via list()', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    globalThis.localStorage.setItem(
      'shoresh-mock-state',
      JSON.stringify({ camp: { id: 'camp-1' }, users: [], conflicts: [], devices: [] })
    )

    await mockShoresh.write({ entity: 'special_days', entity_id: 'sd-1', field: 'name', value: 'Among Us' })

    const rows = await mockShoresh.list(null, 'special_days')
    expect(rows).toEqual([{ id: 'sd-1', camp_id: 'camp-1', name: 'Among Us' }])
  })

  it('write(sort_order) updates the existing row', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    globalThis.localStorage.setItem(
      'shoresh-mock-state',
      JSON.stringify({ camp: { id: 'camp-1' }, users: [], conflicts: [], devices: [] })
    )
    await mockShoresh.write({ entity: 'special_days', entity_id: 'sd-1', field: 'name', value: 'Among Us' })
    await mockShoresh.write({ entity: 'special_days', entity_id: 'sd-1', field: 'sort_order', value: 3 })

    const rows = await mockShoresh.list(null, 'special_days')
    expect(rows).toEqual([{ id: 'sd-1', camp_id: 'camp-1', name: 'Among Us', sort_order: 3 }])
  })

  it('field "__deleted__" removes the row', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    globalThis.localStorage.setItem(
      'shoresh-mock-state',
      JSON.stringify({ camp: { id: 'camp-1' }, users: [], conflicts: [], devices: [] })
    )
    await mockShoresh.write({ entity: 'special_days', entity_id: 'sd-1', field: 'name', value: 'Among Us' })
    expect(await mockShoresh.list(null, 'special_days')).toHaveLength(1)

    await mockShoresh.write({ entity: 'special_days', entity_id: 'sd-1', field: '__deleted__', value: 1 })
    expect(await mockShoresh.list(null, 'special_days')).toEqual([])
  })

  it('enforces UNIQUE(camp_id, name) the same way the real sqlite constraint does — a colliding create throws', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    globalThis.localStorage.setItem(
      'shoresh-mock-state',
      JSON.stringify({ camp: { id: 'camp-1' }, users: [], conflicts: [], devices: [] })
    )
    await mockShoresh.write({ entity: 'special_days', entity_id: 'sd-1', field: 'name', value: 'Among Us' })

    await expect(
      mockShoresh.write({ entity: 'special_days', entity_id: 'sd-2', field: 'name', value: 'Among Us' })
    ).rejects.toThrow(/UNIQUE/)

    // The colliding row was never created.
    expect(await mockShoresh.list(null, 'special_days')).toHaveLength(1)
  })

  it('two different camps (or two different names) do not collide', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    globalThis.localStorage.setItem(
      'shoresh-mock-state',
      JSON.stringify({ camp: { id: 'camp-1' }, users: [], conflicts: [], devices: [] })
    )
    await mockShoresh.write({ entity: 'special_days', entity_id: 'sd-1', field: 'name', value: 'Among Us' })
    await mockShoresh.write({ entity: 'special_days', entity_id: 'sd-2', field: 'name', value: 'Color War' })

    expect(await mockShoresh.list(null, 'special_days')).toHaveLength(2)
  })

  it('rejects a write for a field not in MOCK_WRITE_ALLOWLIST.special_days', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    globalThis.localStorage.setItem(
      'shoresh-mock-state',
      JSON.stringify({ camp: { id: 'camp-1' }, users: [], conflicts: [], devices: [] })
    )
    await expect(
      mockShoresh.write({ entity: 'special_days', entity_id: 'sd-1', field: 'not_a_real_field', value: 'x' })
    ).rejects.toThrow(/not in MOCK_WRITE_ALLOWLIST/)
  })
})

describe('mockShoresh — special_day_time_blocks / special_day_slots create/read/delete', () => {
  it('supports the same generic write/list/delete flow (no UNIQUE constraint, parent-scoped children)', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    globalThis.localStorage.setItem(
      'shoresh-mock-state',
      JSON.stringify({ camp: { id: 'camp-1' }, users: [], conflicts: [], devices: [] })
    )
    await mockShoresh.write({ entity: 'special_days', entity_id: 'sd-1', field: 'name', value: 'Among Us' })
    await mockShoresh.write({ entity: 'special_day_time_blocks', entity_id: 'tb-1', field: 'special_day_id', value: 'sd-1' })
    await mockShoresh.write({ entity: 'special_day_time_blocks', entity_id: 'tb-1', field: 'name', value: 'Opening' })
    await mockShoresh.write({ entity: 'special_day_slots', entity_id: 'sl-1', field: 'special_day_id', value: 'sd-1' })
    await mockShoresh.write({ entity: 'special_day_slots', entity_id: 'sl-1', field: 'group_id', value: 'grp-1' })
    await mockShoresh.write({ entity: 'special_day_slots', entity_id: 'sl-1', field: 'time_block_id', value: 'tb-1' })

    expect(await mockShoresh.list(null, 'special_day_time_blocks')).toEqual([
      { id: 'tb-1', special_day_id: 'sd-1', name: 'Opening' },
    ])
    expect(await mockShoresh.list(null, 'special_day_slots')).toEqual([
      { id: 'sl-1', special_day_id: 'sd-1', group_id: 'grp-1', time_block_id: 'tb-1' },
    ])

    await mockShoresh.write({ entity: 'special_day_slots', entity_id: 'sl-1', field: '__deleted__', value: 1 })
    expect(await mockShoresh.list(null, 'special_day_slots')).toEqual([])
  })
})

describe('mockShoresh — deleteSpecialDay cascade (T106)', () => {
  it('cascades: removes time blocks and slots scoped to the special day, then the special day itself', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    globalThis.localStorage.setItem(
      'shoresh-mock-state',
      JSON.stringify({ camp: { id: 'camp-1' }, users: [], conflicts: [], devices: [] })
    )
    await mockShoresh.write({ entity: 'special_days', entity_id: 'sd-1', field: 'name', value: 'Color War' })
    await mockShoresh.write({ entity: 'special_day_time_blocks', entity_id: 'tb-1', field: 'special_day_id', value: 'sd-1' })
    await mockShoresh.write({ entity: 'special_day_time_blocks', entity_id: 'tb-1', field: 'name', value: 'Opening' })
    await mockShoresh.write({ entity: 'special_day_slots', entity_id: 'sl-1', field: 'special_day_id', value: 'sd-1' })
    await mockShoresh.write({ entity: 'special_day_slots', entity_id: 'sl-1', field: 'group_id', value: 'grp-1' })
    await mockShoresh.write({ entity: 'special_day_slots', entity_id: 'sl-1', field: 'time_block_id', value: 'tb-1' })

    // A second, unrelated special day must survive the cascade untouched.
    await mockShoresh.write({ entity: 'special_days', entity_id: 'sd-2', field: 'name', value: 'Field Day' })

    const result = await mockShoresh.deleteSpecialDay({ specialDayId: 'sd-1' })
    expect(result).toEqual({ ok: true })

    expect(await mockShoresh.list(null, 'special_days')).toEqual([
      { id: 'sd-2', camp_id: 'camp-1', name: 'Field Day' },
    ])
    expect(await mockShoresh.list(null, 'special_day_time_blocks')).toEqual([])
    expect(await mockShoresh.list(null, 'special_day_slots')).toEqual([])
  })

  it('returns { error: "not-found" } for a non-existent special day', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    globalThis.localStorage.setItem(
      'shoresh-mock-state',
      JSON.stringify({ camp: { id: 'camp-1' }, users: [], conflicts: [], devices: [] })
    )
    const result = await mockShoresh.deleteSpecialDay({ specialDayId: 'does-not-exist' })
    expect(result).toEqual({ error: 'not-found' })
  })
})
