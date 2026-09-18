// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, getSchemaVersion } from '../localDb.js'
import { rollbackV68 } from './v68_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-v68down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

function seed(db) {
  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
  db.prepare("INSERT INTO elective_sets (id, camp_id, name) VALUES ('set1','camp1','Chugim')").run()
  db.prepare(
    "INSERT INTO elective_set_activities (id, elective_set_id, activity_id, status) VALUES ('m1','set1','act1','potential')"
  ).run()
  db.prepare(
    "INSERT INTO elective_set_activities (id, elective_set_id, activity_id, status) VALUES ('m2','set1','act2','confirmed')"
  ).run()
}

describe('rollbackV68', () => {
  it('drops the status column and reports how many potential offerings were discarded', () => {
    const db = freshDb()
    seed(db)

    const result = rollbackV68(db)

    expect(result.potentialOfferings).toBe(1)
    const cols = db.pragma('table_info(elective_set_activities)').map((c) => c.name)
    expect(cols).not.toContain('status')
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 68').get().c).toBe(0)
    expect(getSchemaVersion(db)).toBe(67)
    db.close()
  })

  it('preserves every other column and row on elective_set_activities', () => {
    const db = freshDb()
    seed(db)

    rollbackV68(db)

    const rows = db.prepare('SELECT id, elective_set_id, activity_id FROM elective_set_activities ORDER BY id').all()
    expect(rows).toEqual([
      { id: 'm1', elective_set_id: 'set1', activity_id: 'act1' },
      { id: 'm2', elective_set_id: 'set1', activity_id: 'act2' },
    ])
    db.close()
  })

  it('is idempotent — a second call on an already-rolled-back db is a no-op', () => {
    const db = freshDb()
    seed(db)

    rollbackV68(db)
    const second = rollbackV68(db)

    expect(second.potentialOfferings).toBe(0)
    db.close()
  })
})
