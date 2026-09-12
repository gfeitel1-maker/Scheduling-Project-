// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openLocalDb } from '../db/localDb.js'
import { appendOp, runAtomic } from './operations.js'
import { readRecord } from '../automerge/campDocument.js'
import {
  setUserDataDirGetter,
  resetForTests,
  getDocIfLoaded,
  flushPendingWrites,
} from '../sync/automerge/liveDoc.js'

// THE INVARIANT UNDER TEST
//
// `commitPlan` states the promise this file exists to protect
// (electron/ops/ingest.js:1441): "Any throw below rolls back every op and every
// projected row together, so the camp is either fully imported or untouched."
//
// That promise is kept for SQLite and for the `operations` ledger, which share
// one transaction. It is NOT kept for the Automerge document — the store
// PLATFORM_STATE.md:41 calls "the source of truth replicated between devices."
//
// WHY. `appendOp` runs its own `db.transaction()` and then, once that returns,
// writes the document (operations.js:167-174) on the stated belief that the
// op-log write "has already committed and returned by the time this runs."
// When `appendOp` is called INSIDE another transaction — which every
// multi-write caller does (ingest.js:1444, deleteRecord.js:375/497,
// deleteWeek.js:48, deleteEvent.js:51, deleteSpecialDay.js:36,
// deleteElectiveSet.js:39, duplicateWeek.js:61, restore.js:287) — that belief
// is false. better-sqlite3 nests transactions as SAVEPOINTs, which ingest.js
// itself relies on (:1446, "better-sqlite3 nests as savepoints, so the one
// outer transaction stays the rollback boundary"). The savepoint releases; the
// outer transaction is still open and uncommitted.
//
// So an import that fails partway rolls SQLite back and tells the director
// nothing was imported, while the document keeps every write. The next
// `projectAll` — which runs after every local change and every incoming merge
// (syncNode.js:85, :461) — makes SQLite match the document again and writes the
// abandoned import back in. Work the director was told was discarded returns.
//
// The debounce in liveDoc.js is not a mitigation: only the SAVE to disk is
// deferred. `applyWrite` mutates the in-memory document immediately, and the
// in-memory document is what projectAll and sync read.
//
// THE FIX. An Automerge document cannot be rolled back, so it is not written
// until the outermost transaction has COMMITTED — `runAtomic` (operations.js)
// buffers document writes for the duration and drops them on a throw. Every
// multi-write op path goes through it; the guard at the bottom of this file
// keeps it that way.
let userDataDir
let tmpFile
let db

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-txn-boundary-'))
  setUserDataDirGetter(() => userDataDir)
  tmpFile = path.join(os.tmpdir(), `shoresh-txn-boundary-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
})

afterEach(() => {
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

describe('appendOp inside an outer transaction — the rollback boundary', () => {
  it('leaves NOTHING in the document when the outer transaction rolls back', () => {
    // A committed write FIRST, so the document genuinely exists. Without it the
    // assertions below pass vacuously against a null document — and proving the
    // failed job leaves an EXISTING document untouched is the stronger claim
    // anyway: the buffer must drop only its own writes, never earlier ones.
    runAtomic(db, () => { writeGroup('g0', 'Already here') })
    flushPendingWrites()
    expect(readRecord(getDocIfLoaded(db), 'groups', 'g0').name).toBe('Already here')

    expect(() => runAtomic(db, () => {
      writeGroup('g1', 'Bunk A')
      writeGroup('g2', 'Bunk B')
      throw new Error('import failed partway, as commitPlan is designed to do')
    })).toThrow('import failed partway')
    flushPendingWrites()

    // SQLite and the op-log rolled back to the committed write — this half
    // already worked before the fix.
    expect(db.prepare('SELECT id FROM groups').all().map((r) => r.id)).toEqual(['g0'])
    expect(db.prepare("SELECT DISTINCT entity_id FROM operations WHERE entity = 'groups'").all().map((r) => r.entity_id)).toEqual(['g0'])

    // The document must roll back with them. It is the authoritative store:
    // anything left here is written BACK into SQLite by the next projectAll.
    // NOT guarded by `if (doc)`. An earlier draft wrote
    // `getDocIfLoaded('camp-1')` — the function takes the DB, not a camp id —
    // so it returned null and the assertion never ran. The test passed while
    // measuring nothing. The two control cases below are what caught it.
    const doc = getDocIfLoaded(db)
    expect(doc, 'the document should exist — otherwise this test proves nothing').toBeTruthy()
    expect(readRecord(doc, 'groups', 'g0').name).toBe('Already here')
    expect(readRecord(doc, 'groups', 'g1')).toBeNull()
    expect(readRecord(doc, 'groups', 'g2')).toBeNull()
  })

  it('still records a committed outer transaction in all three stores', () => {
    // The guard against "fix it by never writing the document" — the fix must
    // preserve the working case, not trade one asymmetry for another.
    runAtomic(db, () => { writeGroup('g3', 'Bunk C') })
    flushPendingWrites()

    expect(db.prepare('SELECT name FROM groups WHERE id = ?').get('g3').name).toBe('Bunk C')
    expect(db.prepare("SELECT COUNT(*) n FROM operations WHERE entity_id = 'g3'").get().n).toBe(1)
    expect(readRecord(getDocIfLoaded(db), 'groups', 'g3').name).toBe('Bunk C')
  })

  it('only the OUTERMOST boundary releases — a nested job cannot flush early', () => {
    // deleteRecord's cascade calls deleteWeek's, which is why this matters: if
    // an inner runAtomic flushed on its own commit, the bug would simply move
    // one level down and the outer rollback would leave the inner writes behind.
    runAtomic(db, () => { writeGroup('g0', 'Already here') })
    flushPendingWrites()

    expect(() => runAtomic(db, () => {
      runAtomic(db, () => { writeGroup('g5', 'Inner') })
      throw new Error('outer failed after the inner one succeeded')
    })).toThrow('outer failed')
    flushPendingWrites()

    expect(db.prepare('SELECT id FROM groups').all().map((r) => r.id)).toEqual(['g0'])
    expect(readRecord(getDocIfLoaded(db), 'groups', 'g5')).toBeNull()
  })

  it('buffers per database, never process-wide', () => {
    // The same discipline docRegistry/broadcastCallbacks already use in
    // liveDoc.js, for the reason documented there: integration scenarios run
    // two devices in ONE process, and shared global state made one device's
    // node serve the other's writes (scenario 30). A global depth counter would
    // repeat it — device A's rollback discarding device B's buffer.
    const otherFile = path.join(os.tmpdir(), `shoresh-txn-other-${Date.now()}-${Math.random()}.sqlite`)
    const other = openLocalDb(otherFile)
    try {
      other.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-2', 'Device Two')
      other.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-2', 'Camp Two')

      // Device B commits a write while device A is mid-transaction and failing.
      expect(() => runAtomic(db, () => {
        writeGroup('gA', 'Device A, doomed')
        runAtomic(other, () => {
          appendOp(other, {
            entity: 'groups', entity_id: 'gB', field: 'name', value: 'Device B, fine',
            author_user_id: null, device_id: 'device-2', parent_op_id: null, client_write_id: null,
          })
        })
        throw new Error('device A rolls back')
      })).toThrow('device A rolls back')
      flushPendingWrites()

      // A rolled back; B did not, and B's document write survived A's failure.
      expect(db.prepare('SELECT id FROM groups').all()).toEqual([])
      expect(other.prepare('SELECT id FROM groups').all().map((r) => r.id)).toEqual(['gB'])
      expect(readRecord(getDocIfLoaded(other), 'groups', 'gB').name).toBe('Device B, fine')
    } finally {
      other.close()
      if (fs.existsSync(otherFile)) fs.unlinkSync(otherFile)
    }
  })

  it('a top-level write is unaffected — it was always correct', () => {
    writeGroup('g4', 'Bunk D')
    flushPendingWrites()
    expect(db.prepare('SELECT name FROM groups WHERE id = ?').get('g4').name).toBe('Bunk D')
    expect(readRecord(getDocIfLoaded(db), 'groups', 'g4').name).toBe('Bunk D')
  })
})

// Structural guard. The fix is only as good as its adoption: a future
// multi-write path that reaches for `db.transaction` directly gets the old
// behaviour back silently, and no behavioural test would catch it because that
// path would look correct in isolation.
//
// WHAT THIS DOES NOT CATCH, stated plainly rather than implied (Red Hat):
//   - a file that opens a bare transaction around a HELPER which itself calls
//     appendOp (slotOccupants.js's clearSlotOccupant is such a helper today);
//     the new file's own source would contain no `appendOp(` to match on.
//   - a transaction built indirectly, or through a wrapper under another name.
// It is a textual check over three directories, not a call-graph proof. It
// catches the copy-paste case, which is the likely one.
describe('no write path opens its own transaction around an op append', () => {
  it('every multi-write module uses runAtomic', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const opsDir = new URL('.', import.meta.url).pathname
    // Widened past electron/ops/ (Red Hat): a new multi-write module placed
    // under automerge/ or sync/ would previously not have been scanned at all.
    const dirs = [opsDir, opsDir + '../automerge/', opsDir + '../sync/automerge/']
    // These legitimately own a bare transaction: operations.js defines runAtomic
    // and appendOp's own inner transaction; the rest write ONLY host-local
    // tables that never reach the document, so there is nothing to keep in step.
    const ALLOWED = new Set([
      'operations.js', 'confirmAlias.js', 'confirmCompoundCellPattern.js',
      'migrationReviews.js', 'openReconciliationDecisions.js', 'projectionRepair.js',
    ])
    const offenders = []
    for (const dir of dirs) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.js') || file.includes('.test.') || ALLOWED.has(file)) continue
        const src = readFileSync(dir + file, 'utf8')
        // `appendBulkReplaceOp` too (Red Hat): a file using only the bulk
        // primitive would have slipped the old `appendOp(`-only filter.
        if (!src.includes('appendOp(') && !src.includes('appendBulkReplaceOp(')) continue
        for (const [i, line] of src.split('\n').entries()) {
          const t = line.trim()
          if (line.includes('db.transaction(') && !t.startsWith('//') && !t.startsWith('*')) {
            offenders.push(`${file}:${i + 1}`)
          }
        }
      }
    }
    expect(offenders, 'use runAtomic(db, fn) so the document shares the rollback boundary').toEqual([])
  })
})
