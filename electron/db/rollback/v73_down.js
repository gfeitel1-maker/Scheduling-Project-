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

import { rebuildTableCarryingColumns } from '../rebuildTableCarryingColumns.js'

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
      // Each of the nine relaxed tables is rebuilt from its LIVE column set via
      // rebuildTableCarryingColumns: baseColumns is the v72 shape and tableConstraints restores the
      // name-UNIQUE this rollback exists to put back, while any column a LATER migration added —
      // e.g. activities.catalog_role (v75) — is detected from table_info and carried forward WITH
      // ITS DATA. Before this helper, the enumerated column lists here silently dropped such columns
      // (the same defect class fixed on the forward path). See
      // docs/adr/2026-10-01-rebuild-migrations-carry-forward-later-columns.md. The helper runs inside
      // this transaction and does not touch the FK pragma (the caller's OFF/ON wrapper owns it).
      rebuildTableCarryingColumns(db, {
        table: 'locations',
        baseColumns: [
          'id TEXT PRIMARY KEY',
          'camp_id TEXT NOT NULL REFERENCES camps(id)',
          'name TEXT NOT NULL',
          'capacity INTEGER NOT NULL DEFAULT 1',
          'notes TEXT',
          'sort_order INTEGER',
          'map_geometry TEXT',
          "kind TEXT CHECK(kind IS NULL OR kind IN ('building','classroom','pool','field','cabin','court','nature','office','generic')) DEFAULT NULL",
          'grid_x INTEGER DEFAULT NULL',
          'grid_y INTEGER DEFAULT NULL',
          'map_id TEXT DEFAULT NULL',
        ],
        tableConstraints: ['UNIQUE(camp_id, name)'],
        postIndexSql: [
          'DROP INDEX IF EXISTS idx_locations_camp_name',
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_camp_name ON locations(camp_id, name)',
        ],
      })

      rebuildTableCarryingColumns(db, {
        table: 'activities',
        baseColumns: [
          'id TEXT PRIMARY KEY',
          'camp_id TEXT NOT NULL REFERENCES camps(id)',
          'name TEXT NOT NULL',
          'priority INTEGER',
          'is_locked INTEGER',
          'span_blocks INTEGER',
          'location TEXT',
          'is_outdoor INTEGER',
          'max_groups_per_slot INTEGER',
          'min_per_week INTEGER',
          'max_per_week INTEGER',
          'same_tier_only INTEGER',
          'eligible_tier_ids TEXT',
          'eligible_group_ids TEXT',
          'prefer_before_day INTEGER',
          'prefer_before_day_min INTEGER',
          'weather_alternative_id TEXT',
          'notes TEXT',
          'location_id TEXT',
          'recurrence_truth_status TEXT',
        ],
        tableConstraints: ['UNIQUE(camp_id, name)'],
        postIndexSql: [
          'DROP INDEX IF EXISTS idx_activities_camp_name',
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_camp_name ON activities(camp_id, name)',
        ],
      })

      rebuildTableCarryingColumns(db, {
        table: 'events',
        baseColumns: [
          'id TEXT PRIMARY KEY',
          'camp_id TEXT NOT NULL REFERENCES camps(id)',
          'name TEXT NOT NULL',
          'sort_order INTEGER',
          'notes TEXT',
          'location_id TEXT',
        ],
        tableConstraints: ['UNIQUE(camp_id, name)'],
        postIndexSql: ['DROP INDEX IF EXISTS idx_events_camp_name'],
      })

      rebuildTableCarryingColumns(db, {
        table: 'elective_sets',
        baseColumns: [
          'id TEXT PRIMARY KEY',
          'camp_id TEXT NOT NULL REFERENCES camps(id)',
          'name TEXT NOT NULL',
          'sort_order INTEGER',
          'is_reusable INTEGER NOT NULL DEFAULT 1',
          'day_id TEXT REFERENCES days_of_operation(id)',
          'time_block_id TEXT',
          'is_all_groups INTEGER',
          'group_ids TEXT',
          'schedule_week_id TEXT REFERENCES schedule_weeks(id)',
        ],
        tableConstraints: ['UNIQUE(camp_id, name)'],
        postIndexSql: ['DROP INDEX IF EXISTS idx_elective_sets_camp_name'],
      })

      rebuildTableCarryingColumns(db, {
        table: 'groups',
        baseColumns: [
          'id TEXT PRIMARY KEY',
          'camp_id TEXT NOT NULL REFERENCES camps(id)',
          'name TEXT NOT NULL',
          'tier_id TEXT',
          'availability TEXT',
        ],
        tableConstraints: ['UNIQUE(camp_id, name)'],
        postIndexSql: [
          'DROP INDEX IF EXISTS idx_groups_camp_name',
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_camp_name ON groups(camp_id, name)',
        ],
      })

      // fixed_event_model (T293, v84), not anchor_model: unlike localDb.js's forward v73 block
      // (which must detect the live column name dynamically, because it can run BEFORE v84 on a
      // genuine forward migration), this rollback only ever runs AFTER a full initSchema() to
      // CURRENT — every real and test call site rolls back from v84+ — so the live cohorts column
      // is always already fixed_event_model by the time this rebuild reads it.
      rebuildTableCarryingColumns(db, {
        table: 'cohorts',
        baseColumns: [
          'id TEXT PRIMARY KEY',
          'camp_id TEXT NOT NULL REFERENCES camps(id)',
          'name TEXT NOT NULL',
          'session_week_start TEXT',
          'session_week_end TEXT',
          'capacity_source TEXT',
          'fixed_event_model TEXT',
          'sort_order INTEGER',
        ],
        tableConstraints: ['UNIQUE(camp_id, name)'],
        postIndexSql: [
          'DROP INDEX IF EXISTS idx_cohorts_camp_name',
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_cohorts_camp_name ON cohorts(camp_id, name)',
        ],
      })

      rebuildTableCarryingColumns(db, {
        table: 'tiers',
        baseColumns: [
          'id TEXT PRIMARY KEY',
          'camp_id TEXT NOT NULL REFERENCES camps(id)',
          'name TEXT NOT NULL',
          'sort_order INTEGER',
          'cohort_id TEXT REFERENCES cohorts(id)',
        ],
        tableConstraints: ['UNIQUE(camp_id, cohort_id, name)'],
        postIndexSql: [
          'DROP INDEX IF EXISTS idx_tiers_camp_cohort_name',
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_tiers_camp_cohort_name ON tiers(camp_id, cohort_id, name)',
        ],
      })

      rebuildTableCarryingColumns(db, {
        table: 'time_blocks',
        baseColumns: [
          'id TEXT PRIMARY KEY',
          'camp_id TEXT NOT NULL REFERENCES camps(id)',
          'cohort_id TEXT REFERENCES cohorts(id)',
          'name TEXT NOT NULL',
          'start_time TEXT',
          'end_time TEXT',
          'part_of_day TEXT',
          'sort_order INTEGER',
        ],
        tableConstraints: ['UNIQUE(camp_id, cohort_id, name)'],
        postIndexSql: [
          'DROP INDEX IF EXISTS idx_time_blocks_camp_cohort_name',
          'CREATE UNIQUE INDEX IF NOT EXISTS idx_time_blocks_camp_cohort_name ON time_blocks(camp_id, cohort_id, name)',
        ],
      })

      rebuildTableCarryingColumns(db, {
        table: 'special_days',
        baseColumns: [
          'id TEXT PRIMARY KEY',
          'camp_id TEXT NOT NULL REFERENCES camps(id)',
          'name TEXT NOT NULL',
          'sort_order INTEGER',
          'notes TEXT',
        ],
        tableConstraints: ['UNIQUE(camp_id, name)'],
        postIndexSql: ['DROP INDEX IF EXISTS idx_special_days_camp_name'],
      })

      // schedule_weeks is NOT rebuilt — its name-UNIQUE lives only in a named unique index.
      db.exec('DROP INDEX IF EXISTS idx_schedule_weeks_camp_name')
      db.exec('CREATE UNIQUE INDEX idx_schedule_weeks_camp_name ON schedule_weeks(camp_id, name)')

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
