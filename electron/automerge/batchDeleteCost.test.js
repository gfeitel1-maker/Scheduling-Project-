// @vitest-environment node
// Replace re-import freeze (packaged 714d1b32, 2026-10-10): Replace deletes every setup record in
// one deferred applyWrites batch, and each delete listed the whole entity collection and both
// marks collections (provenance, author) through Automerge proxies: O(deletes x keys) inside one
// A.change, 143s of a 150s main-process profile on an imported camp. A batch now lists each
// collection once. Counted in Object.keys calls, never wall clock.
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as A from '@automerge/automerge'
import { createEmptyDoc, applyWrites } from './campDocument.js'
import { DELETE_FIELD } from '../ops/operations.js'

afterEach(() => vi.restoreAllMocks())

function campWith(n) {
  const writes = []
  for (let i = 0; i < n; i++) {
    writes.push({ entity: 'activities', entity_id: `a${i}`, field: 'name', value: `Activity ${i}`, source: i % 2 ? 'human' : 'import', author_user_id: 'u1' })
    writes.push({ entity: 'activities', entity_id: `a${i}`, field: 'min_per_week', value: '1', source: 'human', author_user_id: 'u1' })
  }
  return applyWrites(createEmptyDoc(), writes)
}

const deletes = (ids) => ids.map((id) => ({ entity: 'activities', entity_id: id, field: DELETE_FIELD, author_user_id: 'u2' }))

describe('a batch of deletes', () => {
  it('lists each collection a bounded number of times, not once per deleted record', () => {
    const doc = campWith(1500)
    const spy = vi.spyOn(Object, 'keys')
    applyWrites(doc, deletes(Array.from({ length: 150 }, (_, i) => `a${i}`)))
    expect(spy.mock.calls.length).toBeLessThanOrEqual(20)
  }, 120_000) // building the 1500-record fixture is slow; the assertion is a call count

  it('leaves exactly the same document as deleting one write at a time', () => {
    const base = campWith(60)
    const ids = ['a3', 'a7', 'a8', 'a59']
    const batched = applyWrites(A.clone(base), [
      ...deletes(ids),
      // A record deleted and written again in the same batch, then deleted again.
      { entity: 'activities', entity_id: 'a7', field: 'name', value: 'Back', source: 'human', author_user_id: 'u3' },
      ...deletes(['a7']),
      { entity: 'activities', entity_id: 'a8', field: 'name', value: 'Back again', source: 'human', author_user_id: 'u3' },
    ])
    let single = A.clone(base)
    for (const w of [...deletes(ids), { entity: 'activities', entity_id: 'a7', field: 'name', value: 'Back', source: 'human', author_user_id: 'u3' }, ...deletes(['a7']), { entity: 'activities', entity_id: 'a8', field: 'name', value: 'Back again', source: 'human', author_user_id: 'u3' }]) {
      single = applyWrites(single, [w])
    }
    expect(A.toJS(batched)).toEqual(A.toJS(single))
    const keys = Object.keys(batched.activities)
    expect(keys.some((k) => k.startsWith('a3\u0000'))).toBe(false)
    expect(keys.some((k) => k.startsWith('a7\u0000'))).toBe(false)
    expect(keys.filter((k) => k.startsWith('a8\u0000'))).toEqual(['a8\u0000name'])
  })
})
