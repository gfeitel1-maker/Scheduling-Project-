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

  // Reopening a database that this rollback has taken below 72 re-runs every forward block from
  // v73 up; v73's nine-table rebuild (electron/db/localDb.js, guard `>= 72 && < 73`) rebuilds each
  // table from its LIVE column set (via rebuildTableCarryingColumns), so a column added by a LATER
  // migration — `activities.catalog_role` (v75) — is carried forward WITH ITS DATA rather than
  // silently dropped and re-added as all-NULL. This test pins that round-trip survival; it was the
  // KNOWN-GAP characterization test before the v73 block was fixed (see
  // docs/adr/2026-10-01-rebuild-migrations-carry-forward-later-columns.md).
  it('reopening after this rollback preserves activities.catalog_role (v73 rebuild carries later-added columns forward)', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO activities (id, camp_id, name, catalog_role) VALUES ('act1', 'camp1', 'Swim', 'pinned_event')"
    ).run()

    // Non-vacuity: prove the column actually held the value BEFORE the rollback touches anything.
    // If this assertion failed, the test below would be proving nothing about survival -- there'd
    // be nothing to preserve.
    expect(db.prepare('SELECT catalog_role FROM activities WHERE id = ?').get('act1').catalog_role).toBe(
      'pinned_event'
    )

    rollbackV72(db)
    const file = db.name
    db.close()

    const reopened = openLocalDb(file)
    const row = reopened.prepare('SELECT * FROM activities WHERE id = ?').get('act1')
    expect(row).toBeDefined()
    expect(row.catalog_role).toBe('pinned_event')
    expect(getSchemaVersion(reopened)).toBe(CURRENT_SCHEMA_VERSION)
    reopened.close()
  })
})
