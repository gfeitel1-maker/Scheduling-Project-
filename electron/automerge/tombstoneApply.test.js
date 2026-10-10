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
import { verifyTombstones, applyTombstonesToDoc, settleRejoinDeletes } from './tombstoneApply.js'
import { createEmptyDoc, applyWrites, readRecord, readFieldAuthor } from './campDocument.js'
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

// Keeper ruling on Pair again: a camp-side DELETE wins over the rejoining device's offline FIELD
// EDITS to the same record. A plain Automerge merge keeps the concurrent edit (the record comes back
// holding only that field); settleRejoinDeletes re-deletes it, and leaves every other record alone.
describe('edit vs delete across a Pair-again merge', () => {
  const base = () => applyWrites(A.clone(createEmptyDoc()), [
    { entity: 'activities', entity_id: 'act', field: 'name', value: 'Swim' },
    { entity: 'activities', entity_id: 'act', field: 'location', value: 'Lake' },
    { entity: 'activities', entity_id: 'other', field: 'name', value: 'Art' },
  ])
  const rejoinMerge = (camp, offline) => settleRejoinDeletes(A.clone(offline), A.merge(camp, offline))

  it('the record stays fully deleted after the rejoin merge', () => {
    const b = base()
    const camp = applyWrites(A.clone(b), [{ entity: 'activities', entity_id: 'act', field: DELETE_FIELD, value: null }])
    const offline = applyWrites(A.clone(b), [{ entity: 'activities', entity_id: 'act', field: 'name', value: 'Swim (deep end)' }])
    expect(readRecord(rejoinMerge(camp, offline), 'activities', 'act')).toBeNull()
  })

  it('also when the offline device edited every field, using the camp\'s delete marker', () => {
    const b = base()
    const camp = applyWrites(A.clone(b), [{ entity: 'activities', entity_id: 'act', field: DELETE_FIELD, value: null, author_user_id: 'dir' }])
    const offline = applyWrites(A.clone(b), [
      { entity: 'activities', entity_id: 'act', field: 'name', value: 'Swim 2' },
      { entity: 'activities', entity_id: 'act', field: 'location', value: 'Pool' },
    ])
    const out = rejoinMerge(camp, offline)
    expect(readRecord(out, 'activities', 'act')).toBeNull()
    expect(readFieldAuthor(out, 'activities', 'act', DELETE_FIELD)).toBe('dir')
  })

  it('offline edits to records the camp did not delete still merge', () => {
    const b = base()
    const camp = applyWrites(A.clone(b), [{ entity: 'activities', entity_id: 'act', field: DELETE_FIELD, value: null }])
    const offline = applyWrites(A.clone(b), [{ entity: 'activities', entity_id: 'other', field: 'name', value: 'Art & Craft' }])
    expect(readRecord(rejoinMerge(camp, offline), 'activities', 'other')).toEqual({ name: 'Art & Craft' })
  })

  it('a collection that is not a modeled entity is never touched (it would throw on write)', () => {
    const pre = A.change(base(), (d) => { d.legacy_retired = { 'r\u0000a': 1, 'r\u0000b': 2 } })
    const merged = A.change(A.clone(pre), (d) => { delete d.legacy_retired['r\u0000b'] })
    expect(() => settleRejoinDeletes(A.clone(pre), merged)).not.toThrow()
  })

  it('a record the camp deleted and then re-created is left alone', () => {
    const b = base()
    let camp = applyWrites(A.clone(b), [{ entity: 'activities', entity_id: 'act', field: DELETE_FIELD, value: null }])
    camp = applyWrites(camp, [{ entity: 'activities', entity_id: 'act', field: 'name', value: 'Swim again' }])
    const offline = A.clone(b)
    expect(readRecord(rejoinMerge(camp, offline), 'activities', 'act')).toEqual({ name: 'Swim again' })
  })
})
