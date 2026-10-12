// @vitest-environment node
//
// T375 (keeper ruling 2026-10-11): whether a deletion was the director rejecting a row, or an undo
// of an import ("as if the import never happened"), must be visible on EVERY device, because it
// decides whether a re-import of the same file brings the row back (isHumanDeleted, which drives
// fixed-event re-import suppression and the T219 bundle tombstone). Two devices, one genesis:
// device A deletes, device B merges A's document and records the merge in its history ledger the
// way syncNode does, and B's isHumanDeleted is asked.
import { describe, it, expect, afterEach } from 'vitest'
import * as A from '@automerge/automerge'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { createEmptyDoc, applyWrite } from './campDocument.js'
import { appendReceivedOps } from './historyLedger.js'
import { synthesizeOpEvents } from '../sync/automerge/docDiffEvents.js'
import { isHumanDeleted } from '../ops/fieldProvenance.js'
import { DELETE_FIELD } from '../ops/operations.js'

const ID = 'act-pottery'
afterEach(() => cleanupTemplatedDbs())

function deviceBAfterADeletes(deleteWrite) {
  const genesis = applyWrite(applyWrite(createEmptyDoc(), { entity: 'activities', entity_id: ID, field: 'name', value: 'Pottery' }),
    { entity: 'activities', entity_id: ID, field: 'camp_id', value: 'camp-1' })
  const docA = applyWrite(A.clone(genesis), { entity: 'activities', entity_id: ID, field: DELETE_FIELD, value: null, ...deleteWrite })
  const docB = A.clone(genesis)
  const before = A.getHeads(docB)
  const merged = A.merge(docB, docA)
  const { db } = openTemplatedDb()
  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp-1', 'Camp', ?)").run('a'.repeat(64))
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES ('u1', 'camp-1', 'Ruth', 'h', 's', 'admin')").run()
  db.prepare("INSERT INTO devices (id, name, libp2p_peer_id) VALUES ('device-a', 'A', 'peer-a')").run()
  const events = synthesizeOpEvents(merged, before, A.getHeads(merged))
  // Positive control: B did receive A's delete as a change.
  expect(events.some((e) => e.entity === 'activities' && e.entity_id === ID && e.field === DELETE_FIELD)).toBe(true)
  appendReceivedOps(db, events, { fromPeerId: 'peer-a', doc: merged })
  return db
}

describe('a deletion made on another device', () => {
  it("is a rejection on this device when it was the director's own delete", () => {
    const db = deviceBAfterADeletes({ source: 'human', author_user_id: 'u1' })
    expect(isHumanDeleted(db, 'activities', ID)).toBe(true)
  })

  it('is not a rejection on this device when it was an undo of an import', () => {
    const db = deviceBAfterADeletes({ source: 'undo', author_user_id: 'u1' })
    expect(isHumanDeleted(db, 'activities', ID)).toBe(false)
  })

  it('is not a rejection when it was an import teardown (no source)', () => {
    const db = deviceBAfterADeletes({ author_user_id: 'u1' })
    expect(isHumanDeleted(db, 'activities', ID)).toBe(false)
  })
})
