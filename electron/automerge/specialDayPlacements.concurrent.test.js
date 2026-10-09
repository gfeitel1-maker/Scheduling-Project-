// @vitest-environment node
//
// T350 slice 1 — docs/adr/2026-10-09-special-day-binds-to-a-week-day.md D2 and D5.
// Two documents forked from one state, merged both ways, projected into SQLite.
import { describe, it, expect, afterEach } from 'vitest'
import * as A from '@automerge/automerge'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { DELETE_FIELD } from '../ops/operations.js'
import { PROJECTIONS } from '../ops/projections.js'
import { deriveSpecialDayPlacementId } from '../ops/electiveDerivedIds.js'
import { createEmptyDoc, applyWrite, readRecord } from './campDocument.js'
import { projectAll } from './projector.js'
import { reconcile } from './reconcile.js'
import { recordConflicts } from './conflictStore.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s)
  }
})

function freshDb() {
  const f = path.join(os.tmpdir(), `shoresh-sdp-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  const db = openLocalDb(f)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  return db
}

const W = (doc, entity, entity_id, field, value) => applyWrite(doc, { entity, entity_id, field, value })
const DAY = 'day:camp-1:2'
const PID = deriveSpecialDayPlacementId('week-1', DAY)

function bind(doc, specialDayId, weekId = 'week-1') {
  const id = deriveSpecialDayPlacementId(weekId, DAY)
  doc = W(doc, 'special_day_placements', id, 'week_id', weekId)
  doc = W(doc, 'special_day_placements', id, 'day_id', DAY)
  return W(doc, 'special_day_placements', id, 'special_day_id', specialDayId)
}
const unbind = (doc, id = PID) => W(doc, 'special_day_placements', id, DELETE_FIELD, 1)

function base() {
  let d = createEmptyDoc()
  d = W(d, 'schedule_weeks', 'week-1', 'camp_id', 'camp-1')
  d = W(d, 'schedule_weeks', 'week-1', 'name', 'Week 1')
  for (const sd of ['sd-a', 'sd-b']) {
    d = W(d, 'special_days', sd, 'camp_id', 'camp-1')
    d = W(d, 'special_days', sd, 'name', sd)
  }
  return bind(d, 'sd-a')
}

function project(doc) {
  const db = freshDb()
  recordConflicts(db, reconcile(doc).conflicts)
  const failures = projectAll(db, doc)
  return { db, failures }
}
const placements = (db) => db.prepare('SELECT id, week_id, day_id, special_day_id FROM special_day_placements').all()
const failureRows = (db) => db.prepare('SELECT COUNT(*) c FROM projection_failures').get().c

describe('special_day_placements: two-document convergence (ADR D5)', () => {
  it('unbind on A vs rebind on B converges to a complete row with B\'s special day (add-wins)', () => {
    const b0 = base()
    const a = unbind(A.clone(b0))
    const b = bind(A.clone(b0), 'sd-b')
    const ab = A.merge(A.clone(a), b)
    const ba = A.merge(A.clone(b), a)
    expect(readRecord(ab, 'special_day_placements', PID)).toEqual(readRecord(ba, 'special_day_placements', PID))
    expect(readRecord(ab, 'special_day_placements', PID)).toEqual({ week_id: 'week-1', day_id: DAY, special_day_id: 'sd-b' })
    for (const doc of [ab, ba]) {
      const { db, failures } = project(doc)
      expect(failures).toEqual([])
      expect(placements(db)).toEqual([{ id: PID, week_id: 'week-1', day_id: DAY, special_day_id: 'sd-b' }])
      db.close()
    }
  })

  it('unbind on A vs an unrelated edit on B leaves the row gone on both', () => {
    const b0 = base()
    const a = unbind(A.clone(b0))
    const b = W(A.clone(b0), 'special_days', 'sd-a', 'name', 'Color War')
    for (const doc of [A.merge(A.clone(a), b), A.merge(A.clone(b), a)]) {
      const { db } = project(doc)
      expect(placements(db)).toEqual([])
      db.close()
    }
  })

  it('a partial row (special_day_id only) projects nothing and records no failure', () => {
    let d = base()
    d = unbind(d)
    d = W(d, 'special_day_placements', PID, 'special_day_id', 'sd-b')
    const { db, failures } = project(d)
    expect(failures).toEqual([])
    expect(placements(db)).toEqual([])
    expect(failureRows(db)).toBe(0)
    db.close()
  })

  it('two devices binding different special days to one day become a conflicts row', () => {
    const b0 = base()
    const merged = A.merge(bind(A.clone(b0), 'sd-b'), bind(A.clone(b0), 'sd-c'))
    const { db } = project(merged)
    const rows = db.prepare("SELECT entity, entity_id, field FROM conflicts WHERE resolved_at IS NULL").all()
    expect(rows).toEqual([{ entity: 'special_day_placements', entity_id: PID, field: 'special_day_id' }])
    db.close()
  })
})

describe('special_day_placements: doc replay never reads the op log (Red Hat R1)', () => {
  it('a partial doc row projects nothing even when the op log holds all three bind fields', () => {
    const db = freshDb()
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'D1')
    db.prepare("INSERT INTO schedule_weeks (id, camp_id, name) VALUES ('week-1', 'camp-1', 'Week 1')").run()
    const op = db.prepare(
      "INSERT INTO operations (id, entity, entity_id, field, value, device_id, timestamp) VALUES (?, 'special_day_placements', ?, ?, ?, 'device-1', '2026-10-09')"
    )
    op.run('op-1', PID, 'week_id', 'week-1')
    op.run('op-2', PID, 'day_id', DAY)
    op.run('op-3', PID, 'special_day_id', 'sd-a')
    // The insert itself, not just the end state: delete-reconcile would also hide a bad insert.
    PROJECTIONS.special_day_placements.ensureExists(db, PID, 'special_day_id', 'sd-b', { special_day_id: 'sd-b' })
    expect(placements(db)).toEqual([])
    let d = base()
    d = unbind(d)
    d = W(d, 'special_day_placements', PID, 'special_day_id', 'sd-b')
    recordConflicts(db, reconcile(d).conflicts)
    expect(projectAll(db, d)).toEqual([])
    expect(placements(db)).toEqual([])
    db.close()
  })

  it('a row that goes partial after it was projected is removed, not left stale', () => {
    const { db } = project(base())
    expect(placements(db)).toHaveLength(1)
    let d = base()
    d = unbind(d)
    d = W(d, 'special_day_placements', PID, 'special_day_id', 'sd-b')
    recordConflicts(db, reconcile(d).conflicts)
    expect(projectAll(db, d)).toEqual([])
    expect(placements(db)).toEqual([])
    expect(failureRows(db)).toBe(0)
    db.close()
  })
})

describe('special_day_placements: no ghost week (ADR D2)', () => {
  it('a bind in a week another device deleted leaves no week, no placement, no failure on either side', () => {
    let b0 = createEmptyDoc()
    b0 = W(b0, 'schedule_weeks', 'week-1', 'camp_id', 'camp-1')
    b0 = W(b0, 'schedule_weeks', 'week-1', 'name', 'Week 1')
    b0 = W(b0, 'special_days', 'sd-a', 'camp_id', 'camp-1')
    b0 = W(b0, 'special_days', 'sd-a', 'name', 'Color War')

    const a = W(A.clone(b0), 'schedule_weeks', 'week-1', DELETE_FIELD, 1)
    const b = bind(A.clone(b0), 'sd-a')

    const dbA = freshDb()
    projectAll(dbA, a)
    const dbB = freshDb()
    projectAll(dbB, b)
    expect(placements(dbB)).toHaveLength(1)

    for (const [db, doc] of [[dbA, A.merge(A.clone(a), b)], [dbB, A.merge(A.clone(b), a)]]) {
      recordConflicts(db, reconcile(doc).conflicts)
      expect(projectAll(db, doc)).toEqual([])
      expect(db.prepare('SELECT COUNT(*) c FROM schedule_weeks').get().c).toBe(0)
      expect(placements(db)).toEqual([])
      expect(failureRows(db)).toBe(0)
      db.close()
    }
  })
})
