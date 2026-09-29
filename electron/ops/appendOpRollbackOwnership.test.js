// @vitest-environment node
//
// WHO OWNS ROLLBACK FOR ONE OP (T309, docs/adr/2026-09-29-per-op-savepoint-inside-an-atomic-boundary.md)
//
// `appendOp` makes two writes that must land together or not at all: the
// `INSERT INTO operations` row, and `applyProjection`'s write into the
// projection table. It used to guarantee that with its own `db.transaction`
// on EVERY call. Inside `runAtomic` that became a nested SAVEPOINT, and an
// open savepoint obliges SQLite to keep sub-journal undo records for every
// write made inside it — 55% of the CPU of a 100-camper import, measured.
//
// So `appendOp` now skips its inner transaction while a `runAtomic` frame is
// open, and keeps it otherwise. These tests pin BOTH halves of that, because
// the cheap wrong version of this change — dropping the inner transaction
// unconditionally — passes a performance check and breaks the second describe
// block below.
//
// THESE ARE NOT RED-THEN-GREEN TESTS. They describe behaviour that must NOT
// change, so they are green before the change too. What makes them load-
// bearing was verified separately, by planting the unconditional-removal
// version and confirming the top-level block goes red while the nested block
// stays green. A guard that cannot tell the right fix from the wrong one is
// not a guard.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openLocalDb } from '../db/localDb.js'
import { appendOp, runAtomic } from './operations.js'

let db
let dir

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-appendop-rollback-'))
  db = openLocalDb(path.join(dir, 'db.sqlite'))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
})

afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

// Make `applyProjection` fail for ONE named group, deterministically, without
// touching the module under test. A BEFORE UPDATE trigger is the idiom this
// repo already uses to block a write in a test (see
// electron/db/retireOrphanSlots.migration.test.js). UPDATE and not INSERT:
// `groups.ensureExists` inserts with `OR IGNORE`, whose conflict handling
// makes RAISE(ABORT) from an insert trigger an unreliable lever; the field
// write itself is a plain UPDATE and always fires.
function blockProjectionFor(name) {
  db.exec(`
    CREATE TRIGGER block_one_group BEFORE UPDATE ON groups
    WHEN NEW.name = '${name}'
    BEGIN SELECT RAISE(ABORT, 'projection blocked'); END
  `)
}

const writeGroup = (id, name) =>
  appendOp(db, {
    entity: 'groups', entity_id: id, field: 'name', value: name,
    author_user_id: null, device_id: 'device-1', parent_op_id: null, client_write_id: null,
  })

const opCount = (entityId) =>
  db.prepare('SELECT COUNT(*) c FROM operations WHERE entity = ? AND entity_id = ?').get('groups', entityId).c

const groupIds = () => db.prepare('SELECT id FROM groups ORDER BY id').all().map((r) => r.id)

// ---------------------------------------------------------------------------
// TOP LEVEL — appendOp is the outermost writer and still owns its own rollback.
//
// This is the half the unconditional-removal version breaks. `commitElectiveCandidates`
// in electron/ops/ingest.js is a real caller of exactly this shape: it catches an
// appendOp throw, records it, and CONTINUES its loop — and its call site runs it
// deliberately outside the commit transaction.
// ---------------------------------------------------------------------------
describe('a top-level appendOp owns rollback for its own op', () => {
  it('leaves no operations row when its projection fails', () => {
    blockProjectionFor('Bunk A')

    expect(() => writeGroup('g1', 'Bunk A')).toThrow('projection blocked')

    // Not "the projection did not apply" — the OP ROW must be gone too. An
    // operations row with no projected row is the corruption this guards.
    expect(opCount('g1')).toBe(0)
    expect(groupIds()).toEqual([])
  })

  it('a caller that catches and continues sees the failure leave nothing and the next write land', () => {
    blockProjectionFor('Doomed')
    const failed = []
    const created = []

    // commitElectiveCandidates' exact shape, with no transaction open.
    for (const [id, name] of [['g1', 'Doomed'], ['g2', 'Fine']]) {
      try {
        writeGroup(id, name)
        created.push(id)
      } catch (err) {
        failed.push({ id, message: err.message })
      }
    }

    expect(failed.map((f) => f.id)).toEqual(['g1'])
    expect(created).toEqual(['g2'])

    // The failed candidate left NOTHING — no half-written row, no orphan op.
    expect(opCount('g1')).toBe(0)
    // And the loop's later work really did commit, so this is not passing
    // vacuously against a db where nothing was written at all.
    expect(opCount('g2')).toBe(1)
    expect(groupIds()).toEqual(['g2'])
    expect(db.prepare('SELECT name FROM groups WHERE id = ?').get('g2').name).toBe('Fine')
  })
})

