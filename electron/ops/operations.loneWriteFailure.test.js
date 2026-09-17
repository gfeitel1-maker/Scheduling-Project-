// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'


// Discards the cached template. Per-test cleanup would rebuild the chain every time and
// undo the saving, so this runs once, at the end (T188/F2).
afterAll(() => {
  cleanupTemplatedDbs()
})
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

import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { appendOp, runAtomic } from './operations.js'
import { applyWrite, readRecord } from '../automerge/campDocument.js'
import { projectAll } from '../automerge/projector.js'
import { listDocumentWriteFailures } from './documentWriteFailures.js'
import { repairProjectionForEntity, checkProjectionHealth } from './projectionRepair.js'
import { setUserDataDirGetter, resetForTests, getDocIfLoaded, flushPendingWrites } from '../sync/automerge/liveDoc.js'

let userDataDir, tmpFile, db

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-lone-fail-'))
  setUserDataDirGetter(() => userDataDir)
  // Was openLocalDb(freshPath) — replays the whole migration chain, ~304ms per test.
  // The template copy is the database that chain produces, ~10x cheaper (T188/F2).
  const __templated = openTemplatedDb()
  db = __templated.db
  tmpFile = __templated.file
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

// Fail applyWrite for this value the first `times` attempts.
//   times = 1        -> TRANSIENT: the retry inside recordLocalWrite recovers it.
//   times = Infinity -> PERSISTENT: every attempt fails, and we fall through to
//                       the recorded-failure path.
function failWriteOf(value, times = Infinity) {
  const real = vi.mocked(applyWrite).getMockImplementation()
  let fired = 0
  vi.mocked(applyWrite).mockImplementation((doc, args) => {
    if (args?.value === value && fired < times) {
      fired += 1
      throw new Error('document write failed')
    }
    return real(doc, args)
  })
  return () => fired
}

