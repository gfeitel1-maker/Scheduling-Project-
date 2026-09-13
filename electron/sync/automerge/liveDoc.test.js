import { readRecord, listRecordIds } from '../../automerge/campDocument.js'
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../../db/localDb.js'
import { appendOp } from '../../ops/operations.js'
import { docPath, loadDoc } from './docStore.js'
import { createEmptyDoc, applyWrite } from '../../automerge/campDocument.js'
import {
  recordLocalWrite,
  setUserDataDirGetter,
  resetForTests,
  ensureSeeded,
  getDocIfLoaded,
  flushPendingWrites,
} from './liveDoc.js'

let userDataDir
let tmpFile
let db

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-livedoc-test-'))
  setUserDataDirGetter(() => userDataDir)

  tmpFile = path.join(os.tmpdir(), `shoresh-livedoc-db-${Date.now()}-${Math.random()}.sqlite`)
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
