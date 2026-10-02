// @vitest-environment node
//
// discardDeferredDocWrites (electron/sync/automerge/liveDoc.js) is
// depth-aware about which queued items belong to which nesting level: each
// beginDeferredDocWrites/commitDeferredDocWrites/discardDeferredDocWrites
// records a mark (the queue length at that frame's start) on a `marks`
// stack. A discard pops its frame's mark and truncates the queue back to it
// — even when depth is still > 0 after the decrement — so an inner scope's
// discard drops only that scope's queued writes, never an enclosing scope's.
// Board: i-nested-discard-leaks-queued-doc-writes.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import {
  resetForTests,
  setUserDataDirGetter,
  beginDeferredDocWrites,
  recordLocalWrite,
  discardDeferredDocWrites,
  commitDeferredDocWrites,
  getCurrentDoc,
} from './liveDoc.js'
import { recordKey } from '../../automerge/campDocument.js'

let pendingCleanups = []

afterEach(() => {
  while (pendingCleanups.length > 0) {
    const fn = pendingCleanups.pop()
    try {
      fn()
    } catch {
      // best-effort — a failed cleanup must not mask the real test failure
    }
  }
  cleanupTemplatedDbs()
})

function setupDb() {
  const docDir = fs.mkdtempSync('/tmp/shoresh-discard-nesting-')
  resetForTests()
  setUserDataDirGetter(() => docDir)

  const templated = openTemplatedDb()
  const db = templated.db
  pendingCleanups.push(() => {
    db.close()
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(templated.file + suffix)) fs.unlinkSync(templated.file + suffix)
    }
    fs.rmSync(docDir, { recursive: true, force: true })
  })

  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Fixture', 'a'.repeat(64))

  return db
}

function writeName(db, entityId, value) {
  recordLocalWrite(db, { entity: 'activities', entity_id: entityId, field: 'name', value })
}

describe('discardDeferredDocWrites: nested discard is depth-aware', () => {
  it("an inner scope's discard drops only its own queued write; the outer commit still flushes the outer write", () => {
    const db = setupDb()
    const entityA = randomUUID()
    const entityB = randomUUID()

    beginDeferredDocWrites(db) // outer, depth=1
    writeName(db, entityA, 'A-write')

    beginDeferredDocWrites(db) // inner, depth=2
    writeName(db, entityB, 'B-write')

    discardDeferredDocWrites(db) // depth 2 -> 1; drops ONLY B's queued write
    commitDeferredDocWrites(db) // depth 1 -> 0; flushes what remains (A only)

    const doc = getCurrentDoc(db)

    expect(doc.activities?.[recordKey(entityA, 'name')]).toBe('A-write')
    expect(doc.activities?.[recordKey(entityB, 'name')]).toBeUndefined()
  })

  it('an inner scope that COMMITS (not discards) lets both writes survive the outer commit', () => {
    const db = setupDb()
    const entityA = randomUUID()
    const entityB = randomUUID()

    beginDeferredDocWrites(db) // outer, depth=1
    writeName(db, entityA, 'A-write')

    beginDeferredDocWrites(db) // inner, depth=2
    writeName(db, entityB, 'B-write')

    commitDeferredDocWrites(db) // depth 2 -> 1; inner items stay queued for the outer frame
    commitDeferredDocWrites(db) // depth 1 -> 0; flushes both

    const doc = getCurrentDoc(db)

    expect(doc.activities?.[recordKey(entityA, 'name')]).toBe('A-write')
    expect(doc.activities?.[recordKey(entityB, 'name')]).toBe('B-write')
  })

  it('discarding the outermost scope drops everything queued, including nested writes committed up into it', () => {
    const db = setupDb()
    const entityA = randomUUID()
    const entityB = randomUUID()

    beginDeferredDocWrites(db) // outer, depth=1
    writeName(db, entityA, 'A-write')

    beginDeferredDocWrites(db) // inner, depth=2
    writeName(db, entityB, 'B-write')
    commitDeferredDocWrites(db) // depth 2 -> 1; B's write stays queued for the outer frame

    discardDeferredDocWrites(db) // depth 1 -> 0; drops EVERYTHING still queued

    const doc = getCurrentDoc(db)

    // Nothing was ever applied, so the document may never have been created.
    expect(doc?.activities?.[recordKey(entityA, 'name')]).toBeUndefined()
    expect(doc?.activities?.[recordKey(entityB, 'name')]).toBeUndefined()
  })

  it('discarding with no open frame (depth 0) is a no-op and does not throw', () => {
    const db = setupDb()

    expect(() => discardDeferredDocWrites(db)).not.toThrow()

    const entityA = randomUUID()
    beginDeferredDocWrites(db)
    writeName(db, entityA, 'A-write')
    commitDeferredDocWrites(db)

    const doc = getCurrentDoc(db)
    expect(doc.activities?.[recordKey(entityA, 'name')]).toBe('A-write')
  })

  it('a write enqueued in the outer frame AFTER an inner discard still lands — the truncation does not swallow later outer writes', () => {
    const db = setupDb()
    const entityA = randomUUID()
    const entityB = randomUUID()
    const entityC = randomUUID()

    beginDeferredDocWrites(db) // outer, depth=1
    writeName(db, entityA, 'A-write')

    beginDeferredDocWrites(db) // inner, depth=2
    writeName(db, entityB, 'B-write')

    discardDeferredDocWrites(db) // depth 2 -> 1; drops ONLY B's queued write

    writeName(db, entityC, 'C-write') // enqueued into the still-open outer frame

    commitDeferredDocWrites(db) // depth 1 -> 0; flushes A and C

    const doc = getCurrentDoc(db)

    expect(doc.activities?.[recordKey(entityA, 'name')]).toBe('A-write')
    expect(doc.activities?.[recordKey(entityB, 'name')]).toBeUndefined()
    expect(doc.activities?.[recordKey(entityC, 'name')]).toBe('C-write')
  })

  it('a three-level nest: discarding the innermost frame drops only its write, surrounding frames still flush', () => {
    const db = setupDb()
    const entity1 = randomUUID()
    const entity2 = randomUUID()
    const entity3 = randomUUID()

    beginDeferredDocWrites(db) // depth=1
    writeName(db, entity1, 'W1')

    beginDeferredDocWrites(db) // depth=2
    writeName(db, entity2, 'W2')

    beginDeferredDocWrites(db) // depth=3
    writeName(db, entity3, 'W3')

    discardDeferredDocWrites(db) // depth 3 -> 2; drops ONLY W3

    commitDeferredDocWrites(db) // depth 2 -> 1; W1, W2 stay queued for the outer frame
    commitDeferredDocWrites(db) // depth 1 -> 0; flushes W1, W2

    const doc = getCurrentDoc(db)

    expect(doc.activities?.[recordKey(entity1, 'name')]).toBe('W1')
    expect(doc.activities?.[recordKey(entity2, 'name')]).toBe('W2')
    expect(doc.activities?.[recordKey(entity3, 'name')]).toBeUndefined()
  })
})