describe('a document write that fails on its own', () => {
  it('a TRANSIENT failure loses nothing — the retry recovers it', () => {
    // The owner's question, and the right one: why does this have to lose
    // anything at all? It does not. The value is still in hand at the moment
    // the write fails, so trying again is exact rather than reconstructed.
    // Most real causes — a busy disk, a lock held while the debounced save
    // lands — clear on the next attempt.
    runAtomic(db, () => { write('g0', 'name', 'Original') })
    flushPendingWrites()

    const fired = failWriteOf('Renamed', 1) // fails once, then succeeds
    runAtomic(db, () => { write('g0', 'name', 'Renamed') })
    flushPendingWrites()
    expect(fired(), 'the injected failure never ran — this test would prove nothing').toBe(1)

    // It reached the document despite the failure, so the projection has
    // nothing to revert and nothing was recorded as lost.
    expect(readRecord(getDocIfLoaded(db), 'groups', 'g0').name).toBe('Renamed')
    projectAll(db, getDocIfLoaded(db))
    expect(db.prepare('SELECT name FROM groups WHERE id = ?').get('g0').name).toBe('Renamed')
    expect(listDocumentWriteFailures(db)).toHaveLength(0)
  })

  it('a PERSISTENT failure still reverts the edit at the next projection', () => {
    runAtomic(db, () => { write('g1', 'name', 'Original') })
    flushPendingWrites()
    expect(readRecord(getDocIfLoaded(db), 'groups', 'g1').name).toBe('Original')

    // The director renames the group. SQLite takes it; the document does not.
    const fired = failWriteOf('Renamed')
    runAtomic(db, () => { write('g1', 'name', 'Renamed') })
    flushPendingWrites()
    // 3 = DOCUMENT_WRITE_ATTEMPTS: the retry ran and gave up, which is the
    // precondition for everything this test asserts.
    expect(fired(), 'the injected failure never ran — this test would prove nothing').toBe(3)

    // The screen shows the new name. Nothing errored. This is what the director sees.
    expect(db.prepare('SELECT name FROM groups WHERE id = ?').get('g1').name).toBe('Renamed')
    expect(readRecord(getDocIfLoaded(db), 'groups', 'g1').name).toBe('Original')

    // Then anything at all causes a projection — their next edit, or a sync.
    projectAll(db, getDocIfLoaded(db))

    // The rename is gone. No error, no flag, no trace.
    expect(db.prepare('SELECT name FROM groups WHERE id = ?').get('g1').name).toBe('Original')
  })

  it('a PERSISTENT failure still loses a newly created record entirely', () => {
    runAtomic(db, () => { write('keep', 'name', 'Existing group') })
    flushPendingWrites()

    const fired = failWriteOf('Brand new group')
    runAtomic(db, () => { write('new', 'name', 'Brand new group') })
    flushPendingWrites()
    // 3 = DOCUMENT_WRITE_ATTEMPTS: the retry ran and gave up, which is the
    // precondition for everything this test asserts.
    expect(fired()).toBe(3)

    // It is on screen.
    expect(db.prepare('SELECT id FROM groups ORDER BY id').all().map((r) => r.id)).toEqual(['keep', 'new'])

    projectAll(db, getDocIfLoaded(db))

    // It is not any more. delete-reconcile removes any row the document lacks.
    expect(db.prepare('SELECT id FROM groups ORDER BY id').all().map((r) => r.id)).toEqual(['keep'])
  })

  it('is now recorded durably, and marked as a DOCUMENT failure', () => {
    // Was a MEASUREMENT asserting nothing was recorded — the third finding, and
    // the worst of them: the loss was invisible AND untraceable. The op-log
    // still says the write succeeded (for SQLite it did), so there was nothing
    // to find afterwards.
    const fired = failWriteOf('Doomed')
    runAtomic(db, () => { write('g2', 'name', 'Doomed') })
    flushPendingWrites()
    // 3 = DOCUMENT_WRITE_ATTEMPTS: the retry ran and gave up, which is the
    // precondition for everything this test asserts.
    expect(fired()).toBe(3)

    expect(db.prepare("SELECT COUNT(*) n FROM operations WHERE entity_id = 'g2'").get().n).toBe(1)

    const recorded = listDocumentWriteFailures(db)
    expect(recorded).toHaveLength(1)
    expect(recorded[0].entity).toBe('groups')
    expect(recorded[0].entity_id).toBe('g2')
    expect(recorded[0].field).toBe('name')
    expect(recorded[0].store).toBe('document')
    expect(recorded[0].resolved_at).toBeNull()
  })

  it('does NOT let the projection repair path claim it as fixed', () => {
    // The reason for the `store` column. repairProjectionForEntity replays the
    // op-log INTO SQLite. For a document failure that repair is not merely
    // useless, it is wrong: SQLite is already correct and the DOCUMENT is
    // behind, so the replay succeeds and would then mark the divergence
    // resolved — declaring fixed something that is still broken.
    const fired = failWriteOf('Doomed too')
    runAtomic(db, () => { write('g3', 'name', 'Doomed too') })
    flushPendingWrites()
    // 3 = DOCUMENT_WRITE_ATTEMPTS: the retry ran and gave up, which is the
    // precondition for everything this test asserts.
    expect(fired()).toBe(3)
    expect(listDocumentWriteFailures(db)).toHaveLength(1)

    // The projection health check must not see it as ITS kind of problem...
    expect(checkProjectionHealth(db).failures).toEqual([])
    // ...but it must be readable SOMEWHERE. check_projection_health is the only
    // manual entry point for either kind, so scoping the repair without also
    // surfacing this would have recorded the loss where nothing can read it.
    expect(listDocumentWriteFailures(db)).toHaveLength(1)

    // And repairing that entity must not resolve it.
    repairProjectionForEntity(db, 'groups', 'g3')
    const after = listDocumentWriteFailures(db)
    expect(after, 'a document failure must survive a projection repair').toHaveLength(1)
    expect(after[0].resolved_at).toBeNull()
  })
})
