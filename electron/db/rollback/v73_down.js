// Inverse of migration v73 (electron/db/localDb.js): restores the ten name-UNIQUE constraints
// T241 relaxed (docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md) and
// drops the two additive `conflicts` columns.
//
// ASYMMETRIC BY DESIGN, per the ADR's "Migration and rollback" section: forward always succeeds
// (dropping a constraint and adding nullable columns are both always satisfiable), but rollback
// must REFUSE rather than silently delete or merge real duplicate rows back into a shape the
// restored UNIQUE constraint cannot hold. A director attempting a rollback needs the COMPLETE
// list of every offending table, its colliding value, and the row ids in ONE error — not just the
// first table hit — to decide whether proceeding is even safe, and never a silent dedup or
// deletion (that decision belongs to the director on the entity's own screen, not to a schema
// rollback script).
//
// Usage:  node electron/db/rollback/v73_down.js <path-to-shoresh.sqlite>

// entity, then its unique-key column(s) (the collision key), matching the ADR's ten-table scope.
const RELAXED_TABLES = [
  { table: 'locations', keyCols: ['camp_id', 'name'] },
  { table: 'activities', keyCols: ['camp_id', 'name'] },
  { table: 'events', keyCols: ['camp_id', 'name'] },
  { table: 'elective_sets', keyCols: ['camp_id', 'name'] },
  { table: 'groups', keyCols: ['camp_id', 'name'] },
  { table: 'cohorts', keyCols: ['camp_id', 'name'] },
  { table: 'tiers', keyCols: ['camp_id', 'cohort_id', 'name'] },
  { table: 'time_blocks', keyCols: ['camp_id', 'cohort_id', 'name'] },
  { table: 'schedule_weeks', keyCols: ['camp_id', 'name'] },
  { table: 'special_days', keyCols: ['camp_id', 'name'] },
]

// Finds every live duplicate group (by the table's unique key) across all ten relaxed tables.
// Returns [] when it is safe to restore every constraint.
export function findRelaxedSetDuplicates(db) {
  const offenses = []
  for (const { table, keyCols } of RELAXED_TABLES) {
    const cols = keyCols.join(', ')
    const groups = db
      .prepare(
        `SELECT ${cols}, COUNT(*) as cnt, GROUP_CONCAT(id) as ids
           FROM ${table}
          GROUP BY ${cols}
         HAVING COUNT(*) > 1`
      )
      .all()
    for (const g of groups) {
      const value = keyCols.map((c) => `${c}=${JSON.stringify(g[c])}`).join(', ')
      offenses.push({ table, value, ids: g.ids.split(',') })
    }
  }
  return offenses
}

