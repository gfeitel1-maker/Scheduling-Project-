// Acceptance test for the atomic setup-import primitive (ADR
// 2026-09-30-format-agnostic-setup-import.md §4.9: "a fixture import with an
// injected failure on row N leaves the database byte-identical to before the
// import").
//
// RED-BEFORE-GREEN, as actually observed while building this:
//   1. importSetupRows.js was first written as a plain loop of appendOp with NO
//      runAtomic wrapper. Run against the failure fixture below, the
//      "rolls back every row" test FAILED: after the injected throw on row 3,
//      `snapshot(db)` was NOT equal to the pre-import snapshot — rows 1 and 2
//      (sunday, monday) had fully committed and row 3 had PARTIALLY committed
//      (its day_of_week + camp_id op-rows and its projection row survived up to
//      the field that threw). `expect(after).toEqual(before)` failed on both the
//      `operations` population and the `days_of_operation` population.
//   2. Wrapping the whole loop in a single runAtomic(db, () => {...}) frame made
//      that same test PASS: the throw propagates out of the runAtomic callback,
//      runAtomic's catch discards the deferred doc writes and the SQLite
//      transaction rolls back, so both tables returned byte-identical.
//
// The `non-atomic loop` test below LOCKS that discovery in permanently: it runs
// the exact same appendOp loop WITHOUT runAtomic and asserts the snapshot is
// NOT byte-identical. It is the non-vacuity proof for the atomic test's
// snapshot assertion — if the snapshot comparison could not detect a partial
// write, this test would fail.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { appendOp } from './operations.js'
import { orderFieldsForCreate, orderFieldsForWrite } from '../../src/data/setupCrudRepository.js'
import { importSetupRows } from './importSetupRows.js'

const dirs = []
function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-import-'))
  dirs.push(dir)
  const db = openLocalDb(path.join(dir, 'shoresh.sqlite'))
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('dev-1', 'Host')
  return { db, campId }
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

// Whole-population snapshot of every table this import can touch — NOT scoped to
// "the rows I expect". A WHERE naming the expected row would be blind to a
// spurious partial write the defect adds beside it.
function snapshot(db) {
  return {
    operations: db.prepare('SELECT * FROM operations ORDER BY seq').all(),
    days: db.prepare('SELECT * FROM days_of_operation ORDER BY id').all(),
  }
}

function dayCreate(campId, id, dow, sort) {
  return {
    action: 'create',
    entity: 'days_of_operation',
    entity_id: id,
    name: dow,
    fields: { camp_id: campId, label: dow, day_of_week: dow, sort_order: sort },
  }
}

// A create whose field set carries a field that is not registered on the entity
// — appendOp throws 'field not allowed for entity' when it reaches that field.
// A natural, unexpected mid-loop failure. day_of_week is present so
// orderFieldsForCreate does NOT throw first; the throw comes from appendOp,
// AFTER day_of_week + camp_id have already been written for this row.
function dayCreateThatThrows(campId, id, dow, sort) {
  return {
    action: 'create',
    entity: 'days_of_operation',
    entity_id: id,
    name: dow,
    fields: { camp_id: campId, label: dow, day_of_week: dow, sort_order: sort, not_a_real_field: 'boom' },
  }
}

// The exact appendOp loop importSetupRows runs, but WITHOUT the runAtomic frame.
// This is the "wrong" implementation the primitive replaces; kept here to prove
// the snapshot assertion is non-vacuous.
function nonAtomicImport(db, { rows, author_user_id = null, device_id }) {
  for (const row of rows) {
    const ordered = row.action === 'create'
      ? orderFieldsForCreate(row.entity, row.fields)
      : orderFieldsForWrite(row.entity, row.fields)
    for (const [field, value] of ordered) {
      if (value === undefined) continue
      appendOp(db, {
        entity: row.entity, entity_id: row.entity_id, field, value,
        author_user_id, device_id, client_write_id: randomUUID(), source: 'import',
      })
    }
  }
}

