// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { deriveDayId } from '../electron/ops/dayId.js'

const STORE_KEY = 'shoresh-mock-state'

// Same hand-rolled localStorage harness as the sibling mock tests
// (localClient.mock.integerAffinity.test.js).
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
  camp: { id: 'camp1', name: 'Days Camp' },
  users: [], conflicts: [], devices: [], __fieldSource: {},
  days_of_operation: [],
})

// T205: the mock must agree with electron/ops/projections.js's
// days_of_operation.ensureExists — stamp day_of_week in the same "row
// creation" step when the id is a deterministic day id, so a re-import /
// diff test exercising the mock sees the same shape the real app produces.
describe('mockShoresh days_of_operation day_of_week stamping (T205)', () => {
  let localStorageMock
  let mockShoresh

  beforeEach(async () => {
    localStorageMock = makeLocalStorage()
    localStorageMock.setItem(STORE_KEY, JSON.stringify(seedState()))
    globalThis.localStorage = localStorageMock
    localStorageMock.setItem('shoresh-token', 'token-abc')
    const mod = await import('./localClient.mock.js')
    mockShoresh = mod.mockShoresh
  })

  it('stamps day_of_week on creation for a deterministic day id', async () => {
    const id = deriveDayId('camp1', 3)
    await mockShoresh.write({ entity: 'days_of_operation', entity_id: id, field: 'camp_id', value: 'camp1' })
    const state = JSON.parse(localStorageMock.getItem(STORE_KEY))
    const row = state.days_of_operation.find((r) => r.id === id)
    expect(row).toBeTruthy()
    expect(row.day_of_week).toBe(3)
  })

  it('leaves day_of_week unset for a non-deterministic id, without throwing', async () => {
    const id = 'legacy-random-uuid'
    await expect(
      mockShoresh.write({ entity: 'days_of_operation', entity_id: id, field: 'camp_id', value: 'camp1' })
    ).resolves.toBeTruthy()
    const state = JSON.parse(localStorageMock.getItem(STORE_KEY))
    const row = state.days_of_operation.find((r) => r.id === id)
    expect(row).toBeTruthy()
    expect(row.day_of_week == null).toBe(true)
  })
})
