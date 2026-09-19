// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, getSchemaVersion } from '../localDb.js'
import { rollbackV71 } from './v71_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-v71down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)

describe('rollbackV71', () => {
  it('re-adds recurrence_level to both tables and reverts the schema_migrations row', () => {
    const db = freshDb()
    expect(columns(db, 'anchor_activities')).not.toContain('recurrence_level')
    expect(columns(db, 'elective_sets')).not.toContain('recurrence_level')

    rollbackV71(db)

    expect(columns(db, 'anchor_activities')).toContain('recurrence_level')
    expect(columns(db, 'elective_sets')).toContain('recurrence_level')
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 71').get().c).toBe(0)
    expect(getSchemaVersion(db)).toBe(70)
    db.close()
  })

  it('restores the column at its DEFAULT for every existing row', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare(
      'INSERT INTO anchor_activities (id, camp_id, name) VALUES (?, ?, ?)'
    ).run('a1', 'camp1', 'Flag Raising')

    rollbackV71(db)

    const row = db.prepare('SELECT recurrence_level FROM anchor_activities WHERE id = ?').get('a1')
    expect(row.recurrence_level).toBe('daily')
    db.close()
  })

  it('never strands a higher schema version (uses >= not =)', () => {
    const db = freshDb()
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (72, ?)').run(
      new Date().toISOString()
    )

    rollbackV71(db)

    expect(getSchemaVersion(db)).toBeLessThan(72)
    db.close()
  })

  it('is idempotent — running twice does not error on a column that already exists', () => {
    const db = freshDb()
    rollbackV71(db)
    expect(() => rollbackV71(db)).not.toThrow()
    expect(columns(db, 'anchor_activities')).toContain('recurrence_level')
    db.close()
  })
})
