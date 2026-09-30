// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb, getSchemaVersion, CURRENT_SCHEMA_VERSION } from '../localDb.js'
import { rollbackV72 } from './v72_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-v72down-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

describe('rollbackV72', () => {
  it('removes schema_migrations rows >= 72 and leaves getSchemaVersion at 71', () => {
    const db = freshDb()

    rollbackV72(db)

    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version >= 72').get().c).toBe(0)
    expect(getSchemaVersion(db)).toBe(71)
    db.close()
  })

  it('leaves lower-version schema_migrations rows in place', () => {
    const db = freshDb()

    rollbackV72(db)

    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 71').get().c).toBe(1)
    db.close()
  })

  it('does not drop the tombstones table or any of its rows', () => {
    const db = freshDb()
    db.prepare(
      'INSERT INTO tombstones (id, entity, version, sig, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('ts1', 'campers:camper1', 3, 'sig-bytes-base64', '2026-09-30T00:00:00.000Z')

    rollbackV72(db)

    expect(
      db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='tombstones'").get().c
    ).toBe(1)
    const row = db.prepare('SELECT * FROM tombstones WHERE id = ?').get('ts1')
    expect(row).toEqual({
      id: 'ts1',
      entity: 'campers:camper1',
      version: 3,
      sig: 'sig-bytes-base64',
      created_at: '2026-09-30T00:00:00.000Z',
    })
    db.close()
  })

  it('is idempotent — running twice does not error, and a tombstone row survives the second run', () => {
    const db = freshDb()
    db.prepare(
      'INSERT INTO tombstones (id, entity, version, sig, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('ts1', 'campers:camper1', 3, 'sig-bytes-base64', '2026-09-30T00:00:00.000Z')

    rollbackV72(db)
    expect(() => rollbackV72(db)).not.toThrow()

    const row = db.prepare('SELECT * FROM tombstones WHERE id = ?').get('ts1')
    expect(row).toEqual({
      id: 'ts1',
      entity: 'campers:camper1',
      version: 3,
      sig: 'sig-bytes-base64',
      created_at: '2026-09-30T00:00:00.000Z',
    })
    db.close()
  })

  // KNOWN-GAP / CHARACTERIZATION TEST — asserts the CURRENT WRONG behaviour of localDb.js's v73
  // forward block ON PURPOSE (see this module's header, point 5). Reopening a database that this
  // rollback has taken below 72 re-runs every forward block from v73 up; v73's nine-table rebuild
  // (electron/db/localDb.js, guard `>= 72 && < 73`) enumerates an explicit column list rather than
  // `SELECT *`, and that list predates `activities.catalog_role` (added by v75). The rebuild
  // silently drops the column's data, then v75 re-adds it as all-NULL. This is a defect in
  // localDb.js's v73 block, not in this rollback -- equally reachable via v73_down.js alone -- and
  // is pinned here because this is the module that would otherwise claim reopening is harmless.
  //
  // When localDb.js's v73 block is fixed to preserve later-added columns (e.g. by rebuilding from
  // the live `table_info(activities)` column list instead of a hardcoded one), THIS TEST GOES RED.
  // The correct response then is to flip the final assertion to `'pinned_event'` and delete the
  // corresponding warning from this module's header and CLI message -- not to delete this test.
  it('KNOWN GAP: reopening after this rollback silently drops activities.catalog_role (v73 rebuild re-fires with a stale column list)', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO activities (id, camp_id, name, catalog_role) VALUES ('act1', 'camp1', 'Swim', 'pinned_event')"
    ).run()

    // Non-vacuity: prove the column actually held the value BEFORE the rollback touches anything.
    // If this assertion failed, the test below would be proving nothing about loss -- there'd be
    // nothing to lose.
    expect(db.prepare('SELECT catalog_role FROM activities WHERE id = ?').get('act1').catalog_role).toBe(
      'pinned_event'
    )

    rollbackV72(db)
    const file = db.name
    db.close()

    const reopened = openLocalDb(file)
    const row = reopened.prepare('SELECT * FROM activities WHERE id = ?').get('act1')
    expect(row).toBeDefined()
    expect(row.catalog_role).toBeNull()
    expect(getSchemaVersion(reopened)).toBe(CURRENT_SCHEMA_VERSION)
    reopened.close()
  })
})
