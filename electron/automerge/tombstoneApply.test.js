// @vitest-environment node
//
// Pair again, step one (keeper ruling on #844 R4a): the camp's signed tombstones are verified and
// applied to the device's own document before it merges. Also pins (R4b) what a merge does today
// when one side edits a record the other side deleted.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import * as A from '@automerge/automerge'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { ensureHostSigningKey } from '../auth/localAuth.js'
import { signTombstone } from './tombstoneSignature.js'
import { verifyTombstones, applyTombstonesToDoc } from './tombstoneApply.js'
import { createEmptyDoc, applyWrites, readRecord } from './campDocument.js'
import { DELETE_FIELD } from '../ops/operations.js'

afterAll(() => cleanupTemplatedDbs())
let db, file, pub
beforeEach(() => {
  ;({ db, file } = openTemplatedDb())
  pub = ensureHostSigningKey(db).public_key
})
afterEach(() => { db.close(); fs.unlinkSync(file) })

const tomb = (id) => ({ id, entity: 'campers', version: 1, sig: signTombstone(db, { id, entity: 'campers', version: 1 }) })

function docWithCamper() {
  return applyWrites(A.clone(createEmptyDoc()), [
    { entity: 'campers', entity_id: 'c1', field: 'display_name', value: 'Child' },
    { entity: 'elective_preferences', entity_id: 'p1', field: 'camper_id', value: 'c1' },
    { entity: 'activities', entity_id: 'act', field: 'name', value: 'Swim' },
  ])
}

describe('verifyTombstones', () => {
  it('accepts tombstones signed by the camp key and refuses the whole set if any is forged', () => {
    expect(verifyTombstones(pub, [tomb('c1')])).toBe(true)
    expect(verifyTombstones(pub, [tomb('c1'), { ...tomb('c2'), id: 'c3' }])).toBe(false)
    expect(verifyTombstones(null, [tomb('c1')])).toBe(false)
  })
})

describe('applyTombstonesToDoc', () => {
  it('removes the erased camper and the records that name it, and nothing else', () => {
    const doc = applyTombstonesToDoc(docWithCamper(), [tomb('c1')])
    expect(readRecord(doc, 'campers', 'c1')).toBeNull()
    expect(readRecord(doc, 'elective_preferences', 'p1')).toBeNull()
    expect(readRecord(doc, 'activities', 'act')).toEqual({ name: 'Swim' })
  })

  it('a merge with a document that never had the camper keeps it gone', () => {
    const camp = A.clone(createEmptyDoc())
    const mine = applyTombstonesToDoc(docWithCamper(), [tomb('c1')])
    expect(readRecord(A.merge(camp, mine), 'campers', 'c1')).toBeNull()
  })
})

// R4b — today's result, pinned: one side deletes a record, the other concurrently edits one of its
// fields. Automerge keeps the concurrent edit, so the record comes back holding ONLY that field.
describe('edit vs delete across a merge (current behaviour)', () => {
  it('a field edited offline survives the other side\'s delete; the rest of the record stays deleted', () => {
    const base = applyWrites(A.clone(createEmptyDoc()), [
      { entity: 'activities', entity_id: 'act', field: 'name', value: 'Swim' },
      { entity: 'activities', entity_id: 'act', field: 'location', value: 'Lake' },
    ])
    const camp = applyWrites(A.clone(base), [{ entity: 'activities', entity_id: 'act', field: DELETE_FIELD, value: null }])
    const offline = applyWrites(A.clone(base), [{ entity: 'activities', entity_id: 'act', field: 'name', value: 'Swim (deep end)' }])
    expect(readRecord(A.merge(camp, offline), 'activities', 'act')).toEqual({ name: 'Swim (deep end)' })
  })
})
