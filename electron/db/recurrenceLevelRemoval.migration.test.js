// @vitest-environment node
//
// Migration v71 — DROP the dead `recurrence_level` column (T181) from
// `anchor_activities` and `elective_sets`. Superseded by `kind`
// ('fixed'/'recurring'), `day_id` (NULL = every day), and `schedule_week_id`
// (NULL = every week) — see the ticket's confirmed sweep: no code path ever
// reads recurrence_level to branch, and none writes a non-default value.
// Neither column sits in an index or a CHECK constraint, so this is a plain
// `ALTER TABLE ... DROP COLUMN`, no table rebuild (v51/v59 precedent for the
// rebuild path; this one doesn't need it).
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'

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

const freshDb = () => openLocalDb(tmpFile('v71-fresh'))

// A db stopped at v70 — before the v71 migration runs — so the migration has
// something real to remove. Proves the column was actually present beforehand
// (non-vacuity), not just absent after.
function preV71Db(tag = 'v71-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.prepare('DELETE FROM schema_migrations WHERE version >= 71').run()
  db.exec("ALTER TABLE anchor_activities ADD COLUMN recurrence_level TEXT NOT NULL DEFAULT 'daily'")
  db.exec("ALTER TABLE elective_sets ADD COLUMN recurrence_level TEXT NOT NULL DEFAULT 'daily'")
  return db
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)

describe('migration v71: recurrence_level removal', () => {
  it('CURRENT_SCHEMA_VERSION is 71', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(74)
  })

  it('is present at v70, before the v71 migration runs (non-vacuity)', () => {
    const db = preV71Db()
    expect(columns(db, 'anchor_activities')).toContain('recurrence_level')
    expect(columns(db, 'elective_sets')).toContain('recurrence_level')
    expect(getSchemaVersion(db)).toBe(70)
    db.close()
  })

  it('removes recurrence_level from both tables when migrating v70 -> v71', () => {
    const db = preV71Db()

    initSchema(db)

    expect(columns(db, 'anchor_activities')).not.toContain('recurrence_level')
    expect(columns(db, 'elective_sets')).not.toContain('recurrence_level')
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 71').get().c).toBe(1)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('a fresh install has the same shape as a migrated db — neither has recurrence_level', () => {
    const fresh = freshDb()
    const migrated = preV71Db('v71-parity')
    initSchema(migrated)

    expect(columns(fresh, 'anchor_activities')).not.toContain('recurrence_level')
    expect(columns(fresh, 'elective_sets')).not.toContain('recurrence_level')
    expect(columns(fresh, 'anchor_activities')).toEqual(columns(migrated, 'anchor_activities'))
    expect(columns(fresh, 'elective_sets')).toEqual(columns(migrated, 'elective_sets'))
    fresh.close()
    migrated.close()
  })

  it('the columns that actually drive recurrence survive the migration', () => {
    const db = preV71Db()
    initSchema(db)

    const anchorCols = columns(db, 'anchor_activities')
    expect(anchorCols).toContain('kind')
    expect(anchorCols).toContain('day_id')
    expect(anchorCols).toContain('schedule_week_id')

    const electiveCols = columns(db, 'elective_sets')
    expect(electiveCols).toContain('day_id')
    expect(electiveCols).toContain('schedule_week_id')
    db.close()
  })
})
