// @vitest-environment node
//
// Migration v28 — week_activity_exclusions and week_group_exclusions tables.
// docs/adr/2026-08-03-multi-week-slices-2-3.md
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

// A database rolled back to the v27 shape (schedule_weeks exists, no exclusion
// tables) so v28 can be exercised against it.
function preV28Db() {
  const file = path.join(os.tmpdir(), `shoresh-excl-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = openLocalDb(file) // fully migrated to current
  db.pragma('foreign_keys = OFF')
  db.exec(`
    DROP TABLE IF EXISTS week_activity_exclusions;
    DROP TABLE IF EXISTS week_group_exclusions;
    DROP INDEX IF EXISTS idx_week_activity_exclusions_week_activity;
    DROP INDEX IF EXISTS idx_week_group_exclusions_week_group;
  `)
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 28').run()
  return db
}

function seedCamp(db, campId) {
  db.prepare('INSERT OR IGNORE INTO camps (id, name) VALUES (?, ?)').run(campId, `Camp ${campId}`)
}

function seedWeek(db, weekId, campId) {
  db.prepare(
    'INSERT OR IGNORE INTO schedule_weeks (id, camp_id, name, sort_order, is_archived) VALUES (?, ?, ?, 0, 0)'
  ).run(weekId, campId, 'Week 1')
}

function seedActivity(db, actId, campId) {
  db.prepare("INSERT OR IGNORE INTO activities (id, camp_id, name) VALUES (?, ?, '')").run(actId, campId)
}

function seedGroup(db, grpId, campId) {
  db.prepare("INSERT OR IGNORE INTO groups (id, camp_id, name) VALUES (?, ?, '')").run(grpId, campId)
}

describe('migration v28: week exclusion tables', () => {
  it('migrates a v27 db to v28: both tables and both unique indexes exist', () => {
    const db = preV28Db()
    expect(getSchemaVersion(db)).toBe(27)

    initSchema(db)

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)

    const actTable = db.pragma('table_info(week_activity_exclusions)')
    expect(actTable.map((c) => c.name)).toEqual(expect.arrayContaining(['id', 'week_id', 'activity_id']))

    const grpTable = db.pragma('table_info(week_group_exclusions)')
    expect(grpTable.map((c) => c.name)).toEqual(expect.arrayContaining(['id', 'week_id', 'group_id']))

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name)
    expect(indexes).toContain('idx_week_activity_exclusions_week_activity')
    expect(indexes).toContain('idx_week_group_exclusions_week_group')

    db.close()
  })

  it('does not alter existing rows in other tables during migration', () => {
    const db = preV28Db()
    seedCamp(db, 'camp1')
    seedWeek(db, 'week1', 'camp1')
    seedActivity(db, 'act1', 'camp1')
    seedGroup(db, 'grp1', 'camp1')

    initSchema(db)

    expect(db.prepare('SELECT id FROM schedule_weeks WHERE id = ?').get('week1')).toBeTruthy()
    expect(db.prepare('SELECT id FROM activities WHERE id = ?').get('act1')).toBeTruthy()
    expect(db.prepare('SELECT id FROM groups WHERE id = ?').get('grp1')).toBeTruthy()
    db.close()
  })

  it('is idempotent — a second open does not duplicate tables or indexes', () => {
    const db = preV28Db()
    initSchema(db) // runs v28
    db.prepare('DELETE FROM schema_migrations WHERE version >= 28').run()
    initSchema(db) // re-run

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    const actTables = db.prepare(
      "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='week_activity_exclusions'"
    ).get()
    expect(actTables.c).toBe(1)
    db.close()
  })

  it('hard-block: a db at a future version is refused', () => {
    const file = path.join(os.tmpdir(), `shoresh-excl-future-${Date.now()}.sqlite`)
    files.push(file)
    // Create a db at current version then bump schema_migrations to simulate a
    // future build.
    const db = openLocalDb(file)
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      CURRENT_SCHEMA_VERSION + 1,
      new Date().toISOString()
    )
    db.close()

    expect(() => openLocalDb(file)).toThrow()
    // Confirm the thrown error carries the schema_too_new code via the message
    // (the code property is on the Error but openLocalDb wraps it only for
    // schema_too_new — verify the thrown value is the right kind).
    let caught
    try { openLocalDb(file) } catch (e) { caught = e }
    expect(caught).toBeDefined()
    expect(caught.code ?? caught.message).toMatch(/schema_too_new|newer version/)
  })
})
