// @vitest-environment node
//
// KNOWN GAP, pinned not fixed — routed to board line
// i-nested-discard-leaks-queued-doc-writes for a different worker. This file
// documents CURRENT behavior so a future fix to discardDeferredDocWrites is a
// visible diff in this test, not a silent behavior change.
//
// discardDeferredDocWrites (electron/sync/automerge/liveDoc.js) is NOT
// depth-aware about which queued items belong to which nesting level: it only
// decrements `state.depth` and clears `state.queue` when depth reaches 0.
// When a transaction nests (outer begins, writes A, inner begins, writes B,
// inner discards), the inner discard sees depth > 0 after its decrement and
// returns WITHOUT touching the queue — so B's write is never actually
// discarded. The outer boundary's later commit flushes the whole queue,
// including B.
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

describe('discardDeferredDocWrites: nested discard does not discard (KNOWN GAP)', () => {
  it('an inner scope\'s discard leaks its queued write through to the outer commit', () => {
    const docDir = fs.mkdtempSync('/tmp/shoresh-knowngap-')
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

    const entityA = randomUUID()
    const entityB = randomUUID()

    beginDeferredDocWrites(db) // outer, depth=1
    recordLocalWrite(db, { entity: 'activities', entity_id: entityA, field: 'name', value: 'A-write' })

    beginDeferredDocWrites(db) // inner, depth=2
    recordLocalWrite(db, { entity: 'activities', entity_id: entityB, field: 'name', value: 'B-write' })

    // Intent: discard the INNER scope only — B's write should be dropped,
    // A's should survive once the outer boundary commits.
    discardDeferredDocWrites(db) // depth 2 -> 1; queue is NOT cleared (depth > 0 after decrement)

    commitDeferredDocWrites(db) // depth 1 -> 0; flushes the WHOLE queue, A and B both

    const doc = getCurrentDoc(db)

    // CURRENT (buggy) behavior: both writes land, because the inner discard
    // never actually removed B's queued item.
    expect(doc.activities?.[recordKey(entityA, 'name')]).toBe('A-write')
    expect(doc.activities?.[recordKey(entityB, 'name')]).toBe('B-write')

    // When discard becomes depth-aware (tracking which queue entries belong
    // to which nesting level, board i-nested-discard-leaks-queued-doc-writes),
    // flip this assertion: B's write should be ABSENT (the inner scope was
    // genuinely discarded) while A's write still lands via the outer commit.
    // expect(doc.activities?.[recordKey(entityB, 'name')]).toBeUndefined()
  })
})
