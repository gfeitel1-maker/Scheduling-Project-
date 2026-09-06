// @vitest-environment node
//
// Stage 3 (docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md):
// generalizes campDocument.js/projector.js/seed.js from ONE entity
// (days_of_operation, Stage 1/2) to every entity in DIRECT_CAMP_ENTITIES —
// the simple, id-keyed, per-field camp-scoped entities. These tests prove
// the widened surface: multi-entity parity with the op-log, FK-safe
// projectAll ordering, a full seed+corrupt+rebuild round-trip across all 15
// tables, and the explicit scope boundary (which entities are refused).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { appendOp } from '../ops/operations.js'
import { DIRECT_CAMP_ENTITIES } from '../ops/campScopedEntities.js'
import { PROJECTIONS } from '../ops/projections.js'
import { createEmptyDoc, applyWrite } from './campDocument.js'
import { projectEntity, projectAll, rebuildFromDoc } from './projector.js'
import { seedDocFromSqlite, seedAllFromSqlite } from './seed.js'

let files = []
function freshDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-stage3-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  const db = openLocalDb(f)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  return db
}
function rowsOf(db, entity) {
  const fields = PROJECTIONS[entity].fields
  return db.prepare(`SELECT id, ${fields.join(', ')} FROM ${entity} ORDER BY id`).all()
}
// Dump every modeled entity's table as a { entity: rows[] } map, for a
// whole-camp comparison.
function snapshotAll(db) {
  const out = {}
  for (const entity of DIRECT_CAMP_ENTITIES) out[entity] = rowsOf(db, entity)
  return out
}

let db
beforeEach(() => { db = freshDb('main') })
afterEach(() => {
  try { db.close() } catch { /* already closed */ }
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  files = []
})

describe('Stage 3 — modeled entity set is pinned to DIRECT_CAMP_ENTITIES', () => {
  it('the modeled set (createEmptyDoc keys) equals DIRECT_CAMP_ENTITIES exactly', () => {
    const doc = createEmptyDoc()
    expect(Object.keys(doc).sort()).toEqual([...DIRECT_CAMP_ENTITIES].sort())
  })
})

describe('Stage 3 — scope guard: refuses non-DIRECT_CAMP entities', () => {
  it('applyWrite throws for compound_cell_decisions (host-only)', () => {
    const doc = createEmptyDoc()
    expect(() =>
      applyWrite(doc, { entity: 'compound_cell_decisions', entity_id: 'x', field: 'anything', value: 1 })
    ).toThrow()
  })

  it('applyWrite throws for template_slots (bulk-replace entity)', () => {
    const doc = createEmptyDoc()
    expect(() =>
      applyWrite(doc, { entity: 'template_slots', entity_id: 'x', field: 'activity_id', value: 'a-1' })
    ).toThrow()
  })

  it('applyWrite throws for week_activity_exclusions (parent-scoped)', () => {
    const doc = createEmptyDoc()
    expect(() =>
      applyWrite(doc, { entity: 'week_activity_exclusions', entity_id: 'x', field: 'week_id', value: 'w-1' })
    ).toThrow()
  })

  it('projectEntity throws for the same three out-of-scope entities', () => {
    const doc = createEmptyDoc()
    expect(() => projectEntity(db, doc, 'compound_cell_decisions')).toThrow()
    expect(() => projectEntity(db, doc, 'template_slots')).toThrow()
    expect(() => projectEntity(db, doc, 'week_activity_exclusions')).toThrow()
  })

  it('seedDocFromSqlite throws for the same three out-of-scope entities', () => {
    expect(() => seedDocFromSqlite(db, undefined, 'compound_cell_decisions')).toThrow()
    expect(() => seedDocFromSqlite(db, undefined, 'template_slots')).toThrow()
    expect(() => seedDocFromSqlite(db, undefined, 'week_activity_exclusions')).toThrow()
  })
})

