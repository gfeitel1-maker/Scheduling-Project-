// @vitest-environment jsdom
//
// S1b — mockShoresh.confirmAlias, the dev-mock stand-in for
// electron/ops/confirmAlias.js. Asserts the same OBSERVABLE contract (T74
// fidelity discipline): active-row keying by (entity_type, cohort_id,
// normalizeName(source_label)), supersede-on-reconfirm-to-a-different-target,
// no-op on reconfirm-to-the-same-target, and the { id, superseded } return shape.

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

describe('mockShoresh.confirmAlias', () => {
  it('first confirm inserts an active row and returns { id, superseded: null }', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    const result = await mockShoresh.confirmAlias({
      entity_type: 'activities', cohort_id: null, source_label: 'Art', entity_id: 'art-1',
    })
    expect(result.superseded).toBeNull()
    expect(typeof result.id).toBe('string')
  })

  it('re-confirming the SAME label to the SAME target is a no-op, returning the existing active id', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    const first = await mockShoresh.confirmAlias({
      entity_type: 'activities', cohort_id: null, source_label: 'Art', entity_id: 'art-1',
    })
    const second = await mockShoresh.confirmAlias({
      entity_type: 'activities', cohort_id: null, source_label: 'Art', entity_id: 'art-1',
    })
    expect(second).toEqual({ id: first.id, superseded: null })
  })

  it('re-confirming the SAME label to a DIFFERENT target supersedes the prior active row', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    const first = await mockShoresh.confirmAlias({
      entity_type: 'activities', cohort_id: null, source_label: 'Art', entity_id: 'art-1',
    })
    const second = await mockShoresh.confirmAlias({
      entity_type: 'activities', cohort_id: null, source_label: 'Art', entity_id: 'art-2',
    })
    expect(second.superseded).toBe(first.id)
    expect(second.id).not.toBe(first.id)
  })

  it('keys active rows by cohort_id for cohort-scoped entity types (tiers/time_blocks)', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    const cohortA = await mockShoresh.confirmAlias({
      entity_type: 'tiers', cohort_id: 'cohort-a', source_label: 'Juniors', entity_id: 'tier-a',
    })
    // Same label, different cohort — a distinct scope key, not a supersede.
    const cohortB = await mockShoresh.confirmAlias({
      entity_type: 'tiers', cohort_id: 'cohort-b', source_label: 'Juniors', entity_id: 'tier-b',
    })
    expect(cohortB.superseded).toBeNull()
    expect(cohortB.id).not.toBe(cohortA.id)
  })

  it('is case/whitespace-normalized (normalizeName) for the scope key match', async () => {
    const { mockShoresh } = await import('./localClient.mock.js')
    const first = await mockShoresh.confirmAlias({
      entity_type: 'activities', cohort_id: null, source_label: 'Art', entity_id: 'art-1',
    })
    const second = await mockShoresh.confirmAlias({
      entity_type: 'activities', cohort_id: null, source_label: '  ART  ', entity_id: 'art-2',
    })
    expect(second.superseded).toBe(first.id)
  })
})
