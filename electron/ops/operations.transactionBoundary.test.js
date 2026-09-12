// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openLocalDb } from '../db/localDb.js'
import { appendOp } from './operations.js'
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
// THIS TEST IS EXPECTED TO FAIL until the document write joins the transaction
// it belongs to. It is the red half of that fix, written first on purpose.
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
    const importLike = db.transaction(() => {
      writeGroup('g1', 'Bunk A')
      writeGroup('g2', 'Bunk B')
      throw new Error('import failed partway, as commitPlan is designed to do')
    })

    expect(() => importLike()).toThrow('import failed partway')
    flushPendingWrites()

    // SQLite and the op-log rolled back — this half already works.
    expect(db.prepare('SELECT id FROM groups').all()).toEqual([])
    expect(db.prepare("SELECT id FROM operations WHERE entity = 'groups'").all()).toEqual([])

    // The document must roll back with them. It is the authoritative store:
    // anything left here is written BACK into SQLite by the next projectAll.
    // NOT guarded by `if (doc)`. An earlier draft wrote
    // `getDocIfLoaded('camp-1')` — the function takes the DB, not a camp id —
    // so it returned null and the assertion never ran. The test passed while
    // measuring nothing. The two control cases below are what caught it.
    const doc = getDocIfLoaded(db)
    expect(doc, 'the document should be loaded — otherwise this test proves nothing').toBeTruthy()
    expect(readRecord(doc, 'groups', 'g1')).toBeNull()
    expect(readRecord(doc, 'groups', 'g2')).toBeNull()
  })

  it('still records a committed outer transaction in all three stores', () => {
    // The guard against "fix it by never writing the document" — the fix must
    // preserve the working case, not trade one asymmetry for another.
    const importLike = db.transaction(() => {
      writeGroup('g3', 'Bunk C')
    })
    importLike()
    flushPendingWrites()

    expect(db.prepare('SELECT name FROM groups WHERE id = ?').get('g3').name).toBe('Bunk C')
    expect(db.prepare("SELECT COUNT(*) n FROM operations WHERE entity_id = 'g3'").get().n).toBe(1)
    expect(readRecord(getDocIfLoaded(db), 'groups', 'g3').name).toBe('Bunk C')
  })

  it('a top-level write is unaffected — it was always correct', () => {
    writeGroup('g4', 'Bunk D')
    flushPendingWrites()
    expect(db.prepare('SELECT name FROM groups WHERE id = ?').get('g4').name).toBe('Bunk D')
    expect(readRecord(getDocIfLoaded(db), 'groups', 'g4').name).toBe('Bunk D')
  })
})
