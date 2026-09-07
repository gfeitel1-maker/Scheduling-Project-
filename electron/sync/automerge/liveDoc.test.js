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
    expect(doc.groups.g1.name).toBe('Bunk A')
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
    expect(doc.groups.g1.name).toBe('Bunk A')
    expect(doc.activities.a1.name).toBe('Swim')
  })

  it('does nothing for an unmodeled entity (e.g. day_overrides) — no doc file is created', () => {
    recordLocalWrite(db, {
      entity: 'day_overrides',
      entity_id: 'd1',
      field: 'reason',
      value: 'holiday',
    })
    flushPendingWrites()

    expect(fs.existsSync(docPath(userDataDir, 'camp-1'))).toBe(false)
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
    expect(doc.template_slots['s1']).toEqual({ activity_id: 'a1' })
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
    expect(doc.groups.g1).toBeUndefined()
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
    expect(getDocIfLoaded(db).groups.g1.name).toBe('Bunk A')
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
    expect(doc.groups.g49.name).toBe('Bunk 49')
    expect(Object.keys(doc.groups)).toHaveLength(50)
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
      expect(doc.groups.g1.name).toBe('Bunk A')
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
    expect(doc.groups.g1.name).toBe('Bunk A')
    expect(doc.activities.a1.name).toBe('Swim')

    // Seeding is NOT debounced — it must be on disk immediately, before any caller (e.g. main.js's
    // sync-node startup) can act on "a doc now exists for this camp".
    expect(fs.existsSync(docPath(userDataDir, 'camp-1'))).toBe(true)
    const persisted = loadDoc(userDataDir, 'camp-1')
    expect(persisted.groups.g1.name).toBe('Bunk A')
  })

  it('loads the persisted doc on a second call rather than re-seeding', () => {
    appendOp(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A', device_id: 'device-1' })
    ensureSeeded(db)
    resetForTests() // simulate a fresh process: in-memory cache gone, but the file persists
    setUserDataDirGetter(() => userDataDir)

    // Mutate SQLite AFTER the doc was persisted — if ensureSeeded re-seeded instead of loading,
    // this new row would appear in the doc. It must not.
    appendOp(db, { entity: 'groups', entity_id: 'g2', field: 'name', value: 'Bunk B', device_id: 'device-1' })

    const doc = ensureSeeded(db)
    expect(doc.groups.g1.name).toBe('Bunk A')
    expect(doc.groups.g2).toBeUndefined() // NOT re-seeded — loaded from the persisted file as-is
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
    expect(doc.groups.g1.name).toBe('Bunk A')
    expect(doc.activities.a1.name).toBe('Swim')
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

describe('unmodeled/deferred entities are never touched by seeding or projection', () => {
  it('day_overrides rows in SQLite survive ensureSeeded + projectAll untouched (deferred, not in the doc at all)', async () => {
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
    expect(doc.day_overrides).toBeUndefined() // deferred: never modeled in the doc shape at all

    projectAll(db, doc) // must not touch day_overrides — it isn't in MODELED_ORDER at all
    const after = db.prepare('SELECT * FROM day_overrides ORDER BY id').all()
    expect(after).toEqual(before)
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
