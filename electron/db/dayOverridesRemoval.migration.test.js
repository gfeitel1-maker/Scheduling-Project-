// @vitest-environment node
//
// Migration v59 — remove Day Overrides entirely (T145, reversing T108's
// re-point). Drops `day_overrides` AND rebuilds `schedule_snapshots` without
// `day_overrides_json`. Hard cutover following the v53/overlay precedent: the
// data is discarded, not preserved.
//
// Mirrors dayOverrideTemplatesRemoval.migration.test.js (the v46 drop) in
// shape, with one addition it did not need: v46 dropped two tables that were
// provably EMPTY on every device, whereas v59 drops a table that really did
// carry rows, plus a column on a table that must survive the rebuild intact.
// So this also proves the surviving snapshot columns and their DATA come
// through the rebuild unharmed — that is the part a table rebuild can silently
// get wrong.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV59 } from './rollback/v59_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function tmpFile(tag) {
  const file = path.join(os.tmpdir(), `shoresh-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return file
}

const freshDb = () => openLocalDb(tmpFile('v59-fresh'))

// Fully migrated, then rolled back to the v58 shape so v59 can be exercised
// against a database that actually has the table and the column.
function preV59Db(tag = 'v59-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  rollbackV59(db)
  return db
}

const tableExists = (db, name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)

describe('migration v59: Day Overrides removal', () => {
  it('declares the current schema version and creates neither the table nor the column on a fresh db', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(72)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 59').get().c).toBe(1)
    expect(tableExists(db, 'day_overrides')).toBe(false)
    expect(columns(db, 'schedule_snapshots')).not.toContain('day_overrides_json')
    db.close()
  })

  it('drops the table and the column on a migrated db that had both', () => {
    const db = preV59Db()
    expect(tableExists(db, 'day_overrides')).toBe(true)
    expect(columns(db, 'schedule_snapshots')).toContain('day_overrides_json')

    initSchema(db)

    expect(tableExists(db, 'day_overrides')).toBe(false)
    expect(columns(db, 'schedule_snapshots')).not.toContain('day_overrides_json')
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('carries existing snapshot ROWS through the table rebuild intact', () => {
    // The part a rebuild silently gets wrong. A snapshot is a director's saved
    // version of a week; losing one to a migration is unrecoverable.
    const db = preV59Db('v59-rows')
    // Real parent rows rather than switching foreign keys off: the point of
    // this test is that a genuine snapshot survives, and a fixture that could
    // only exist with constraints disabled would not prove that.
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Test Camp')
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind) VALUES (?, ?, ?, ?)')
      .run('tpl-1', 'camp-1', 'Manual', 'manual')
    db.prepare(
      `INSERT INTO schedule_snapshots (id, template_id, name, is_auto, created_at, slots, day_overrides_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('snap-1', 'tpl-1', 'Week of the 4th', 0, '2026-07-04T00:00:00.000Z', '[{"a":1}]', '[{"kind":"swap"}]')

    initSchema(db)

    const row = db.prepare('SELECT * FROM schedule_snapshots WHERE id = ?').get('snap-1')
    expect(row).toBeTruthy()
    expect(row.name).toBe('Week of the 4th')
    expect(row.created_at).toBe('2026-07-04T00:00:00.000Z')
    expect(row.slots).toBe('[{"a":1}]')
    expect(row.template_id).toBe('tpl-1')
    expect(row.is_auto).toBe(0)
    // The discarded half — deliberate, per the v53 precedent.
    expect('day_overrides_json' in row).toBe(false)
    db.close()
  })

  it('is idempotent — re-running initSchema on an already-migrated db is a no-op', () => {
    const db = freshDb()
    const before = db.prepare('SELECT COUNT(*) c FROM schedule_snapshots').get().c
    initSchema(db)
    initSchema(db)
    expect(tableExists(db, 'day_overrides')).toBe(false)
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_snapshots').get().c).toBe(before)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('the rollback restores the SHAPE, and says plainly that it does not restore DATA', () => {
    const db = preV59Db('v59-rollback')
    expect(tableExists(db, 'day_overrides')).toBe(true)
    expect(columns(db, 'schedule_snapshots')).toContain('day_overrides_json')

    initSchema(db)
    expect(tableExists(db, 'day_overrides')).toBe(false)

    const result = rollbackV59(db)
    expect(tableExists(db, 'day_overrides')).toBe(true)
    expect(columns(db, 'schedule_snapshots')).toContain('day_overrides_json')
    // Honest about the cost: the shape comes back, the rows never do.
    expect(result.dataRestored).toBe(false)
    // And the version must fall below 59 so the next initSchema re-drops it —
    // the >= 59 delete, not = 59 (v32_down/v46_down precedent).
    expect(getSchemaVersion(db)).toBeLessThan(59)
    db.close()
  })

  // Code Reviewer round 2 (MEDIUM) — the v53 block's `hasDayOverridesJson`
  // TRUE branch had no coverage. Every other fixture in this file reaches v53
  // with the column already absent, so the conditional only ever took the
  // "missing" path, and the comment's claim that a genuine v52 database still
  // carries its data forward was prose, not proof.
  //
  // This builds that database the hard way — schema.sql's CURRENT shape, then
  // the column ALTER-added back the way v38 did, then schema_migrations wound
  // back to 52 — so v53 executes with the column PRESENT, exactly as it did
  // for every real device before T145.
  it('v53 still carries a real pre-T145 db\'s day_overrides_json forward, then v59 drops it', () => {
    const db = new Database(tmpFile('v53-true-branch'))
    db.pragma('foreign_keys = ON')
    initSchema(db)
    db.exec('ALTER TABLE schedule_snapshots ADD COLUMN day_overrides_json TEXT')
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Test Camp')
    db.prepare('INSERT INTO schedule_templates (id, camp_id, name, kind) VALUES (?, ?, ?, ?)')
      .run('tpl-1', 'camp-1', 'Manual', 'manual')
    db.prepare(
      `INSERT INTO schedule_snapshots (id, template_id, name, is_auto, created_at, slots, day_overrides_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('snap-v52', 'tpl-1', 'Pre-T145 version', 0, '2026-05-01T00:00:00.000Z', '[{"s":1}]', '[{"kind":"swap"}]')

    // Wind back to v52 so v53 runs against a column-present table.
    db.prepare('DELETE FROM schema_migrations WHERE version >= 53').run()
    expect(columns(db, 'schedule_snapshots')).toContain('day_overrides_json')

    initSchema(db)

    // v53 carried it (the TRUE branch), then v59 dropped it — and the row and
    // its other columns survived BOTH rebuilds.
    const row = db.prepare('SELECT * FROM schedule_snapshots WHERE id = ?').get('snap-v52')
    expect(row).toBeTruthy()
    expect(row.name).toBe('Pre-T145 version')
    expect(row.slots).toBe('[{"s":1}]')
    expect(row.created_at).toBe('2026-05-01T00:00:00.000Z')
    expect(columns(db, 'schedule_snapshots')).not.toContain('day_overrides_json')
    expect(tableExists(db, 'day_overrides')).toBe(false)
    db.close()
  })

  it('day_overrides_json is the LAST column after rollback, matching how v38 added it', () => {
    // Column order is load-bearing here — see the v53 block's comment in
    // localDb.js and the v50 column-order trap (bug #194).
    const db = preV59Db('v59-colorder')
    const cols = columns(db, 'schedule_snapshots')
    expect(cols[cols.length - 1]).toBe('day_overrides_json')
    db.close()
  })
})
