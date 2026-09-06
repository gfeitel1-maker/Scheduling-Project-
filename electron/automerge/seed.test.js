// @vitest-environment node
//
// Stage 2 slice 1 (docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md):
// the SAFE on-ramp for existing camp data into the Automerge document. Red Hat
// flagged the highest-severity structural gap in Stage 1: projectEntity/
// rebuildFromDoc delete any SQLite row not present in the document, so running
// them against a live camp with an EMPTY/partial document would silently delete
// real rows (and orphan convention-only referrers). seedDocFromSqlite closes
// that: it builds the document from the entity's current SQLite rows FIRST, so
// the document is the authoritative superset before any projection runs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { appendOp } from '../ops/operations.js'
import { STAGE1_ENTITY } from './campDocument.js'
import { projectEntity, rebuildFromDoc } from './projector.js'
import { seedDocFromSqlite } from './seed.js'

let files = []
function freshDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-stage2seed-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  const db = openLocalDb(f)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  return db
}
function daysRows(db) {
  return db.prepare('SELECT id, camp_id, label, day_of_week, sort_order FROM days_of_operation ORDER BY id').all()
}
// Populate days_of_operation the REAL way — through the op-log — so the seed is
// tested against data shaped exactly as the live app produces it.
function seedDaysViaOpLog(db, days) {
  for (const d of days) {
    for (const [field, value] of Object.entries(d)) {
      if (field === 'id') continue
      appendOp(db, { entity: STAGE1_ENTITY, entity_id: d.id, field, value, device_id: 'device-1' })
    }
  }
}

let db
beforeEach(() => { db = freshDb('main') })
afterEach(() => {
  try { db.close() } catch { /* already closed */ }
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  files = []
})

describe('seedDocFromSqlite — safe on-ramp for existing SQLite data', () => {
  it('builds a document from current SQLite rows that projects back byte-identically', () => {
    seedDaysViaOpLog(db, [
      { id: 'day-1', camp_id: 'camp-1', label: 'Monday', day_of_week: 1, sort_order: 0 },
      { id: 'day-2', camp_id: 'camp-1', label: 'Tuesday', day_of_week: 2, sort_order: 1 },
    ])
    const original = daysRows(db)
    const doc = seedDocFromSqlite(db)
    // Project into a SEPARATE db and confirm the rows match the source exactly.
    const db2 = freshDb('roundtrip')
    projectEntity(db2, doc)
    expect(daysRows(db2)).toEqual(original)
    db2.close()
  })

  it('THE SAFETY GUARANTEE: seed THEN rebuildFromDoc loses no data', () => {
    // This is the whole point: rebuildFromDoc wipes the table and re-derives it
    // from the doc. If the doc was seeded from SQLite first, nothing is lost.
    seedDaysViaOpLog(db, [
      { id: 'day-1', camp_id: 'camp-1', label: 'Monday', day_of_week: 1, sort_order: 0 },
      { id: 'day-2', camp_id: 'camp-1', label: 'Tuesday', day_of_week: 2, sort_order: 1 },
      { id: 'day-3', camp_id: 'camp-1', label: 'Wednesday', day_of_week: 3, sort_order: 2 },
    ])
    const before = daysRows(db)
    const doc = seedDocFromSqlite(db)
    rebuildFromDoc(db, doc) // wipes + re-derives IN PLACE
    expect(daysRows(db)).toEqual(before) // zero data loss
  })

  it('CONTRAST: rebuildFromDoc with an UNSEEDED (empty) doc would delete everything — the bug seeding prevents', () => {
    seedDaysViaOpLog(db, [{ id: 'day-1', camp_id: 'camp-1', label: 'Monday', day_of_week: 1, sort_order: 0 }])
    expect(daysRows(db)).toHaveLength(1)
    // Demonstrate the hazard explicitly so the guarantee above is meaningful:
    const empty = seedDocFromSqlite(freshDb('empty')) // a doc seeded from an EMPTY db is empty
    rebuildFromDoc(db, empty)
    expect(daysRows(db)).toEqual([]) // everything gone — which is why seeding from the RIGHT db matters
  })

  it('handles an empty table without error (empty doc, empty projection)', () => {
    const doc = seedDocFromSqlite(db)
    expect(doc[STAGE1_ENTITY]).toEqual({})
    const db2 = freshDb('empty-roundtrip')
    projectEntity(db2, doc)
    expect(daysRows(db2)).toEqual([])
    db2.close()
  })

  it('skips NULL columns (absent in the doc = column default on projection)', () => {
    // A day with only the required label set; day_of_week/sort_order NULL.
    appendOp(db, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'camp_id', value: 'camp-1', device_id: 'device-1' })
    appendOp(db, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Solo', device_id: 'device-1' })
    const doc = seedDocFromSqlite(db)
    expect(doc[STAGE1_ENTITY]['day-1']).toEqual({ camp_id: 'camp-1', label: 'Solo' })
    const db2 = freshDb('null-roundtrip')
    projectEntity(db2, doc)
    expect(daysRows(db2)).toEqual([{ id: 'day-1', camp_id: 'camp-1', label: 'Solo', day_of_week: null, sort_order: null }])
    db2.close()
  })

  it('refuses an entity outside DIRECT_CAMP_ENTITIES (explicit scope — Automerge generalization slice widened to all direct camp entities, not just days_of_operation)', () => {
    expect(() => seedDocFromSqlite(db, undefined, 'week_activity_exclusions')).toThrow()
  })
})
