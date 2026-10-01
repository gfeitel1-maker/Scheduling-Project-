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
// FLUSH — `applyWrites`, which liveDoc calls from applyLocalWritesNow (and from
// applyLocalWriteNow, a one-line alias for it). Spying on `recordLocalWrite`
// instead (the first attempt) replaced the queueing function, so nothing was ever
// buffered, the flush had nothing to apply, and the test passed while exercising
// none of this. Hence its own file: vi.mock is hoisted and file-wide.
//
// IT WAS `applyWrite` UNTIL THE BATCHED FLUSH LANDED, and that drift is why this
// is written down twice. liveDoc stopped importing applyWrite entirely, so the
// only reason the injection still fired was incidental: seeding goes through
// electron/automerge/seed.js, which does call applyWrite. The guard below stayed
// green on a failure thrown in the SEED rather than in the flush this file is
// about. WHEN THIS LAYER MOVES AGAIN, re-point the mock at whatever liveDoc
// imports from campDocument.js.
vi.mock('../automerge/campDocument.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, applyWrites: vi.fn(actual.applyWrites) }
})

import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { appendOp, runAtomic } from './operations.js'
import { applyWrites, readRecord } from '../automerge/campDocument.js'
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
  vi.mocked(applyWrites).mockRestore?.()
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
    const real = vi.mocked(applyWrites).getMockImplementation()
    let seen = 0
    vi.mocked(applyWrites).mockImplementation((doc, writes) => {
      seen += 1
      if (seen === 1) throw new Error('document write failed')
      return real(doc, writes)
    })

    expect(() => runAtomic(db, () => {
      writeGroup('g1', 'First')
      writeGroup('g2', 'Second')
    })).not.toThrow()
    flushPendingWrites()

    // Proof the injection actually ran. Without this the assertions below pass
    // for the wrong reason — the exact way the first draft of this test lied.
    expect(seen, 'applyWrites was never called — nothing was exercised').toBeGreaterThan(1)

    // SQLite committed and stays committed: the job really did succeed.
    expect(db.prepare('SELECT id FROM groups').all().map((r) => r.id).sort()).toEqual(['g1', 'g2'])

    // One failure must not truncate the rest — the later write is independent
    // and was independently applicable before deferral existed.
    expect(readRecord(getDocIfLoaded(db), 'groups', 'g2').name).toBe('Second')
  })
})
