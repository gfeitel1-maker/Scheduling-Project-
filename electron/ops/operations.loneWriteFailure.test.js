// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// THE SECOND DIRECTION.
//
// docs/current/WHERE_DATA_LIVES.md lists this as open: "A document write can
// fail on its own — appendOp catches it and logs. The edit is in A, not B. Your
// change silently reverts at the next sync, or a new row disappears."
//
// The rollback direction is fixed (#367). This file measures the other one, and
// it is a MEASUREMENT, not a fix: it asserts what actually happens today so the
// cost is on the record before anyone decides what it is worth.
//
// Injection happens at `applyWrite`, the layer that actually runs — spying on
// `recordLocalWrite` replaces the queueing function and exercises none of this
// (learned the hard way in #367).
vi.mock('../automerge/campDocument.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, applyWrite: vi.fn(actual.applyWrite) }
})

import { openLocalDb } from '../db/localDb.js'
import { appendOp, runAtomic } from './operations.js'
import { applyWrite, readRecord } from '../automerge/campDocument.js'
import { projectAll } from '../automerge/projector.js'
import { setUserDataDirGetter, resetForTests, getDocIfLoaded, flushPendingWrites } from '../sync/automerge/liveDoc.js'

let userDataDir, tmpFile, db

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-lone-fail-'))
  setUserDataDirGetter(() => userDataDir)
  tmpFile = path.join(os.tmpdir(), `shoresh-lone-fail-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
})

afterEach(() => {
  vi.mocked(applyWrite).mockRestore?.()
  resetForTests()
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

const write = (id, field, value) =>
  appendOp(db, {
    entity: 'groups', entity_id: id, field, value,
    author_user_id: null, device_id: 'device-1', parent_op_id: null, client_write_id: null,
  })

// Fail the NEXT applyWrite whose value matches, and only that one.
function failWriteOf(value) {
  const real = vi.mocked(applyWrite).getMockImplementation()
  let fired = 0
  vi.mocked(applyWrite).mockImplementation((doc, args) => {
    if (args?.value === value && fired === 0) {
      fired += 1
      throw new Error('document write failed')
    }
    return real(doc, args)
  })
  return () => fired
}

describe('a document write that fails on its own (WHERE_DATA_LIVES.md, open gap)', () => {
  it('MEASUREMENT: an edited field reverts at the next projection', () => {
    runAtomic(db, () => { write('g1', 'name', 'Original') })
    flushPendingWrites()
    expect(readRecord(getDocIfLoaded(db), 'groups', 'g1').name).toBe('Original')

    // The director renames the group. SQLite takes it; the document does not.
    const fired = failWriteOf('Renamed')
    runAtomic(db, () => { write('g1', 'name', 'Renamed') })
    flushPendingWrites()
    expect(fired(), 'the injected failure never ran — this test would prove nothing').toBe(1)

    // The screen shows the new name. Nothing errored. This is what the director sees.
    expect(db.prepare('SELECT name FROM groups WHERE id = ?').get('g1').name).toBe('Renamed')
    expect(readRecord(getDocIfLoaded(db), 'groups', 'g1').name).toBe('Original')

    // Then anything at all causes a projection — their next edit, or a sync.
    projectAll(db, getDocIfLoaded(db))

    // The rename is gone. No error, no flag, no trace.
    expect(db.prepare('SELECT name FROM groups WHERE id = ?').get('g1').name).toBe('Original')
  })

  it('MEASUREMENT: a newly created record disappears entirely', () => {
    runAtomic(db, () => { write('keep', 'name', 'Existing group') })
    flushPendingWrites()

    const fired = failWriteOf('Brand new group')
    runAtomic(db, () => { write('new', 'name', 'Brand new group') })
    flushPendingWrites()
    expect(fired()).toBe(1)

    // It is on screen.
    expect(db.prepare('SELECT id FROM groups ORDER BY id').all().map((r) => r.id)).toEqual(['keep', 'new'])

    projectAll(db, getDocIfLoaded(db))

    // It is not any more. delete-reconcile removes any row the document lacks.
    expect(db.prepare('SELECT id FROM groups ORDER BY id').all().map((r) => r.id)).toEqual(['keep'])
  })

  it('MEASUREMENT: nothing records that it happened', () => {
    // The op-log still says the write succeeded, because for SQLite it did.
    // projection_failures — the table built for exactly this shape of problem —
    // is not written by this path. So there is no durable trace to find later,
    // and `repairProjectionForEntity` replays the op-log into SQLite, which
    // would restore the row while leaving the document still missing it.
    const fired = failWriteOf('Doomed')
    runAtomic(db, () => { write('g2', 'name', 'Doomed') })
    flushPendingWrites()
    expect(fired()).toBe(1)

    expect(db.prepare("SELECT COUNT(*) n FROM operations WHERE entity_id = 'g2'").get().n).toBe(1)
    expect(db.prepare('SELECT COUNT(*) n FROM projection_failures').get().n).toBe(0)
  })
})
