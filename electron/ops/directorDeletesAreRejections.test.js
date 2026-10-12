// @vitest-environment node
//
// T375 (keeper ruling 2026-10-11): "every delete a director causes is a rejection, direct or
// cascaded; only undo and import teardown are not." A rejection is what stops a re-import of the
// same file bringing the row back (isHumanDeleted), on this device and, through the document's
// marker, on every other one. One test per director delete path.
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as A from '@automerge/automerge'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { appendOp, DELETE_FIELD } from './operations.js'
import { deleteRecord } from './deleteRecord.js'
import { deleteEvent } from './deleteEvent.js'
import { deleteElectiveRun } from './deleteElectiveRun.js'
import { mergeActivity, previewActivityMerge, totalActivityRefCount } from './mergeActivity.js'
import { isHumanDeleted } from './fieldProvenance.js'
import { createEmptyDoc, applyWrites } from '../automerge/campDocument.js'
import { appendReceivedOps } from '../automerge/historyLedger.js'
import { synthesizeOpEvents } from '../sync/automerge/docDiffEvents.js'

afterAll(() => cleanupTemplatedDbs())
const session = { author_user_id: 'user1', device_id: 'device1' }
let db
const write = (entity, id, field, value) => appendOp(db, { entity, entity_id: id, field, value, ...session })
function seedCamp(d) {
  d.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', ?)").run('a'.repeat(64))
  d.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES ('user1', 'camp1', 'Ruth', 'h', 's', 'admin')").run()
  d.prepare("INSERT INTO devices (id, name) VALUES ('device1', 'iPad')").run()
}
beforeEach(() => { db = openTemplatedDb().db; seedCamp(db) })

function fixedEvent(id, fields) {
  write('fixed_events', id, 'camp_id', 'camp1')
  write('fixed_events', id, 'name', id)
  for (const [f, v] of Object.entries(fields)) write('fixed_events', id, f, v)
}

describe('a director delete is a rejection on this device', () => {
  it("a group's cascade over the fixed events that targeted only it", () => {
    write('groups', 'b2', 'camp_id', 'camp1'); write('groups', 'b2', 'name', 'Badger 2')
    fixedEvent('music', { kind: 'recurring', is_all_groups: 0, group_ids: JSON.stringify(['b2']) })
    expect(deleteRecord(db, { entity: 'groups', entity_id: 'b2', ...session }).ok).toBe(true)
    expect(isHumanDeleted(db, 'fixed_events', 'music')).toBe(true)
    expect(isHumanDeleted(db, 'groups', 'b2')).toBe(true)
  })

  it('removing a day takes its fixed events with it', () => {
    write('days_of_operation', 'mon', 'camp_id', 'camp1'); write('days_of_operation', 'mon', 'label', 'Monday')
    fixedEvent('flag', { kind: 'fixed', day_id: 'mon', is_all_groups: 1 })
    const res = deleteRecord(db, { entity: 'days_of_operation', entity_id: 'mon', ...session })
    expect(res.ok).toBe(true)
    expect(isHumanDeleted(db, 'fixed_events', 'flag')).toBe(true)
    expect(isHumanDeleted(db, 'days_of_operation', 'mon')).toBe(true)
  })

  it('deleteEvent', () => {
    write('events', 'ev1', 'camp_id', 'camp1'); write('events', 'ev1', 'name', 'Trip')
    expect(deleteEvent(db, { eventId: 'ev1' }, session).error).toBeUndefined()
    expect(isHumanDeleted(db, 'events', 'ev1')).toBe(true)
  })

  it('deleteElectiveRun', () => {
    write('elective_assignment_runs', 'run1', 'camp_id', 'camp1'); write('elective_assignment_runs', 'run1', 'name', 'Week 1')
    expect(deleteElectiveRun(db, { runId: 'run1' }, session).error).toBeUndefined()
    expect(isHumanDeleted(db, 'elective_assignment_runs', 'run1')).toBe(true)
  })

  it('mergeActivity: the merged-away activity does not come back as its own activity', () => {
    for (const [id, name] of [['a1', 'Swim'], ['a2', 'Swimming']]) { write('activities', id, 'camp_id', 'camp1'); write('activities', id, 'name', name) }
    const refs = previewActivityMerge(db, { loser_id: 'a2' })
    const res = mergeActivity(db, { loser_id: 'a2', winner_id: 'a1', expected_ref_count: totalActivityRefCount(refs.refs ?? refs), ...session })
    expect(res.error).toBeUndefined()
    expect(isHumanDeleted(db, 'activities', 'a2')).toBe(true)
  })
})

describe("a group's cascade is a rejection on another device too", () => {
  it('device B reads the cascaded fixed event as rejected after merging device A', () => {
    write('groups', 'b2', 'camp_id', 'camp1'); write('groups', 'b2', 'name', 'Badger 2')
    fixedEvent('music', { kind: 'recurring', is_all_groups: 0, group_ids: JSON.stringify(['b2']) })
    const before = db.prepare('SELECT MAX(seq) AS s FROM operations').get().s
    deleteRecord(db, { entity: 'groups', entity_id: 'b2', ...session })
    // Device A's document, built from the very ops device A just wrote (as appendOp mirrors them).
    const toWrite = (rows) => rows.map((r) => ({ entity: r.entity, entity_id: r.entity_id, field: r.field, value: r.value, source: r.source ?? undefined, author_user_id: r.author_user_id }))
    const setupOps = db.prepare('SELECT * FROM operations WHERE seq <= ? ORDER BY seq').all(before).filter((r) => r.field !== DELETE_FIELD)
    const deleteOps = db.prepare('SELECT * FROM operations WHERE seq > ? ORDER BY seq').all(before)
    const genesis = applyWrites(createEmptyDoc(), toWrite(setupOps))
    const docA = applyWrites(A.clone(genesis), toWrite(deleteOps))
    const dbB = openTemplatedDb().db
    seedCamp(dbB)
    dbB.prepare("INSERT INTO devices (id, name, libp2p_peer_id) VALUES ('device-a', 'A', 'peer-a')").run()
    const docB = A.clone(genesis)
    const heads = A.getHeads(docB)
    const merged = A.merge(docB, docA)
    appendReceivedOps(dbB, synthesizeOpEvents(merged, heads, A.getHeads(merged)), { fromPeerId: 'peer-a', doc: merged })
    expect(isHumanDeleted(dbB, 'fixed_events', 'music')).toBe(true)
  })
})
