// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, getSchemaVersion } from '../localDb.js'
import { rollbackV74 } from './v74_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-v74down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
const hasTable = (db, name) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0

describe('rollbackV74', () => {
  it('drops elective_run_outer_snapshots and the two run columns, reverting schema_migrations', () => {
    const db = freshDb()
    expect(hasTable(db, 'elective_run_outer_snapshots')).toBe(true)
    expect(columns(db, 'elective_assignment_runs')).toContain('finalized_at')

    rollbackV74(db)

    expect(hasTable(db, 'elective_run_outer_snapshots')).toBe(false)
    expect(columns(db, 'elective_assignment_runs')).not.toContain('finalized_at')
    expect(columns(db, 'elective_assignment_runs')).not.toContain('finalized_by')
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 74').get().c).toBe(0)
    expect(getSchemaVersion(db)).toBe(72)
    db.close()
  })

  it('never strands a higher schema version (uses >= not =)', () => {
    const db = freshDb()
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (75, ?)').run(
      new Date().toISOString()
    )

    rollbackV74(db)

    expect(getSchemaVersion(db)).toBeLessThan(75)
    db.close()
  })

  it('is idempotent — running twice does not error on an already-dropped table/column', () => {
    const db = freshDb()
    rollbackV74(db)
    expect(() => rollbackV74(db)).not.toThrow()
    expect(hasTable(db, 'elective_run_outer_snapshots')).toBe(false)
    db.close()
  })

  it('is non-destructive to the run row itself — only the two new columns are lost', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO elective_assignment_runs (id, camp_id, name, status) VALUES ('run1', 'camp1', 'Run', 'draft')"
    ).run()

    rollbackV74(db)

    const row = db.prepare('SELECT id, name, status FROM elective_assignment_runs WHERE id = ?').get('run1')
    expect(row).toEqual({ id: 'run1', name: 'Run', status: 'draft' })
    db.close()
  })
})
