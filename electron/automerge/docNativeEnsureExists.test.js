// @vitest-environment node
//
// Doc-native ensureExists (docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md, Stage 6
// prep): seven entities' PROJECTIONS[...].ensureExists reconstructed their NOT-NULL FK columns by
// querying the `operations` table for a sibling field's prior value — the correct behavior for
// true op-log replay (one field at a time), but a dependency on a table Stage 6 removes entirely.
// PR #322's backfillOperationsForRow bridged this by writing synthetic operations rows before
// projecting a document row, which worked but kept the dependency alive.
//
// This slice makes ensureExists itself doc-native: it takes an optional `knownRow` (the full
// document row for this id, already fully known at once, unlike one-field-at-a-time op-log
// replay) and consults it BEFORE falling back to the operations query. The op-log path (appendOp,
// syncClient replay) passes no knownRow and is byte-for-byte unchanged.
//
// These tests prove the thing PR #322's bridge only worked around: project each of the seven
// entities into a FRESH database that has ZERO `operations` rows at all, using ONLY applyWrite
// (the pure doc-mutation path) — never appendOp. If ensureExists still secretly depended on the
// operations table, these rows would silently never materialize, exactly as day_overrides did
// before it was deferred.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { PROJECTIONS } from '../ops/projections.js'
import { createEmptyDoc, applyWrite, DEFERRED_ENTITIES, MODELED_ENTITIES, readRecord, listRecordIds } from './campDocument.js'
import { projectAll, rebuildFromDoc } from './projector.js'
import { seedAllFromSqlite } from './seed.js'

