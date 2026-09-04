// @vitest-environment node
//
// Migration v51 — Fixed vs Recurring events: anchor_activities.kind
// (docs/adr/2026-08-28-fixed-vs-recurring-events.md §5/§8). Adds
// `kind TEXT NOT NULL DEFAULT 'fixed' CHECK (kind IN ('fixed', 'recurring'))`
// plus a table-level CHECK enforcing the §1 decision table as a stored
// invariant: a 'fixed' row must be is_all_groups=1, unit_id NULL,
// group_ids NULL/'[]'. SQLite ADD COLUMN cannot attach a cross-column CHECK
// to an existing table, so this migration recreates the table (same shape
// as v48/v49/v50), NOT a bare ALTER TABLE ADD COLUMN.
//
// Backfill is NOT a free DEFAULT (the trap the ADR names explicitly): every
// existing row's `kind` is computed from columns it already has —
// is_all_groups=1 AND unit_id IS NULL AND (group_ids IS NULL OR group_ids
// = '[]') => 'fixed', else 'recurring'. Mirrors anchorRecurrence.migration.
// test.js's fresh-vs-migrated shape for a recreate-shaped column addition.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV51 } from './rollback/v51_down.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
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
  return openLocalDb(tmpFile('v51-fresh'))
}

// A database migrated fully forward, then rolled back to the v50 shape (no
// anchor_activities.kind column, no CHECK), so v51 can be exercised against it.
function preV51Db(tag = 'v51-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  db.pragma('foreign_keys = OFF')
  db.exec('ALTER TABLE anchor_activities RENAME TO anchor_activities_tmp')
  db.exec(`CREATE TABLE anchor_activities (
    id TEXT PRIMARY KEY,
    camp_id TEXT NOT NULL REFERENCES camps(id),
    cohort_id TEXT REFERENCES cohorts(id),
    day_id TEXT REFERENCES days_of_operation(id),
    time_block_id TEXT,
    name TEXT,
    unit_id TEXT,
    span_blocks INTEGER,
    is_all_groups INTEGER,
    group_ids TEXT,
    notes TEXT,
    schedule_week_id TEXT REFERENCES schedule_weeks(id),
    recurrence_level TEXT NOT NULL DEFAULT 'daily',
    location_id TEXT
  )`)
  db.exec(`INSERT INTO anchor_activities
    (id, camp_id, cohort_id, day_id, time_block_id, name, unit_id, span_blocks,
     is_all_groups, group_ids, notes, schedule_week_id, recurrence_level, location_id)
    SELECT id, camp_id, cohort_id, day_id, time_block_id, name, unit_id, span_blocks,
           is_all_groups, group_ids, notes, schedule_week_id, recurrence_level, location_id
    FROM anchor_activities_tmp`)
  db.exec('DROP TABLE anchor_activities_tmp')
  db.pragma('foreign_keys = ON')
  db.prepare('DELETE FROM schema_migrations WHERE version >= 51').run()
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

describe('migration v51: fresh vs migrated equivalence', () => {
  it('declares schema version 51 on a fresh db and gives anchor_activities the kind column', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(55)
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 51').get().c).toBe(1)
    const cols = db.pragma('table_info(anchor_activities)').map((c) => c.name)
    expect(cols).toContain('kind')
    db.close()
  })

  it('migrates a pre-v51 db forward to 51', () => {
    const db = preV51Db()
    expect(getSchemaVersion(db)).toBe(50)
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    db.close()
  })

  it('gives fresh and migrated identical anchor_activities columns', () => {
    const fresh = freshDb()
    const migrated = preV51Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'anchor_activities')).toEqual(tableInfo(fresh, 'anchor_activities'))
    fresh.close()
    migrated.close()
  }, 30000)

  it('declares anchor_activities columns in order, kind last', () => {
    const db = freshDb()
    expect(db.pragma('table_info(anchor_activities)').map((c) => c.name)).toEqual([
      'id', 'camp_id', 'cohort_id', 'day_id', 'time_block_id', 'name', 'unit_id', 'span_blocks',
      'is_all_groups', 'group_ids', 'notes', 'schedule_week_id', 'recurrence_level', 'location_id', 'kind',
    ])
    db.close()
  })

  it('schema.sql and localDb.js agree on the anchor_activities CREATE TABLE shape', () => {
    const schemaText = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    const match = schemaText.match(/CREATE TABLE IF NOT EXISTS anchor_activities \([\s\S]*?\n\);/)
    expect(match, 'expected an anchor_activities CREATE TABLE block in schema.sql').toBeTruthy()
    expect(match[0]).toContain("kind TEXT NOT NULL DEFAULT 'fixed' CHECK (kind IN ('fixed', 'recurring'))")
  })

  describe('backfill rule — deterministic from existing scope columns, not a free DEFAULT', () => {
    // §1 decision-table rows + edge case 3 (a group_ids row covering every group).
    it('classifies rows per the §5 step-2 rule and writes no op-log entry for the backfill', () => {
      const db = preV51Db()
      db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
      db.prepare("INSERT INTO groups (id, camp_id, name, tier_id) VALUES ('g1', 'camp1', 'Group 1', 't1')").run()
      db.prepare("INSERT INTO groups (id, camp_id, name, tier_id) VALUES ('g2', 'camp1', 'Group 2', 't1')").run()

      const insertAnchor = db.prepare(
        `INSERT INTO anchor_activities (id, camp_id, name, unit_id, is_all_groups, group_ids)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      // (a) all-groups anchor — no unit_id, is_all_groups=1, no group_ids.
      insertAnchor.run('a-all', 'camp1', 'Flagpole', null, 1, null)
      // (b) unit_id-scoped anchor.
      insertAnchor.run('a-unit', 'camp1', 'Division Swim', 't1', 0, null)
      // (c) group_ids-scoped anchor, a proper subset.
      insertAnchor.run('a-subset', 'camp1', 'Lunch A', null, 0, JSON.stringify(['g1']))
      // (d) group_ids-scoped anchor that happens to list every group id in
      //     the camp (§1 edge case 3) — stays Recurring, classification is
      //     by column shape, not by evaluating the current roster.
      insertAnchor.run('a-covering', 'camp1', 'Lunch Everyone', null, 0, JSON.stringify(['g1', 'g2']))
      // (e) is_all_groups=1 but group_ids also non-empty (never produced by
      //     the app, but a hand-edited/legacy row) — the backfill rule (and
      //     the CHECK it must satisfy) requires ALL THREE conditions for
      //     'fixed', so a non-empty group_ids disqualifies it even though
      //     is_all_groups=1: backfills to 'recurring'.
      insertAnchor.run('a-all-stale-groups', 'camp1', 'Weird Legacy Row', null, 1, JSON.stringify(['g1']))
      // (f) is_all_groups NULL, no unit_id, group_ids '[]' string (today's
      //     "empty scope" shape some writers leave behind) — not is_all_groups=1,
      //     so this backfills to 'recurring' per the rule as written.
      insertAnchor.run('a-null-scope', 'camp1', 'Untouched Stub', null, null, '[]')

      const opCountBefore = db.prepare('SELECT COUNT(*) c FROM operations').get().c

      initSchema(db) // runs v51

      const kindOf = (id) => db.prepare('SELECT kind FROM anchor_activities WHERE id = ?').get(id).kind
      expect(kindOf('a-all')).toBe('fixed')
      expect(kindOf('a-unit')).toBe('recurring')
      expect(kindOf('a-subset')).toBe('recurring')
      expect(kindOf('a-covering')).toBe('recurring')
      expect(kindOf('a-all-stale-groups')).toBe('recurring')
      expect(kindOf('a-null-scope')).toBe('recurring')

      // No op-log row emitted for the backfill — a DDL-time side effect,
      // same precedent as the v32 locations backfill.
      const opCountAfter = db.prepare('SELECT COUNT(*) c FROM operations').get().c
      expect(opCountAfter).toBe(opCountBefore)
      expect(
        db.prepare("SELECT COUNT(*) c FROM operations WHERE entity = 'anchor_activities' AND field = 'kind'").get().c
      ).toBe(0)
      db.close()
    })
  })

  it('CHECK constraint rejects a hand-constructed row where kind=fixed but scope is not all-groups', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    expect(() =>
      db.prepare(
        `INSERT INTO anchor_activities (id, camp_id, name, kind, is_all_groups, group_ids)
         VALUES ('bad', 'camp1', 'Invalid Fixed', 'fixed', 0, '["g1"]')`
      ).run()
    ).toThrow(/CHECK constraint failed/)
    db.close()
  })

  it('CHECK constraint rejects kind=fixed with a unit_id set', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    expect(() =>
      db.prepare(
        `INSERT INTO anchor_activities (id, camp_id, name, kind, unit_id, is_all_groups)
         VALUES ('bad2', 'camp1', 'Invalid Fixed', 'fixed', 't1', 1)`
      ).run()
    ).toThrow(/CHECK constraint failed/)
    db.close()
  })

  it('CHECK constraint accepts a valid fixed row and a valid recurring row', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    expect(() =>
      db.prepare(
        `INSERT INTO anchor_activities (id, camp_id, name, kind, is_all_groups, group_ids)
         VALUES ('good-fixed', 'camp1', 'Flagpole', 'fixed', 1, NULL)`
      ).run()
    ).not.toThrow()
    expect(() =>
      db.prepare(
        `INSERT INTO anchor_activities (id, camp_id, name, kind, is_all_groups, group_ids)
         VALUES ('good-recurring', 'camp1', 'Lunch', 'recurring', 0, '["g1"]')`
      ).run()
    ).not.toThrow()
    db.close()
  })

  it('is idempotent — re-running v51 does not duplicate the column or lose data', () => {
    const db = preV51Db()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO anchor_activities (id, camp_id, name, unit_id, is_all_groups, group_ids) VALUES ('a1', 'camp1', 'Division Swim', 't1', 0, NULL)"
    ).run()
    initSchema(db) // runs v51
    expect(db.prepare('SELECT kind FROM anchor_activities WHERE id = ?').get('a1').kind).toBe('recurring')
    db.prepare("UPDATE anchor_activities SET kind = 'recurring' WHERE id = 'a1'").run()
    db.prepare('DELETE FROM schema_migrations WHERE version >= 51').run()
    initSchema(db) // re-run v51 (no-op: column already present)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.pragma('table_info(anchor_activities)').filter((c) => c.name === 'kind')).toHaveLength(1)
    expect(db.prepare('SELECT kind FROM anchor_activities WHERE id = ?').get('a1').kind).toBe('recurring')
    db.close()
  })

  describe('cross-device backfill determinism', () => {
    // §5's "same device-independent function" claim, made executable: two DB
    // fixtures seeded with the same anchor_activities rows in different
    // insertion order must produce identical kind values after migrating.
    it('produces identical kind values regardless of row insertion order', () => {
      const rows = [
        { id: 'r1', unit_id: null, is_all_groups: 1, group_ids: null },
        { id: 'r2', unit_id: 't1', is_all_groups: 0, group_ids: null },
        { id: 'r3', unit_id: null, is_all_groups: 0, group_ids: JSON.stringify(['g1']) },
        { id: 'r4', unit_id: null, is_all_groups: 1, group_ids: '[]' },
      ]

      const dbA = preV51Db('order-a')
      dbA.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
      const insertA = dbA.prepare(
        'INSERT INTO anchor_activities (id, camp_id, name, unit_id, is_all_groups, group_ids) VALUES (?, ?, ?, ?, ?, ?)'
      )
      for (const r of rows) insertA.run(r.id, 'camp1', r.id, r.unit_id, r.is_all_groups, r.group_ids)
      initSchema(dbA)

      const dbB = preV51Db('order-b')
      dbB.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
      const insertB = dbB.prepare(
        'INSERT INTO anchor_activities (id, camp_id, name, unit_id, is_all_groups, group_ids) VALUES (?, ?, ?, ?, ?, ?)'
      )
      for (const r of [...rows].reverse()) insertB.run(r.id, 'camp1', r.id, r.unit_id, r.is_all_groups, r.group_ids)
      initSchema(dbB)

      const kindsOf = (db) =>
        Object.fromEntries(
          db.prepare('SELECT id, kind FROM anchor_activities ORDER BY id').all().map((r) => [r.id, r.kind])
        )
      expect(kindsOf(dbA)).toEqual(kindsOf(dbB))
      expect(kindsOf(dbA)).toEqual({ r1: 'fixed', r2: 'recurring', r3: 'recurring', r4: 'fixed' })
      dbA.close()
      dbB.close()
    })
  })
})

describe('FK enforcement survives a migration (success and forced failure)', () => {
  // The v49/v50/v51 recreate-and-copy blocks bracket their DDL with
  // `PRAGMA foreign_keys = OFF ... ON`. The invariant that matters is that a
  // connection never comes out of migration with FK enforcement left OFF —
  // otherwise later writes on that connection would silently bypass FK checks.
  //
  // Two facts make this robust: (1) these blocks run inside db.transaction(),
  // and PRAGMA foreign_keys is a no-op while a transaction is open, so the OFF
  // never actually takes effect today; (2) a finally in each block re-asserts
  // ON regardless, guarding a future refactor that moves the DDL out of the
  // transaction. This test pins the observable invariant on both the happy path
  // and a forced mid-DDL throw.
  it('leaves foreign_keys=ON after a successful full migration', () => {
    const db = preV51Db('v51-fk-ok')
    initSchema(db)
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    db.close()
  })

  it('leaves foreign_keys=ON even when the v51 DDL throws partway', () => {
    const db = preV51Db('v51-fk-throw')
    // Sabotage: a stray table with the migration's scratch name makes the
    // block's `CREATE TABLE anchor_activities_v51` throw before it finishes,
    // exercising the throw path through the finally.
    db.exec('CREATE TABLE anchor_activities_v51 (id TEXT)')
    expect(() => initSchema(db)).toThrow()
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    db.close()
  })
})

describe('rollbackV51', () => {
  it('drops the kind column and the schema_migrations row, reporting discarded recurring-row count', () => {
    const db = freshDb()
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    db.prepare(
      "INSERT INTO anchor_activities (id, camp_id, name, kind, is_all_groups, group_ids) VALUES ('a1', 'camp1', 'Flagpole', 'fixed', 1, NULL)"
    ).run()
    db.prepare(
      "INSERT INTO anchor_activities (id, camp_id, name, kind, unit_id, is_all_groups) VALUES ('a2', 'camp1', 'Division Swim', 'recurring', 't1', 0)"
    ).run()

    const result = rollbackV51(db)
    expect(result).toEqual({ recurringDiscarded: 1 })
    const cols = db.pragma('table_info(anchor_activities)').map((c) => c.name)
    expect(cols).not.toContain('kind')
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 51').get().c).toBe(0)
    expect(db.prepare("SELECT name FROM anchor_activities WHERE id = 'a1'").get().name).toBe('Flagpole')
    db.close()
  })
})
