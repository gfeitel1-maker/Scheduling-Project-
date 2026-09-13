// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { normalizeSlots } from './utils/normalizeSlots'

const STORE_KEY = 'shoresh-mock-state'

// Same harness the sibling mock tests use (localClient.mock.anchorKind.test.js):
// a hand-rolled localStorage plus a pre-seeded camp, so the mock is driven
// directly rather than through bootstrapCamp.
function makeLocalStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  }
}

const seedState = () => ({
  camp: { id: 'camp1', name: 'Affinity Camp' },
  users: [], conflicts: [], devices: [], __fieldSource: {},
  template_slots: [], activities: [],
})

// T102 — the dev mock must emulate SQLite's INTEGER affinity for the slot
// columns the renderer reads as booleans.
//
// THE DEFECT THIS PINS, because it was invisible and total:
//
// The op log carries every value as a STRING (validateBulkReplaceRows in
// electron/ops/operations.js accepts only string/null). In the real app that
// string lands in an INTEGER column and SQLite coerces it, so the renderer
// reads the number 1. The mock stored it verbatim, so the renderer read the
// string "1" — and normalizeSlots' toSlotBool is a strict
// `value === 1 || value === true`, which makes "1" FALSE.
//
// Every slot therefore read as is_span_head:false, i.e. the continuation of a
// merged block. Continuations render nothing. The schedule grid came up with
// no cells AND NO GRID LINES, while the stats bar simultaneously reported
// "45 of 45 Placed" — because recalcStats filters on is_anchor/activity_id and
// never consults is_span_head. Two readers of the same rows, one broken field,
// and the disagreement was the only visible symptom.
//
// Nothing asserted the stored TYPE, which is why it survived. That is what
// these tests are for.
describe('mock emulates SQLite INTEGER affinity (T102)', () => {
  beforeEach(() => {
    globalThis.localStorage = makeLocalStorage()
    globalThis.window = { localStorage: globalThis.localStorage, location: { search: '' } }
    globalThis.localStorage.setItem(STORE_KEY, JSON.stringify(seedState()))
  })

  it('stores a numeric-string is_span_head as a NUMBER, via write()', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    await mockShoresh.write({ entity: 'template_slots', entity_id: 'slot-1', field: 'is_span_head', value: '1' })
    const [row] = (await mockShoresh.list(null, 'template_slots')).filter(r => r.id === 'slot-1')
    expect(typeof row.is_span_head).toBe('number')
    expect(row.is_span_head).toBe(1)
  })

  it('does the same through bulkReplace() — the path a schedule REBUILD takes', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    await mockShoresh.bulkReplace({
      entity: 'template_slots',
      scope_id: 'tpl-1',
      rows: [{ id: 'slot-2', template_id: 'tpl-1', is_span_head: '1', is_anchor: '0' }],
    })
    const [row] = (await mockShoresh.list(null, 'template_slots')).filter(r => r.id === 'slot-2')
    expect(row.is_span_head).toBe(1)
    expect(row.is_anchor).toBe(0)
  })

  it('survives the real read boundary: normalizeSlots yields TRUE, not false', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    // The end-to-end assertion. Before the fix this produced `false` for every
    // row, which is what emptied the grid.
    await mockShoresh.bulkReplace({
      entity: 'template_slots',
      scope_id: 'tpl-2',
      rows: [{ id: 'slot-3', template_id: 'tpl-2', is_span_head: '1', is_anchor: '0' }],
    })
    const raw = (await mockShoresh.list(null, 'template_slots')).filter(r => r.id === 'slot-3')
    const [slot] = normalizeSlots(raw)
    expect(slot.is_span_head).toBe(true)
    expect(slot.is_anchor).toBe(false)
  })

  it('leaves a genuinely non-numeric value alone', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    await mockShoresh.write({ entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swim' })
    const [row] = (await mockShoresh.list(null, 'activities')).filter(r => r.id === 'act-1')
    expect(row.name).toBe('Swim')
  })

  it('does NOT coerce a numeric-looking value outside the affinity list', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    // A camp, group or activity named "2024" must stay a string — the
    // coercion is scoped to columns the renderer reads as booleans, not
    // applied to every numeric-looking string in the store.
    await mockShoresh.write({ entity: 'activities', entity_id: 'act-2', field: 'name', value: '2024' })
    const [row] = (await mockShoresh.list(null, 'activities')).filter(r => r.id === 'act-2')
    expect(typeof row.name).toBe('string')
    expect(row.name).toBe('2024')
  })

  it('preserves NULL as NULL — "never written" is not the same as false', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    await mockShoresh.write({ entity: 'template_slots', entity_id: 'slot-4', field: 'is_span_head', value: null })
    const [row] = (await mockShoresh.list(null, 'template_slots')).filter(r => r.id === 'slot-4')
    expect(row.is_span_head).toBeNull()
    const [slot] = normalizeSlots([row])
    expect(slot.is_span_head).toBeNull()
  })
})
