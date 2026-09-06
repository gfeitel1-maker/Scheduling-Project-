// @vitest-environment node
//
// Automerge generalization slice (docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md):
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
import { createEmptyDoc, applyWrite, MODELED_ENTITIES, DEFERRED_ENTITIES } from './campDocument.js'
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

describe('Automerge generalization slice — modeled entity set is pinned to DIRECT_CAMP_ENTITIES minus DEFERRED_ENTITIES', () => {
  it('the modeled set (createEmptyDoc keys) equals DIRECT_CAMP_ENTITIES \\ DEFERRED_ENTITIES exactly', () => {
    const doc = createEmptyDoc()
    const expected = [...DIRECT_CAMP_ENTITIES].filter((e) => !DEFERRED_ENTITIES.has(e))
    expect(Object.keys(doc).sort()).toEqual(expected.sort())
    expect([...MODELED_ENTITIES].sort()).toEqual(expected.sort())
  })

  it('DEFERRED_ENTITIES is exactly {day_overrides}', () => {
    expect([...DEFERRED_ENTITIES]).toEqual(['day_overrides'])
  })
})

describe('Automerge generalization slice — scope guard: refuses non-DIRECT_CAMP entities', () => {
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

describe('Automerge generalization slice — day_overrides is refused at all three entry points (deferred, op-log-coupled)', () => {
  it('applyWrite throws for day_overrides', () => {
    const doc = createEmptyDoc()
    expect(() =>
      applyWrite(doc, { entity: 'day_overrides', entity_id: 'x', field: 'schedule_week_id', value: 'w-1' })
    ).toThrow(/deferred/)
  })

  it('projectEntity throws for day_overrides', () => {
    const doc = createEmptyDoc()
    expect(() => projectEntity(db, doc, 'day_overrides')).toThrow(/deferred/)
  })

  it('seedDocFromSqlite throws for day_overrides', () => {
    expect(() => seedDocFromSqlite(db, undefined, 'day_overrides')).toThrow(/deferred/)
  })
})

describe('Automerge generalization slice — multi-entity parity with the op-log (load-bearing)', () => {
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

describe('Automerge generalization slice — FK-safe projectAll ordering', () => {
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

describe('Automerge generalization slice — delete-reconcile runs in REVERSE FK order (BLOCKER fix)', () => {
  it('projectAll deletes a parent (cohort) and its child (tier) together without an FK violation', () => {
    // SQLite already has a cohort and a tier that references it, written
    // directly (bypassing the op-log/doc entirely, like real pre-existing data).
    db.prepare("INSERT INTO cohorts (id, camp_id, name) VALUES ('c1', 'camp-1', 'Session A')").run()
    db.prepare("INSERT INTO tiers (id, camp_id, cohort_id, name) VALUES ('t1', 'camp-1', 'c1', 'Senior')").run()

    // The document is empty for both entities — it represents "both were
    // deleted", coherently, in the same replay. Before the fix, projectAll's
    // per-entity interleaved upsert+delete ran cohorts (delete c1) BEFORE
    // tiers (delete t1), and deleting c1 while t1.cohort_id still pointed at
    // it threw under foreign_keys=ON.
    const doc = createEmptyDoc()

    expect(() => projectAll(db, doc)).not.toThrow()
    expect(db.prepare('SELECT * FROM cohorts WHERE id = ?').get('c1')).toBeUndefined()
    expect(db.prepare('SELECT * FROM tiers WHERE id = ?').get('t1')).toBeUndefined()
  })
})

describe('Automerge generalization slice — inconsistent doc is a rules-layer boundary, not a projector bug', () => {
  it('a doc whose tier references a cohort the doc never created throws, and leaves SQLite byte-identical to before the call (atomic rollback)', () => {
    // This doc is DOMAIN-INVARIANT-BROKEN by construction: doc.tiers.t1
    // references cohort_id 'c1', but doc.cohorts has no 'c1' entry at all.
    // Real writes can never produce this shape through applyWrite (a director
    // cannot reference a cohort that was never created) — this is a synthetic
    // doc standing in for what a buggy Stage-2 rules layer or a corrupted
    // sync payload could hand the projector. The projector CANNOT resolve
    // this (there is no cohort row to project), so it throws — that is
    // correct, not a defect. Guarding against ever PRODUCING such a doc is
    // the Stage-2 rules layer's job, not this projector's.
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'tiers', entity_id: 't1', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'tiers', entity_id: 't1', field: 'cohort_id', value: 'c1' })
    doc = applyWrite(doc, { entity: 'tiers', entity_id: 't1', field: 'name', value: 'Senior' })

    const before = snapshotAll(db)
    expect(() => projectAll(db, doc)).toThrow()
    // Atomicity proof: better-sqlite3 nests projectEntity's/upsertEntity's
    // inner transactions as savepoints under projectAll's outer transaction,
    // so a throw partway through unwinds ALL of it, not just the entity that
    // threw — SQLite is left exactly as it was before projectAll was called.
    expect(snapshotAll(db)).toEqual(before)
  })
})

describe('Automerge generalization slice — full-camp rebuildFromDoc round-trip (SQLite is disposable)', () => {
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
      // Code Reviewer LOW: broaden coverage beyond the original 8 entities to
      // every remaining op-log-INDEPENDENT ensureExists (day_overrides is the
      // only op-log-coupled one, and it's deferred — see campDocument.js).
      { entity: 'camp_maps', entity_id: 'map-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'camp_maps', entity_id: 'map-1', field: 'kind', value: 'outdoor' },
      { entity: 'schedule_weeks', entity_id: 'week-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'schedule_weeks', entity_id: 'week-1', field: 'name', value: 'Week 1' },
      // WRITE-ORDERING CONTRACT (projections.js schedule_templates comment):
      // `kind` must be the FIRST field written for a new row, or the
      // ensureExists stub materializes with the NOT NULL DEFAULT 'generated'
      // and a later 'manual' kind write can collide under UNIQUE(week_id, kind).
      { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'kind', value: 'manual' },
      { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'week_id', value: 'week-1' },
      { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'name', value: 'Manual v1' },
      { entity: 'special_days', entity_id: 'sd-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'special_days', entity_id: 'sd-1', field: 'name', value: 'Color War' },
      { entity: 'elective_sets', entity_id: 'es-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'elective_sets', entity_id: 'es-1', field: 'name', value: 'Afternoon Electives' },
      { entity: 'events', entity_id: 'ev-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'events', entity_id: 'ev-1', field: 'name', value: 'Visiting Day' },
    ]
    for (const w of stream) appendOp(db, { ...w, device_id: 'device-1' })

    const before = snapshotAll(db)
    const doc = seedAllFromSqlite(db)

    // Corrupt SQLite: junk rows + mangled fields, directly, bypassing the op-log.
    db.prepare("INSERT INTO groups (id, camp_id, name) VALUES ('junk-group', 'camp-1', 'GARBAGE')").run()
    db.prepare("UPDATE activities SET name = 'WRONG' WHERE id = 'act-1'").run()
    db.prepare("DELETE FROM anchor_activities WHERE id = 'anchor-1'").run()
    db.prepare("UPDATE schedule_templates SET name = 'WRONG' WHERE id = 'tpl-1'").run()
    db.prepare("DELETE FROM camp_maps WHERE id = 'map-1'").run()
    db.prepare("UPDATE special_days SET name = 'WRONG' WHERE id = 'sd-1'").run()
    db.prepare("UPDATE elective_sets SET name = 'WRONG' WHERE id = 'es-1'").run()
    db.prepare("UPDATE events SET name = 'WRONG' WHERE id = 'ev-1'").run()

    rebuildFromDoc(db, doc) // no entity arg -> full-camp rebuild

    expect(snapshotAll(db)).toEqual(before)
  })
})
