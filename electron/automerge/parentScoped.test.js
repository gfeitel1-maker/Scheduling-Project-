// @vitest-environment node
//
// Parent-scoped entities slice (docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md,
// Stage 5 continuation): widens the Automerge document layer to the 11 PARENT_SCOPED_ENTITIES
// (electron/ops/campScopedEntities.js), including template_slots — the schedule itself, and the
// only bulk-replace entity. Without this, Stage 6 (retiring the op-log) would stop every
// schedule/snapshot/event/special-day/elective/week-exclusion from syncing.
//
// Document shape: the 10 simple parent-scoped join/child tables use the SAME flat
// doc[entity][row_id] = {field: value} shape the 14 camp-scoped entities already use — each row's
// parent key (week_id/special_day_id/elective_set_id/event_id) is just an ordinary field, so
// applyWrite/applyProjection/delete-reconcile all work completely unchanged.
//
// template_slots is different: it ALSO gets a second, separate document collection,
// `doc.template_slots_scopes[template_id]`, mirroring operations.js's own two-primitive design for
// this one table (appendOp/applyProjection for individual cell edits vs. appendBulkReplaceOp/
// applyBulkReplaceProjection for a wholesale "replace every row for this template" regenerate).
// A bulk-replace scope value is a single JSON-string map value — a plain Automerge map key, not a
// nested collaborative list — so two concurrent regenerates of the SAME template are a genuine
// per-key LWW conflict (one deterministic winner, both values inspectable via A.getConflicts), NOT
// a row-level union of two different schedules. See the "concurrent regenerate" describe block
// below for the explicit, asserted proof of what that produces.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as A from '@automerge/automerge'
import { DELETE_FIELD } from '../ops/operations.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { appendOp, appendBulkReplaceOp } from '../ops/operations.js'
import { PARENT_SCOPED_ENTITIES, DOMAIN_SNAPSHOT_ORDER } from '../ops/campScopedEntities.js'
import { PROJECTIONS } from '../ops/projections.js'
import {
  createEmptyDoc,
  applyWrite,
  applyBulkReplace,
  MODELED_ENTITIES,
  BULK_REPLACE_MODELED_ENTITIES, readRecord, listRecordIds } from './campDocument.js'
import { projectEntity, projectAll, rebuildFromDoc } from './projector.js'
import { seedDocFromSqlite, seedAllFromSqlite } from './seed.js'

