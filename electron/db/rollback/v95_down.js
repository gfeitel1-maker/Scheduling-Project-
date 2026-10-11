// Inverse of migration v95 (electron/db/localDb.js) — F2, time_blocks.events_only.
//
//   1. `ALTER TABLE time_blocks DROP COLUMN events_only` — the column sits in no index and no CHECK
//      constraint, so the plain single-statement form applies (v87_down's shape).
//   2. DATA LOSS: every events_only flag is discarded, so a block that was event-only becomes
//      schedulable again and Generate may place an activity in it. There is no prior value to
//      restore: the column did not exist before v95.
//   3. This rollback does not edit PROJECTIONS; the older build simply has no events_only field.
//
// Usage:  node electron/db/rollback/v95_down.js <path-to-shoresh.sqlite>

import { assertHighestApplied } from './assertHighestApplied.js'

const hasColumn = (db, table, column) =>
  db.pragma(`table_info(${table})`).some((c) => c.name === column)

/**
 * @returns {{ok:true, discarded:{eventsOnlyBlocks:number}}}
 */
export function rollbackV95(db) {
  const discarded = {
    eventsOnlyBlocks: hasColumn(db, 'time_blocks', 'events_only')
      ? db.prepare('SELECT COUNT(*) c FROM time_blocks WHERE events_only = 1').get().c
      : 0,
  }

  db.transaction(() => {
    if (hasColumn(db, 'time_blocks', 'events_only')) {
      db.exec('ALTER TABLE time_blocks DROP COLUMN events_only')
    }
    // `>= 95`, never `= 95` (bareEqualityRollback.guard.test.js's class).
    db.prepare('DELETE FROM schema_migrations WHERE version >= 95').run()
  })()

  return { ok: true, discarded }
}

if (process.argv[1] && process.argv[1].endsWith('v95_down.js')) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node electron/db/rollback/v95_down.js <path-to-shoresh.sqlite>')
    process.exit(1)
  }
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  assertHighestApplied(db, 95)
  const result = rollbackV95(db)
  db.close()
  console.log(
    `v95 rolled back: discarded ${result.discarded.eventsOnlyBlocks} events-only time block flag(s); ` +
    'those blocks are schedulable again. This app build still declares schema version 95: reopening it re-adds the column, all 0.'
  )
}
