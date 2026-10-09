// T350 — rollbackV92 drops special_day_placements and nothing else.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, getSchemaVersion } from '../localDb.js'
import { rollbackV92 } from './v92_down.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s)
  }
})
function tmpFile(tag) {
  const file = path.join(os.tmpdir(), `shoresh-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return file
}
const hasTable = (db) =>
  db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table' AND name = 'special_day_placements'").get().c > 0

describe('rollbackV92', () => {
  it('drops the table, reports discarded bindings, clears version >= 92, and is idempotent', () => {
    const db = openLocalDb(tmpFile('v92-down'))
    db.prepare("INSERT INTO camps (id, name) VALUES ('c1', 'Camp')").run()
    db.prepare("INSERT INTO schedule_weeks (id, camp_id, name) VALUES ('w1', 'c1', 'Week 1')").run()
    db.prepare("INSERT INTO special_day_placements (id, week_id, day_id, special_day_id) VALUES ('p1', 'w1', 'd', 's')").run()
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (93, ?)').run(new Date().toISOString())
    expect(rollbackV92(db).discarded).toEqual({ specialDayPlacements: 1 })
    expect(hasTable(db)).toBe(false)
    expect(getSchemaVersion(db)).toBe(91)
    expect(db.prepare('SELECT COUNT(*) c FROM schedule_weeks').get().c).toBe(1)
    expect(rollbackV92(db).discarded).toEqual({ specialDayPlacements: 0 })
    db.close()
  })
})