let files = []
function freshDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-parentscoped-${tag}-${Date.now()}-${Math.random()}.sqlite`)
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

let db
beforeEach(() => { db = freshDb('main') })
afterEach(() => {
  try { db.close() } catch { /* already closed */ }
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  files = []
})

describe('parent-scoped entities — modeled set includes all 11 PARENT_SCOPED_ENTITIES', () => {
  it('MODELED_ENTITIES now includes every PARENT_SCOPED_ENTITIES key', () => {
    for (const entity of Object.keys(PARENT_SCOPED_ENTITIES)) {
      expect(MODELED_ENTITIES.has(entity)).toBe(true)
    }
  })

  it('template_slots is ALSO registered as a bulk-replace entity', () => {
    expect(BULK_REPLACE_MODELED_ENTITIES.has('template_slots')).toBe(true)
  })
})

describe('parent-scoped entities — round-trip seed -> project for each new entity', () => {
  // A minimal camp fixture: one week, one template, one group, one activity, one special day, one
  // elective set, one event — everything every parent-scoped child needs as its parent.
  function seedParents() {
    const stream = [
      { entity: 'schedule_weeks', entity_id: 'week-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'schedule_weeks', entity_id: 'week-1', field: 'name', value: 'Week 1' },
      { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'kind', value: 'manual' },
      { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'week_id', value: 'week-1' },
      { entity: 'groups', entity_id: 'group-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'groups', entity_id: 'group-1', field: 'name', value: 'Bunk 1' },
      { entity: 'activities', entity_id: 'act-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swim' },
      { entity: 'special_days', entity_id: 'sd-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'special_days', entity_id: 'sd-1', field: 'name', value: 'Color War' },
      { entity: 'elective_sets', entity_id: 'es-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'elective_sets', entity_id: 'es-1', field: 'name', value: 'Afternoon Electives' },
      { entity: 'events', entity_id: 'ev-1', field: 'camp_id', value: 'camp-1' },
      { entity: 'events', entity_id: 'ev-1', field: 'name', value: 'Visiting Day' },
    ]
    for (const w of stream) appendOp(db, { ...w, device_id: 'device-1' })
  }

  const cases = [
    { entity: 'week_activity_exclusions', id: 'wae-1', fields: { week_id: 'week-1', activity_id: 'act-1' } },
    { entity: 'week_group_exclusions', id: 'wge-1', fields: { week_id: 'week-1', group_id: 'group-1' } },
    { entity: 'special_day_time_blocks', id: 'sdtb-1', fields: { special_day_id: 'sd-1', name: 'Morning', sort_order: 0 } },
    { entity: 'special_day_slots', id: 'sds-1', fields: { special_day_id: 'sd-1', group_id: 'group-1', time_block_id: 'tb-1' } },
    { entity: 'elective_set_activities', id: 'esa-1', fields: { elective_set_id: 'es-1', activity_id: 'act-1' } },
    { entity: 'event_time_blocks', id: 'etb-1', fields: { event_id: 'ev-1', name: 'Morning', sort_order: 0 } },
    { entity: 'event_groups', id: 'eg-1', fields: { event_id: 'ev-1', name: 'Group A', sort_order: 0 } },
  ]

  for (const { entity, id, fields } of cases) {
    it(`${entity}: op-log write -> seedDocFromSqlite -> projectEntity reproduces the row`, () => {
      seedParents()
      for (const [field, value] of Object.entries(fields)) {
        appendOp(db, { entity, entity_id: id, field, value, device_id: 'device-1' })
      }
      const before = rowsOf(db, entity)
      expect(before).toHaveLength(1)

      const doc = seedDocFromSqlite(db, undefined, entity)
      // Corrupt SQLite directly, then rebuild from the doc alone.
      db.prepare(`DELETE FROM ${entity}`).run()
      expect(rowsOf(db, entity)).toEqual([])
      projectEntity(db, doc, entity)
      expect(rowsOf(db, entity)).toEqual(before)
    })
  }

  it('week_location_exclusions and event_slots (three-NOT-NULL join rows) round-trip too', () => {
    seedParents()
    appendOp(db, { entity: 'locations', entity_id: 'loc-1', field: 'camp_id', value: 'camp-1', device_id: 'device-1' })
    appendOp(db, { entity: 'locations', entity_id: 'loc-1', field: 'name', value: 'Lake', device_id: 'device-1' })
    appendOp(db, { entity: 'week_location_exclusions', entity_id: 'wle-1', field: 'week_id', value: 'week-1', device_id: 'device-1' })
    appendOp(db, { entity: 'week_location_exclusions', entity_id: 'wle-1', field: 'location_id', value: 'loc-1', device_id: 'device-1' })

    appendOp(db, { entity: 'event_groups', entity_id: 'eg-1', field: 'event_id', value: 'ev-1', device_id: 'device-1' })
    appendOp(db, { entity: 'event_time_blocks', entity_id: 'etb-1', field: 'event_id', value: 'ev-1', device_id: 'device-1' })
    appendOp(db, { entity: 'event_slots', entity_id: 'esl-1', field: 'event_id', value: 'ev-1', device_id: 'device-1' })
    appendOp(db, { entity: 'event_slots', entity_id: 'esl-1', field: 'event_group_id', value: 'eg-1', device_id: 'device-1' })
    appendOp(db, { entity: 'event_slots', entity_id: 'esl-1', field: 'time_block_id', value: 'etb-1', device_id: 'device-1' })

    let doc = createEmptyDoc()
    doc = seedDocFromSqlite(db, doc, 'week_location_exclusions')
    doc = seedDocFromSqlite(db, doc, 'event_groups')
    doc = seedDocFromSqlite(db, doc, 'event_time_blocks')
    doc = seedDocFromSqlite(db, doc, 'event_slots')

    const beforeWle = rowsOf(db, 'week_location_exclusions')
    const beforeSlots = rowsOf(db, 'event_slots')
    db.prepare('DELETE FROM week_location_exclusions').run()
    db.prepare('DELETE FROM event_slots').run()

    projectEntity(db, doc, 'week_location_exclusions')
    projectEntity(db, doc, 'event_slots')

    expect(rowsOf(db, 'week_location_exclusions')).toEqual(beforeWle)
    expect(rowsOf(db, 'event_slots')).toEqual(beforeSlots)
  })
})

describe('parent-scoped entities — FK-safe ordering, including delete-reconcile of a parent and its children together', () => {
  it('projectAll projects a week and its week_activity_exclusions child without an FK error', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'schedule_weeks', entity_id: 'week-1', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'schedule_weeks', entity_id: 'week-1', field: 'name', value: 'Week 1' })
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'act-1', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swim' })
    doc = applyWrite(doc, { entity: 'week_activity_exclusions', entity_id: 'wae-1', field: 'week_id', value: 'week-1' })
    doc = applyWrite(doc, { entity: 'week_activity_exclusions', entity_id: 'wae-1', field: 'activity_id', value: 'act-1' })

    expect(() => projectAll(db, doc)).not.toThrow()
    expect(rowsOf(db, 'week_activity_exclusions')).toEqual([{ id: 'wae-1', week_id: 'week-1', activity_id: 'act-1' }])
  })

  it('the WRONG order (child before parent) throws an FK error — proves DOMAIN_SNAPSHOT_ORDER position is load-bearing', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'act-1', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'week_activity_exclusions', entity_id: 'wae-1', field: 'week_id', value: 'week-1' })
    doc = applyWrite(doc, { entity: 'week_activity_exclusions', entity_id: 'wae-1', field: 'activity_id', value: 'act-1' })
    // Project the child directly, before schedule_weeks exists at all.
    expect(() => projectEntity(db, doc, 'week_activity_exclusions')).toThrow()
  })

  it('projectAll deletes a special_day parent and its special_day_time_blocks child together, no FK violation', () => {
    db.prepare("INSERT INTO special_days (id, camp_id, name) VALUES ('sd1', 'camp-1', 'Color War')").run()
    db.prepare(
      "INSERT INTO special_day_time_blocks (id, special_day_id, name, sort_order) VALUES ('sdtb1', 'sd1', 'Morning', 0)"
    ).run()

    // The doc omits both — represents "both deleted" coherently in one replay. Carries one
    // unrelated row so it isn't a wholly-empty doc (assertDocIsSupersetOrEmpty guard).
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'keep-1', field: 'camp_id', value: 'camp-1' })

    expect(() => projectAll(db, doc)).not.toThrow()
    expect(db.prepare('SELECT * FROM special_days WHERE id = ?').get('sd1')).toBeUndefined()
    expect(db.prepare('SELECT * FROM special_day_time_blocks WHERE id = ?').get('sdtb1')).toBeUndefined()
  })

  it('DOMAIN_SNAPSHOT_ORDER position sanity: every PARENT_SCOPED_ENTITIES key appears after its parentTable', () => {
    // schedule_snapshots is deliberately excluded from DOMAIN_SNAPSHOT_ORDER itself (campScopedEntities.js's
    // own comment: unbounded historical growth over a season, a full_sync-payload concern) — the
    // projector positions it separately (projector.js's DOMAIN_ORDER_WITH_SNAPSHOTS), so it is
    // excluded from this particular sanity check on the raw array.
    const indexOf = (e) => DOMAIN_SNAPSHOT_ORDER.indexOf(e)
    for (const [entity, { parentTable }] of Object.entries(PARENT_SCOPED_ENTITIES)) {
      if (entity === 'schedule_snapshots') continue
      expect(indexOf(entity)).toBeGreaterThan(indexOf(parentTable))
    }
  })
})

describe('parent-scoped entities — two nodes converging on parent-scoped rows', () => {
  it('two devices each writing a different week_group_exclusions row converge to both, no data loss', () => {
    let base = createEmptyDoc()
    base = applyWrite(base, { entity: 'schedule_weeks', entity_id: 'week-1', field: 'camp_id', value: 'camp-1' })
    base = applyWrite(base, { entity: 'groups', entity_id: 'g1', field: 'camp_id', value: 'camp-1' })
    base = applyWrite(base, { entity: 'groups', entity_id: 'g2', field: 'camp_id', value: 'camp-1' })

    let a = A.clone(base)
    let b = A.clone(base)
    a = applyWrite(a, { entity: 'week_group_exclusions', entity_id: 'wge-a', field: 'week_id', value: 'week-1' })
    a = applyWrite(a, { entity: 'week_group_exclusions', entity_id: 'wge-a', field: 'group_id', value: 'g1' })
    b = applyWrite(b, { entity: 'week_group_exclusions', entity_id: 'wge-b', field: 'week_id', value: 'week-1' })
    b = applyWrite(b, { entity: 'week_group_exclusions', entity_id: 'wge-b', field: 'group_id', value: 'g2' })

    const merged = A.merge(A.clone(a), b)
    expect(listRecordIds(merged, 'week_group_exclusions')).toEqual(['wge-a', 'wge-b'])
    expect(readRecord(merged, 'week_group_exclusions', 'wge-a').group_id).toBe('g1')
    expect(readRecord(merged, 'week_group_exclusions', 'wge-b').group_id).toBe('g2')
  })
})

describe('template_slots bulk-replace — field-level edits still use the ordinary flat shape', () => {
  it('applyWrite works normally for template_slots (individual cell edit), same as any other modeled entity', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'template_slots', entity_id: 'slot-1', field: 'template_id', value: 'tpl-1' })
    doc = applyWrite(doc, { entity: 'template_slots', entity_id: 'slot-1', field: 'activity_id', value: 'act-1' })
    expect(readRecord(doc, 'template_slots', 'slot-1')).toEqual({ template_id: 'tpl-1', activity_id: 'act-1' })
  })
})

describe('template_slots bulk-replace — the wholesale-regenerate primitive', () => {
  function rows(templateId, n, prefix) {
    return Array.from({ length: n }, (_, i) => ({
      id: `${prefix}-${i}`,
      template_id: templateId,
      group_id: null,
      activity_id: null,
      day_id: null,
      time_block_id: null,
    }))
  }

  it('applyBulkReplace writes ALL rows for a scope atomically into template_slots_scopes', () => {
    let doc = createEmptyDoc()
    doc = applyBulkReplace(doc, { entity: 'template_slots', scope_id: 'tpl-1', rows: rows('tpl-1', 3, 'r') })
    const stored = JSON.parse(doc.template_slots_scopes['tpl-1'])
    expect(stored).toHaveLength(3)
    expect(stored.map((r) => r.id)).toEqual(['r-0', 'r-1', 'r-2'])
  })

  it('a single-device projectAll materializes exactly the bulk-replaced rows in SQLite', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'kind', value: 'manual' })
    doc = applyWrite(doc, { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'camp_id', value: 'camp-1' })
    doc = applyBulkReplace(doc, { entity: 'template_slots', scope_id: 'tpl-1', rows: rows('tpl-1', 5, 'r') })

    expect(() => projectAll(db, doc)).not.toThrow()
    const stored = rowsOf(db, 'template_slots')
    expect(stored.map((r) => r.id).sort()).toEqual(['r-0', 'r-1', 'r-2', 'r-3', 'r-4'])
  })

  it('a SECOND bulk-replace on the same device fully replaces the first (old rows gone, new rows present)', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'kind', value: 'manual' })
    doc = applyWrite(doc, { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'camp_id', value: 'camp-1' })
    doc = applyBulkReplace(doc, { entity: 'template_slots', scope_id: 'tpl-1', rows: rows('tpl-1', 3, 'gen1') })
    projectAll(db, doc)
    expect(rowsOf(db, 'template_slots').map((r) => r.id).sort()).toEqual(['gen1-0', 'gen1-1', 'gen1-2'])

    doc = applyBulkReplace(doc, { entity: 'template_slots', scope_id: 'tpl-1', rows: rows('tpl-1', 2, 'gen2') })
    projectAll(db, doc)
    expect(rowsOf(db, 'template_slots').map((r) => r.id).sort()).toEqual(['gen2-0', 'gen2-1'])
  })

  it('deleting the template (scope removed from the doc entirely) cascades: projectAll removes its template_slots rows', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'kind', value: 'manual' })
    doc = applyWrite(doc, { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'camp_id', value: 'camp-1' })
    doc = applyBulkReplace(doc, { entity: 'template_slots', scope_id: 'tpl-1', rows: rows('tpl-1', 3, 'r') })
    projectAll(db, doc)
    expect(rowsOf(db, 'template_slots')).toHaveLength(3)

    // Delete the template row AND drop its scope entry from the doc — the caller's job when
    // deleting a template is to omit both, exactly like any other parent+child coherent delete.
    // Carries one unrelated row so it isn't a WHOLLY empty doc (assertDocIsSupersetOrEmpty guard —
    // see the analogous "keep-1" activity in generalize.test.js's parent+child delete test).
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'keep-1', field: 'camp_id', value: 'camp-1' })
    // Deleting a record is applyWrite's DELETE_FIELD path — under one key per
    // field there is no single container to `delete`, so the record's field
    // keys are removed together. The scope entry is still a plain key.
    doc = applyWrite(doc, { entity: 'schedule_templates', entity_id: 'tpl-1', field: DELETE_FIELD, value: 1 })
    doc = A.change(doc, (d) => {
      delete d.template_slots_scopes['tpl-1']
    })
    expect(() => projectAll(db, doc)).not.toThrow()
    expect(rowsOf(db, 'template_slots')).toEqual([])
    expect(db.prepare('SELECT * FROM schedule_templates WHERE id = ?').get('tpl-1')).toBeUndefined()
  })

  it('parity: op-log appendBulkReplaceOp and doc applyBulkReplace project byte-identically', () => {
    const dbA = freshDb('bulk-oplog')
    const dbB = freshDb('bulk-doc')
    const templateRows = rows('tpl-1', 4, 'p').map((r, i) => ({ ...r, group_id: i % 2 === 0 ? 'g1' : null }))

    appendOp(dbA, { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'kind', value: 'manual', device_id: 'device-1' })
    appendOp(dbA, { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'camp_id', value: 'camp-1', device_id: 'device-1' })
    appendOp(dbA, { entity: 'groups', entity_id: 'g1', field: 'camp_id', value: 'camp-1', device_id: 'device-1' })
    appendBulkReplaceOp(dbA, { entity: 'template_slots', scope_id: 'tpl-1', rows: templateRows.map((r) => ({ ...r, group_id: r.group_id, day_id: null, time_block_id: null, activity_id: null })), device_id: 'device-1' })

    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'kind', value: 'manual' })
    doc = applyWrite(doc, { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'groups', entity_id: 'g1', field: 'camp_id', value: 'camp-1' })
    doc = applyBulkReplace(doc, { entity: 'template_slots', scope_id: 'tpl-1', rows: templateRows })
    projectAll(dbB, doc)

    expect(rowsOf(dbB, 'template_slots')).toEqual(rowsOf(dbA, 'template_slots'))
    dbA.close()
    dbB.close()
  })

  describe('the hard part: concurrent regenerate of the SAME template on two devices', () => {
    it('converges to exactly ONE full generation in SQLite — never a union/mix of both devices\' rows', () => {
      let base = createEmptyDoc()
      base = applyWrite(base, { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'kind', value: 'manual' })
      base = applyWrite(base, { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'camp_id', value: 'camp-1' })

      let a = A.clone(base)
      let b = A.clone(base)
      // Two directors, on two devices, BOTH regenerate the same template concurrently, before
      // either has seen the other's write. Different row ids (fresh UUIDs in real usage).
      a = applyBulkReplace(a, { entity: 'template_slots', scope_id: 'tpl-1', rows: rows('tpl-1', 4, 'deviceA') })
      b = applyBulkReplace(b, { entity: 'template_slots', scope_id: 'tpl-1', rows: rows('tpl-1', 3, 'deviceB') })

      const merged = A.merge(A.clone(a), b)
      const winningRows = JSON.parse(merged.template_slots_scopes['tpl-1'])
      const winningIds = winningRows.map((r) => r.id).sort()
      // The winner is EXACTLY one generation's full row set — 4 deviceA rows or 3 deviceB rows —
      // never some other count (a union would be 7).
      const isExactlyA = winningIds.length === 4 && winningIds.every((id) => id.startsWith('deviceA'))
      const isExactlyB = winningIds.length === 3 && winningIds.every((id) => id.startsWith('deviceB'))
      expect(isExactlyA || isExactlyB).toBe(true)

      // Project the merged doc: SQLite must hold exactly the winning generation, not a mix.
      expect(() => projectAll(db, merged)).not.toThrow()
      const projected = rowsOf(db, 'template_slots').map((r) => r.id).sort()
      expect(projected).toEqual(winningIds)
    })

    it('BOTH competing generations remain inspectable via A.getConflicts, for a future resolution UI', () => {
      let base = createEmptyDoc()
      base = applyWrite(base, { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'kind', value: 'manual' })
      let a = A.clone(base)
      let b = A.clone(base)
      a = applyBulkReplace(a, { entity: 'template_slots', scope_id: 'tpl-1', rows: rows('tpl-1', 2, 'deviceA') })
      b = applyBulkReplace(b, { entity: 'template_slots', scope_id: 'tpl-1', rows: rows('tpl-1', 2, 'deviceB') })
      const merged = A.merge(A.clone(a), b)

      const conflicts = A.getConflicts(merged.template_slots_scopes, 'tpl-1')
      const parsedValues = Object.values(conflicts).map((v) => JSON.parse(v).map((r) => r.id).sort())
      expect(parsedValues).toContainEqual(['deviceA-0', 'deviceA-1'])
      expect(parsedValues).toContainEqual(['deviceB-0', 'deviceB-1'])
    })
  })
})

describe('scale: a realistic-size schedule (hundreds of slots) seeds and projects correctly', () => {
  it('480 slots (max schedule grid size) round-trip through seed -> corrupt -> rebuildFromDoc', () => {
    appendOp(db, { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'kind', value: 'manual', device_id: 'device-1' })
    appendOp(db, { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'camp_id', value: 'camp-1', device_id: 'device-1' })

    const bigRows = Array.from({ length: 480 }, (_, i) => ({
      id: `slot-${i}`,
      template_id: 'tpl-1',
      group_id: null,
      activity_id: null,
      day_id: null,
      time_block_id: null,
      anchor_id: null,
      is_anchor: '0',
      is_span_head: '0',
      flags: null,
      elective_set_id: null,
      event_id: null,
    }))
    const t0 = Date.now()
    appendBulkReplaceOp(db, { entity: 'template_slots', scope_id: 'tpl-1', rows: bigRows, device_id: 'device-1' })
    const appendMs = Date.now() - t0

    const t1 = Date.now()
    const doc = seedAllFromSqlite(db)
    const seedMs = Date.now() - t1
    expect(rowsOf(db, 'template_slots')).toHaveLength(480)

    db.prepare('DELETE FROM template_slots').run()
    db.prepare('DELETE FROM schedule_templates').run()

    const t2 = Date.now()
    rebuildFromDoc(db, doc)
    const rebuildMs = Date.now() - t2

    expect(rowsOf(db, 'template_slots')).toHaveLength(480)
    // An O(n^2) TRIPWIRE, deliberately not a benchmark. The ceiling is very generous on purpose:
    // this suite runs with heavy parallelism and this repo's machine has been observed at load 65+,
    // where a 480-row seed measured 8.5s against an earlier 5s ceiling and failed — while passing in
    // ~1s isolated. A tight bound here does not detect algorithmic regressions, it detects machine
    // load, and a test that fails on load is a test people learn to ignore (this repo has already
    // been bitten by exactly that with a 300ms wall-clock assertion elsewhere).
    //
    // At 480 rows a genuinely pathological regression is orders of magnitude slower, not 2x, so a
    // 60s ceiling still fails loudly for the thing this is guarding against. The assertions that
    // carry the real correctness weight are the two toHaveLength(480) checks above, which are
    // timing-independent.
    const TRIPWIRE_MS = 60_000
    expect(appendMs).toBeLessThan(TRIPWIRE_MS)
    expect(seedMs).toBeLessThan(TRIPWIRE_MS)
    expect(rebuildMs).toBeLessThan(TRIPWIRE_MS)
  })
})