// ---------------------------------------------------------------------------
// NESTED — runAtomic owns rollback for the whole boundary, so a failure takes
// every op with it, not just the one that failed.
// ---------------------------------------------------------------------------
describe('inside runAtomic the boundary owns rollback for every op', () => {
  it('a projection failure on the third op rolls back the first two as well', () => {
    blockProjectionFor('Bunk C')

    expect(() => runAtomic(db, () => {
      writeGroup('g1', 'Bunk A')
      writeGroup('g2', 'Bunk B')
      writeGroup('g3', 'Bunk C') // fails here
    })).toThrow('projection blocked')

    expect(groupIds()).toEqual([])
    expect(db.prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'groups'").get().c).toBe(0)
  })

  it('an ordinary caller throw still rolls back every op in the boundary', () => {
    expect(() => runAtomic(db, () => {
      writeGroup('g1', 'Bunk A')
      writeGroup('g2', 'Bunk B')
      throw new Error('caller aborts partway')
    })).toThrow('caller aborts partway')

    expect(groupIds()).toEqual([])
    expect(db.prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'groups'").get().c).toBe(0)
  })

  it('a committed boundary keeps every op, and a later failed boundary does not disturb it', () => {
    runAtomic(db, () => {
      writeGroup('g1', 'Bunk A')
      writeGroup('g2', 'Bunk B')
    })
    expect(groupIds()).toEqual(['g1', 'g2'])

    blockProjectionFor('Bunk D')
    expect(() => runAtomic(db, () => {
      writeGroup('g3', 'Bunk C')
      writeGroup('g4', 'Bunk D')
    })).toThrow('projection blocked')

    // The earlier committed boundary is untouched — the rollback undid its own
    // frame and no more.
    expect(groupIds()).toEqual(['g1', 'g2'])
    expect(db.prepare('SELECT name FROM groups WHERE id = ?').get('g1').name).toBe('Bunk A')
  })

  it('nested runAtomic frames still roll back to the outermost boundary', () => {
    blockProjectionFor('Inner bad')

    expect(() => runAtomic(db, () => {
      writeGroup('g1', 'Outer good')
      runAtomic(db, () => {
        writeGroup('g2', 'Inner bad')
      })
    })).toThrow('projection blocked')

    expect(groupIds()).toEqual([])
  })

  it('appendOp returns to owning its own rollback after the boundary closes', () => {
    runAtomic(db, () => { writeGroup('g1', 'Bunk A') })

    // Depth must be back to zero: this top-level write is on the owning path
    // again, so its failure must leave nothing — exactly as in the first block.
    blockProjectionFor('Bunk B')
    expect(() => writeGroup('g2', 'Bunk B')).toThrow('projection blocked')
    expect(opCount('g2')).toBe(0)
    expect(groupIds()).toEqual(['g1'])
  })

  it('a thrown boundary does not leave the depth counter stuck', () => {
    expect(() => runAtomic(db, () => { throw new Error('boom') })).toThrow('boom')

    // If runAtomic leaked its depth on the throw path, appendOp would believe a
    // boundary is still open and stop owning rollback for this top-level write.
    blockProjectionFor('Bunk A')
    expect(() => writeGroup('g1', 'Bunk A')).toThrow('projection blocked')
    expect(opCount('g1')).toBe(0)
  })
})
