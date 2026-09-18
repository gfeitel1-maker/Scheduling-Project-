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
import { openLocalDb, getOrCreateDeviceId } from '../db/localDb.js'
import { appendOp, DELETE_FIELD } from '../ops/operations.js'
import { STAGE1_ENTITY, createEmptyDoc, applyWrite, readRecord } from './campDocument.js'
import { projectEntity, rebuildFromDoc, projectAll } from './projector.js'
import { reconcile } from './reconcile.js'
import { recordConflicts } from './conflictStore.js'

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

describe('projector — tenant guard parity (foreign camp_id is rejected, not crashed)', () => {
  it('a foreign camp_id does NOT crash and does NOT write a foreign-camp row (matches op-log)', () => {
    // Red Hat finding: the op-log's applyProjection rejects a camp_id write
    // whose value isn't this device's camp. Because the projector now reuses
    // applyProjection, it inherits that guard: a day whose only field is a
    // foreign camp_id creates no row (op-log parity), and no FK crash.
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'evil-1', field: 'camp_id', value: 'other-camp' })
    expect(() => projectEntity(db, doc)).not.toThrow()
    expect(daysRows(db)).toEqual([])
  })

  it('a valid day with a foreign camp_id write keeps the device camp (guard skips the bad write)', () => {
    // op-log: label write creates the row (device camp_id via ensureExists),
    // the foreign camp_id write is rejected -> row keeps the device camp.
    const dbA = freshDb('guard-oplog')
    const dbB = freshDb('guard-doc')
    let doc = createEmptyDoc()
    const stream = [
      { entity_id: 'day-1', field: 'label', value: 'Monday' },
      { entity_id: 'day-1', field: 'camp_id', value: 'other-camp' }, // rejected by the guard
    ]
    for (const w of stream) {
      appendOp(dbA, { ...w, entity: STAGE1_ENTITY, device_id: 'device-1' })
      doc = applyWrite(doc, { ...w, entity: STAGE1_ENTITY })
    }
    projectEntity(dbB, doc)
    expect(daysRows(dbB)).toEqual(daysRows(dbA))
    expect(daysRows(dbA)).toEqual([{ id: 'day-1', camp_id: 'camp-1', label: 'Monday', day_of_week: null, sort_order: null }])
    dbA.close(); dbB.close()
  })
})

describe('projector — a merged (conflict-resolved) document projects cleanly', () => {
  it('projects the converged value of a concurrent same-field edit', async () => {
    const A = await import('@automerge/automerge')
    let base = createEmptyDoc()
    base = applyWrite(base, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'camp_id', value: 'camp-1' })
    base = applyWrite(base, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Monday' })
    let a = A.clone(base)
    let b = A.clone(base)
    a = applyWrite(a, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Lunes' })
    b = applyWrite(b, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Montag' })
    const merged = A.merge(A.clone(a), b)

    // BEHAVIOUR CHANGE, deliberate (docs/adr/2026-09-08-crdt-conflict-reconciliation.md).
    // This test used to project straight through and assert that SQLite showed
    // whichever value Automerge picked. That IS the defect: two people set the
    // same field to different values, one of them silently loses, and both
    // screens agree on the same wrong answer. Projecting now REFUSES a document
    // carrying a conflict nobody was told about.
    expect(() => projectEntity(db, merged)).toThrow(/never recorded/)

    // Once the disagreement is recorded — which is what puts it in front of a
    // human — projection proceeds exactly as before, and SQLite still shows the
    // converged value while the conflict awaits a decision.
    const { conflicts } = reconcile(merged)
    expect(conflicts).toHaveLength(1)
    recordConflicts(db, conflicts)

    projectEntity(db, merged)
    const rows = daysRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].label).toBe(readRecord(merged, STAGE1_ENTITY, 'day-1').label)
    expect(['Lunes', 'Montag']).toContain(rows[0].label)
  })
})

