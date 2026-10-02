// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../localDb.js'
import { rollbackV73 } from './v73_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-v73down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

describe('rollbackV73', () => {
  // v73_down rebuilds the nine relaxed tables to restore their name-UNIQUE constraint. It runs only
  // on a CURRENT (v84+) database, which has activities.catalog_role (v75). The rebuild must carry
  // that later-added column forward WITH ITS DATA, not drop it (the same defect class fixed on the
  // forward path). See docs/adr/2026-10-01-rebuild-migrations-carry-forward-later-columns.md.
  it('preserves a populated activities.catalog_role through the rebuild and restores UNIQUE(camp_id, name)', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO activities (id, camp_id, name, catalog_role) VALUES ('act1', 'camp1', 'Swim', 'pinned_event')"
    ).run()

    // Non-vacuity: the column holds the value before the rollback touches anything.
    expect(
      db.prepare('SELECT catalog_role FROM activities WHERE id = ?').get('act1').catalog_role
    ).toBe('pinned_event')

    rollbackV73(db)

    const row = db.prepare('SELECT * FROM activities WHERE id = ?').get('act1')
    expect(row).toBeDefined()
    expect(row.catalog_role).toBe('pinned_event')

    // UNIQUE(camp_id, name) restored: a duplicate name is now rejected.
    expect(() =>
      db
        .prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act2', 'camp1', 'Swim')")
        .run()
    ).toThrow(/UNIQUE/)

    db.close()
  })
})