let files = []
function freshDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-docnative-${tag}-${Date.now()}-${Math.random()}.sqlite`)
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
function operationsCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM operations').get().n
}

let db
beforeEach(() => { db = freshDb('main') })
afterEach(() => {
  try { db.close() } catch { /* already closed */ }
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  files = []
})

// Builds a document containing every parent this test's target rows need, entirely via
// applyWrite — no appendOp, no operations rows. Every parent is included so delete-reconcile
// (which treats the doc as authoritative) doesn't remove it out from under an FK.
function docWithParents() {
  let doc = createEmptyDoc()
  const write = (entity, entity_id, field, value) => {
    doc = applyWrite(doc, { entity, entity_id, field, value })
  }
  write('schedule_weeks', 'week-1', 'camp_id', 'camp-1')
  write('schedule_weeks', 'week-1', 'name', 'Week 1')
  write('days_of_operation', 'day-1', 'camp_id', 'camp-1')
  write('days_of_operation', 'day-1', 'label', 'Monday')
  write('groups', 'group-1', 'camp_id', 'camp-1')
  write('groups', 'group-1', 'name', 'Bunk 1')
  write('activities', 'act-1', 'camp_id', 'camp-1')
  write('activities', 'act-1', 'name', 'Swim')
  write('locations', 'loc-1', 'camp_id', 'camp-1')
  write('locations', 'loc-1', 'name', 'Lake')
  write('special_days', 'sd-1', 'camp_id', 'camp-1')
  write('special_days', 'sd-1', 'name', 'Color War')
  write('elective_sets', 'es-1', 'camp_id', 'camp-1')
  write('elective_sets', 'es-1', 'name', 'Afternoon Electives')
  write('events', 'ev-1', 'camp_id', 'camp-1')
  write('events', 'ev-1', 'name', 'Visiting Day')
  write('event_groups', 'eg-1', 'event_id', 'ev-1')
  write('event_groups', 'eg-1', 'name', 'Group A')
  write('event_groups', 'eg-1', 'sort_order', 0)
  write('event_time_blocks', 'etb-1', 'event_id', 'ev-1')
  write('event_time_blocks', 'etb-1', 'name', 'Morning')
  write('event_time_blocks', 'etb-1', 'sort_order', 0)
  return () => doc
}

describe('doc-native ensureExists — seven op-log-backed entities project from a pure document, zero operations rows', () => {
  const cases = [
    {
      entity: 'week_activity_exclusions',
      id: 'wae-1',
      fields: { week_id: 'week-1', activity_id: 'act-1' },
      expected: { id: 'wae-1', week_id: 'week-1', activity_id: 'act-1' },
    },
    {
      entity: 'week_group_exclusions',
      id: 'wge-1',
      fields: { week_id: 'week-1', group_id: 'group-1' },
      expected: { id: 'wge-1', week_id: 'week-1', group_id: 'group-1' },
    },
    {
      entity: 'week_location_exclusions',
      id: 'wle-1',
      fields: { week_id: 'week-1', location_id: 'loc-1' },
      expected: { id: 'wle-1', week_id: 'week-1', location_id: 'loc-1' },
    },
    {
      entity: 'special_day_slots',
      id: 'sds-1',
      fields: { special_day_id: 'sd-1', group_id: 'group-1', time_block_id: 'tb-1' },
      expected: {
        id: 'sds-1', special_day_id: 'sd-1', group_id: 'group-1', time_block_id: 'tb-1',
        activity_id: null, location_id: null,
      },
    },
    {
      entity: 'elective_set_activities',
      id: 'esa-1',
      fields: { elective_set_id: 'es-1', activity_id: 'act-1' },
      expected: { id: 'esa-1', elective_set_id: 'es-1', activity_id: 'act-1', camper_headcount: null },
    },
    {
      entity: 'event_slots',
      id: 'esl-1',
      fields: { event_id: 'ev-1', event_group_id: 'eg-1', time_block_id: 'etb-1' },
      expected: {
        id: 'esl-1', event_id: 'ev-1', event_group_id: 'eg-1', time_block_id: 'etb-1',
        activity_id: null, location_id: null,
      },
    },
    {
      entity: 'day_overrides',
      id: 'do-1',
      fields: { camp_id: 'camp-1', schedule_week_id: 'week-1', day_id: 'day-1', group_id: 'group-1', time_block_id: 'tb-1' },
      expected: {
        id: 'do-1', camp_id: 'camp-1', schedule_week_id: 'week-1', day_id: 'day-1', group_id: 'group-1',
        time_block_id: 'tb-1', activity_id: null, kind: 'swap', note: null,
      },
    },
  ]

  for (const { entity, id, fields, expected } of cases) {
    it(`${entity}: materializes correctly via projectAll on a fresh db, and 'operations' stays empty`, () => {
      const getDoc = docWithParents()
      let doc = getDoc()
      for (const [field, value] of Object.entries(fields)) {
        doc = applyWrite(doc, { entity, entity_id: id, field, value })
      }

      expect(operationsCount(db)).toBe(0)
      expect(() => projectAll(db, doc)).not.toThrow()

      const rows = rowsOf(db, entity)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toEqual(expected)
      // Proves the op-log dependency is genuinely gone, not merely hidden: nothing this
      // projection did wrote anything to `operations`.
      expect(operationsCount(db)).toBe(0)
    })
  }

  it('day_overrides is no longer deferred', () => {
    expect(DEFERRED_ENTITIES.has('day_overrides')).toBe(false)
    expect(MODELED_ENTITIES.has('day_overrides')).toBe(true)
  })

  it('day_overrides round-trips: build via applyWrite, corrupt SQLite, rebuildFromDoc reproduces it from the document alone', () => {
    const getDoc = docWithParents()
    let doc = getDoc()
    doc = applyWrite(doc, { entity: 'day_overrides', entity_id: 'do-1', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'day_overrides', entity_id: 'do-1', field: 'schedule_week_id', value: 'week-1' })
    doc = applyWrite(doc, { entity: 'day_overrides', entity_id: 'do-1', field: 'day_id', value: 'day-1' })
    doc = applyWrite(doc, { entity: 'day_overrides', entity_id: 'do-1', field: 'group_id', value: 'group-1' })
    doc = applyWrite(doc, { entity: 'day_overrides', entity_id: 'do-1', field: 'time_block_id', value: 'tb-1' })
    doc = applyWrite(doc, { entity: 'day_overrides', entity_id: 'do-1', field: 'kind', value: 'cancel' })

    projectAll(db, doc)
    const before = rowsOf(db, 'day_overrides')
    expect(before).toHaveLength(1)
    expect(before[0].kind).toBe('cancel')

    db.prepare('DELETE FROM day_overrides').run()
    expect(rowsOf(db, 'day_overrides')).toEqual([])

    rebuildFromDoc(db, doc)
    expect(rowsOf(db, 'day_overrides')).toEqual(before)
  })
})

describe('day_overrides — two devices converge', () => {
  it('two devices each writing a different day_overrides row converge to both, no data loss', async () => {
    const A = await import('@automerge/automerge')
    let base = createEmptyDoc()
    base = applyWrite(base, { entity: 'schedule_weeks', entity_id: 'week-1', field: 'camp_id', value: 'camp-1' })
    base = applyWrite(base, { entity: 'days_of_operation', entity_id: 'day-1', field: 'camp_id', value: 'camp-1' })
    base = applyWrite(base, { entity: 'groups', entity_id: 'g1', field: 'camp_id', value: 'camp-1' })
    base = applyWrite(base, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk 1' })
    base = applyWrite(base, { entity: 'groups', entity_id: 'g2', field: 'camp_id', value: 'camp-1' })
    base = applyWrite(base, { entity: 'groups', entity_id: 'g2', field: 'name', value: 'Bunk 2' })

    let a = A.clone(base)
    let b = A.clone(base)
    a = applyWrite(a, { entity: 'day_overrides', entity_id: 'do-a', field: 'camp_id', value: 'camp-1' })
    a = applyWrite(a, { entity: 'day_overrides', entity_id: 'do-a', field: 'schedule_week_id', value: 'week-1' })
    a = applyWrite(a, { entity: 'day_overrides', entity_id: 'do-a', field: 'day_id', value: 'day-1' })
    a = applyWrite(a, { entity: 'day_overrides', entity_id: 'do-a', field: 'group_id', value: 'g1' })
    a = applyWrite(a, { entity: 'day_overrides', entity_id: 'do-a', field: 'time_block_id', value: 'tb-1' })

    b = applyWrite(b, { entity: 'day_overrides', entity_id: 'do-b', field: 'camp_id', value: 'camp-1' })
    b = applyWrite(b, { entity: 'day_overrides', entity_id: 'do-b', field: 'schedule_week_id', value: 'week-1' })
    b = applyWrite(b, { entity: 'day_overrides', entity_id: 'do-b', field: 'day_id', value: 'day-1' })
    b = applyWrite(b, { entity: 'day_overrides', entity_id: 'do-b', field: 'group_id', value: 'g2' })
    b = applyWrite(b, { entity: 'day_overrides', entity_id: 'do-b', field: 'time_block_id', value: 'tb-1' })

    const merged = A.merge(A.clone(a), b)
    expect(listRecordIds(merged, 'day_overrides')).toEqual(['do-a', 'do-b'])
    expect(readRecord(merged, 'day_overrides', 'do-a').group_id).toBe('g1')
    expect(readRecord(merged, 'day_overrides', 'do-b').group_id).toBe('g2')

    expect(() => projectAll(db, merged)).not.toThrow()
    const rows = rowsOf(db, 'day_overrides')
    expect(rows.map((r) => r.id).sort()).toEqual(['do-a', 'do-b'])
  })
})

describe('op-log path is unchanged: seedAllFromSqlite + rebuildFromDoc still work for these seven entities via real op-log writes', () => {
  it('a real op-log write (appendOp) still seeds and rebuilds correctly (regression guard)', async () => {
    const { appendOp } = await import('../ops/operations.js')
    appendOp(db, { entity: 'schedule_weeks', entity_id: 'week-1', field: 'camp_id', value: 'camp-1', device_id: 'device-1' })
    appendOp(db, { entity: 'activities', entity_id: 'act-1', field: 'camp_id', value: 'camp-1', device_id: 'device-1' })
    appendOp(db, { entity: 'week_activity_exclusions', entity_id: 'wae-1', field: 'week_id', value: 'week-1', device_id: 'device-1' })
    appendOp(db, { entity: 'week_activity_exclusions', entity_id: 'wae-1', field: 'activity_id', value: 'act-1', device_id: 'device-1' })

    const before = rowsOf(db, 'week_activity_exclusions')
    expect(before).toHaveLength(1)

    const doc = seedAllFromSqlite(db)
    db.prepare('DELETE FROM week_activity_exclusions').run()
    rebuildFromDoc(db, doc)
    expect(rowsOf(db, 'week_activity_exclusions')).toEqual(before)
  })
})