describe('projector — Finding 1 regression: projectAll must never wipe live SQLite from an unseeded doc', () => {
  it('THROWS instead of deleting every row when doc is completely empty but SQLite has data (the reproduced wipe bug)', () => {
    // Reproduce the empirically-confirmed bug: a live camp db with real rows (via the REAL op-log
    // write path, not hand-inserted SQL) + a freshly createEmptyDoc() (exactly what
    // startAutomergeSyncNodeIfEnabled falls back to before Stage 5e's seeding is wired). Before the
    // fix, projectAll(db, doc) silently succeeded and deleted every row. It must now throw loudly
    // and leave every row intact.
    appendOp(db, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'camp_id', value: 'camp-1', device_id: 'device-1' })
    appendOp(db, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Monday', device_id: 'device-1' })
    expect(daysRows(db)).toHaveLength(1)

    const emptyDoc = createEmptyDoc()
    expect(() => projectAll(db, emptyDoc)).toThrow(/refusing to delete-reconcile/i)

    // The whole point: the live row survived.
    expect(daysRows(db)).toEqual([{ id: 'day-1', camp_id: 'camp-1', label: 'Monday', day_of_week: null, sort_order: null }])
  })

  it('does NOT throw when the doc genuinely is a superset (normal projection keeps working)', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: STAGE1_ENTITY, entity_id: 'day-1', field: 'label', value: 'Monday' })
    expect(() => projectAll(db, doc)).not.toThrow()
    expect(daysRows(db)).toEqual([{ id: 'day-1', camp_id: 'camp-1', label: 'Monday', day_of_week: null, sort_order: null }])
  })

  it('does NOT throw when both doc and SQLite are empty (legitimate fresh camp, nothing to protect)', () => {
    expect(() => projectAll(db, createEmptyDoc())).not.toThrow()
    expect(daysRows(db)).toEqual([])
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

// T194 round 2, H1(b). upsertCampsEntity has always contained a bad camps row
// per-row, for a stated reason: an uncaught throw aborts projectAll's ONE
// shared transaction and rolls back every OTHER entity's legitimate
// projection, so ONE unprojectable record from a paired peer permanently
// freezes the receiving device's projection. Every other entity went through
// upsertEntity, which had no such containment. This pins the general rule.
describe('projector — one unprojectable row does not abort the batch', () => {
  it('projects the good rows and skips the bad one', () => {
    let doc = createEmptyDoc()
    // A NOT NULL column explicitly set to null — the shape a malformed record
    // from a paired peer takes once it reaches the projection.
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'act-bad', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'act-bad', field: 'name', value: null })
    doc = applyWrite(doc, { entity: 'days_of_operation', entity_id: 'day-good', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'days_of_operation', entity_id: 'day-good', field: 'label', value: 'Monday' })
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'act-1', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swim' })

    expect(() => projectAll(db, doc)).not.toThrow()

    expect(db.prepare('SELECT label FROM days_of_operation WHERE id = ?').get('day-good')?.label).toBe('Monday')
    expect(db.prepare('SELECT name FROM activities WHERE id = ?').get('act-1')?.name).toBe('Swim')
  })
})

// T194 round 3 (Red Hat). The containment above is per-FIELD, not per-ROW: the try/catch sits
// INSIDE the field loop, so a row whose earlier fields succeed (creating the row via
// ensureExists) but whose LATER field throws is left PARTIALLY APPLIED in SQLite — present,
// plausible-looking, with one field silently stale — rather than cleanly absent. This plants a
// multi-field entity (elective_assignment_runs: camp_id and name are alphabetically before
// status, so both apply before the CHECK-violating status is reached) and proves the row is
// atomic: nothing left behind, one failure recorded, one log line, and every OTHER entity in the
// same pass still projects.
describe('projector — a multi-field row is atomic: a later field failing leaves no partial row', () => {
  it('rolls back the whole row, records exactly one failure, and does not abort the batch', () => {
    // Mirrors main.js's real startup order (ensureDeviceRow): this device's own row exists in
    // `devices` before any projection runs, which is what lets the failure-recording synthetic
    // op (projector.js's recordRowProjectionFailure) satisfy operations.device_id's FK.
    db.prepare('INSERT OR IGNORE INTO devices (id, name) VALUES (?, ?)').run(getOrCreateDeviceId(db), 'Self')
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'elective_assignment_runs', entity_id: 'run-bad', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'elective_assignment_runs', entity_id: 'run-bad', field: 'name', value: 'Week 1 Draft' })
    // Violates the CHECK (status IN ('draft', 'final')) — the corrupted/newer-peer-version shape
    // Red Hat named. camp_id and name are applied first (field order in PROJECTIONS.
    // elective_assignment_runs.fields), so by the time this throws, the row already exists.
    doc = applyWrite(doc, { entity: 'elective_assignment_runs', entity_id: 'run-bad', field: 'status', value: 'bogus' })
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'act-1', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'act-1', field: 'name', value: 'Swim' })

    const errors = []
    const realError = console.error
    console.error = (...args) => errors.push(args.join(' '))
    try {
      expect(() => projectAll(db, doc)).not.toThrow()
    } finally {
      console.error = realError
    }

    // No partial row: the pre-fix code left camp_id/name committed with status missing/default
    // rather than the row being wholly absent.
    expect(db.prepare('SELECT * FROM elective_assignment_runs WHERE id = ?').get('run-bad')).toBeUndefined()
    // The other entity in the same pass still projected — the batch was not aborted.
    expect(db.prepare('SELECT name FROM activities WHERE id = ?').get('act-1')?.name).toBe('Swim')
    // One log line for the row, not one per field.
    const rowErrors = errors.filter((e) => e.includes('run-bad'))
    expect(rowErrors.length).toBe(1)
    // Exactly one durable failure recorded — a dropped row must be diagnosable and repairable,
    // not console-only.
    const failures = db.prepare('SELECT * FROM projection_failures WHERE entity_id = ?').all('run-bad')
    expect(failures.length).toBe(1)
    expect(failures[0].entity).toBe('elective_assignment_runs')
    expect(failures[0].store).toBe('projection')
    expect(failures[0].resolved_at).toBeNull()
  })
})