export function rollbackV73(db) {
  const offenses = findRelaxedSetDuplicates(db)
  if (offenses.length > 0) {
    const detail = offenses
      .map((o) => `${o.table} (${o.value}): rows [${o.ids.join(', ')}]`)
      .join('; ')
    throw new Error(
      `v73 rollback refused: ${offenses.length} table(s) hold duplicate rows the restored ` +
        `UNIQUE constraint cannot accept — resolve every one (rename or delete on that entity's ` +
        `own screen) before rolling back. Offending: ${detail}`
    )
  }

  // PRAGMA foreign_keys is a genuine no-op while a transaction is open — see localDb.js's v73
  // block for why that matters here specifically (template_slots/week_group_exclusions/
  // week_activity_exclusions/elective_set_activities/event_*/special_day_* carry real FKs, with
  // real rows on any camp with a schedule, into the tables this rebuilds). Toggle BEFORE
  // db.transaction() opens its BEGIN, not inside the callback.
  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE locations_v72 (
          id TEXT PRIMARY KEY,
          camp_id TEXT NOT NULL REFERENCES camps(id),
          name TEXT NOT NULL,
          capacity INTEGER NOT NULL DEFAULT 1,
          notes TEXT,
          sort_order INTEGER,
          map_geometry TEXT,
          kind TEXT CHECK(
            kind IS NULL OR kind IN ('building','classroom','pool','field','cabin','court','nature','office','generic')
          ) DEFAULT NULL,
          grid_x INTEGER DEFAULT NULL,
          grid_y INTEGER DEFAULT NULL,
          map_id TEXT DEFAULT NULL,
          UNIQUE(camp_id, name)
        );
        INSERT INTO locations_v72 (id, camp_id, name, capacity, notes, sort_order, map_geometry, kind, grid_x, grid_y, map_id)
          SELECT id, camp_id, name, capacity, notes, sort_order, map_geometry, kind, grid_x, grid_y, map_id FROM locations;
        DROP TABLE locations;
        ALTER TABLE locations_v72 RENAME TO locations;
        DROP INDEX IF EXISTS idx_locations_camp_name;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_camp_name ON locations(camp_id, name);

        CREATE TABLE activities_v72 (
          id TEXT PRIMARY KEY,
          camp_id TEXT NOT NULL REFERENCES camps(id),
          name TEXT NOT NULL,
          priority INTEGER,
          is_locked INTEGER,
          span_blocks INTEGER,
          location TEXT,
          is_outdoor INTEGER,
          max_groups_per_slot INTEGER,
          min_per_week INTEGER,
          max_per_week INTEGER,
          same_tier_only INTEGER,
          eligible_tier_ids TEXT,
          eligible_group_ids TEXT,
          prefer_before_day INTEGER,
          prefer_before_day_min INTEGER,
          weather_alternative_id TEXT,
          notes TEXT,
          location_id TEXT,
          recurrence_truth_status TEXT,
          UNIQUE(camp_id, name)
        );
        INSERT INTO activities_v72 (id, camp_id, name, priority, is_locked, span_blocks, location, is_outdoor, max_groups_per_slot, min_per_week, max_per_week, same_tier_only, eligible_tier_ids, eligible_group_ids, prefer_before_day, prefer_before_day_min, weather_alternative_id, notes, location_id, recurrence_truth_status)
          SELECT id, camp_id, name, priority, is_locked, span_blocks, location, is_outdoor, max_groups_per_slot, min_per_week, max_per_week, same_tier_only, eligible_tier_ids, eligible_group_ids, prefer_before_day, prefer_before_day_min, weather_alternative_id, notes, location_id, recurrence_truth_status FROM activities;
        DROP TABLE activities;
        ALTER TABLE activities_v72 RENAME TO activities;
        DROP INDEX IF EXISTS idx_activities_camp_name;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_camp_name ON activities(camp_id, name);

        CREATE TABLE events_v72 (
          id TEXT PRIMARY KEY,
          camp_id TEXT NOT NULL REFERENCES camps(id),
          name TEXT NOT NULL,
          sort_order INTEGER,
          notes TEXT,
          location_id TEXT,
          UNIQUE(camp_id, name)
        );
        INSERT INTO events_v72 (id, camp_id, name, sort_order, notes, location_id)
          SELECT id, camp_id, name, sort_order, notes, location_id FROM events;
        DROP TABLE events;
        ALTER TABLE events_v72 RENAME TO events;
        DROP INDEX IF EXISTS idx_events_camp_name;

        CREATE TABLE elective_sets_v72 (
          id TEXT PRIMARY KEY,
          camp_id TEXT NOT NULL REFERENCES camps(id),
          name TEXT NOT NULL,
          sort_order INTEGER,
          is_reusable INTEGER NOT NULL DEFAULT 1,
          day_id TEXT REFERENCES days_of_operation(id),
          time_block_id TEXT,
          is_all_groups INTEGER,
          group_ids TEXT,
          schedule_week_id TEXT REFERENCES schedule_weeks(id),
          UNIQUE(camp_id, name)
        );
        INSERT INTO elective_sets_v72 (id, camp_id, name, sort_order, is_reusable, day_id, time_block_id, is_all_groups, group_ids, schedule_week_id)
          SELECT id, camp_id, name, sort_order, is_reusable, day_id, time_block_id, is_all_groups, group_ids, schedule_week_id FROM elective_sets;
        DROP TABLE elective_sets;
        ALTER TABLE elective_sets_v72 RENAME TO elective_sets;
        DROP INDEX IF EXISTS idx_elective_sets_camp_name;

        CREATE TABLE groups_v72 (
          id TEXT PRIMARY KEY,
          camp_id TEXT NOT NULL REFERENCES camps(id),
          name TEXT NOT NULL,
          tier_id TEXT,
          availability TEXT,
          UNIQUE(camp_id, name)
        );
        INSERT INTO groups_v72 (id, camp_id, name, tier_id, availability)
          SELECT id, camp_id, name, tier_id, availability FROM groups;
        DROP TABLE groups;
        ALTER TABLE groups_v72 RENAME TO groups;
        DROP INDEX IF EXISTS idx_groups_camp_name;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_camp_name ON groups(camp_id, name);

        CREATE TABLE cohorts_v72 (
          id TEXT PRIMARY KEY,
          camp_id TEXT NOT NULL REFERENCES camps(id),
          name TEXT NOT NULL,
          session_week_start TEXT,
          session_week_end TEXT,
          capacity_source TEXT,
          anchor_model TEXT,
          sort_order INTEGER,
          UNIQUE(camp_id, name)
        );
        INSERT INTO cohorts_v72 (id, camp_id, name, session_week_start, session_week_end, capacity_source, anchor_model, sort_order)
          SELECT id, camp_id, name, session_week_start, session_week_end, capacity_source, anchor_model, sort_order FROM cohorts;
        DROP TABLE cohorts;
        ALTER TABLE cohorts_v72 RENAME TO cohorts;
        DROP INDEX IF EXISTS idx_cohorts_camp_name;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_cohorts_camp_name ON cohorts(camp_id, name);

        CREATE TABLE tiers_v72 (
          id TEXT PRIMARY KEY,
          camp_id TEXT NOT NULL REFERENCES camps(id),
          name TEXT NOT NULL,
          sort_order INTEGER,
          cohort_id TEXT REFERENCES cohorts(id),
          UNIQUE(camp_id, cohort_id, name)
        );
        INSERT INTO tiers_v72 (id, camp_id, name, sort_order, cohort_id)
          SELECT id, camp_id, name, sort_order, cohort_id FROM tiers;
        DROP TABLE tiers;
        ALTER TABLE tiers_v72 RENAME TO tiers;
        DROP INDEX IF EXISTS idx_tiers_camp_cohort_name;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tiers_camp_cohort_name ON tiers(camp_id, cohort_id, name);

        CREATE TABLE time_blocks_v72 (
          id TEXT PRIMARY KEY,
          camp_id TEXT NOT NULL REFERENCES camps(id),
          cohort_id TEXT REFERENCES cohorts(id),
          name TEXT NOT NULL,
          start_time TEXT,
          end_time TEXT,
          part_of_day TEXT,
          sort_order INTEGER,
          UNIQUE(camp_id, cohort_id, name)
        );
        INSERT INTO time_blocks_v72 (id, camp_id, cohort_id, name, start_time, end_time, part_of_day, sort_order)
          SELECT id, camp_id, cohort_id, name, start_time, end_time, part_of_day, sort_order FROM time_blocks;
        DROP TABLE time_blocks;
        ALTER TABLE time_blocks_v72 RENAME TO time_blocks;
        DROP INDEX IF EXISTS idx_time_blocks_camp_cohort_name;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_time_blocks_camp_cohort_name ON time_blocks(camp_id, cohort_id, name);

        CREATE TABLE special_days_v72 (
          id TEXT PRIMARY KEY,
          camp_id TEXT NOT NULL REFERENCES camps(id),
          name TEXT NOT NULL,
          sort_order INTEGER,
          notes TEXT,
          UNIQUE(camp_id, name)
        );
        INSERT INTO special_days_v72 (id, camp_id, name, sort_order, notes)
          SELECT id, camp_id, name, sort_order, notes FROM special_days;
        DROP TABLE special_days;
        ALTER TABLE special_days_v72 RENAME TO special_days;
        DROP INDEX IF EXISTS idx_special_days_camp_name;

        DROP INDEX IF EXISTS idx_schedule_weeks_camp_name;
        CREATE UNIQUE INDEX idx_schedule_weeks_camp_name ON schedule_weeks(camp_id, name);
      `)

      // conflicts: SQLite has no DROP COLUMN pre-3.35 semantics issue here (better-sqlite3 bundles
      // a modern SQLite that supports ALTER TABLE DROP COLUMN directly), but drop via rebuild
      // anyway to mirror the table-rebuild recipe used everywhere else in this file and avoid
      // depending on a specific SQLite version's DROP COLUMN support.
      const conflictCols = db.pragma('table_info(conflicts)').map((c) => c.name)
      if (conflictCols.includes('entity_ids') || conflictCols.includes('kind')) {
        db.exec('ALTER TABLE conflicts DROP COLUMN entity_ids')
        db.exec('ALTER TABLE conflicts DROP COLUMN kind')
      }

      // `>= 73`, not `= 73` — a bare equality strands any HIGHER version in the table (T220
      // convention, bareEqualityRollback.guard.test.js).
      db.prepare('DELETE FROM schema_migrations WHERE version >= 73').run()
    })()
  } finally {
    db.pragma('foreign_keys = ON')
  }

  return { restored: RELAXED_TABLES.map((t) => t.table) }
}

// Direct invocation (node electron/db/rollback/v73_down.js <file>).
if (process.argv[1] && process.argv[1].endsWith('v73_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v73_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  try {
    const result = rollbackV73(db)
    db.close()
    console.log(`v73 rolled back: restored UNIQUE on ${result.restored.join(', ')}`)
    console.log(
      'This app build still declares schema version 73 — reopening it re-applies v73 and ' +
      're-relaxes every constraint. Downgrade to a pre-v73 build before launching the app again.'
    )
  } catch (err) {
    db.close()
    console.error(err.message)
    process.exit(1)
  }
}