describe('Stage 3 — multi-entity parity with the op-log (load-bearing)', () => {
  it('a mixed write stream across several entities projects byte-identically via op-log vs. Automerge', () => {
    const dbA = freshDb('parity-oplog') // Path A: real op-log
    const dbB = freshDb('parity-doc') // Path B: Automerge doc -> projector
    let doc = createEmptyDoc()

    const stream = [
      { entity: 'cohorts', entity_id: 'cohort-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'cohorts', entity_id: 'cohort-1', field: 'name', value: 'Session A' },
      { entity: 'days_of_operation', entity_id: 'day-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'days_of_operation', entity_id: 'day-1', field: 'label', value: 'Monday' },
      { entity: 'groups', entity_id: 'group-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'groups', entity_id: 'group-1', field: 'name', value: 'Bunk 1' },
      { entity: 'tiers', entity_id: 'tier-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'tiers', entity_id: 'tier-1', field: 'cohort_id', value: 'cohort-1' },
      { entity: 'tiers', entity_id: 'tier-1', field: 'name', value: 'Senior' },
      { entity: 'time_blocks', entity_id: 'tb-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'time_blocks', entity_id: 'tb-1', field: 'cohort_id', value: 'cohort-1' },
      { entity: 'time_blocks', entity_id: 'tb-1', field: 'name', value: 'Period 1' },
      { entity: 'activities', entity_id: 'act-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swim' },
      { entity: 'locations', entity_id: 'loc-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'locations', entity_id: 'loc-1', field: 'name', value: 'Lake' },
      { entity: 'anchor_activities', entity_id: 'anchor-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'anchor_activities', entity_id: 'anchor-1', field: 'cohort_id', value: 'cohort-1' },
      { entity: 'anchor_activities', entity_id: 'anchor-1', field: 'day_id', value: 'day-1' },
      { entity: 'anchor_activities', entity_id: 'anchor-1', field: 'name', value: 'Flag' },
      { entity: 'groups', entity_id: 'group-1', field: 'name', value: 'Bunk 1 (renamed)' }, // update-in-place
      { entity: 'tiers', entity_id: 'tier-1', field: '__deleted__', value: 1 }, // delete
    ]

    for (const w of stream) {
      appendOp(dbA, { ...w, device_id: 'device-1' })
      doc = applyWrite(doc, w)
    }
    projectAll(dbB, doc)

    for (const entity of ['cohorts', 'days_of_operation', 'groups', 'tiers', 'time_blocks', 'activities', 'locations', 'anchor_activities']) {
      expect(rowsOf(dbB, entity)).toEqual(rowsOf(dbA, entity))
    }
    // Concrete final state, not just "both equal" — tiers should be empty
    // (deleted), groups should show the rename.
    expect(rowsOf(dbA, 'tiers')).toEqual([])
    expect(rowsOf(dbA, 'groups')[0].name).toBe('Bunk 1 (renamed)')

    dbA.close()
    dbB.close()
  })
})

describe('Stage 3 — FK-safe projectAll ordering', () => {
  it('projects an entity that references another (anchor_activities -> cohorts/days_of_operation) without an FK error', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'cohorts', entity_id: 'cohort-1', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'cohorts', entity_id: 'cohort-1', field: 'name', value: 'Session A' })
    doc = applyWrite(doc, { entity: 'days_of_operation', entity_id: 'day-1', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'days_of_operation', entity_id: 'day-1', field: 'label', value: 'Monday' })
    doc = applyWrite(doc, { entity: 'tiers', entity_id: 'tier-1', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'tiers', entity_id: 'tier-1', field: 'cohort_id', value: 'cohort-1' })
    doc = applyWrite(doc, { entity: 'time_blocks', entity_id: 'tb-1', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'time_blocks', entity_id: 'tb-1', field: 'cohort_id', value: 'cohort-1' })
    doc = applyWrite(doc, { entity: 'anchor_activities', entity_id: 'anchor-1', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'anchor_activities', entity_id: 'anchor-1', field: 'cohort_id', value: 'cohort-1' })
    doc = applyWrite(doc, { entity: 'anchor_activities', entity_id: 'anchor-1', field: 'day_id', value: 'day-1' })
    doc = applyWrite(doc, { entity: 'anchor_activities', entity_id: 'anchor-1', field: 'name', value: 'Flag' })

    expect(() => projectAll(db, doc)).not.toThrow()
    expect(rowsOf(db, 'anchor_activities')).toEqual([
      { id: 'anchor-1', camp_id: 'camp-1', cohort_id: 'cohort-1', day_id: 'day-1', time_block_id: null, name: 'Flag', is_all_groups: 1, group_ids: null, notes: null, schedule_week_id: null, recurrence_level: 'daily', location_id: null, span_blocks: null, kind: 'fixed' },
    ])
  })

  it('the WRONG order throws an FK error — proving DOMAIN_SNAPSHOT_ORDER is load-bearing, not incidental', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'cohorts', entity_id: 'cohort-1', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'tiers', entity_id: 'tier-1', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'tiers', entity_id: 'tier-1', field: 'cohort_id', value: 'cohort-1' })
    // Project tiers BEFORE cohorts exists -> FK violation.
    expect(() => projectEntity(db, doc, 'tiers')).toThrow()
  })
})

describe('Stage 3 — full-camp rebuildFromDoc round-trip (SQLite is disposable)', () => {
  it('seedAllFromSqlite -> corrupt SQLite -> rebuildFromDoc(db, doc) restores every modeled table identically', () => {
    // Seed a mini-camp across several tables via the REAL op-log.
    const stream = [
      { entity: 'cohorts', entity_id: 'cohort-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'cohorts', entity_id: 'cohort-1', field: 'name', value: 'Session A' },
      { entity: 'days_of_operation', entity_id: 'day-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'days_of_operation', entity_id: 'day-1', field: 'label', value: 'Monday' },
      { entity: 'groups', entity_id: 'group-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'groups', entity_id: 'group-1', field: 'name', value: 'Bunk 1' },
      { entity: 'tiers', entity_id: 'tier-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'tiers', entity_id: 'tier-1', field: 'cohort_id', value: 'cohort-1' },
      { entity: 'tiers', entity_id: 'tier-1', field: 'name', value: 'Senior' },
      { entity: 'time_blocks', entity_id: 'tb-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'time_blocks', entity_id: 'tb-1', field: 'cohort_id', value: 'cohort-1' },
      { entity: 'activities', entity_id: 'act-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swim' },
      { entity: 'locations', entity_id: 'loc-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'locations', entity_id: 'loc-1', field: 'name', value: 'Lake' },
      { entity: 'anchor_activities', entity_id: 'anchor-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'anchor_activities', entity_id: 'anchor-1', field: 'cohort_id', value: 'cohort-1' },
      { entity: 'anchor_activities', entity_id: 'anchor-1', field: 'day_id', value: 'day-1' },
      { entity: 'anchor_activities', entity_id: 'anchor-1', field: 'name', value: 'Flag' },
    ]
    for (const w of stream) appendOp(db, { ...w, device_id: 'device-1' })

    const before = snapshotAll(db)
    const doc = seedAllFromSqlite(db)

    // Corrupt SQLite: junk rows + mangled fields, directly, bypassing the op-log.
    db.prepare("INSERT INTO groups (id, camp_id, name) VALUES ('junk-group', 'camp-1', 'GARBAGE')").run()
    db.prepare("UPDATE activities SET name = 'WRONG' WHERE id = 'act-1'").run()
    db.prepare("DELETE FROM anchor_activities WHERE id = 'anchor-1'").run()

    rebuildFromDoc(db, doc) // no entity arg -> full-camp rebuild

    expect(snapshotAll(db)).toEqual(before)
  })
})
