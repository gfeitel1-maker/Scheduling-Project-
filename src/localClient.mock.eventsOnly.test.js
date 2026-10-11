// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'

const STORE_KEY = 'shoresh-mock-state'
const store = new Map()
const localStorageMock = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
}

// T364 / T365 parity with electron/ops/ingest.eventsOnly.test.js: the mock's commit path sets a short
// event block's flag on a re-import, clears an import-set one, and leaves a director's alone.
describe('mock ingestCommit events_only', () => {
  let mock
  const APPROVED = { groups: ['Otters 1'], days_of_operation: ['Monday'], time_blocks: ['08:50-09:00', '09:05-09:50'] }
  const FLAG = { name: 'Flag Raising', time_block: '08:50-09:00', days: ['Monday'], scope: { is_all_groups: true, groups: [] } }
  const commit = (fixedEvents) => mock.ingestCommit({ approved: APPROVED, fixedEvents, mode: 'add' })
  const block = () => JSON.parse(localStorageMock.getItem(STORE_KEY)).time_blocks.find((b) => b.name === '08:50-09:00')

  beforeEach(async () => {
    store.clear()
    localStorageMock.setItem(STORE_KEY, JSON.stringify({ camp: { id: 'camp1', name: 'C' }, users: [], conflicts: [], devices: [], __fieldSource: {} }))
    localStorageMock.setItem('shoresh-token', 'token-abc')
    globalThis.localStorage = localStorageMock
    mock = (await import('./localClient.mock.js')).mockShoresh
  })

  it('sets on a fresh import, clears when the event goes', async () => {
    await commit([FLAG])
    expect(block().events_only).toBe(1)
    await commit([])
    expect(block().events_only).toBe(0)
  })

  it('never touches a flag the director wrote', async () => {
    await commit([])
    await mock.write({ entity: 'time_blocks', entity_id: block().id, field: 'events_only', value: 1 })
    await commit([])
    expect(block().events_only).toBe(1)
  })

  it('leaves the flag alone when the caller carries no fixedEvents', async () => {
    await commit([FLAG])
    await mock.ingestCommit({ approved: APPROVED, mode: 'add' })
    expect(block().events_only).toBe(1)
  })
})
