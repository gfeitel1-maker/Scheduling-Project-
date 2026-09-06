// @vitest-environment node
//
// Stage 1 (docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md): SQLite
// as a PROJECTION of an Automerge document, proven against the REAL schema
// (openLocalDb) and — the load-bearing test — proven byte-identical to the
// existing op-log projection for the same write stream. If this parity test
// passes, SQLite projected from an Automerge doc is indistinguishable from
// SQLite projected op-by-op today, for `days_of_operation`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { appendOp, DELETE_FIELD } from '../ops/operations.js'
import { STAGE1_ENTITY, createEmptyDoc, applyWrite } from './campDocument.js'
import { projectEntity, rebuildFromDoc } from './projector.js'

let files = []
function freshDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-stage1-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  const db = openLocalDb(f)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  return db
}
function daysRows(db) {
  return db.prepare('SELECT id, camp_id, label, day_of_week, sort_order FROM days_of_operation ORDER BY id').all()
}

let db
beforeEach(() => { db = freshDb('proj') })
afterEach(() => {
  try { db.close() } catch { /* already closed */ }
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  files = []
})

describe('projector — Automerge doc -> SQLite for days_of_operation', () => {
  it('projects rows present in the doc', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Monday' })
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'sort_order', value: 1 })
    projectEntity(db, doc)
    expect(daysRows(db)).toEqual([{ id: 'day-1', camp_id: 'camp-1', label: 'Monday', day_of_week: null, sort_order: 1 }])
  })

  it('is idempotent — projecting twice yields the same rows', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Monday' })
    projectEntity(db, doc)
    const once = daysRows(db)
    projectEntity(db, doc)
    expect(daysRows(db)).toEqual(once)
  })

  it('reconciles deletes — a row removed from the doc is removed from SQLite', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Monday' })
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-2', field: 'label', value: 'Tuesday' })
    projectEntity(db, doc)
    expect(daysRows(db).map((r) => r.id)).toEqual(['day-1', 'day-2'])
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: DELETE_FIELD, value: 1 })
    projectEntity(db, doc)
    expect(daysRows(db).map((r) => r.id)).toEqual(['day-2'])
  })

  it('rebuildFromDoc reproduces the table from the document ALONE (SQLite is disposable)', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Monday' })
    projectEntity(db, doc)
    const expected = daysRows(db)
    // Corrupt SQLite: insert junk + mangle the real row. The doc is untouched.
    db.prepare("INSERT INTO days_of_operation (id, camp_id, label) VALUES ('junk', 'camp-1', 'GARBAGE')").run()
    db.prepare("UPDATE days_of_operation SET label = 'WRONG' WHERE id = 'day-1'").run()
    rebuildFromDoc(db, doc)
    expect(daysRows(db)).toEqual(expected)
  })
})

describe('projector — PARITY with the op-log projection (load-bearing)', () => {
  it('the same write stream yields byte-identical SQLite via op-log and via Automerge', () => {
    // Path A: the REAL op-log — appendOp writes + projects into dbA.
    const dbA = freshDb('parity-oplog')
    // Path B: Automerge doc -> projector into dbB.
    const dbB = freshDb('parity-doc')
    let doc = createEmptyDoc()

    // One representative write stream a director could produce editing Days:
    // create two days, set every field, rename one, then delete one.
    const stream = [
      { entity_id: 'day-1', field: 'camp_id', value: 'camp-1' },
      { entity_id: 'day-1', field: 'label', value: 'Monday' },
      { entity_id: 'day-1', field: 'day_of_week', value: 1 },
      { entity_id: 'day-1', field: 'sort_order', value: 0 },
      { entity_id: 'day-2', field: 'camp_id', value: 'camp-1' },
      { entity_id: 'day-2', field: 'label', value: 'Tuesday' },
      { entity_id: 'day-2', field: 'day_of_week', value: 2 },
      { entity_id: 'day-2', field: 'sort_order', value: 1 },
      { entity_id: 'day-1', field: 'label', value: 'Mon (renamed)' }, // update-in-place
      { entity_id: 'day-2', field: DELETE_FIELD, value: 1 }, // delete
    ]

    for (const w of stream) {
      appendOp(dbA, { ...w, entity: STAGE1_ENTITY, device_id: 'device-1' })
      doc = applyWrite(doc, { ...w, entity: STAGE1_ENTITY })
    }
    projectEntity(dbB, doc)

    expect(daysRows(dbB)).toEqual(daysRows(dbA))
    // And be concrete about what that final state is, so the parity isn't
    // "both empty" or "both wrong-but-equal".
    expect(daysRows(dbA)).toEqual([
      { id: 'day-1', camp_id: 'camp-1', label: 'Mon (renamed)', day_of_week: 1, sort_order: 0 },
    ])

    dbA.close()
    dbB.close()
  })
})
