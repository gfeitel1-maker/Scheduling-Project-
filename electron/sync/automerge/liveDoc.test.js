import { readRecord, listRecordIds } from '../../automerge/campDocument.js'
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../../db/localDb.js'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { appendOp } from '../../ops/operations.js'
import { docPath, loadDoc, saveDoc } from './docStore.js'
import {
  createEmptyDoc,
  applyWrite,
  MODELED_ENTITIES,
  BULK_REPLACE_MODELED_ENTITIES,
  bulkReplaceCollectionName,
} from '../../automerge/campDocument.js'
import * as A from '@automerge/automerge'
import { DOCUMENT_OUTCOME } from '../../ops/documentOutcome.js'
import {
  recordLocalWrite,
  recordLocalBulkReplace,
  beginDeferredDocWrites,
  commitDeferredDocWrites,
  setUserDataDirGetter,
  setDocCipher,
  resetForTests,
  ensureSeeded,
  getDocIfLoaded,
  flushPendingWrites,
  discardLiveDoc,
  DOC_CHANGE_CHUNK,
} from './liveDoc.js'
import { listDocumentWriteFailures } from '../../ops/documentWriteFailures.js'

// Discards the cached template once, at the end (T188/F2b).
afterAll(() => {
  cleanupTemplatedDbs()
})

let userDataDir
let tmpFile
let db

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-livedoc-test-'))
  setUserDataDirGetter(() => userDataDir)

  // Was openLocalDb(freshPath) — the per-test migration-chain replay, ~304ms (T188/F2b).
  // ONLY this setup call is templated. The second openLocalDb further down deliberately
  // builds a DISTINCT second database (a replica / another device) and is left alone.
  const __t = openTemplatedDb()
  db = __t.db
  tmpFile = __t.file
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('device-1', 'Device One')
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
})

afterEach(() => {
  resetForTests()
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

describe('recordLocalWrite', () => {
  it('mirrors a modeled-entity write into the persisted doc, keyed by the db camp id', () => {
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A' })
    flushPendingWrites()

    const doc = loadDoc(userDataDir, 'camp-1')
    expect(readRecord(doc, 'groups', 'g1').name).toBe('Bunk A')
  })

  it('is gracefully inert (no throw, no file) when userDataDir is not configured (pre-Stage-5e)', () => {
    // Red Hat 5b finding: before startup wiring exists, a flag-on write must not
    // throw on every call — it warns once and skips, op-log stays source of truth.
    resetForTests() // clears the getter set in beforeEach -> unconfigured state
    expect(() =>
      recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A' })
    ).not.toThrow()
    expect(fs.existsSync(docPath(userDataDir, 'camp-1'))).toBe(false)
  })

  it('accumulates multiple writes into the same doc', () => {
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A' })
    recordLocalWrite(db, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim' })
    flushPendingWrites()

    const doc = loadDoc(userDataDir, 'camp-1')
    expect(readRecord(doc, 'groups', 'g1').name).toBe('Bunk A')
    expect(readRecord(doc, 'activities', 'a1').name).toBe('Swim')
  })


  // Parent-scoped entities slice: template_slots is now modeled in its flat (individual-cell-edit)
  // shape, so a field write DOES mirror into the doc — see recordLocalBulkReplace's own tests below
  // for the separate wholesale-regenerate primitive.
  it('mirrors a template_slots individual-cell field write into the doc (flat shape)', () => {
    recordLocalWrite(db, {
      entity: 'template_slots',
      entity_id: 's1',
      field: 'activity_id',
      value: 'a1',
    })
    flushPendingWrites()

    expect(fs.existsSync(docPath(userDataDir, 'camp-1'))).toBe(true)
    const doc = loadDoc(userDataDir, 'camp-1')
    expect(readRecord(doc, 'template_slots', 's1')).toEqual({ activity_id: 'a1' })
  })

  it('does nothing when the db has no camp row yet', () => {
    const freshTmpFile = path.join(os.tmpdir(), `shoresh-livedoc-nocamp-${Date.now()}.sqlite`)
    const freshDb = openLocalDb(freshTmpFile)
    try {
      recordLocalWrite(freshDb, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'X' })
      flushPendingWrites()
      expect(fs.existsSync(docPath(userDataDir, 'camp-1'))).toBe(false)
    } finally {
      freshDb.close()
      fs.unlinkSync(freshTmpFile)
    }
  })

  it('applies DELETE_FIELD by removing the entity row from the doc', () => {
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A' })
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: '__deleted__', value: 1 })
    flushPendingWrites()

    const doc = loadDoc(userDataDir, 'camp-1')
    expect(readRecord(doc, 'groups', 'g1')).toBeNull()
  })
})

