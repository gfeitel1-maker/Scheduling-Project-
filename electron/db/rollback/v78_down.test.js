// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../localDb.js'
import { rollbackV78 } from './v78_down.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-v78down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = openLocalDb(file)
  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
  db.prepare("INSERT INTO elective_assignment_runs (id, camp_id, name) VALUES ('run1', 'camp1', 'Run')").run()
  return db
}

describe('rollbackV78', () => {
  it('drops occurrence_id and stamps the version back down when every row is single-occurrence', () => {
    const db = freshDb()
    db.prepare(
      "INSERT INTO elective_preferences (id, run_id, camper_id, occurrence_id, choice_id, rank) VALUES ('p1', 'run1', 'cam1', 'occ-1', 'choice1', 1)"
    ).run()

    const result = rollbackV78(db)
    expect(result.ok).toBe(true)
    expect(result.discarded.preferences).toBe(1)
    expect(db.pragma('table_info(elective_preferences)').map((c) => c.name)).not.toContain('occurrence_id')
    expect(db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v).toBe(74)
    db.close()
  })

  it('refuses and names the blocking rows when one (run, camper, choice) spans two occurrences', () => {
    const db = freshDb()
    db.prepare(
      "INSERT INTO elective_preferences (id, run_id, camper_id, occurrence_id, choice_id, rank) VALUES ('p1', 'run1', 'cam1', 'occ-1', 'choice1', 1)"
    ).run()
    db.prepare(
      "INSERT INTO elective_preferences (id, run_id, camper_id, occurrence_id, choice_id, rank) VALUES ('p2', 'run1', 'cam1', 'occ-2', 'choice1', 2)"
    ).run()

    const result = rollbackV78(db)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/refused/)
    expect(result.blocking).toHaveLength(1)
    expect(result.blocking[0]).toMatchObject({ run_id: 'run1', camper_id: 'cam1', choice_id: 'choice1' })
    // Nothing was touched — the table still has occurrence_id.
    expect(db.pragma('table_info(elective_preferences)').map((c) => c.name)).toContain('occurrence_id')
    db.close()
  })
})
