// @vitest-environment node
//
// Migration v77 (T267, docs/adr/2026-09-26-fixed-recurring-event-identity-model.md). Renames anchor_activities to
// fixed_events and gives it a real activity_id, replacing the by-name link
// src/engine/anchorActivityLink.js resolved through (the T62 scar its header describes).
//
// PR 1 scope only: schema + document-key rename + projection registration + backfill. This file
// pins the backfill's three outcomes (zero candidates, two candidates, exactly one candidate),
// the fresh-vs-migrated column-order parity (the column-order trap this repo has been bitten by
// before), and that the rollback restores the original table shape.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV77 } from './rollback/v77_down.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function tmpFile(tag) {
  const file = path.join(os.tmpdir(), `shoresh-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return file
}

function freshDb() {
  return openLocalDb(tmpFile('v77-fresh'))
}

// A database migrated fully forward, then rolled back to the pre-v77 shape (table named
// anchor_activities, no activity_id column, no fixed_event_identity_gaps table) so v77 can be
// exercised against it — mirroring every other *.migration.test.js's preVNNDb() shape in this file.
function preV77Db(tag = 'v77-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  rollbackV77(db)
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

const seedCamp = (db, campId = 'camp1') =>
  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES (?, 'Camp', 'sec')").run(campId)

describe('migration v77: fresh vs migrated equivalence', () => {
  it('declares schema version 77 and renames anchor_activities to fixed_events', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(77)
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fixed_events'").get()
    ).toBeTruthy()
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='anchor_activities'").get()
    ).toBeUndefined()
    db.close()
  })

  it('gives fresh and migrated identical fixed_events columns, in the same order', () => {
    const fresh = freshDb()
    const migrated = preV77Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'fixed_events')).toEqual(tableInfo(fresh, 'fixed_events'))
    fresh.close()
    migrated.close()
  })

  it('declares fixed_events columns in order, activity_id LAST', () => {
    const db = freshDb()
    expect(db.pragma('table_info(fixed_events)').map((c) => c.name)).toEqual([
      'id', 'camp_id', 'cohort_id', 'day_id', 'time_block_id', 'name', 'unit_id', 'span_blocks',
      'is_all_groups', 'group_ids', 'notes', 'schedule_week_id', 'location_id', 'kind', 'unit_ids',
      'activity_id',
    ])
    db.close()
  })

  it('a fresh install has fixed_event_identity_gaps with the declared columns', () => {
    const db = freshDb()
    expect(db.pragma('table_info(fixed_event_identity_gaps)').map((c) => c.name)).toEqual([
      'id', 'camp_id', 'fixed_event_id', 'name', 'candidate_count', 'created_at',
    ])
    db.close()
  })

  it('is idempotent — re-running v77 does not duplicate the column or the gaps table', () => {
    const db = preV77Db()
    seedCamp(db)
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a1', 'camp1', 'Lunch')").run()
    initSchema(db) // runs v77
    db.prepare('DELETE FROM schema_migrations WHERE version >= 77').run()
    // Re-running the rename must not throw on a table that no longer has the old name; the
    // migration itself guards with `hasOld = tableExists('anchor_activities')`, so verify the
    // second pass is a genuine no-op on the rename while still safe.
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.pragma('table_info(fixed_events)').filter((c) => c.name === 'activity_id')).toHaveLength(1)
    db.close()
  })
})

describe('migration v77: backfill resolves fixed_events.activity_id by name-match', () => {
  it('sets activity_id when exactly one catalog activity matches by name', () => {
    const db = preV77Db()
    seedCamp(db)
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-swim', 'camp1', 'Swim')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-one', 'camp1', 'Swim')").run()

    initSchema(db)

    const row = db.prepare('SELECT activity_id FROM fixed_events WHERE id = ?').get('a-one')
    expect(row.activity_id).toBe('act-swim')
    expect(db.prepare('SELECT COUNT(*) c FROM fixed_event_identity_gaps WHERE fixed_event_id = ?').get('a-one').c).toBe(0)
    db.close()
  })

  it('matches case- and whitespace-insensitively (anchorNameKey semantics)', () => {
    const db = preV77Db()
    seedCamp(db)
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-swim', 'camp1', 'Swim  Time')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-one', 'camp1', 'swim time')").run()

    initSchema(db)

    expect(db.prepare('SELECT activity_id FROM fixed_events WHERE id = ?').get('a-one').activity_id).toBe('act-swim')
    db.close()
  })

  it('leaves activity_id NULL and records a gap for zero candidates', () => {
    const db = preV77Db()
    seedCamp(db)
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-zero', 'camp1', 'Mifkad')").run()

    initSchema(db)

    const row = db.prepare('SELECT activity_id FROM fixed_events WHERE id = ?').get('a-zero')
    expect(row.activity_id).toBeNull()
    const gap = db.prepare('SELECT * FROM fixed_event_identity_gaps WHERE fixed_event_id = ?').get('a-zero')
    expect(gap).toBeTruthy()
    expect(gap.candidate_count).toBe(0)
    expect(gap.name).toBe('Mifkad')
    expect(gap.camp_id).toBe('camp1')
    db.close()
  })

  it('leaves activity_id NULL and records a gap for two-or-more candidates', () => {
    const db = preV77Db()
    seedCamp(db)
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-lunch-1', 'camp1', 'Lunch')").run()
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-lunch-2', 'camp1', 'lunch')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-two', 'camp1', 'Lunch')").run()

    initSchema(db)

    const row = db.prepare('SELECT activity_id FROM fixed_events WHERE id = ?').get('a-two')
    expect(row.activity_id).toBeNull()
    const gap = db.prepare('SELECT * FROM fixed_event_identity_gaps WHERE fixed_event_id = ?').get('a-two')
    expect(gap).toBeTruthy()
    expect(gap.candidate_count).toBe(2)
    db.close()
  })

  it('all three outcomes together in one migration pass — non-vacuity: distinct fixed_events rows land in distinct buckets', () => {
    const db = preV77Db()
    seedCamp(db)
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-swim', 'camp1', 'Swim')").run()
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-lunch-1', 'camp1', 'Lunch')").run()
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-lunch-2', 'camp1', 'lunch')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-one', 'camp1', 'Swim')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-zero', 'camp1', 'Mifkad')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-two', 'camp1', 'Lunch')").run()

    initSchema(db)

    const byId = (id) => db.prepare('SELECT activity_id FROM fixed_events WHERE id = ?').get(id)
    expect(byId('a-one').activity_id).toBe('act-swim')
    expect(byId('a-zero').activity_id).toBeNull()
    expect(byId('a-two').activity_id).toBeNull()
    const gaps = db.prepare('SELECT fixed_event_id, candidate_count FROM fixed_event_identity_gaps ORDER BY fixed_event_id').all()
    expect(gaps).toEqual([
      { fixed_event_id: 'a-two', candidate_count: 2 },
      { fixed_event_id: 'a-zero', candidate_count: 0 },
    ])
    db.close()
  })

  it('scopes name-matching to the same camp — a same-named activity in a different camp is not a candidate', () => {
    const db = preV77Db()
    seedCamp(db, 'camp1')
    seedCamp(db, 'camp2')
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-other-camp', 'camp2', 'Swim')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-one', 'camp1', 'Swim')").run()

    initSchema(db)

    // Zero candidates WITHIN camp1, even though camp2 has a same-named row — proves the backfill
    // is camp-scoped, not a global name index (this app is one-camp-per-device in practice, but the
    // migration must not silently cross-link camps if that invariant is ever relaxed).
    expect(db.prepare('SELECT activity_id FROM fixed_events WHERE id = ?').get('a-one').activity_id).toBeNull()
    expect(db.prepare('SELECT candidate_count FROM fixed_event_identity_gaps WHERE fixed_event_id = ?').get('a-one').candidate_count).toBe(0)
    db.close()
  })
})

describe('rollbackV77', () => {
  it('restores anchor_activities with its original columns and drops the new table', () => {
    const db = freshDb()
    seedCamp(db)
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-swim', 'camp1', 'Swim')").run()
    db.prepare("INSERT INTO fixed_events (id, camp_id, name, activity_id) VALUES ('a1', 'camp1', 'Swim', 'act-swim')").run()

    const result = rollbackV77(db)

    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='anchor_activities'").get()
    ).toBeTruthy()
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fixed_events'").get()
    ).toBeUndefined()
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fixed_event_identity_gaps'").get()
    ).toBeUndefined()
    const cols = db.pragma('table_info(anchor_activities)').map((c) => c.name)
    expect(cols).not.toContain('activity_id')
    // The row itself survives — only activity_id is lost, same posture as every other *_down.js.
    expect(db.prepare("SELECT name FROM anchor_activities WHERE id = 'a1'").get().name).toBe('Swim')
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 77').get().c).toBe(0)
    expect(result.renamed).toEqual(['fixed_events -> anchor_activities'])
    db.close()
  })

  it('never strands a higher schema version (uses >= not =)', () => {
    const db = freshDb()
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (78, ?)').run(
      new Date().toISOString()
    )
    rollbackV77(db)
    expect(getSchemaVersion(db)).toBeLessThan(77)
    db.close()
  })
})
