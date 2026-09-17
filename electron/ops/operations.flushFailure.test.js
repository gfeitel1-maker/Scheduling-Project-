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
// The failure has to be injected at the layer that actually runs during the
// FLUSH — `applyWrite`, which liveDoc calls from applyLocalWriteNow. Spying on
// `recordLocalWrite` instead (the first attempt) replaced the queueing function,
// so nothing was ever buffered, the flush had nothing to apply, and the test
// passed while exercising none of this. Hence its own file: vi.mock is hoisted
// and file-wide.
vi.mock('../automerge/campDocument.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, applyWrite: vi.fn(actual.applyWrite) }
})

import { openLocalDb } from '../db/localDb.js'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { appendOp, runAtomic } from './operations.js'
import { applyWrite, readRecord } from '../automerge/campDocument.js'
import { setUserDataDirGetter, resetForTests, getDocIfLoaded, flushPendingWrites } from '../sync/automerge/liveDoc.js'

let userDataDir, tmpFile, db

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-flush-fail-'))
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

const writeGroup = (id, name) =>
  appendOp(db, {
    entity: 'groups', entity_id: id, field: 'name', value: name,
    author_user_id: null, device_id: 'device-1', parent_op_id: null, client_write_id: null,
  })

describe('a document write that fails during the flush', () => {
  it('is contained — the committed job is not reported as failed, and later writes still land', () => {
    // Red Hat, on the first version of this fix: by flush time SQLite has
    // already COMMITTED. A throw escaping the flush reaches commitPlan's catch,
    // which re-throws anything that is not its own HELD/DRY_RUN sentinel — so
    // the director would be told the import failed while SQLite says it
    // succeeded. That is the mirror of the bug this change exists to fix.
    const real = vi.mocked(applyWrite).getMockImplementation()
    let seen = 0
    vi.mocked(applyWrite).mockImplementation((doc, args) => {
      seen += 1
      if (seen === 1) throw new Error('document write failed')
      return real(doc, args)
    })

    expect(() => runAtomic(db, () => {
      writeGroup('g1', 'First')
      writeGroup('g2', 'Second')
    })).not.toThrow()
    flushPendingWrites()

    // Proof the injection actually ran. Without this the assertions below pass
    // for the wrong reason — the exact way the first draft of this test lied.
    expect(seen, 'applyWrite was never called — nothing was exercised').toBeGreaterThan(1)

    // SQLite committed and stays committed: the job really did succeed.
    expect(db.prepare('SELECT id FROM groups').all().map((r) => r.id).sort()).toEqual(['g1', 'g2'])

    // One failure must not truncate the rest — the later write is independent
    // and was independently applicable before deferral existed.
    expect(readRecord(getDocIfLoaded(db), 'groups', 'g2').name).toBe('Second')
  })
})
