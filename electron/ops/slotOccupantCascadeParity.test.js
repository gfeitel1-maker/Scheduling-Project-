// @vitest-environment node
//
// Slot-occupant cascade parity guard.
//
// A `template_slots` row is a grid cell that can be OCCUPIED by several kinds
// of entity (an activity, an anchor, an elective set, an event) and POSITIONED
// by several more (group, day, time block). When one of those entities is
// permanently deleted, something has to happen to the referencing
// `template_slots` rows — and today that "something" is hand-written, once per
// occupant kind, in a different file each time:
//
//   activity_id -> deleteRecord.js  (clear the field to null)
//   event_id    -> deleteEvent.js   (clear the field to null)
//   group_id    -> deleteRecord.js  (delete the whole row)
//   day_id      -> deleteRecord.js  (delete the whole row)
//   elective_set_id -> deleteElectiveSet.js DELIBERATELY does nothing
//
// Nothing failed if you added a fourth occupant kind and forgot the cascade.
// This file is that failure. It scans a fully migrated db for every reference
// column on `template_slots` and requires each one to be declared in
// SLOT_OCCUPANT_CASCADES with an explicit policy and a reason — and, for the
// `clear` policy, requires the named module to actually call the shared
// clearSlotOccupant helper for that field.
//
// Same idiom as undoReferences.schemaParity.test.js: a mechanical scanner
// plus a planted-miss proof, so the guard is proven to catch a gap rather than
// merely proven to pass today.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openLocalDb } from '../db/localDb.js'
import { SLOT_OCCUPANT_CASCADES, SLOT_OCCUPANT_STRUCTURAL_COLUMNS, clearSlotOccupant } from './slotOccupants.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})
function migratedDb() {
  const file = path.join(os.tmpdir(), `shoresh-slotocc-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

function referenceColumns(db) {
  return db
    .pragma('table_info(template_slots)')
    .map((c) => c.name)
    .filter((name) => name !== 'id' && /_ids?$/.test(name))
}

const VALID_POLICIES = new Set(['clear', 'delete-row', 'dangle'])

describe('SLOT_OCCUPANT_CASCADES — registry completeness', () => {
  it('declares every reference column on a migrated template_slots', () => {
    const db = migratedDb()
    const unaccounted = referenceColumns(db).filter(
      (column) =>
        !Object.hasOwn(SLOT_OCCUPANT_CASCADES, column) &&
        !SLOT_OCCUPANT_STRUCTURAL_COLUMNS.has(column)
    )
    expect(
      unaccounted,
      'template_slots reference columns with no declared delete cascade — add an entry to SLOT_OCCUPANT_CASCADES (electron/ops/slotOccupants.js)'
    ).toEqual([])
  })

  it('proves the scanner catches a planted missing declaration', () => {
    const db = migratedDb()
    const planted = { ...SLOT_OCCUPANT_CASCADES }
    delete planted.event_id
    const unaccounted = referenceColumns(db).filter(
      (column) => !Object.hasOwn(planted, column) && !SLOT_OCCUPANT_STRUCTURAL_COLUMNS.has(column)
    )
    expect(unaccounted).toEqual(['event_id'])
  })

  it('declares no column that does not exist on a migrated template_slots', () => {
    const db = migratedDb()
    const real = new Set(db.pragma('table_info(template_slots)').map((c) => c.name))
    for (const column of Object.keys(SLOT_OCCUPANT_CASCADES)) {
      expect(real.has(column), `SLOT_OCCUPANT_CASCADES declares template_slots.${column}, which does not exist`).toBe(true)
    }
  })

  it('gives every entry a valid policy, a target entity, and a reason', () => {
    for (const [column, entry] of Object.entries(SLOT_OCCUPANT_CASCADES)) {
      expect(VALID_POLICIES.has(entry.policy), `${column}: unknown policy ${entry.policy}`).toBe(true)
      expect(typeof entry.deletedEntity, `${column}: missing deletedEntity`).toBe('string')
      expect((entry.reason ?? '').length, `${column}: missing reason`).toBeGreaterThan(20)
    }
  })
})

describe('SLOT_OCCUPANT_CASCADES — declarations match the implementations', () => {
  const sourceOf = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8')

  it('every clear-policy field is actually cleared via clearSlotOccupant in its named module', () => {
    for (const [column, entry] of Object.entries(SLOT_OCCUPANT_CASCADES)) {
      if (entry.policy !== 'clear') continue
      const src = sourceOf(entry.implementedIn)
      expect(
        src.includes('clearSlotOccupant'),
        `${entry.implementedIn} is declared as the ${column} cascade but never calls clearSlotOccupant`
      ).toBe(true)
      expect(
        src.includes(`'${column}'`),
        `${entry.implementedIn} is declared as the ${column} cascade but never names the field`
      ).toBe(true)
    }
  })

  it('preserves the deliberate elective_set_id asymmetry — deleteElectiveSet.js never touches template_slots', () => {
    expect(SLOT_OCCUPANT_CASCADES.elective_set_id.policy).toBe('dangle')
    // Its header comment explains at length WHY it leaves template_slots
    // alone, so only executable lines are checked.
    const code = sourceOf('deleteElectiveSet.js')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    expect(code).not.toContain('template_slots')
  })
})

describe('clearSlotOccupant', () => {
  const ACTOR = { author_user_id: 'u1', device_id: 'dev1' }

  function seed(db) {
    db.exec(`
      INSERT INTO camps (id, name) VALUES ('camp1', 'Camp');
      INSERT INTO devices (id, name) VALUES ('dev1', 'Device');
      INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role)
        VALUES ('u1', 'camp1', 'Alice', 'hash', 'salt', 'staff');
      INSERT INTO groups (id, camp_id, name) VALUES ('g1', 'camp1', 'A'), ('g2', 'camp1', 'B');
      INSERT INTO activities (id, camp_id, name) VALUES ('a1', 'camp1', 'Swim'), ('a2', 'camp1', 'Arts');
    `)
    db.exec(`
      INSERT INTO template_slots (id, template_id, group_id, day_id, time_block_id, activity_id, event_id)
      VALUES ('s1', 't1', 'g1', 'd1', 'b1', 'a1', 'e1'),
             ('s2', 't1', 'g1', 'd1', 'b2', 'a2', NULL),
             ('s3', 't1', 'g2', 'd1', 'b1', 'a1', NULL)
    `)
  }

  it('nulls the named field on every referencing row and returns one op each', () => {
    const db = migratedDb()
    seed(db)
    const ops = clearSlotOccupant(db, { field: 'activity_id', entityId: 'a1', ...ACTOR })

    expect(ops).toHaveLength(2)
    expect(ops.every((op) => op.entity === 'template_slots' && op.field === 'activity_id')).toBe(true)
    expect(ops.map((op) => op.entity_id).sort()).toEqual(['s1', 's3'])

    const after = db.prepare('SELECT id, activity_id FROM template_slots ORDER BY id').all()
    expect(after).toEqual([
      { id: 's1', activity_id: null },
      { id: 's2', activity_id: 'a2' },
      { id: 's3', activity_id: null },
    ])
  })

  it('is a no-op returning no ops when nothing references the entity', () => {
    const db = migratedDb()
    seed(db)
    expect(clearSlotOccupant(db, { field: 'activity_id', entityId: 'nope', ...ACTOR })).toEqual([])
  })

  it('clears only the rows the caller pre-read when rows are supplied', () => {
    const db = migratedDb()
    seed(db)
    const ops = clearSlotOccupant(db, { field: 'activity_id', entityId: 'a1', rows: [{ id: 's3' }], ...ACTOR })
    expect(ops.map((op) => op.entity_id)).toEqual(['s3'])
    expect(db.prepare("SELECT activity_id FROM template_slots WHERE id = 's1'").get().activity_id).toBe('a1')
  })

  it('refuses a field that is not a declared slot occupant', () => {
    const db = migratedDb()
    expect(() => clearSlotOccupant(db, { field: 'template_id', entityId: 't1' })).toThrow(/not a declared slot occupant/)
  })

  it('refuses a declared field whose policy is not clear', () => {
    const db = migratedDb()
    expect(() => clearSlotOccupant(db, { field: 'group_id', entityId: 'g1' })).toThrow(/policy is 'delete-row'/)
  })
})
