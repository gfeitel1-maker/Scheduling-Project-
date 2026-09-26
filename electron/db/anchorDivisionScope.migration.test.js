// @vitest-environment node
//
// Migration v65 — T180: a Recurring Event's DIVISION scope becomes stored data
// instead of a group snapshot taken at save time.
//
// Adds `anchor_activities.unit_ids TEXT` (a JSON array of tier ids). The
// engine resolves it live (src/engine/buildSchedule.js), so a group added to a
// division after the event was saved is covered without a re-save — which is
// the whole defect. `unit_id`, the legacy SINGLE-division column, is left in
// place and backfilled into `unit_ids`; the picker has always been
// multi-select, so one column could never hold what the director picked.
//
// SQLite cannot attach a cross-column CHECK via ALTER TABLE ADD COLUMN, and
// the v51 `kind='fixed'` invariant has to grow to cover the new column — so
// this migration RECREATES the table, exactly as v51 did.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'

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

// A db migrated fully forward, then reshaped back to the v64 anchor_activities
// (no unit_ids, v51's narrower CHECK) so the v65 block can be exercised.
function preV65Db(tag = 'v65-pre') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.pragma('foreign_keys = OFF')
  db.exec(`
    ALTER TABLE anchor_activities RENAME TO anchor_activities_tmp;
    CREATE TABLE anchor_activities (
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
      location_id TEXT,
      kind TEXT NOT NULL DEFAULT 'fixed' CHECK (kind IN ('fixed', 'recurring')),
      CHECK (
        kind = 'recurring'
        OR (kind = 'fixed' AND is_all_groups = 1 AND unit_id IS NULL
            AND (group_ids IS NULL OR group_ids = '[]'))
      )
    );
    -- recurrence_level is intentionally NOT selected from anchor_activities_tmp —
    -- that table came from a fully-migrated (head, v71) db, which no longer has
    -- the column (T181 dropped it). It is declared above with its own DEFAULT
    -- instead, matching the value it always held anyway (v42's DEFAULT 'daily').
    INSERT INTO anchor_activities
      (id, camp_id, cohort_id, day_id, time_block_id, name, unit_id, span_blocks,
       is_all_groups, group_ids, notes, schedule_week_id, location_id, kind)
      SELECT id, camp_id, cohort_id, day_id, time_block_id, name, unit_id, span_blocks,
             is_all_groups, group_ids, notes, schedule_week_id,
             location_id, kind
      FROM anchor_activities_tmp;
    DROP TABLE anchor_activities_tmp;
  `)
  db.prepare('DELETE FROM schema_migrations WHERE version >= 65').run()
  db.pragma('foreign_keys = ON')
  return db
}

describe('v65 — anchor_activities.unit_ids (division scope)', () => {
  it('a fresh db lands at CURRENT_SCHEMA_VERSION and carries unit_ids', () => {
    const db = openLocalDb(tmpFile('v65-fresh'))
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(76)
    const cols = db.pragma('table_info(anchor_activities)').map((c) => c.name)
    expect(cols).toContain('unit_ids')
    expect(cols).toContain('unit_id')
    db.close()
  })

  it('a migrated db ends up with the same anchor_activities shape as a fresh one', () => {
    const fresh = openLocalDb(tmpFile('v65-shape-fresh'))
    const migrated = preV65Db('v65-shape-mig')
    initSchema(migrated)
    const shape = (d) => d.pragma('table_info(anchor_activities)').map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}`)
    expect(shape(migrated)).toEqual(shape(fresh))
    fresh.close()
    migrated.close()
  }, 30000)

  it('backfills unit_ids from a legacy single unit_id, and leaves rows without one alone', () => {
    const db = preV65Db('v65-backfill')
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    const ins = db.prepare(
      "INSERT INTO anchor_activities (id, camp_id, name, kind, unit_id, is_all_groups, group_ids) VALUES (?, 'camp1', ?, ?, ?, ?, ?)"
    )
    ins.run('a-unit', 'Division Swim', 'recurring', 't1', 0, null)
    ins.run('a-groups', 'Snapshot Swim', 'recurring', null, 0, JSON.stringify(['g1']))
    ins.run('a-fixed', 'Lunch', 'fixed', null, 1, null)

    initSchema(db)

    const rows = Object.fromEntries(
      db.prepare('SELECT id, unit_id, unit_ids, group_ids FROM anchor_activities').all().map((r) => [r.id, r])
    )
    expect(JSON.parse(rows['a-unit'].unit_ids)).toEqual(['t1'])
    // The legacy column is NOT cleared: rolling back past v65 must not lose the scope.
    expect(rows['a-unit'].unit_id).toBe('t1')
    // A snapshot row stays a snapshot — the migration cannot invent the division
    // the director meant, and guessing it from group_ids is exactly the
    // backwards derivation T180 exists to remove.
    expect(rows['a-groups'].unit_ids).toBeNull()
    expect(JSON.parse(rows['a-groups'].group_ids)).toEqual(['g1'])
    expect(rows['a-fixed'].unit_ids).toBeNull()
    db.close()
  }, 30000)

  it("the CHECK still holds the 'fixed = all-camp' invariant, now including unit_ids", () => {
    const db = openLocalDb(tmpFile('v65-check'))
    db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES ('camp1', 'Camp', 'sec')").run()
    expect(() =>
      db.prepare(
        "INSERT INTO anchor_activities (id, camp_id, name, kind, unit_ids, is_all_groups) VALUES ('x', 'camp1', 'Lunch', 'fixed', ?, 1)"
      ).run(JSON.stringify(['t1']))
    ).toThrow(/CHECK constraint failed/)
    // An empty array is not a scope claim, so a fixed row may carry it.
    expect(() =>
      db.prepare(
        "INSERT INTO anchor_activities (id, camp_id, name, kind, unit_ids, is_all_groups) VALUES ('y', 'camp1', 'Lunch', 'fixed', '[]', 1)"
      ).run()
    ).not.toThrow()
    // A recurring row may carry unit_ids — that is the point.
    expect(() =>
      db.prepare(
        "INSERT INTO anchor_activities (id, camp_id, name, kind, unit_ids, is_all_groups) VALUES ('z', 'camp1', 'Swim', 'recurring', ?, 0)"
      ).run(JSON.stringify(['t1', 't2']))
    ).not.toThrow()
    db.close()
  })

  it('schema.sql and localDb.js agree on the anchor_activities shape', () => {
    const schemaText = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    const match = schemaText.match(/CREATE TABLE IF NOT EXISTS anchor_activities \([\s\S]*?\n\);/)
    expect(match, 'expected an anchor_activities CREATE TABLE block in schema.sql').toBeTruthy()
    expect(match[0]).toContain('unit_ids TEXT')
    expect(match[0]).toContain("unit_ids IS NULL OR unit_ids = '[]'")
  })
})