describe('importSetupRows', () => {
  it('commits a clean set and returns per-action counts', () => {
    const { db, campId } = freshDb()
    const out = importSetupRows(db, {
      device_id: 'dev-1',
      rows: [
        dayCreate(campId, 'd-sun', 'sunday', 0),
        dayCreate(campId, 'd-mon', 'monday', 1),
        dayCreate(campId, 'd-tue', 'tuesday', 2),
      ],
    })

    expect(out.ok).toBe(true)
    expect(out.created).toBe(3)
    expect(out.updated).toBe(0)
    expect(out.rowCount).toBe(3)

    // Every op-row and its projection row landed.
    expect(db.prepare('SELECT COUNT(*) c FROM days_of_operation').get().c).toBe(3)
    const mon = db.prepare('SELECT * FROM days_of_operation WHERE id = ?').get('d-mon')
    expect(mon.day_of_week).toBe('monday')
    expect(mon.camp_id).toBe(campId)
    expect(mon.sort_order).toBe(1)
    // Provenance of an import write is recorded.
    expect(db.prepare('SELECT DISTINCT source FROM operations WHERE entity = ?').get('days_of_operation').source).toBe('import')
    db.close()
  })

  it('applies both create and update actions in one atomic frame', () => {
    const { db, campId } = freshDb()
    importSetupRows(db, { device_id: 'dev-1', rows: [dayCreate(campId, 'd-sun', 'sunday', 0)] })

    const out = importSetupRows(db, {
      device_id: 'dev-1',
      rows: [
        { action: 'update', entity: 'days_of_operation', entity_id: 'd-sun', name: 'sunday', fields: { label: 'Sunday (edited)' } },
        dayCreate(campId, 'd-mon', 'monday', 1),
      ],
    })

    expect(out.ok).toBe(true)
    expect(out.created).toBe(1)
    expect(out.updated).toBe(1)
    expect(db.prepare('SELECT * FROM days_of_operation WHERE id = ?').get('d-sun').label).toBe('Sunday (edited)')
    db.close()
  })

  it('rolls back every row on an unexpected mid-set throw — snapshot byte-identical', () => {
    const { db, campId } = freshDb()
    // Pre-existing state the rollback must preserve exactly.
    importSetupRows(db, { device_id: 'dev-1', rows: [dayCreate(campId, 'd-sat', 'saturday', 9)] })
    const before = snapshot(db)

    const out = importSetupRows(db, {
      device_id: 'dev-1',
      rows: [
        dayCreate(campId, 'd-sun', 'sunday', 0),
        dayCreate(campId, 'd-mon', 'monday', 1),
        dayCreateThatThrows(campId, 'd-tue', 'tuesday', 2), // row 3 throws
      ],
    })

    const after = snapshot(db)

    // Structured failure identifying the failed row by number AND name, plus reason.
    expect(out.ok).toBe(false)
    expect(out.failedRow.number).toBe(3)
    expect(out.failedRow.name).toBe('tuesday')
    expect(out.failedRow.entity_id).toBe('d-tue')
    expect(out.reason).toMatch(/field not allowed/i)
    expect(out.created).toBe(0)
    expect(out.updated).toBe(0)

    // The whole affected population is byte-identical: no create row before N
    // survives, no partial field write of row N survives.
    expect(after).toEqual(before)
    expect(after.days).toHaveLength(1)
    expect(after.days[0].id).toBe('d-sat')
    db.close()
  })

  it('throws-nowhere discovery: a NON-ATOMIC loop leaves rows-before-N and a partial row N persisted', () => {
    const { db, campId } = freshDb()
    importSetupRows(db, { device_id: 'dev-1', rows: [dayCreate(campId, 'd-sat', 'saturday', 9)] })
    const before = snapshot(db)

    expect(() =>
      nonAtomicImport(db, {
        device_id: 'dev-1',
        rows: [
          dayCreate(campId, 'd-sun', 'sunday', 0),
          dayCreate(campId, 'd-mon', 'monday', 1),
          dayCreateThatThrows(campId, 'd-tue', 'tuesday', 2),
        ],
      })
    ).toThrow(/field not allowed/i)

    const after = snapshot(db)
    // This is the defect the primitive exists to prevent: the snapshot is NOT
    // byte-identical. sunday + monday committed, and tuesday partially
    // committed (its projection row exists before the throwing field).
    expect(after).not.toEqual(before)
    expect(after.days.map((d) => d.id).sort()).toEqual(['d-mon', 'd-sat', 'd-sun', 'd-tue'])
    db.close()
  })

  it('rolls back and reports when a row carries an unknown action', () => {
    const { db, campId } = freshDb()
    importSetupRows(db, { device_id: 'dev-1', rows: [dayCreate(campId, 'd-sat', 'saturday', 9)] })
    const before = snapshot(db)

    const out = importSetupRows(db, {
      device_id: 'dev-1',
      rows: [
        dayCreate(campId, 'd-sun', 'sunday', 0),
        // A typo'd action must NOT silently route through the update path and
        // bypass orderFieldsForCreate's ordering guard — it is a programming
        // error in the confirmed set and rolls the whole set back.
        { action: 'Create', entity: 'days_of_operation', entity_id: 'd-mon', name: 'monday', fields: { camp_id: campId, label: 'monday', day_of_week: 'monday', sort_order: 1 } },
      ],
    })

    expect(out.ok).toBe(false)
    expect(out.failedRow.number).toBe(2)
    expect(out.failedRow.name).toBe('monday')
    expect(out.reason).toMatch(/unknown action "Create"/)
    expect(snapshot(db)).toEqual(before)
    db.close()
  })

  it('rolls back when a create omits its UNIQUE field (orderFieldsForCreate throws)', () => {
    const { db, campId } = freshDb()
    importSetupRows(db, { device_id: 'dev-1', rows: [dayCreate(campId, 'd-sat', 'saturday', 9)] })
    const before = snapshot(db)

    const out = importSetupRows(db, {
      device_id: 'dev-1',
      rows: [
        dayCreate(campId, 'd-sun', 'sunday', 0),
        // Row 2: a create with day_of_week OMITTED — orderFieldsForCreate throws
        // because the UNIQUE field is absent, which rolls the set back.
        { action: 'create', entity: 'days_of_operation', entity_id: 'd-mon', name: 'monday', fields: { camp_id: campId, label: 'monday', sort_order: 1 } },
        dayCreate(campId, 'd-tue', 'tuesday', 2),
      ],
    })

    expect(out.ok).toBe(false)
    expect(out.failedRow.number).toBe(2)
    expect(out.failedRow.name).toBe('monday')
    expect(out.reason).toMatch(/must include "day_of_week"/)
    expect(snapshot(db)).toEqual(before)
    db.close()
  })

  it('rolls back on an update-action row that throws mid-set — same guarantee as a create', () => {
    const { db, campId } = freshDb()
    importSetupRows(db, { device_id: 'dev-1', rows: [dayCreate(campId, 'd-sun', 'sunday', 0)] })
    const before = snapshot(db)

    const out = importSetupRows(db, {
      device_id: 'dev-1',
      rows: [
        { action: 'update', entity: 'days_of_operation', entity_id: 'd-sun', name: 'sunday', fields: { label: 'Sunday (edited)' } },
        // Row 2: an update whose field set carries an unregistered field —
        // appendOp throws, rolling back the edit made in row 1 too.
        { action: 'update', entity: 'days_of_operation', entity_id: 'd-sun', name: 'sunday', fields: { not_a_real_field: 'boom' } },
      ],
    })

    expect(out.ok).toBe(false)
    expect(out.failedRow.number).toBe(2)
    expect(out.reason).toMatch(/field not allowed/i)
    expect(out.updated).toBe(0)
    // Row 1's edit did not survive: the label is still the original.
    expect(snapshot(db)).toEqual(before)
    expect(db.prepare('SELECT label FROM days_of_operation WHERE id = ?').get('d-sun').label).toBe('sunday')
    db.close()
  })
})
