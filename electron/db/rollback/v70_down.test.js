// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, getSchemaVersion } from '../localDb.js'
import { rollbackV70 } from './v70_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-v70down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

describe('rollbackV70', () => {
  it('drops idx_days_of_operation_camp_day and reverts the schema_migrations row', () => {
    const db = freshDb()

    rollbackV70(db)

    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_days_of_operation_camp_day'").get()
    ).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 70').get().c).toBe(0)
    expect(getSchemaVersion(db)).toBe(69)
    db.close()
  })

  it('clears the durable domain_state_migration_pending marker for version 70', () => {
    const db = freshDb()
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp1', 'Camp')
    db.prepare(
      "INSERT INTO domain_state_migration_pending (version, detail, created_at) VALUES (70, 'test', ?)"
    ).run(new Date().toISOString())

    rollbackV70(db)

    expect(db.prepare('SELECT * FROM domain_state_migration_pending WHERE version = 70').get()).toBeUndefined()
    db.close()
  })

  it('never strands a higher schema version (uses >= not =)', () => {
    const db = freshDb()
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (71, ?)').run(
      new Date().toISOString()
    )

    rollbackV70(db)

    expect(getSchemaVersion(db)).toBeLessThan(71)
    db.close()
  })
})
