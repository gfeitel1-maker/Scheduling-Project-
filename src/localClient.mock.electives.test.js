// @vitest-environment jsdom
//
// T41 slice 1 (docs/work/specs/2026-08-20-group-electives-design.md): "Mock
// parity: a drift test that the mock's elective-sets behavior matches the
// real path (UNIQUE(camp_id,name), create/read/delete)." Mock-parity gaps
// have bitten before (T74) — this exercises mockShoresh.write/list directly,
// the way the real app's flow would under `npm run dev`. Mirrors
// src/localClient.mock.specialDays.test.js.

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

describe('mockShoresh — elective_sets create/read/delete', () => {
  it('write(name) creates a row stamped with the singleton camp id, readable via list()', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    globalThis.localStorage.setItem(
      'shoresh-mock-state',
      JSON.stringify({ camp: { id: 'camp-1' }, users: [], conflicts: [], devices: [] })
    )

    await mockShoresh.write({ entity: 'elective_sets', entity_id: 'es-1', field: 'name', value: 'Afternoon Chugim' })

    const rows = await mockShoresh.list(null, 'elective_sets')
    expect(rows).toEqual([{ id: 'es-1', camp_id: 'camp-1', name: 'Afternoon Chugim' }])
  })

  it('write(sort_order) updates the existing row', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    globalThis.localStorage.setItem(
      'shoresh-mock-state',
      JSON.stringify({ camp: { id: 'camp-1' }, users: [], conflicts: [], devices: [] })
    )
    await mockShoresh.write({ entity: 'elective_sets', entity_id: 'es-1', field: 'name', value: 'Afternoon Chugim' })
    await mockShoresh.write({ entity: 'elective_sets', entity_id: 'es-1', field: 'sort_order', value: 3 })

    const rows = await mockShoresh.list(null, 'elective_sets')
    expect(rows).toEqual([{ id: 'es-1', camp_id: 'camp-1', name: 'Afternoon Chugim', sort_order: 3 }])
  })

  it('field "__deleted__" removes the row', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    globalThis.localStorage.setItem(
      'shoresh-mock-state',
      JSON.stringify({ camp: { id: 'camp-1' }, users: [], conflicts: [], devices: [] })
    )
    await mockShoresh.write({ entity: 'elective_sets', entity_id: 'es-1', field: 'name', value: 'Afternoon Chugim' })
    expect(await mockShoresh.list(null, 'elective_sets')).toHaveLength(1)

    await mockShoresh.write({ entity: 'elective_sets', entity_id: 'es-1', field: '__deleted__', value: 1 })
    expect(await mockShoresh.list(null, 'elective_sets')).toEqual([])
  })

  it('enforces UNIQUE(camp_id, name) the same way the real sqlite constraint does — a colliding create throws', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    globalThis.localStorage.setItem(
      'shoresh-mock-state',
      JSON.stringify({ camp: { id: 'camp-1' }, users: [], conflicts: [], devices: [] })
    )
    await mockShoresh.write({ entity: 'elective_sets', entity_id: 'es-1', field: 'name', value: 'Afternoon Chugim' })

    await expect(
      mockShoresh.write({ entity: 'elective_sets', entity_id: 'es-2', field: 'name', value: 'Afternoon Chugim' })
    ).rejects.toThrow(/UNIQUE/)

    // The colliding row was never created.
    expect(await mockShoresh.list(null, 'elective_sets')).toHaveLength(1)
  })
})

describe('mockShoresh — elective_set_activities and template_slots.elective_set_id write', () => {
  it('write(activity_id) creates a member row', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    globalThis.localStorage.setItem(
      'shoresh-mock-state',
      JSON.stringify({ camp: { id: 'camp-1' }, users: [], conflicts: [], devices: [] })
    )
    await mockShoresh.write({ entity: 'elective_sets', entity_id: 'es-1', field: 'name', value: 'Afternoon Chugim' })
    await mockShoresh.write({ entity: 'elective_set_activities', entity_id: 'esa-1', field: 'elective_set_id', value: 'es-1' })
    await mockShoresh.write({ entity: 'elective_set_activities', entity_id: 'esa-1', field: 'activity_id', value: 'act-1' })

    const rows = await mockShoresh.list(null, 'elective_set_activities')
    expect(rows).toContainEqual(
      expect.objectContaining({ id: 'esa-1', elective_set_id: 'es-1', activity_id: 'act-1' })
    )
  })

  it('template_slots.elective_set_id is a writable field, distinct from activity_id', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    globalThis.localStorage.setItem(
      'shoresh-mock-state',
      JSON.stringify({ camp: { id: 'camp-1' }, users: [], conflicts: [], devices: [] })
    )
    await mockShoresh.write({ entity: 'elective_sets', entity_id: 'es-1', field: 'name', value: 'Afternoon Chugim' })
    await mockShoresh.write({ entity: 'template_slots', entity_id: 'ts-1', field: 'template_id', value: 'tpl-1' })
    await mockShoresh.write({ entity: 'template_slots', entity_id: 'ts-1', field: 'elective_set_id', value: 'es-1' })

    const rows = await mockShoresh.list(null, 'template_slots')
    const slot = rows.find((r) => r.id === 'ts-1')
    expect(slot.elective_set_id).toBe('es-1')
  })
})

// T105 §2 — the reuse-surface exclusion the ticket's scope literally requires:
// listDurableElectiveSets must never surface an is_reusable=0 (one-off) set,
// and the generic list('elective_sets') must never be substituted for it on a
// reuse surface (T110 Red Hat note).
describe('mockShoresh — listDurableElectiveSets (T105 §2 reuse-surface exclusion)', () => {
  it('excludes an is_reusable=0 set and includes an is_reusable=1 set', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    globalThis.localStorage.setItem(
      'shoresh-mock-state',
      JSON.stringify({ camp: { id: 'camp-1' }, users: [], conflicts: [], devices: [] })
    )
    await mockShoresh.write({ entity: 'elective_sets', entity_id: 'es-oneoff', field: 'name', value: 'One-Off' })
    await mockShoresh.write({ entity: 'elective_sets', entity_id: 'es-oneoff', field: 'is_reusable', value: 0 })
    await mockShoresh.write({ entity: 'elective_sets', entity_id: 'es-durable', field: 'name', value: 'Durable' })
    await mockShoresh.write({ entity: 'elective_sets', entity_id: 'es-durable', field: 'is_reusable', value: 1 })

    const durable = await mockShoresh.listDurableElectiveSets()
    expect(durable.map(s => s.id)).toEqual(['es-durable'])

    // The flip side: the generic list still returns BOTH — the render surface
    // (§2's electiveSetsAll) must see the one-off too.
    const all = await mockShoresh.list(null, 'elective_sets')
    expect(all.map(s => s.id).sort()).toEqual(['es-durable', 'es-oneoff'])
  })

  it('a set with no is_reusable write at all (never promoted) is excluded, not treated as durable', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    globalThis.localStorage.setItem(
      'shoresh-mock-state',
      JSON.stringify({ camp: { id: 'camp-1' }, users: [], conflicts: [], devices: [] })
    )
    await mockShoresh.write({ entity: 'elective_sets', entity_id: 'es-1', field: 'name', value: 'Fresh One-Off' })
    const durable = await mockShoresh.listDurableElectiveSets()
    expect(durable).toEqual([])
  })
})