describe('recordLocalWrite — debounced persistence (Stage 5e item 3)', () => {
  // Seeding-on-first-touch always persists synchronously (item 1's correctness bar — it must be
  // on disk before anything can rely on "this camp is seeded"). Debounce governs every write
  // AFTER that first one, so these tests seed an (empty) doc up front, exactly like a camp
  // continuing to run after its one-time seed, before exercising the debounce behavior itself.
  beforeEach(() => {
    ensureSeeded(db) // persists an empty doc synchronously; camp has no rows yet in this suite
  })

  it('does not write to disk synchronously — the write is only in memory until a flush', () => {
    const mtimeBefore = fs.statSync(docPath(userDataDir, 'camp-1')).mtimeMs
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A' })

    // The on-disk file is still the pre-write (seeded-empty) one: the save is debounced.
    expect(fs.statSync(docPath(userDataDir, 'camp-1')).mtimeMs).toBe(mtimeBefore)
    // But the in-memory doc already reflects the write (readable via getDocIfLoaded).
    expect(readRecord(getDocIfLoaded(db), 'groups', 'g1').name).toBe('Bunk A')
  })

  it('batches many rapid writes into a single saveDoc call', () => {
    let writeCount = 0
    const realWriteFileSync = fs.writeFileSync
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
      writeCount += 1
      return realWriteFileSync(...args)
    })
    try {
      for (let i = 0; i < 50; i++) {
        recordLocalWrite(db, { entity: 'groups', entity_id: `g${i}`, field: 'name', value: `Bunk ${i}` })
      }
      expect(writeCount).toBe(0) // nothing flushed yet
      flushPendingWrites()
      expect(writeCount).toBe(1) // 50 writes -> exactly one save
    } finally {
      spy.mockRestore()
    }

    const doc = loadDoc(userDataDir, 'camp-1')
    expect(readRecord(doc, 'groups', 'g49').name).toBe('Bunk 49')
    expect(listRecordIds(doc, 'groups')).toHaveLength(50)
  })

  it('flushPendingWrites is a no-op (no throw, no extra write) when nothing is pending', () => {
    const mtimeBefore = fs.statSync(docPath(userDataDir, 'camp-1')).mtimeMs
    expect(() => flushPendingWrites()).not.toThrow()
    expect(fs.statSync(docPath(userDataDir, 'camp-1')).mtimeMs).toBe(mtimeBefore)
  })

  it('a real timer eventually flushes on its own without an explicit flush call', async () => {
    vi.useFakeTimers()
    try {
      const mtimeBefore = fs.statSync(docPath(userDataDir, 'camp-1')).mtimeMs
      recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A' })
      expect(fs.statSync(docPath(userDataDir, 'camp-1')).mtimeMs).toBe(mtimeBefore)
      await vi.advanceTimersByTimeAsync(1000)
      const doc = loadDoc(userDataDir, 'camp-1')
      expect(readRecord(doc, 'groups', 'g1').name).toBe('Bunk A')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ensureSeeded — Stage 5e item 1 (seed-on-first-enable)', () => {
  it('returns null when userDataDir is not configured', () => {
    resetForTests()
    expect(ensureSeeded(db)).toBeNull()
  })

  it('returns null when the db has no camp row yet', () => {
    const freshTmpFile = path.join(os.tmpdir(), `shoresh-livedoc-ensure-nocamp-${Date.now()}.sqlite`)
    const freshDb = openLocalDb(freshTmpFile)
    try {
      expect(ensureSeeded(freshDb)).toBeNull()
    } finally {
      freshDb.close()
      fs.unlinkSync(freshTmpFile)
    }
  })

  it('seeds a fresh doc from CURRENT SQLite rows when no doc file exists yet, and persists it immediately (not debounced)', () => {
    // Populate SQLite the REAL way — through the op-log (appendOp), with the flag OFF (default),
    // exactly like a camp that has been running on op-log sync for months before flag-on.
    appendOp(db, { entity: 'groups', entity_id: 'g1', field: 'camp_id', value: 'camp-1', device_id: 'device-1' })
    appendOp(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A', device_id: 'device-1' })
    appendOp(db, { entity: 'activities', entity_id: 'a1', field: 'camp_id', value: 'camp-1', device_id: 'device-1' })
    appendOp(db, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim', device_id: 'device-1' })

    const doc = ensureSeeded(db)
    expect(readRecord(doc, 'groups', 'g1').name).toBe('Bunk A')
    expect(readRecord(doc, 'activities', 'a1').name).toBe('Swim')

    // Seeding is NOT debounced — the file must exist immediately, before any
    // caller (e.g. main.js's sync-node startup) can act on "a doc now exists
    // for this camp". That is the assertion; it is unchanged.
    expect(fs.existsSync(docPath(userDataDir, 'camp-1'))).toBe(true)

    // Its CONTENTS, though, are subject to the ordinary debounce. Stage 6b made
    // that visible: with automerge the default engine, appendOp's dual-write is
    // live, so the first write is what seeds — and it can only capture SQLite as
    // it stood at that instant (`ensureExists` creates the row before its fields
    // arrive; `groups.name` is NOT NULL, so it exists as ''). Later writes land
    // in memory and persist on the next flush, exactly as designed. Flushing
    // here asserts the end state rather than racing the timer.
    flushPendingWrites()
    const persisted = loadDoc(userDataDir, 'camp-1')
    expect(readRecord(persisted, 'groups', 'g1').name).toBe('Bunk A')
  })

  it('loads the persisted doc on a second call rather than re-seeding', () => {
    appendOp(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A', device_id: 'device-1' })
    ensureSeeded(db)
    resetForTests() // simulate a fresh process: in-memory cache gone, but the file persists
    setUserDataDirGetter(() => userDataDir)

    // Mutate SQLite AFTER the doc was persisted — if ensureSeeded re-seeded instead of loading,
    // this new row would appear in the doc. It must not.
    //
    // Written with raw SQL rather than appendOp, and that matters since Stage 6b:
    // with automerge the default engine, appendOp ALSO dual-writes into the
    // document, so using it here would put g2 in the doc by the write path and
    // the assertion below could no longer tell "re-seeded" from "written". Raw
    // SQL touches only SQLite, which is what this test needs to distinguish.
    db.prepare("INSERT INTO groups (id, camp_id, name) VALUES ('g2', 'camp-1', 'Bunk B')").run()

    const doc = ensureSeeded(db)
    expect(readRecord(doc, 'groups', 'g1').name).toBe('Bunk A')
    expect(readRecord(doc, 'groups', 'g2')).toBeNull() // NOT re-seeded — loaded from the persisted file as-is
  })

  it('is idempotent within a process — a second call returns the same cached doc without re-reading disk', () => {
    appendOp(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A', device_id: 'device-1' })
    const first = ensureSeeded(db)
    const second = ensureSeeded(db)
    expect(second).toBe(first)
  })

  it('a subsequent recordLocalWrite after ensureSeeded builds on the seeded doc, not a fresh empty one', () => {
    appendOp(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A', device_id: 'device-1' })
    ensureSeeded(db)
    recordLocalWrite(db, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim' })
    flushPendingWrites()

    const doc = loadDoc(userDataDir, 'camp-1')
    expect(readRecord(doc, 'groups', 'g1').name).toBe('Bunk A')
    expect(readRecord(doc, 'activities', 'a1').name).toBe('Swim')
  })
})

// T145 — this test outlived the `day_overrides is modeled` describe it used to
// share. It is about TEMPLATE_SLOTS, not day_overrides, and was very nearly
// lost as collateral when that block was deleted wholesale (caught in review).
// Kept here on its own so the connection it actually tests — that an entity can
// be modeled in both its flat and bulk-replace-scope shapes at once — is not
// hostage to some unrelated entity's lifecycle.
describe('template_slots is modeled in both shapes', () => {
  it('template_slots is modeled in BOTH its flat and bulk-replace-scope shapes', () => {
    expect(createEmptyDoc().template_slots).toEqual({})
    expect(createEmptyDoc().template_slots_scopes).toEqual({})
    expect(() =>
      applyWrite(createEmptyDoc(), { entity: 'template_slots', entity_id: 's1', field: 'activity_id', value: 'a1' })
    ).not.toThrow()
  })
})

// --- The debounced save is the third place a write can be lost ------------
//
// applyWrite failing in memory is recorded (documentWriteFailures.js). The
// nested-transaction case is closed (runAtomic). The fsync at the END of the
// debounce window was not covered by either: it throws inside a setTimeout
// callback, which is an uncaught main-process exception, and the op ids that
// contributed to the window are gone by then. These pin that the loss is now
// contained and recorded against exactly the ops that were in flight.
describe('flushPendingWrites — a failing save is contained and recorded', () => {
  function failTheSave() {
    // Real fault injection, not a mock: point the writer at a path whose
    // parent is a FILE, so mkdirSync inside saveDoc throws ENOTDIR the way a
    // full or unwritable disk would.
    const blocker = path.join(os.tmpdir(), `shoresh-livedoc-blocker-${Date.now()}-${Math.random()}`)
    fs.writeFileSync(blocker, 'not a directory')
    setUserDataDirGetter(() => blocker)
    return blocker
  }

  it('does not throw out of the flush when saveDoc fails', () => {
    ensureSeeded(db)
    const op = appendOp(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A', device_id: 'device-1' })
    expect(op).toBeTruthy()
    const blocker = failTheSave()
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g2', field: 'name', value: 'Bunk B', op_id: op.id })
    expect(() => flushPendingWrites()).not.toThrow()
    fs.rmSync(blocker, { force: true })
  })

  it('records the ops that were in the failed window, so the loss is queryable', () => {
    ensureSeeded(db)
    const op = appendOp(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A', device_id: 'device-1' })
    const blocker = failTheSave()
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A', op_id: op.id })
    flushPendingWrites()
    const failures = listDocumentWriteFailures(db)
    expect(failures.map((f) => f.op_id)).toContain(op.id)
    expect(failures[0].store).toBe('document')
    fs.rmSync(blocker, { force: true })
  })

  it('a successful flush leaves no failure rows and clears the tracked ops', () => {
    ensureSeeded(db)
    const op = appendOp(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A', device_id: 'device-1' })
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A', op_id: op.id })
    flushPendingWrites()
    expect(listDocumentWriteFailures(db)).toEqual([])
    // A second, failing window must not re-report the op from the first one.
    const op2 = appendOp(db, { entity: 'groups', entity_id: 'g2', field: 'name', value: 'Bunk B', device_id: 'device-1' })
    const blocker = failTheSave()
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g2', field: 'name', value: 'Bunk B', op_id: op2.id })
    flushPendingWrites()
    expect(listDocumentWriteFailures(db).map((f) => f.op_id)).toEqual([op2.id])
    fs.rmSync(blocker, { force: true })
  })
})

// At-rest encryption seam (ADR 2026-09-15). When main.js injects a cipher via setDocCipher, the
// .automerge file liveDoc writes must be encrypted on disk and read back correctly through the SAME
// module — and a legacy plaintext file (written before the cipher was set) must still load. These
// pin the liveDoc half of the wiring; docCipher.js's own crypto is pinned in electron/db/docCipher.test.js.
// The default (no cipher set) stays plaintext, which every other test above relies on.
describe('at-rest document cipher (setDocCipher)', () => {
  // A minimal fake cipher: prefix-tag on encrypt, strip on decrypt, passthrough for anything not
  // tagged (mirrors docCipher's legacy-plaintext passthrough). Enough to prove the bytes on disk are
  // transformed and that liveDoc threads the SAME cipher through save AND load.
  const TAG = Buffer.from('FAKEENC:', 'ascii')
  const fakeCipher = {
    encrypt: (buf) => Buffer.concat([TAG, buf]),
    decrypt: (buf) =>
      buf.length >= TAG.length && buf.subarray(0, TAG.length).equals(TAG) ? buf.subarray(TAG.length) : buf,
  }

  it('writes an ENCRYPTED file to disk and reads the data back through liveDoc', () => {
    setDocCipher(fakeCipher)
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A' })
    flushPendingWrites()

    // On disk: the raw bytes carry the cipher tag, i.e. it is NOT the plaintext Automerge document.
    const raw = fs.readFileSync(docPath(userDataDir, 'camp-1'))
    expect(raw.subarray(0, TAG.length).equals(TAG)).toBe(true)

    // Read back through docStore WITH the cipher: the data round-trips.
    expect(readRecord(loadDoc(userDataDir, 'camp-1', fakeCipher), 'groups', 'g1').name).toBe('Bunk A')
  })

  it('loads a LEGACY plaintext file even after a cipher is injected (passthrough on read)', () => {
    // Simulate a device that has a plaintext .automerge from the pre-encryption era.
    let legacy = createEmptyDoc()
    legacy = applyWrite(legacy, { entity: 'groups', entity_id: 'g9', field: 'name', value: 'Old Bunk' })
    saveDoc(userDataDir, 'camp-1', legacy) // written with no cipher = plaintext

    setDocCipher(fakeCipher)
    ensureSeeded(db) // liveDoc loads the existing (plaintext) file rather than re-seeding
    expect(readRecord(getDocIfLoaded(db), 'groups', 'g9').name).toBe('Old Bunk')
  })

  it('default (no cipher) writes plaintext — unchanged behavior', () => {
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A' })
    flushPendingWrites()
    const raw = fs.readFileSync(docPath(userDataDir, 'camp-1'))
    expect(raw.subarray(0, TAG.length).equals(TAG)).toBe(false) // not our fake-cipher tag
    expect(readRecord(loadDoc(userDataDir, 'camp-1'), 'groups', 'g1').name).toBe('Bunk A')
  })
})

// --- The deferred flush replays a RUN of writes in one change (T6xx) --------
//
// commitDeferredDocWrites used to call applyLocalWriteNow once per queued item,
// which is one A.change per field and therefore O(n²) across a runAtomic body
// (see the 2026-10-01 amendment to
// docs/adr/2026-09-29-per-op-savepoint-inside-an-atomic-boundary.md). These pin
// the three things batching must not change: order across a mixed queue,
// per-item failure containment, and the per-op id ledger scheduleSave carries.
describe('commitDeferredDocWrites — batched replay', () => {
  function slotRows(templateId, n) {
    return Array.from({ length: n }, (_, i) => ({
      id: `slot-${i}`,
      template_id: templateId,
      group_id: null,
      activity_id: null,
      day_id: null,
      time_block_id: null,
    }))
  }

  // These tests are only meaningful if the Automerge path actually RUNS. It is
  // inert without a userDataDir getter (beforeEach sets one) — a test that
  // silently returned early would pass while proving nothing.
  it('the dual-write path is live in this suite (guards against an inert no-op)', () => {
    recordLocalWrite(db, { entity: 'groups', entity_id: 'guard', field: 'name', value: 'live' })
    expect(readRecord(getDocIfLoaded(db), 'groups', 'guard').name).toBe('live')
  })

  it('a mixed write/bulk queue replays in queue order', () => {
    ensureSeeded(db)
    beginDeferredDocWrites(db)
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'first' })
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'second' })
    recordLocalBulkReplace(db, { entity: 'template_slots', scope_id: 'tpl-1', rows: slotRows('tpl-1', 2) })
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'third' })
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g2', field: 'name', value: 'other' })
    commitDeferredDocWrites(db)

    const doc = getDocIfLoaded(db)
    // Last write to the field wins, across the bulk item sitting in the middle.
    expect(readRecord(doc, 'groups', 'g1').name).toBe('third')
    expect(readRecord(doc, 'groups', 'g2').name).toBe('other')
    expect(JSON.parse(doc.template_slots_scopes['tpl-1'])).toHaveLength(2)
  })

  it('a failing write falls back per item: every other write lands exactly once', () => {
    ensureSeeded(db)
    // Op rows only — appendOp itself dual-writes, so these deliberately name
    // DIFFERENT records from the ones the deferred batch below writes.
    const opA = appendOp(db, { entity: 'groups', entity_id: 'ph-a', field: 'name', value: 'ph', device_id: 'device-1' })
    const opBad = appendOp(db, { entity: 'groups', entity_id: 'ph-bad', field: 'name', value: 'ph', device_id: 'device-1' })
    const opC = appendOp(db, { entity: 'groups', entity_id: 'ph-c', field: 'name', value: 'ph', device_id: 'device-1' })
    const before = A.getAllChanges(getDocIfLoaded(db)).length

    beginDeferredDocWrites(db)
    recordLocalWrite(db, { entity: 'groups', entity_id: 'ga', field: 'name', value: 'A', op_id: opA.id }, opA)
    // A real fault INSIDE the A.change callback: Automerge refuses a symbol
    // value. Nothing before it in the batch may survive, and nothing after it
    // may be lost.
    recordLocalWrite(db, { entity: 'groups', entity_id: 'gbad', field: 'name', value: Symbol('nope'), op_id: opBad.id }, opBad)
    recordLocalWrite(db, { entity: 'groups', entity_id: 'gc', field: 'name', value: 'C', op_id: opC.id }, opC)
    expect(() => commitDeferredDocWrites(db)).not.toThrow()

    const doc = getDocIfLoaded(db)
    expect(readRecord(doc, 'groups', 'ga').name).toBe('A')
    expect(readRecord(doc, 'groups', 'gc').name).toBe('C')
    expect(readRecord(doc, 'groups', 'gbad')).toBeNull()
    // EXACTLY ONCE: two surviving writes means two new changes, not four. A
    // batch that half-applied before throwing would show more.
    expect(A.getAllChanges(doc).length - before).toBe(2)

    expect(opA[DOCUMENT_OUTCOME]).toBe('applied')
    expect(opC[DOCUMENT_OUTCOME]).toBe('applied')
    expect(opBad[DOCUMENT_OUTCOME]).toBe('failed')
    // Attributed to ITS OWN op, not to the run.
    expect(listDocumentWriteFailures(db).map((f) => f.op_id)).toEqual([opBad.id])
  })

  it('scheduleSave still carries every op id in a batched window', () => {
    ensureSeeded(db)
    const ops = ['n1', 'n2', 'n3', 'n4'].map((id) =>
      appendOp(db, { entity: 'groups', entity_id: id, field: 'name', value: id, device_id: 'device-1' })
    )
    // Fail the save: the ledger of op ids in the window is what names the lost
    // writes, and it is the only way to observe scheduleSave's set from outside.
    const blocker = path.join(os.tmpdir(), `shoresh-livedoc-blocker-${Date.now()}-${Math.random()}`)
    fs.writeFileSync(blocker, 'not a directory')
    setUserDataDirGetter(() => blocker)

    beginDeferredDocWrites(db)
    for (const op of ops) {
      recordLocalWrite(db, { entity: 'groups', entity_id: op.entity_id, field: 'name', value: op.entity_id, op_id: op.id }, op)
    }
    commitDeferredDocWrites(db)
    flushPendingWrites()

    expect(listDocumentWriteFailures(db).map((f) => f.op_id).sort()).toEqual(ops.map((o) => o.id).sort())
    fs.rmSync(blocker, { force: true })
  })
})

// --- What the batched replay must keep true -------------------------------
//
// Three things the round-1 suite left unpinned, each found by deleting the line
// that implements it and watching 1901 tests stay green.
describe('commitDeferredDocWrites — the invariants behind the batch', () => {
  it('a SUCCESSFUL batch stamps every op applied, not just a failing one', () => {
    ensureSeeded(db)
    const ops = ['b1', 'b2', 'b3'].map((id) =>
      appendOp(db, { entity: 'groups', entity_id: id, field: 'name', value: id, device_id: 'device-1' })
    )
    // appendOp above already dual-wrote these outside any boundary, so reset the
    // field to the value the deferred path sets before it queues anything.
    for (const op of ops) op[DOCUMENT_OUTCOME] = 'deferred'

    beginDeferredDocWrites(db)
    for (const op of ops) {
      recordLocalWrite(db, { entity: 'groups', entity_id: op.entity_id, field: 'name', value: 'batched', op_id: op.id }, op)
      expect(op[DOCUMENT_OUTCOME]).toBe('deferred')
    }
    commitDeferredDocWrites(db)

    // THE LOAD-BEARING ASSERTION. migrationDomainState.js's resolve pass fails
    // closed on anything that is not 'applied' (`allApplied = false`), so a run
    // left saying 'deferred' leaves resolved_at NULL and keeps sync refused —
    // and localWriteClient.js hands the same string to the renderer. Deleting
    // the stamping loop in the batch-success branch is otherwise invisible.
    for (const op of ops) expect(op[DOCUMENT_OUTCOME]).toBe('applied')
    expect(listDocumentWriteFailures(db)).toEqual([])
  })

  it('a write and a bulk-replace can never address the same document key', () => {
    // WHY THIS AND NOT A CONTENDING FIXTURE. commitDeferredDocWrites partitions
    // the queue into CONTIGUOUS runs, and round 1's comment claimed that
    // contiguity is what keeps a bulk sitting between two writes in its place.
    // It is not: the two primitives write DIFFERENT top-level collections
    // (`template_slots` vs `template_slots_scopes`), so no ordering between a
    // write and a bulk is observable in the document at all, and no fixture can
    // make one contend. Contiguity is kept as the structurally safe default,
    // and THIS is the invariant that makes reordering harmless — so this is
    // what gets guarded. It goes red the day a bulk-replace entity's scope
    // collection collides with a modeled entity's own collection, which is
    // exactly when ordering would start to matter.
    for (const entity of BULK_REPLACE_MODELED_ENTITIES) {
      const scopes = bulkReplaceCollectionName(entity)
      expect(scopes).not.toBe(entity)
      expect(MODELED_ENTITIES.has(scopes)).toBe(false)
    }
  })

  it('a fault in a LATER chunk still lands every other write exactly once', () => {
    // The batch is split into DOC_CHANGE_CHUNK-sized A.change calls (the fix for
    // the commit regression), so a fault can now land in a chunk after one that
    // already succeeded — and the document that chunk consumed is the one the
    // per-item fallback would otherwise re-read. A chunked batch that did not
    // publish each chunk to the registry would hand the fallback an outdated
    // document and lose the whole run.
    ensureSeeded(db)
    const n = DOC_CHANGE_CHUNK + 5
    const ops = Array.from({ length: n }, (_, i) =>
      appendOp(db, { entity: 'groups', entity_id: `chunk-ph-${i}`, field: 'name', value: 'ph', device_id: 'device-1' })
    )

    beginDeferredDocWrites(db)
    ops.forEach((op, i) => {
      const bad = i === DOC_CHANGE_CHUNK + 2
      recordLocalWrite(
        db,
        { entity: 'groups', entity_id: `ck-${i}`, field: 'name', value: bad ? Symbol('nope') : `v-${i}`, op_id: op.id },
        op
      )
    })
    expect(() => commitDeferredDocWrites(db)).not.toThrow()

    const doc = getDocIfLoaded(db)
    for (let i = 0; i < n; i += 1) {
      if (i === DOC_CHANGE_CHUNK + 2) {
        expect(readRecord(doc, 'groups', `ck-${i}`)).toBeNull()
        expect(ops[i][DOCUMENT_OUTCOME]).toBe('failed')
      } else {
        expect(readRecord(doc, 'groups', `ck-${i}`).name).toBe(`v-${i}`)
        expect(ops[i][DOCUMENT_OUTCOME]).toBe('applied')
      }
    }
    expect(listDocumentWriteFailures(db).map((f) => f.op_id)).toEqual([ops[DOC_CHANGE_CHUNK + 2].id])
  })
})

describe('discardLiveDoc', () => {
  it('drops a pending save so a replaced document file is not overwritten by the old in-memory doc', () => {
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Old' })
    flushPendingWrites()
    recordLocalWrite(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Newer-unsaved' })

    const file = docPath(userDataDir, 'camp-1')
    const restored = Buffer.from('restored-bytes')
    discardLiveDoc(db)
    fs.writeFileSync(file, restored)
    flushPendingWrites()

    expect(fs.readFileSync(file).equals(restored)).toBe(true)
    expect(getDocIfLoaded(db)).toBeFalsy()
  })
})
