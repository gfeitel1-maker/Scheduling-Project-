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

  // day_overrides was previously the one unmodeled/deferred entity here (its ensureExists read the
  // operations table, which the doc-replay path never writes). The doc-native ensureExists slice
  // gave it a `knownRow` fallback instead (projections.js), so it is now modeled like any other
  // entity — an unregistered field on it is still a silent no-op (fields.includes check in
  // applyWrite), same as any modeled entity, but the entity itself is no longer refused.
  it('day_overrides: a registered field mirrors into the doc; an unregistered field is a silent no-op', () => {
    recordLocalWrite(db, {
      entity: 'day_overrides',
      entity_id: 'd1',
      field: 'not_a_real_field',
      value: 'holiday',
    })
    flushPendingWrites()
    const docAfterNoOp = loadDoc(userDataDir, 'camp-1')
    expect(readRecord(docAfterNoOp, 'day_overrides', 'd1')).toBeNull()

    recordLocalWrite(db, { entity: 'day_overrides', entity_id: 'd1', field: 'kind', value: 'cancel' })
    flushPendingWrites()
    const doc = loadDoc(userDataDir, 'camp-1')
    expect(readRecord(doc, 'day_overrides', 'd1')).toEqual({ kind: 'cancel' })
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

describe('seed-on-first-touch — row-for-row superset proof (Stage 5e item 1 correctness bar)', () => {
  it('a doc seeded via the SAME lazy path recordLocalWrite uses is a true superset: projecting it back changes nothing', async () => {
    const { projectAll } = await import('../../automerge/projector.js')

    // Realistic multi-entity, multi-row data, all via the real op-log write path.
    appendOp(db, { entity: 'cohorts', entity_id: 'c1', field: 'camp_id', value: 'camp-1', device_id: 'device-1' })
    appendOp(db, { entity: 'cohorts', entity_id: 'c1', field: 'name', value: 'Session A', device_id: 'device-1' })
    appendOp(db, { entity: 'groups', entity_id: 'g1', field: 'camp_id', value: 'camp-1', device_id: 'device-1' })
    appendOp(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A', device_id: 'device-1' })
    appendOp(db, { entity: 'groups', entity_id: 'g2', field: 'camp_id', value: 'camp-1', device_id: 'device-1' })
    appendOp(db, { entity: 'groups', entity_id: 'g2', field: 'name', value: 'Bunk B', device_id: 'device-1' })
    appendOp(db, { entity: 'activities', entity_id: 'a1', field: 'camp_id', value: 'camp-1', device_id: 'device-1' })
    appendOp(db, { entity: 'activities', entity_id: 'a1', field: 'name', value: 'Swim', device_id: 'device-1' })
    appendOp(db, { entity: 'activities', entity_id: 'a2', field: 'camp_id', value: 'camp-1', device_id: 'device-1' })
    appendOp(db, { entity: 'activities', entity_id: 'a2', field: 'name', value: 'Arts & Crafts', device_id: 'device-1' })

    const rowsBefore = {
      cohorts: db.prepare('SELECT * FROM cohorts ORDER BY id').all(),
      groups: db.prepare('SELECT * FROM groups ORDER BY id').all(),
      activities: db.prepare('SELECT * FROM activities ORDER BY id').all(),
    }
    expect(rowsBefore.groups).toHaveLength(2)
    expect(rowsBefore.activities).toHaveLength(2)

    // This is the exact path a first flag-on for an EXISTING camp takes: liveDoc has nothing
    // cached, no doc file exists yet, so ensureSeeded seeds from current SQLite.
    const doc = ensureSeeded(db)

    // Immediately projecting the freshly seeded doc back onto the SAME db must be a no-op — a true
    // superset never deletes or changes a row that was already there.
    projectAll(db, doc)

    const rowsAfter = {
      cohorts: db.prepare('SELECT * FROM cohorts ORDER BY id').all(),
      groups: db.prepare('SELECT * FROM groups ORDER BY id').all(),
      activities: db.prepare('SELECT * FROM activities ORDER BY id').all(),
    }
    expect(rowsAfter).toEqual(rowsBefore)
  })
})

describe('day_overrides is modeled: seeding and projection round-trip it like any other entity', () => {
  // Was the one deferred entity here (its ensureExists read the operations table, which the
  // doc-replay path never writes). The doc-native ensureExists slice (projections.js's `knownRow`
  // parameter) un-deferred it — see docNativeEnsureExists.test.js for the full pure-document
  // (zero-operations-rows) coverage. This test now proves the op-log path still round-trips too.
  it('day_overrides rows in SQLite survive ensureSeeded + projectAll unchanged', async () => {
    const { projectAll } = await import('../../automerge/projector.js')

    // day_overrides needs all FOUR of its NOT-NULL FKs satisfied before ensureExists inserts the
    // row (see projections.js's day_overrides.ensureExists) — build each referenced row first via
    // the real op-log path, exactly as the live app does.
    appendOp(db, { entity: 'days_of_operation', entity_id: 'day-1', field: 'camp_id', value: 'camp-1', device_id: 'device-1' })
    appendOp(db, { entity: 'schedule_weeks', entity_id: 'week-1', field: 'name', value: 'Week 1', device_id: 'device-1' })
    appendOp(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A', device_id: 'device-1' })
    appendOp(db, { entity: 'time_blocks', entity_id: 'tb1', field: 'name', value: 'Morning', device_id: 'device-1' })
    appendOp(db, { entity: 'day_overrides', entity_id: 'do1', field: 'schedule_week_id', value: 'week-1', device_id: 'device-1' })
    appendOp(db, { entity: 'day_overrides', entity_id: 'do1', field: 'day_id', value: 'day-1', device_id: 'device-1' })
    appendOp(db, { entity: 'day_overrides', entity_id: 'do1', field: 'group_id', value: 'g1', device_id: 'device-1' })
    appendOp(db, { entity: 'day_overrides', entity_id: 'do1', field: 'time_block_id', value: 'tb1', device_id: 'device-1' })

    const before = db.prepare('SELECT * FROM day_overrides ORDER BY id').all()
    expect(before.length).toBeGreaterThan(0)

    const doc = ensureSeeded(db)

    // The document carries the fields that were explicitly WRITTEN. Since Stage
    // 6b it is built by appendOp's dual-write rather than by seeding from a
    // finished SQLite row, so columns that `ensureExists` DERIVES (camp_id from
    // the parent, kind's default) are not in it — they are reconstructed on
    // projection from `knownRow` plus the FKs, which is exactly what that
    // parameter exists for.
    expect(readRecord(doc, 'day_overrides', 'do1')).toEqual({
      schedule_week_id: 'week-1',
      day_id: 'day-1',
      group_id: 'g1',
      time_block_id: 'tb1',
    })

    // And this is the assertion that actually matters, unchanged: a round trip
    // through the document restores the SQLite row IDENTICALLY, derived columns
    // included. If the derivation were lost, this is where it would show.
    db.prepare('DELETE FROM day_overrides').run()
    projectAll(db, doc)
    const after = db.prepare('SELECT * FROM day_overrides ORDER BY id').all()

    // `created_at` is EXCLUDED from the comparison, and that is a correction
    // rather than a concession. It is a SQLite `CURRENT_TIMESTAMP` default, so
    // the re-projected row gets a fresh one at insert time — the round trip
    // never promised to preserve it, and cannot. Comparing it made this test
    // fail whenever a second boundary happened to fall between the two inserts:
    // a real red on a loaded full-suite run (`14:44:13` vs `14:44:14`), passing
    // on every isolated re-run, which is the most expensive kind of flake
    // because it looks like a genuine defect exactly once.
    //
    // Asserted as PRESENT rather than dropped, so a column that vanished from
    // the projection still fails here — which is what excluding it outright
    // would have hidden.
    const withoutTimestamp = (rows) => rows.map(({ created_at: _created_at, ...rest }) => rest)
    for (const row of after) {
      expect(row.created_at, 'created_at must still be populated by the projection').toBeTruthy()
    }
    expect(withoutTimestamp(after)).toEqual(withoutTimestamp(before))
  })

  // Parent-scoped entities slice: template_slots is now dual-modeled — a flat collection
  // (individual cell edits, same shape as every other modeled entity) AND a separate
  // template_slots_scopes collection (the bulk-replace primitive) — see campDocument.js's
  // applyBulkReplace comment. Neither is unmodeled any more; see parentScoped.test.js for full
  // coverage of both.
  it('template_slots is modeled in BOTH its flat and bulk-replace-scope shapes', () => {
    expect(createEmptyDoc().template_slots).toEqual({})
    expect(createEmptyDoc().template_slots_scopes).toEqual({})
    expect(() =>
      applyWrite(createEmptyDoc(), { entity: 'template_slots', entity_id: 's1', field: 'activity_id', value: 'a1' })
    ).not.toThrow()
  })
})
